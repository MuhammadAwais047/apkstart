'use strict';
/**
 * Window check: start the emulator the way the main process does and confirm no stray windows appear.
 *
 * Two window classes are watched:
 *   1. "Android Emulator - apkstart5554" (QWindowIcon, emulator main window)
 *      - should only exist as our child window after embed, never visible on the desktop;
 *   2. console windows (conhost's ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS)
 *      - qemu and netsimd each open one, titled with the launched exe path.
 *
 * Usage: node tools/check-windows.js [runtimeRoot]
 *   runtimeRoot defaults to engine/ in the repo (locally downloaded runtime); the install dir's
 *   resources/runtime。
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

// Runtime dir: CLI arg > env var > engine/ in the repo
const ROOT = path.resolve(process.argv[2] || process.env.APKSTART_RUNTIME || path.join(__dirname, '..', 'engine'));
const EMU = path.join(ROOT, 'emulator', 'emulator.exe');
// The AVD may live on another drive (runtime.avdDir); common for users, so allow it explicitly
const AVD_HOME = process.env.APKSTART_AVD_HOME
  || path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  console.log('agent ready, port=', agent.port);

  const windows = async () => {
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    return (r && r.list) || [];
  };

  // The agent only touches windows of processes in the runtime dir: declare the scope or it hides nothing
  await agent.scope([ROOT]);
  await agent.bootHide();
  console.log('standing suppression enabled');

  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart', '-no-snapshot-load',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  let leaked = 0;
  const ticks = Math.max(24, Number(process.env.CHECK_SECONDS || 0) * 2 || 24);
  for (let i = 0; i < ticks; i += 1) {
    await sleep(500);
    const list = await windows();
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] unexpected visible window:`, JSON.stringify(hit));
    }
  }

  const probe = await agent.probe().catch(() => null);
  console.log('probe (hidden windows must still be found):', JSON.stringify(probe));

  const left = (await windows()).filter(bad);
  console.log('Unexpected windows still on the desktop at the end:', JSON.stringify(left));

  const okProbe = !!(probe && Number(probe.emu) !== 0);
  // A window may appear briefly and be suppressed within 400ms; the final count must be 0
  const ok = left.length === 0 && okProbe;
  console.log('');
  console.log(`Result: ${ok ? 'PASS' : 'FAIL'} (${leaked} unexpected sightings, ${left.length} remaining at the end)`);

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
