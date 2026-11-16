'use strict';
/**
 * Local persistence: app list + settings
 * Data directory: %APPDATA%\apkstart
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  engine: {
    mode: 'builtin',         // builtin (bundled runtime, default) | attach (connect to an existing runtime, advanced)
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = decided by doctor from machine memory
    cores: 0,                // 0 = auto
    autoMemory: true,        // zero config: derive memory/cores/disk/render flags automatically
    idleShutdownMinutes: 15,
    startVisible: true,
    // A window is mandatory: in headless mode SurfaceFlinger emits no VSYNC, so app processes live but the screen shows nothing.
    // A windowed emulator gives native 60fps with native mouse and keyboard, and ApkStart only dresses it up as an app window.
    headless: false,
    gpuMode: 'auto',         // auto = pick a backend per emulator version and degrade step by step
    // The render backend that last "crashed right after launch" (format `<emulator version>|<gpu>`); in auto mode it ranks last next time,
    // so every boot does not waste 20+ seconds before falling back to software rendering. Invalidated by a runtime upgrade.
    badGpu: '',
    forceTcg: false,         // kept for advanced troubleshooting; doctor already falls back on the normal path
    audio: true,             // Android app sound (notification tones/video). Turning it off saves a little CPU
    // ---- lightweight container (all on by default to save resources; each can be turned off) ----
    liteMode: true,          // cap the vCPU quota so qemu does not saturate physical cores and slow Windows
    // One-word policy: save (frugal) / balanced / smooth (video and games first).
    // The UI exposes only this choice and translates it on save into liteMode / priorityMode / renderSize,
    // while the fine-grained switches remain at the bottom for advanced users.
    resourceMode: 'balanced',
    // Data partition size (GB): apps, game caches and their update packages all live here.
    // 0 = auto (6/8GB depending on free disk). Raising it **grows in place** on the next Android start, losing no installed apps.
    dataPartitionGB: 0,
    // Render resolution: lower is smoother and more power-frugal; auto = 720x1280 / 540x960 by acceleration state
    renderSize: 'auto',
    // Network acceleration: give the emulator a public DNS. Android's default 10.0.2.3 forwards to the host DNS,
    // which under a VPN / corporate network / some carriers takes hundreds of milliseconds and visibly hitches video apps' first screen.
    fastDns: true,
    // Snapshot: a quickboot memory snapshot makes the second start take seconds, at the cost of a ~2-3GB
    // ram.bin on disk. It can be turned off when disk is tight (only start speed is affected, not app data).
    keepSnapshot: true,
    // Log cap (KB): beyond it a backup is rotated in, so long-term use never fills the disk
    logLimitKB: 2048,
    // Mouse bindings: the left button maps natively to "confirm/tap" in the emulator and needs no switch.
    // Right-click back and smooth wheel need a low-level hook, installed only while an app window is in the foreground and removed on blur.
    mouseRightBack: true,    // right button = Android back (intercepts Qt's default "right-click as tap" misfire)
    mouseWheelMode: 'smooth', // smooth = coalesce into one injected swipe | native = leave it to Qt | off = untouched
    mouseSideButtons: false, // side buttons back/forward: off by default; enabling adds one more mapping
    deepTrim: false,         // deep-trim system background packages (Play Store/setup wizard etc.); the system is untouched by default
    // balanced = yield to the foreground | performance = qemu Normal | game = qemu High + low-latency input
  priorityMode: 'balanced',
    // Prewarm: boot the Android environment in the background after ApkStart starts, so the first app tap barely waits.
    // It costs about 1GB of resident memory (the same trade-off as WSA / Tencent's PC store) and can be turned off any time.
    prewarm: true,
  },
  runtime: {
    dir: '',                 // empty = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // manually set the QEMU installer URL
    isoUrl: '',              // manually set the system image URL
    isoPath: '',             // system image (ISO) path
    diskPath: '',            // virtual disk the OS is installed to
    diskSizeGB: 24,
    headless: false,         // hide the VM window (debugging only)
    installMode: 'guided',   // guided (walk the user through a manual install) | auto (experimental automated install)
    emulatorUrl: '',         // manually set the emulator package URL (empty = resolve the latest from the SDK index)
    sysimgUrl: '',           // manually set the system image package URL
    compatImage: false,      // ARM compatibility mode: use the Google Play image (built-in native bridge, installs ARM-only apps)
    deployFailedAt: 0,       // timestamp of the last failed auto-setup (0 = none). No automatic retry for 30 minutes after a failure
    // Slim-edition runtime bundle: downloaded from this project's GitHub Release by default (same source as "software update"),
    // falling back to Google's per-component downloads when unavailable. Can be pointed at a self-hosted mirror here.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // GitHub acceleration mirror prefix (optional). Direct GitHub Releases often run at tens of KB/s from mainland China,
    // so a prefix such as https://ghfast.top/ routes download requests through a mirror.
    // Empty = direct (still tried first with 8 parallel chunks, which saturate bandwidth).
    mirrorPrefix: '',
    // Download concurrency: connections for chunked downloads. 8 by default; 16 helps on weak or throttled links.
    downloadConnections: 8,
    // Update/download source choice. auto = query GitHub and Gitee together and measure every download URL's
    // 128KB speed, using the fastest; a single side can also be forced (useful when a corporate network allows one domain).
    sourcePreference: 'auto',
    // Automatically try public GitHub acceleration mirrors (ghfast / gh-proxy). Off means direct plus custom prefixes only.
    // These are third-party services that only relay public release files and never touch account information.
    autoMirror: true,
    // Gitee's releases API demands an access_token even for public repositories (404 without one),
    // so put a read-only token here to use Gitee as an update source; empty means GitHub + mirrors only.
    giteeToken: '',
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // Start menu shortcut = makes the app findable in Windows Search
  shortcutDir: '',           // empty = desktop
  freeform: false,           // share one runtime window instead of Android freeform small windows
  hideAfterLaunch: false,    // the main process must stay resident, or exiting kills the Android runtime
  notifyOnInstall: true,
  autoStart: true,           // launch at login, on by default with nothing to configure
  autoDeploy: true,          // complete all deployment automatically on first run, no longer in 1-5 steps
  // Startup welcome card: lastDate records the last auto-popup date (at most once a day on a manual open),
  // and disabled = the user ticked "do not pop up automatically".
  welcome: { lastDate: '', disabled: false },
  display: {
    mode: 'window',          // window (portrait, freely resizable) | fullscreen (fit the screen automatically)
    portrait: '900x1600',    // portrait resolution in window mode, resizable in settings
    density: 0,              // 0 = derived from the resolution
    rememberBounds: true,    // remember each app's window position/size
    autoFullscreenOnLaunch: false,
    // Landscape = swap the AVD physical panel to 1280x720 and restart (the only way to get upright + filled).
    // Persisted here, so ApkStart boots in this orientation after a restart.
    landscape: false,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Strip a possible UTF-8 BOM. JSON.parse throws outright on a BOM, so the whole config
    // silently falls back to defaults - users see "all my settings are gone" with no idea why.
    // The file is touched by the settings page, sync tools and even hand edits, so a BOM must be tolerated.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resource policy -> concrete switches.
 *   save     : 2 vCPU + low priority + 540x960, for old laptops / always-on use;
 *   balanced : vCPU at half the physical cores (2-4) + yield to the foreground + 720x1280;
 *   smooth   : unlimited vCPU + foreground-equal priority + 720x1280, video and games first.
 * Resolution stays below 1080p for now: the quickboot snapshot fingerprint binds to it, so a change forces a cold boot, and at 720p
 * a phone-ratio window shows no visible difference while performance drops a tier.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    // Old versions ran headless by default: app processes started but no window appeared, equivalent to "cannot open".
    // Migrate to windowed mode unconditionally, and never allow old config to turn it off again.
    s.engine.headless = false;
    // Old versions killed the whole Android runtime on shell exit, so a desktop icon tap flashed and vanished.
    s.hideAfterLaunch = false;
    // Old versions used Android freeform small windows; now the whole emulator window is the app window,
    // so the app must fill that screen or a window ends up nested inside a window.
    s.freeform = false;
    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // When only the "resource policy" changed, translate it into the three concrete switches so the two configs never disagree
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    return path.join(ICON_DIR, `${pkg}.png`);
  },

  apkPath(pkg, version = 'cur') {
    return path.join(APK_DIR, `${pkg}-${version}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
