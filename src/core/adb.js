'use strict';
/**
 * adb client wrapper
 * Only the subset ApkStart needs: install / launch / stop / uninstall / file sync / screenshots
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:\\Android\\platform-tools\\adb.exe',
  'C:\\adb\\adb.exe',
  'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
];

/**
 * Translate raw pm install failures into messages users can understand.
 * Keep the original error code at the end for searchability.
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'Install failed: this app only ships ARM native libraries (common for many Chinese apps); '
      + 'the current system image has no ARM translation layer. ApkStart will switch to the compatibility image with the built-in newer translator and retry.',
    INSTALL_FAILED_OLDER_SDK:
      'Install failed: the app requires a newer Android version than this runtime (needs a newer system image).',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      'Install failed: the APK has no valid signature and cannot be installed.',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      'Install failed: signature differs from the installed version; uninstall the old version first.',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      'Install failed: a newer version is already installed; downgrades are not allowed.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      'Install failed: the runtime is low on disk space; free some space and retry.',
    INSTALL_FAILED_INVALID_APK:
      'Install failed: the APK is corrupt or incomplete (possibly an unfinished download); obtain it again.',
    INSTALL_FAILED_INVALID_URI: 'Install failed: the APK path contains special characters; move it to an English-only path and retry.',
    INSTALL_FAILED_ALREADY_EXISTS: 'Install failed: an app with the same name but a different signature exists; uninstall it first.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Install failed: signature differs from the installed version; uninstall the old version first.',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      'Install failed: this app targets a very old Android version (targetSdk too low) and Android 14 blocks it by default.'
      + 'ApkStart will retry automatically with the official bypass flag.',
    INSTALL_FAILED_TEST_ONLY: 'Install failed: this is a test-only package; retrying with the test-package flag.',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: 'Install failed: the app depends on device features (e.g. vendor libraries) that this runtime lacks.',
    INSTALL_FAILED_USER_RESTRICTION: 'Install failed: the system blocked installation; restart the runtime and retry.',
    INSTALL_FAILED_CONFLICTING_PROVIDER: 'Install failed: ContentProvider conflict with an existing app; uninstall the conflicting app.',
    INSTALL_FAILED_INTERNAL_ERROR: 'Install failed: internal system error (often low storage or an unfinished boot); restart the runtime and retry.',
  };
  const msg = table[tag];
  return msg ? `${msg} (${tag})` : `Install failed: ${raw}`;
}

/** Translate post-launch crash logs into understandable causes */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || 'app'} crashed after launch: the ARM translator is incompatible with the app signal handling.`
      + 'ApkStart will switch to the Android 14 compatibility image and retry automatically.';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || 'app'} crashed after launch: a device-native library is missing (the app may only ship ARM builds).`
      + 'Switching to the compatibility image with the ARM translator and retrying automatically.';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || 'app'} crashes immediately (internal app error, possibly related to the emulator environment or missing Google services).`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || 'app'} failed to start: the system rejected the launch request (permissions or signature).`;
  }
  return `${pkg || 'app'} did not start${t ? `: ${t.slice(0, 240)}` : ' (process not alive)'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cached resolved launch entries (adbPath|pkg -> activity), valid for 10 minutes */
const LAUNCHER_CACHE = new Map();

/**
 * Windows adb is unstable with non-ASCII paths (non-ASCII usernames/download dirs are common).
 * Copy the APK to a pure-ASCII temp directory before install and delete it afterwards.
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'apkstart-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Assemble the full component am start -n expects from "Activity".
 * Both forms must be supported:
 *   - Bare class name (what old apps.json stored): `MainActivity` / `.MainActivity` -> `<pkg>/<activity>`
 *   - Full component (`cmd package resolve-activity` output): `com.a.b/.Main` -> used as-is
 * The old code always built `${pkg}/${activity}`, turning a full component into `pkg/pkg/class`,
 * so am start was cancelled (result code=-92): tapping the icon just showed the Android home screen.
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** Extract the component belonging to pkg from `cmd package resolve-activity --brief` output (tolerates trailing blank/priority lines) */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * The adb install timeout used to be fixed at 240s, but a 2 GB+ package on a slow disk
 * ("push + install + dexopt") easily exceeds 4 minutes; a timeout is treated as an install failure,
 * which users see as "big package does nothing / fails". Scale by size here, capped at 20 minutes.
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Parse `find -exec stat -c '%Y|%s|%n'` output.
 * Returns null when the output is not stat-like (device does not support it).
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // Output exists but no line parses -> not stat format
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // resident `adb shell` process
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // rely on PATH
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    return { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // Share the runtime emulator's dedicated adb server port (default 5044), isolated from
        // WSA / third-party emulator adb on 5037, so device registration is not kicked into offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // adb install writes the failure reason to stdout with a non-zero exit code;
          // the old code only read stderr, so users always saw a vague "failed".
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} failed: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * Resident input channel.
   * Wheel/back are high-frequency inputs: execFile-ing adb per wheel notch spawns piles of processes
   * and the desktop visibly stutters. Reuse one `adb shell`, one command per line, and echo
   * a terminator at the end - that tells us when a command really finished and creates backpressure
   * so swipe commands do not queue up in the shell.
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // The whole line must equal the marker: some shells echo the command line itself,
          // and a contains() check would mistake "just written" for "done", piling up swipes.
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* ignore: caller handles offline devices etc. */ });
    p.stdin.on('error', () => { /* exit handler cleans up on disconnect */ });
    p.on('error', () => { this._failWaiters(new Error('Failed to start adb shell')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell exited'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** Run one whitelisted input command; on failure the session is recycled and the caller may fall back to one-shot adb */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('Invalid input command');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__APKSTART_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('input command timed out'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Input channel closed'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* may already be connected */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state needs a serial, so fall back to the devices list
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * Install a single APK with automatic fallbacks:
   *  - drop -g by default (auto-granting all permissions crashes PermissionController on some images);
   *  - pass --bypass-low-target-sdk-block so Android 14 accepts old-targetSdk apps;
   *  - retry with another invocation when adb rejects the flag / non-ASCII path / transfer errors;
   *  - NO_MATCHING_ABIS throws an error with a code so the caller can switch images.
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g auto-grants runtime permissions and skips in-app dialogs; dropped if the image does not support it
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* fall back to the default when size is unavailable */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // old adb rejects the new flag / test-package marker -> try another invocation
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // transfer errors (device dropped, adb server restarted) get one retry
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // no explicit error code: try the last invocation
        }
      }
      const err = new Error(friendlyInstallError(last || 'Install failed without a clear reason'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** Split APKs (multiple parts from .apks / .xapk) go through install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('No installable split APKs');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('Split APK installation failed');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // some devices require an explicit user
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    return /package:/.test(out);
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** Resolve the real launch Activity from the system (fallback when the manifest parse fails) */
  /** Entry points can change after an upgrade; evict the package from the cache before resolving */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  async resolveLauncher(pkg) {
    // Resolving the launch Activity costs an adb round trip (~200-400ms) and does not change within a session.
    // Cache it so the second tap skips the round trip; it expires after 10 minutes and reinstalls evict it.
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* fall back to monkey */ }
    return null;
  }

  /** Whether the app is really alive: am start success does not mean the process survived */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // Without a crash log do not declare failure: some large apps take 20-40s on first start
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * Launch an app with three-level fallback:
   *   freeform window -> normal fullscreen -> monkey fallback;
   * each attempt verifies the process survived; on crash it grabs logcat and throws a coded error for image switching.
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // Use the system-resolved LAUNCHER entry, not just the main Activity parsed from the APK:
    // many apps (the drama app etc.) initialize on their splash page; entering the main Activity directly
    // throws "had you called RpcService.init" and the app flashes and closes.
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved may be a full component (pkg/class) or just a class name (old apps.json);
    // normalize to the full component am start -n needs, avoiding pkg/pkg/class cancellation.
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n (the app is still loading)`;
      lastError = alive.crash || lastError;
      // When the crash log clearly points at the ARM translator, stop retrying and let the caller switch images
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // monkey fallback: on some images am start -a/-c/-p cannot resolve the launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // Prefer explicit crash info; otherwise keep the original launch error
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** Enable freeform (separate window) support; failure does not affect the main flow */
  async ensureFreeform() {
    // Combine into one adb shell: 4 separate execFiles cost 600ms+ on Windows,
    // and this sits right in the "tap to open" wait.
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // Android ls -l has with-group and without-group formats; the date may be
      // "2026-11-12 18:52" or "Nov 12 18:52", which a fixed regex cannot parse at all.
      // The second number after the permission bits is the size; the last field is the name.
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // The name follows the HH:MM token (the date part has a variable 2-3 tokens)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * Remote listing with real mtimes (toybox stat).
   * ls -l dates ("Mon DD HH:MM") cannot be converted reliably, making sync think everything changed.
   * Returns null when the device lacks stat; the caller should fall back to listRemote.
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Clear app data */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
  }

  /** Export app data (run-as on Windows/debug builds; otherwise fall back to adb backup) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/apkstart-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * Grant all requested runtime permissions in one pass.
   * Skipping this has two consequences: (1) a system dialog on first start looks like "the app did not open";
   * (2) after pm clear the permissions drop and the app stalls on the grant page.
   */
  async grantRuntimePermissions(pkg) {
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // leave the runtime permissions section
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // Send all grants at once: one pm grant process per line costs 150ms+ on Windows,
    // four or five permissions add up to 1s, and these commands have no dependencies.
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // Special permissions go through appops, otherwise dialogs still appear
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    return granted;
  }

  /**
   * Enter the "this is the app" state:
   *  - dismiss the lock screen so boot does not stop at it;
   *  - hide the status bar (keep the navigation keys so back/home still work without a mouse);
   *  - disable system animations; a huge difference on low-end machines.
   * All are settings-level commands costing a few hundred ms and safe to repeat.
   */
  async prepareForeground() {
    // 7 commands used to run serially, each spawning a new adb process (150-250ms on Windows),
    // totaling 1-1.7s inside the "tap to open" wait. One combined shell leaves a single round trip.
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // Note: do not write wm user-rotation / accelerometer_rotation here.
      // Orientation is decided by setOrientation / resetDisplayOverrides from the current state,
      // and hard-coding lock 0 here would force landscape back to portrait (image on its side).
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** Mouse right/side buttons / shortcuts map through the resident input channel, removing 100ms-level back delay */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // If the runtime just restarted and the resident shell is not connected, fall back to one-shot adb; never drop the click
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * Switch between phone and tablet layouts.
   *
   * Key: **never change wm size**. Changing it alters the guest framebuffer's physical size
   * (720x1280 -> 1280x720) while the embedded Qt window keeps its size/orientation, so the image is
   * squashed or rotated 90 degrees and mouse mapping breaks. Worse, wm size overrides persist
   * in /data across restarts - the root of the repeated "black bars / not filled / cannot tap"
   * reports.
   *
   * Now only logical density changes (wm density); the framebuffer stays upright at 720x1280:
   *   - 320dpi -> smallestWidth 360dp -> phone layout
   *   - 190dpi -> smallestWidth 606dp (>=600dp) -> tablet / split layout
   * Size, orientation and tap mapping stay unchanged, so no tilt, no bars, taps always land.
   */
  async setOrientation(landscape) {
    try {
      // Auto-rotate must be off (the sensor would spin), but user_rotation is locked to the target:
      // once the physical panel is 1280x720, only user-rotation 1 (90 degrees) makes
      // Android lay out for landscape - otherwise it renders portrait content at rotation 0
      // and Qt shows it lying on its side in a landscape window.
      await this.shell('settings put system accelerometer_rotation 0; wm size reset', { timeout: 15000 });
      await this.shell(`wm user-rotation lock ${landscape ? 1 : 0}`, { timeout: 15000 });
      await this.shell(landscape ? 'wm density 190' : 'wm density reset', { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Clear wm size / density overrides left by older versions at startup (they persist in /data and keep the image tilted) */
  async resetDisplayOverrides(landscape = false) {
    try {
      await this.shell('wm size reset; wm density reset', { timeout: 15000 });
      await this.shell('settings put system accelerometer_rotation 0', { timeout: 15000 });
      await this.shell(`wm user-rotation lock ${landscape ? 1 : 0}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Current logical resolution (window aspect ratio is computed from it after a landscape switch) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** When a grant dialog is still on top (self-heal even with nobody at the PC), dismiss it with Back */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * Display adaptation: in fullscreen set the Android resolution to the monitor size (content fills it),
   * in windowed mode restore the portrait preset. wm commands apply at runtime; no Android restart.
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity,
};
