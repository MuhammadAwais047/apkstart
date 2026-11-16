'use strict';
/**
 * Install / launch / uninstall orchestration layer
 * Chains "parse APK -> install into runtime -> persist local metadata -> create desktop shortcut" into one pipeline.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** APK contains only ARM native libs (true for most Chinese-market apps) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Split packages (.apks / .xapk): extract the split APKs into a pure-ASCII temp directory.
 * File-based ZIP reader + streaming writes: split packages reach 2 GB+, loading them fully fails.
 * Returns { meta, files, cleanup }; meta comes from the base APK carrying AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('No APK splits found in this package (it may not be .apks/.xapk)');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // A single split can be hundreds of MB: extract as a stream, never through a Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* this split has no manifest */ }
    }
    if (!meta) throw new Error('Failed to parse the base APK of the split package');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}.lnk`);
  }

  /**
   * Two copies: Desktop + Start Menu.
   * Windows Search indexes .lnk files under "Start Menu \ Programs"; a desktop-only shortcut is not searchable,
   * and desktops are often redirected to OneDrive, so the Start Menu copy guarantees an entry point.
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // Use a dedicated subdirectory: still indexed by Windows Search, and no clash with a third-party app
      // (observed: the drama app name was already occupied in Start Menu by another desktop helper)
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}.lnk`));
    }
    return [...new Set(out)];
  }

  /** Compatible image downloads on first ARM app, used as a shared read-only base layer, fetched once */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'First ARM app: downloading the compatibility image (~1.5 GB, once)…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Compatibility image download failed; check your network and retry');
    return true;
  }

  /** Switching images requires restarting the runtime; installed apps are then restored from local APK backups */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Switching to the compatibility image and restarting the runtime…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Wait for the old device to disappear from adb so ensure() does not reuse it
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'The runtime is unavailable after switching the compatibility image');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Restoring installed app ${app.label}…` });
      } catch (_) { /* one app failing to restore does not block */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Parsing APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Recognized ${meta.label} (${meta.package})`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    try {
      // Zero-config: ARM-only apps automatically pull an image with ARM translation; no toggle required
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Preparing the Android runtime…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Runtime unavailable');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Install + persist metadata + shortcut; on failure, retry once after auto-repair */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // After install the old quickboot snapshot's disk state is stale; keeping it makes installed apps vanish after restart
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Updating the app…' : 'Installing the app…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // Still getting ABI mismatch here: the runtime is an AOSP image; switch to the compatible image and retry
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Switched the compatibility image; reinstalling…' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Persist the icon. Many APK icons are WebP which nativeImage cannot decode, so the renderer decodes it +
    // a brand placeholder as fallback, guaranteeing the .lnk always has an icon (icoPath was always null before).
    // iconFallback records "real icon failed, placeholder used" - surfaced as a soft warning to the user,
    // otherwise a plain green triangle on the desktop looks like ApkStart picked the wrong icon.
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* icon failure does not block the install */ }
    }

    // Back up the APK for reinstall / recovery
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // Trust the system's resolved launch intent: the "main Activity" parsed from the APK is often not
    // the real LAUNCHER entry; launching with it skips the app's init pages and crashes.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* keep the APK-parsed result */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Creating the desktop shortcut…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Failed to create shortcut: ${e.message}` });
      }
    }

    // Compatibility note: with ARM-only native libs an x86 runtime needs a translation layer
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`This app requires Android ${meta.minSdk}+, newer than the current runtime; it may not run correctly.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('The app icon could not be parsed (unusual adaptive icon); the shortcut uses a placeholder for now.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('The app icon (WebP) failed to decode; the shortcut uses a placeholder for now.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // The install invalidated the old snapshot, so schedule one: persist the "new app installed" state when idle,
    // otherwise the next launch pays a 20+ second cold boot.
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} installed`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      description: `${app.label} — run by ApkStart`,
      cwd: this.ctx.cwd,
      // One AUMID per app: taskbar groups by app instead of piling everything under ApkStart
      appUserModelId: `RoutineMiku.ApkStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // Primary paths all failed (custom shortcut dir not writable / blocked by security software):
    // fall back to the Desktop once more - a desktop icon is how users find the app.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}.lnk`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'Failed to create shortcut');
    // Also persist the Start Menu path so uninstall removes both
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** Backfill missing shortcuts and icons: older versions only made the desktop copy and WebP icons failed */
  async ensureShortcuts() {
    const made = [];
    // If the user explicitly disabled "create automatically after install" and this app has no entry point,
    // do not backfill, otherwise the switch has no effect at startup.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* icon backfill failure does not affect the entry */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // When an icon was just backfilled, rebuild even if the .lnk exists so it picks up the real icon
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* one failure does not block startup */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {} } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime unavailable');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // Set resolution before launching the app so wm size does not trigger a config change that recreates it
    if (beforeStart) await beforeStart(rt).catch((e) => onLog(`Display fit skipped: ${e.message}`));
    // Clear wm size / density overrides and auto-rotate settings older versions may have left in /data.
    // These overrides persist; without cleanup every launch shows the image rotated 90 degrees, letterboxed,
    // and clicks miss their target (user reports: "rotated / black bars / cannot tap Agree").
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // Cold start also runs a network check: state clearly when offline, otherwise users only see "this app is always black",
    // never suspecting the VM has no network (a page that cannot fetch data renders black).
    // Key fix: Wi-Fi association often lags sys.boot_completed by tens of seconds, and the app fetches its home page immediately,
    // so the home page renders fully black - the real cause of "black screen after tapping Agree and continue".
    // So wait for network readiness before launching (max 90s); a few seconds of waiting beats a black screen.
    // Check the network before launching: **wait only, never restart**.
    // This used to call ensureNetwork(), which on a slow network did "stop VM -> cold boot",
    // so the adb device vanished mid-install and the app simply would not open.
    // The launch path must never take destructive action; if the wait times out, launch anyway - a slow page is acceptable.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      const net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`VM network ready (${net.ip || ''})`);
      } else {
        onLog('VM network is not ready yet; starting the app anyway (online pages may load later)');
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // The app may not be installed in the current runtime (image rebuilt / data cleared / first run); launching reports
    // "Invalid packageName". Install from the local cache first so "open app" always works,
    // without a manual reinstall - exactly the "tap an installed app to enter the system" experience.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      const pkgs = await rt.client.shell(`pm list packages ${pkg}`, { timeout: 8000 }).catch(() => '');
      if (!new RegExp(`package:${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(pkgs)) {
        onLog('The app is not installed yet; installing it automatically…');
        await rt.client.install(app.apkPath).catch((e) => onLog(`Automatic install failed: ${e.message}`));
      }
    }
    // Observe for 25s, requiring "alive for 5s straight" to count as a successful launch.
    // Key: "not up yet" and "came up then died" must be distinguished. An empty pidof used to mean failure,
    // so large apps (10+ seconds on first launch) were force-stopped mid-load and restarted,
    // taking three rounds to come up - perceived as "it takes a minute after tapping".
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // Check before sleeping: a warm start in a persistent container usually shows up within 1s,
        // so sleeping 1s first would slow the fastest path by a full second.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // came up then vanished = really crashed
        } else {
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // only never seeing the process counts as failure
    };
    try {
      // Ensure runtime permissions first: the -g granted at install may be lost after clearing data,
      // and missing permissions leave the app behind a system grant dialog - "tap does nothing / will not open".
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // A grant dialog on top makes the app look broken; grant first, then dismiss the dialog
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Only hand a clear crash log to the caller (may switch images); without evidence it is just slow, retry
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // Lock the orientation right after the Activity appears. Done here because app startup itself triggers
        // config changes (Activity recreation), and a pre-launch user-rotation may be reset to 0,
        // which on a landscape panel shows the image lying on its side (perceived as "will not rotate straight").
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`The app exited after launch (attempt ${attempt}); retrying automatically…`);
      }
      if (!ok) {
        // Last resort: an abnormal exit leaves half-initialized data that crashes on every later start.
        // Clearing app data once then relaunching has the highest success rate (no manual cache clearing).
        onLog('The app keeps exiting; resetting its data and retrying…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear also drops runtime permissions; re-grant them or the app stalls on the system dialog
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('The app exits right after launch; retried automatically and reset app data, still unsuccessful');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // Crash came from the ARM translation layer: switch images, reinstall the backup APK, launch again
        onLog('ARM translation layer crash detected; switching the compatibility image automatically…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* keep the original package */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
