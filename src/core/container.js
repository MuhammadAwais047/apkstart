'use strict';
/**
 * App-level container (pure computation layer)
 *
 * ApkStart is built on a full-system QEMU VM, so it cannot "load only the services a given App
 * needs" the way WSA / Zhuoyitong do - the Linux kernel, zygote and system_server must all come up.
 * But the "heaviness" users actually feel does not come from those resident services; it comes from:
 *   1. Booting a whole Android for every App launch (40-142 s cold boot, CPU and disk saturated);
 *   2. Previously opened Apps all stay in the background eating memory, using the network and holding wake locks;
 *   3. With no App in the foreground, qemu still competes with the desktop for CPU at Normal priority;
 *   4. File sync and notification polling keep running with no App open at all.
 *
 * This file turns the parts that can genuinely be cut into composable, unit-testable commands:
 *   - the environment boots once; "open App" then means am start + attach the window (handled by Runtime.beginApp);
 *   - launching a new App stops other user Apps' processes, keeping only what the current one needs;
 *   - closing the last App puts Android into idle, clears background processes and lowers qemu priority;
 *   - system packages are never touched by default (stopping GMS makes Apps that rely on push/login fail repeatedly),
 *     and only an explicitly enabled "deep trim" disables a small set of clearly useless background packages.
 *
 * This file depends on neither adb nor Electron; everything is pure functions, which keeps regression testing easy.
 */

/** Never trim: touching them leads straight to a black screen or app crashes */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Disabled only by "deep trim": these packages only do background updates/wallpapers/printing, and stopping them does not affect opening Apps */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play Store (background update scan)
  'com.google.android.setupwizard',         // first-run setup wizard
  'com.android.printspooler',               // print service
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // screensaver
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** Clearly system/framework packages: skipped by session trimming to avoid false kills */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Only valid Android package names may be concatenated into shell commands, preventing injection if the list is tainted */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Trim commands to run when launching an App.
 * @param {object} o
 * @param {string} o.pkg            package about to be opened
 * @param {string[]} o.installed    user App packages installed on this machine (the list in the store)
 * @param {boolean} o.deep          deep trim (disable system background packages), default false
 * @param {boolean} o.killBackground also clear background cached processes, default false
 *   (clearing during launch may hit an App that just came to the foreground; clearing is the job of endApp's park command)
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Clear system-cached background processes (not the foreground, not persistent services),
  // so "keep only the current App" really returns memory instead of just force-stopping package names.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // On metered networks disable background data so the store/sync cannot keep waking the device
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * After the last App closes, let the container "idle without eating resources".
 * No shutdown, no AVD destruction: the next launch is still instant; CPU and memory are just handed back to Windows first.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Recover from deep trim (called when the user turns the switch off, so it can always be undone) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Session state machine: decide what state the container should be in after a launch/close.
 * Pure functions, which makes "switching between windows" and "closing the last window" easy to verify.
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** One-line summary for logs/diagnostics */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Container idle (Android resident but deprioritized, 0 app processes)';
  return `Container active: ${n} app window${n === 1 ? '' : 's'}${plan && plan.stopped && plan.stopped.length
    ? `, stopped ${plan.stopped.length} background app${plan.stopped.length === 1 ? '' : 's'}` : ''}`;
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
};
