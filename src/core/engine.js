'use strict';
/**
 * Runtime engine: the QEMU + Android-x86 VM bundled with ApkStart
 *
 * Design principles:
 *  - fully self-contained by default (builtin): adb / QEMU / system images are all managed by ApkStart, with no third-party emulator
 *  - every Android operation goes through adb, so the engine is replaceable
 *  - the VM starts on demand and is reclaimed when idle; once running it is reused resident, so installing/opening apps is near-instant
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** Whether anything listens on a TCP port (used to tell whether the emulator left by a previous run is still up) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

const ATTACH_ENDPOINTS = [
  { name: 'Windows Subsystem for Android', serial: '127.0.0.1:58526' },
  { name: 'LDPlayer', serial: '127.0.0.1:5555' },
  { name: 'MuMu emulator', serial: '127.0.0.1:7555' },
  { name: 'Nox', serial: '127.0.0.1:62001' },
  { name: 'MEmu', serial: '127.0.0.1:21503' },
];

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // container sessions: app windows currently open
    this.emuSerial = EMU_SERIAL;   // the port is chosen dynamically, so the serial follows it
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  get settings() { return store.getSettings(); }

  /** Whether the emulator engine is running */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- basics ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial
      || (this.settings.engine.mode === 'attach' ? this.settings.device : this.emuSerial);
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // When the port/adb changes, do not leave the old resident adb shell holding a connection in the background
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- state ----------------

  async status() {
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // "Why did the last start fail": fall back to the on-disk record when memory is empty, so settings/diagnostics show the real cause
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'adb missing: click "Set up everything" to download it automatically';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // "No hardware acceleration" is no longer a blocking step: doctor falls back to software emulation
    // and retries failed boots through GPU/acceleration/memory combinations in order.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /** Advanced mode: detect an existing runtime on this machine (non-default path) */
  async probe() {
    const adbPath = this.adbPath();
    const one = (ep) => new Promise((resolve) => {
      const c = new AdbClient({ adbPath, serial: ep.serial });
      const timer = setTimeout(() => resolve(null), 4000);
      c.isOnline().then((online) => {
        clearTimeout(timer);
        if (!online && ep.serial.includes(':')) return c.connect().then((ok) => (ok ? ep : null));
        return online ? ep : null;
      }).then(resolve).catch(() => { clearTimeout(timer); resolve(null); });
    });
    const found = await Promise.all(ATTACH_ENDPOINTS.map(one));
    return found.filter(Boolean);
  }

  // ---------------- start / stop the VM ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // First choice: the official emulator (bundled device model and GPU translation, the best experience)
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Start Android with the official emulator.
   * Unlike QEMU+ISO there is no "install the OS" step: the image is the system, so the first start is the boot.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('No hardware acceleration detected: falling back to software emulation (the first boot is slower, no settings needed)');
    }

    this.vmStarting = true;
    try {
      // The probe goes to EmulatorEngine's boot loop, which retries with another flag set on exit or a fatal log line
      // One adb command per round: it used to spawn three processes (get-state + getprop + pm path),
      // costing 300-500ms per round on a snapshot restore - exactly what the "tap an app" feel hinges on.
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (_) {
          errStreak += 1;
          // adb transport occasionally stalls at offline / unauthorized (another adb server grabbed the port,
          // or the handshake was interrupted); every shell round then errors and the probe stays pending -
          // the caller only sees "boot timed out" and waits out 240 seconds. Six consecutive failures restart the server to self-heal.
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb connection problem; restarting the adb server and continuing to wait…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() returns {ok:false} rather than throwing on failure (low disk, repeated retries failing, etc.).
      // The old code ignored that field and returned ok:true upward - so the caller believed it was ready,
      // adb then reported device not found repeatedly, and the user saw "tapping does nothing" instead of the real cause.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'The Android runtime failed to start',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // Snapshots now save when idle: saving at once writes 1-3GB and competes with the app the user just opened
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Pass the retry/diagnostic conclusion to the UI as-is instead of wrapping it in a vague "start failed"
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- prewarm (keep the environment resident like WSA) ----------------

  /** Save the quickboot snapshot when idle: write only with no app window, avoiding I/O contention with app starts */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** For external callers such as the installer: re-save a snapshot after installing an app so the next boot is still instant */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Prewarm: boot the Android environment in the background before the user opens any app.
   * WSA / Tencent's PC app store follow the same idea: a resident environment, so tapping an icon only needs one am start.
   *  - fully silent: no dialogs, no errors, and a failure does not block opening apps normally;
   *  - idempotent: reuses the same Promise while booting or once ready, never starting a second VM;
   *  - cheap: after boot, park qemu at the lowest priority.
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    // Advanced mode reuses a runtime someone else already started and must not open one of our own
    if (this.settings.engine.mode === 'attach') return Promise.resolve({ ok: false, skipped: 'attach' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`Pre-warm: ${m}`) });
        if (r && r.ok) {
          // The user may have opened an app during prewarm: do not push it down to idle priority then
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Pre-warm done (${Math.round(ms / 1000)}s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('QEMU is not installed; finish the runtime setup first');
    if (install && !env.iso.ok) throw new Error('System image (ISO) is not ready');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Android has not been installed to the virtual disk yet');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Starting the runtime (${env.hypervisor.whpx ? 'WHPX hardware acceleration' : 'pure software emulation'})…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Start failed: ${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`Runtime exited (code=${code})`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU failed to start; see the log: ${logFile}`);

    // Install mode: the ISO holds a Linux installer with no adb, so "wait for adb" does not apply
    if (install) {
      onLog('The installer started; follow the guide in the VM window');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'The VM started but adb could not connect: enable "Developer options → ADB over network" in the VM and retry',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'The Android kernel did not finish booting; check the runtime log (corrupt image or acceleration not active)'
          : 'Android booted but system services are not ready (it may be stuck on the first-boot wizard — finish it in the VM window)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Wait until Android is genuinely usable: adb online does not mean the system is usable.
   * Both sys.boot_completed=1 and a responsive package manager are required, or am start fails outright.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android kernel started, waiting for system services… (${Math.round((Date.now() - start) / 1000)}s)`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android ready (${Math.round((Date.now() - start) / 1000)}s)`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Waiting for system services… ${Math.round((Date.now() - start) / 1000)}s`
          : `Booting Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // Serials like emulator-5554 are registered by the emulator itself and need no adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Waiting for Android to start… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    this.startWatchdog();
  }

  /** Graceful stop: the emulator shuts down via its console, QEMU via the monitor */
  async stop({ graceful = true } = {}) {
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // An adopted emulator (adoptExisting) has no proc handle in this process, so the old logic
    // returned false - the idle watchdog could never stop it and the container kept holding CPU/memory.
    // This path now shuts down via the adb console, falling back to a port-based force kill when needed.
    //
    // Note: emulator.exe is only a launcher that exits after spawning qemu, so even "ones we started"
    // often land here. saveSnapshotNow must be called once before shutdown, or no snapshot is ever stored and
    // every tap is a full cold boot (the difference between 25 and 8 seconds is exactly this step).
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor timed out')));
      sock.on('error', (e) => {
        // QEMU drops the connection after commands such as quit (ECONNRESET/EPIPE), which is normal
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- install the OS onto the virtual disk ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Download or import the Android system image (ISO) first');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'Failed to start the installer environment');
    return r;
  }

  /** After installation: shut the installer down -> write the marker -> boot from disk from then on */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * Adopt the emulator left by the previous run.
   * Each emulator has its own console port (5554/5556/...), with the adb port at +1.
   * If the port accepts a connection and the system has boot_completed, use it directly as our runtime,
   * so "close ApkStart, tap an app again" takes seconds instead of cold-booting another VM.
   */
  /**
   * Find every live emulator console port.
   * Probing sequentially from 5554 does not work: the port drifts upward across starts (5554 -> 5556 -> 5558 ...),
   * a fixed range always misses one eventually and a new VM gets started. So instead find every TCP port
   * qemu listens on by process name - none are missed.
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* fall back to port probing */ }

    if (ports.size) {
      // Both the console port (even) and the adb port (+1) listen, so keep the console ports only
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Fallback: with no qemu process info, probe directly (a refused connect returns at once, near-zero cost)
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('No previous runtime found; cold booting');
      return null;
    }
    onLog(`Found ${alive.length} leftover runtimes (ports ${alive.join(', ')}); trying to take over`);

    // The adb server may still hold offline records from the last process (true after the emulator restarted adbd),
    // so clear them first; otherwise get-state always says offline and a healthy VM is misjudged as "not ready" and killed.
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Found a previous runtime (${serial}) that is not ready; shutting it down and rebooting`);
        // The AVD directory is locked: leaving this one alive makes new instances exit at once, appearing as "never boots at all".
        // adb cannot connect, so find the process by console port and force-kill it.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Took over the running runtime (${serial})`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** Which process listens on a TCP port (used to force-kill a stuck emulator) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Clean up orphaned emulators left by the previous run that were not adopted.
   * The emulator is detached when ApkStart closes, so qemu survives; on the next start it still holds the AVD lock,
   * so a cold boot goes straight to FATAL "Running multiple emulators with the same AVD".
   * The implementation lives in EmulatorEngine, and the retry path (killAttempt) uses the same logic.
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * Idempotent entry: prewarm and a user tap may happen at once and share one Promise,
   * avoiding both sides judging "not online" and each starting an emulator (AVD lock conflict plus double memory).
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    // The emulator survives the last ApkStart exit (instant next tap), but the new process has no handle to it
    // and the adb server may have been restarted - isOnline() alone judges "no runtime",
    // so another one starts. Here the live emulator is adopted first, avoiding duplicate VMs eating memory.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // An emulator left by the last session / started by another process is reused even on a different port, never duplicated
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* nothing found: start normally */ }

    // Process alive but device offline (usually stuck booting): stop it and start again rather than waiting
    if (this.emulator.running()) {
      onLog('Detected a stuck runtime; restarting…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Advanced mode: connect to an existing runtime
    if (s.engine.mode === 'attach') {
      onLog('Probing for existing runtimes…');
      const found = await this.probe();
      if (found.length) {
        store.saveSettings({ device: found[0].serial });
        const c2 = this.client(found[0].serial);
        if (await c2.isOnline()) {
          await this.prepare(c2);
          return { ok: true, client: c2, engine: found[0].name };
        }
      }
      return { ok: false, needsSetup: 'attach', error: 'No usable existing runtime found' };
    }

    // Default: the bundled runtime
    // In the single-file edition the image is compressed, so expand it first (instant if already expanded).
    // Do not swallow an expansion failure: checkEnv() would then only say "system image missing"
    // and users would think nothing was downloaded rather than that extraction failed (full disk / corrupt file).
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`Failed to expand the system image: ${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // Emulator path: the image is the system, with no "install to disk" step
    if (env.emulator.ok && env.sysimg.ok) {
      // Unadopted emulators may survive after ApkStart closes (detached qemu still lives),
      // holding the AVD lock so a cold boot goes straight to FATAL "Running multiple emulators with the same AVD".
      // When adoption fails, clear these orphans before cold booting, guaranteeing "close and reopen" always works.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU path (user-supplied ISO already installed to the virtual disk)
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'System image still missing: click "Download system image"'
          : 'Runtime components are not fully deployed yet',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- app-level container sessions ----------------

  /**
   * How "open like a container" actually works:
   * the Android environment boots once and stays resident (quickboot snapshot + adoptExisting adoption),
   * after which opening an app is just am start plus attaching the existing window, never rebooting the system.
   * Three extra things reduce load on the system:
   *   - stop other user apps' processes so only what the current app needs runs;
   *   - give qemu a "yield to the foreground" priority while a window is open;
   *   - enable file sync / notification polling only while a window exists (handed to the UI layer via onActive).
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // Scheduling level while an app is in the foreground. balanced uses normal (not below):
    // below starves qemu when the system is busy, showing up as dropped video frames and delayed click response -
    // the main cause of "clicks do not track". normal merely matches the desktop and costs no extra CPU/memory/GPU.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // An app is about to open: defer "save the snapshot when idle" so it does not contend for disk during the start
      this.emulator.cancelSnapshotSave();
    }
    // Ensure the priority on every open / switch back: endApp drops an idle qemu to idle,
    // and without raising it again on return it stays low -> input feels wooden. setPriority is idempotent
    // and does nothing inside the script when already at the target, so the cost is tiny.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* a failed poll start does not affect opening the app */ }
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // The app just finished am start, and clearing the background now could hit a process entering the foreground; leave clearing to endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * Close an app window: stop its process; if it was the last window, put the container into
   * a "resident but nearly free" parked state (clear background + Android idle + lower qemu priority).
   * No shutdown, no AVD deletion - the next tap is still instant.
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // In game mode keep the high priority even with no app window for now,
      // otherwise the next tap must raise it again and the first input lags noticeably.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Now at its most idle: save the memory state as a snapshot so the next boot restores instead of cold-booting
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Container parked (Android stays resident, 0 app processes, qemu at lowest priority)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Lets the settings page restore disabled system packages when "deep trim" is switched off */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- idle reclaim ----------------

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // An adopted emulator has no local proc handle, so vmRunning is false:
      // it used to return here, so the container was never reclaimed. Now adb online is checked as well.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- diagnostics / slimming (called by the UI) ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // The in-memory attempts are valid for this session only and are empty when a report is exported after a restart.
    // So fall back to the last failure record on disk and append the tail of emulator.log - otherwise the report
    // holds a single UNKNOWN line with no real cause (issues #20/#25 both stalled here).
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * Reclaim old images / old AVDs / lock files / snapshots in the runtime.
   * Root cause of "click clean but nothing is cleaned": with the runtime running, keepSnapshots excluded the current AVD's
   * quickboot snapshot (a multi-GB ram.img), leaving almost nothing to clean in a single-AVD setup.
   * Callers can now pass includeSnapshots explicitly: stop the runtime, then trim, and snapshots are really reclaimed.
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // If the preview phase stopped the VM, tell the user: the runtime can be restarted manually after cleaning
    return { ...report, apply, stoppedVm };
  }

  /**
   * Fully reset Android data (wipe the /data user partition + installed apps + quickboot snapshots),
   * restoring the AVD to "freshly installed system with no third-party app".
   * This really deletes an 8-16GB user data image, so it needs double confirmation (the UI owns that) and touches only
   * the active AVD (apkstart.avd), never the read-only base image or other AVDs.
   * config.ini / hardware-qemu.ini are kept, so the AVD stays valid and the next tap cold-boots to rebuild data.
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Delete: the user data image (qcow2 delta + backing file), quickboot snapshots, leftover lock files/directories.
          // Keep: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / the various *.ini / *.txt / *.cache - they are the AVD's identity and infrastructure,
          //       and deleting them invalidates the AVD or breaks the next boot. The next tap rebuilds /data as -wipe-data would.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* busy: skip for now and clean next time */ }
        }
      }
      // Once the user data image is deleted, the user-side "installed apps" records must be cleared too,
      // or the desktop/launcher keeps listing apps that no longer exist.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * Wait for the VM to get network.
   *
   * Measured: `sys.boot_completed` only means the system is up; Wi-Fi association + DHCP still take another
   * dozen seconds to a minute to get 10.0.2.16. Apps like Hongguo fetch the home feed immediately,
   * and with no network the page renders as a solid black area (the privacy dialog is local, so it shows fine),
   * so users see "a black screen forever after tapping agree and continue". So wait for the network before launching apps.
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // A freshly restarted VM has a window where even adb is not up; do not give up on the first offline
        // (as before: right after a data reset it returned device-offline and declared the repair failed).
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return { ok: false, reason: 'device-offline' };
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return last;
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Waiting for the Android VM to get network… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return last || { ok: false, reason: 'timeout' };
  }

  /**
   * Repair "the Android VM has no network".
   * In most cases Wi-Fi association simply lags boot completion and a restart plus a wait fixes it;
   * user data need **not** be wiped; "reset Android data" is suggested only after the wait times out.
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * Ensure the VM has network: wait first, then cold-boot once (bypassing a possibly "offline" snapshot) and wait again.
   * This cures "Hongguo goes black after tapping agree": apps must start only once the network is ready.
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // A cold boot is expensive (tens of seconds), so do it once per process: otherwise every tap repeats it
    // and the user experiences "minutes of waiting after a tap".
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('Network still not ready; cold-booting the VM once (without snapshot) and retrying…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // Save a snapshot as soon as the network is good so the next restore brings the NIC state back too
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Repair "the Android VM has no network".
   * Order: cold boot (leaving data alone) -> wait for network -> reset data only if that fails (in-app data is lost).
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Reset data directly: measured as the only reliable way to get this image online.
      // (Cold booting and waiting 3 minutes is a waste - a cold boot on existing user data never joins Wi-Fi.)
      onLog('Repairing VM networking: resetting Android data and rebooting (the app list is kept and apps reinstall when opened)…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Give the previous qemu / netsimd time to exit cleanly, or -wipe-data hits the AVD lock
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'The VM failed to start', boot: false, wiped: true };
      }
      const network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Save the "network is good" state as a snapshot at once, so the next restore brings the NIC state back,
        // or closing and reopening returns to a state with no network.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Network restored (${network.ip || ''} gateway ${network.gateway || 'reachable'}); a working snapshot was saved.`);
      } else {
        onLog('Still no network after the reset. Check whether the host network or firewall blocks the emulator (netsimd uses a local loopback port).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    this.emulator.cancelSnapshotSave();
    // qemu must **never** be force-killed here:
    //  1) it truncates a quickboot snapshot being written, leaving a multi-GB ram.img shell,
    //     which fails to load next boot -> a full cold boot, the direct cause of "two minutes on every open";
    //  2) leaving it lets the next ApkStart adopt it and open apps instantly (same behaviour as WSA / Tencent's PC store).
    // Uninstall takes another path (app:removeSelf explicitly cleans up processes).
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
