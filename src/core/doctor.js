'use strict';
/**
 * Device adaptation / auto-diagnostics (the zero-config foundation)
 *
 * Goal: no parameter tuning required on any machine.
 *  - chooseProfile()  derives launch parameters from RAM, CPU, disk, acceleration state and emulator version;
 *  - planVariants()   returns the step-down retry plan after a failed launch (GPU -> accel -> memory -> cold boot);
 *  - diagnose()       turns emulator stderr into actionable fix suggestions;
 *  - shortPath()      handles non-ASCII / spaced install paths (emulator's QEMU is very sensitive to them).
 *
 * This module is pure functions + read-only probing: no settings writes, no Android launch, easy to unit test.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Host profile (millisecond-level, read-only) */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** Free space on the volume holding a directory (MB); returns 0 when unavailable */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Since emulator 36.4.9 swiftshader_indirect is deprecated and -gpu software is the new name.
 * On 37.x, swiftshader_indirect causes GL init failure / immediate exit (varies a lot by machine).
 * Candidates must therefore be version-selected, each with a fallback.
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  return modern
    // Order is the auto-mode priority:
    // 1) host        - real GPU rendering, lowest CPU, most responsive;
    // 2) swangle     - software rendering with ANGLE on top of SwiftShader; far friendlier
    //                  to Android WebView compositing than raw software/swiftshader (apps that show
    //                  a black screen after Agree fail exactly there), hence second place;
    // 3) software    - pure SwiftShader fallback; compatible but WebView compositing often goes black, last resort;
    // 4) swiftshader - legacy-name fallback.
    // Note safeGpu (TCG fallback with acceleration off) still uses software: slow but most compatible.
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
}

/** Windows 8.3 short path: the emulator cannot find files under non-ASCII usernames / install dirs */
/**
 * Screen spec. landscape=true yields a real landscape panel (1280x720).
 *
 * Why change the panel size instead of runtime wm size: the emulator LCD is a physical panel;
 * Qt sizes the window from it and pastes the frame at the top-left. Runtime wm size only changes Android's
 * logical resolution while the panel stays portrait - the image ends up rotated 90 degrees, occupying a strip
 * with black borders and broken tap coordinates. Only switching hw.lcd.width/height and restarting
 * yields an upright, filled landscape screen.
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* keep the original path when 8.3 names are disabled */ }
  return p;
}

/**
 * Derive zero-config launch parameters.
 * Explicit engine.memoryMB / cores / gpuMode settings act as caps/overrides, but an
 * unset value no longer hard-codes 4 GB/4 cores and wrecks small machines.
 */
/**
 * "Light container" quota: constrain only what hurts host responsiveness most - vCPU count.
 *
 * The old logic gave a 16-core machine 4 cores; qemu's 4 vCPU threads kept physical cores busy,
 * leaving the desktop, mouse and browser to fight over the scraps - "it stutters as soon as it opens".
 * Running one Android app on 2 vCPUs is plenty; extra vCPUs only slow the host.
 *
 * Memory and resolution are deliberately untouched: the cap is already 2-3 GB, and lowering resolution
 * changes the quickboot snapshot fingerprint, forcing a cold boot on every mode switch.
 *
 * Pure function; returns null when settings is null (keeps old callers/tests unchanged).
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // The old logic used floor(cores/4) clamped to 2-3 - an 8-core machine got 2 vCPUs and software video decoding
    // turned into a slideshow. Now: half the physical cores, capped at 4:
    // 8 cores -> 4, 4 cores -> 2; the desktop keeps spare cores and video still works.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3 GB suffices for Android 14 and mainstream apps; more only inflates RAM use and snapshot size
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // "Resource saver" mode: light loads like video/novel reading do not need 3 GB, so cap at 2 GB.
  // Net effect: about 1 GB less resident qemu memory and a 1 GB smaller snapshot (disk sync benefits).
  // Only applied when the user did not set memory manually; manual values always win.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // Lower when physical free memory is short; Android 14 needs at least 2 GB, below that only slow TCG runs
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, 8192);

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) cores = clamp(Number(overrides.cores) || cores, 1, 8);
  // Lite mode only adjusts when cores are unset; manual values always win
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data size: app bodies, game asset packs and their update packs live here; 4 GB fills up fast
  // (shown as "not enough disk space" during in-app updates). Default 6/8 GB based on free disk,
  // and users can also set it directly (growing takes effect in place on next boot, no data loss).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  const autoDataMB = disk && disk < 12288 ? 4096 : 6144;
  const dataMB = wantGB > 0 ? clamp(Math.round(wantGB * 1024), 2048, 65536) : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Render resolution: auto picks by acceleration state (software emulation drops to 540x960 for smoothness)
  // Landscape first: landscape is decided by the physical panel size, so it must go into the AVD and a restart,
  // so orientation comes from settings.display.landscape first, then renderSize is applied.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // If an explicit resolution does not match the orientation, correct it (landscape uses the long edge as width)
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // Pure software emulation does start on Windows, but an Android 14 cold boot can take 5-10 minutes
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Convert user settings from "advanced parameters" into overrides.
 * 0 / auto / unset all mean "no override" and still go through auto derivation;
 * only an explicit memory value with auto disabled takes effect.
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * Unified entry for display / diagnostics: compute the same parameters as a real boot without starting Android.
 * The settings page used to call chooseProfile() without version/accel state, showing the deprecated
 * swiftshader_indirect / software emulation on 37.x machines, mismatching the actual launch.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044 } = {}) {
  return chooseProfile({
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Failure retry matrix: from best to most conservative, at most 4 attempts.
 * Swap GPU backend -> disable hw accel (TCG) -> lower memory and force a cold boot to drop the snapshot.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'hardware acceleration' : 'software emulation'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Software emulation with acceleration off (slow, but most compatible)',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Conservative cold boot (minimum memory + fresh snapshot)',
    // Never wipe here: it used to be wipe:true, and with a full disk every attempt failed, so
    // repeated retries wiped snapshots and data, taking installed apps and saves with them -
    // that is how "disk full, then every app vanished" happened.
    // ensureDataPartition decides when userdata must be rebuilt (only on image corruption),
    // not via -wipe-data in the launch arguments.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Dedupe (identical gpu/accel/wipe combos are not retried) - but the last tier must stay:
  // it is the only "no snapshot load" option and may be identical to the previous tier on small-RAM machines.
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Find a free port pair (emulator console + adb registration ports must be adjacent even/odd) */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * adb server port: fixed, not probed.
 * It used to scan upward from 5044 for a free port, but the adb server is a resident process holding it,
 * so every ApkStart launch added another adb server (6 in one session was observed),
 * and the shifting port broke adoption of the previous emulator on the next launch.
 * 5044 is ApkStart's dedicated port (user adb lives on 5037); use it fixed.
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * Config fingerprint: only image / data partition / engine version changes invalidate the snapshot.
 * GPU, acceleration mode and memory are deliberately excluded - auto-retry flips them often,
 * and including them would trigger -wipe-data on every retry, deleting installed apps.
 */
/**
 * Quickboot snapshot "config fingerprint": only these changes invalidate an old snapshot (black screen / no boot).
 *
 * **dataMB is deliberately excluded**: an enlarged data partition still works with an old snapshot (qemu mounts
 * with the new size); counting it would mean "user only wanted more space, got snapshot invalidation + cold boot +
 * deleted data" - observed once, at the cost of losing every installed app.
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * System image "identity": keep only the part after `system-images/...`.
 *
 * The drive does not matter; moving the same images to another directory must not count as "image changed" -
 * otherwise moving the runtime from C: to D: (which the settings page itself suggests) would
 * leave AVD sysdir pointing at the old path -> "image changed" -> -wipe-data -> all apps lost.
 * This trap is real, so both places (AVD config, snapshot fingerprint) must use identity, not absolute paths.
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // On Windows emulator/qemu exits with 0xC0000005 (decimal 3221225477):
    // observed mostly when the GPU driver / Vulkan backend crashes just as the guest starts;
    // unrelated to CPU, memory or image (on the same machine -gpu software usually gets through).
    // Must precede GPU_INIT: crash logs also mention render init, so detecting the crash first is more accurate.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Render backend crash (0xC0000005 access violation)',
    hint: 'Retried automatically with a more conservative render backend and remembered it for next time.'
      + 'If it keeps happening, update the GPU driver; or lower the quality in Settings → Performance & resources and disable Remote Desktop / GPU passthrough, then retry.',
  },
  {
    code: 'GPU_INIT',
    // Match only failure contexts: normal logs also contain Vulkan/EGL/ANGLE, so do not misjudge them as fatal
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'GPU render backend failed to initialize',
    hint: 'Switched to software rendering and retried. If it still fails, update the GPU driver, or disable Remote Desktop / GPU passthrough and retry.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'The current runtime rejects this GPU mode',
    hint: 'Picked a GPU mode supported by this runtime version and retried (swiftshader_indirect for old versions, software for new ones).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: 'Hardware acceleration unavailable',
    hint: 'Fell back to software emulation automatically (the first boot is noticeably slower). For smooth performance, tick "Virtual Machine Platform" in Windows Features, or install the AEHD driver and reboot.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足/i,
    title: 'Memory allocation failed',
    hint: 'Reduced the memory and core count given to Android automatically. Close memory-hungry programs and retry.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Emulator port is in use',
    hint: 'Switched to a free port automatically. If it keeps happening, exit other emulators (Nox/MuMu/BlueStacks) or restart the PC.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'A lock file was left by the previous run',
    hint: 'Cleared the AVD lock file and restarted automatically.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'System image missing or corrupt / incompatible with old user data',
    hint: 'Rebooted automatically with clean user data. If it still fails, delete the image in "Runtime" and download it again.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: 'Runtime components deleted by antivirus, or VC++ runtime missing',
    hint: 'Add the ApkStart folder to your antivirus whitelist, unpack the package again, and install the Microsoft VC++ 2015-2022 runtime.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足/i,
    title: 'Not enough disk space to start Android',
    hint: 'Move the runtime folder (Settings → System integration → Runtime data folder) to a drive with free space,'
      + 'or turn off "Keep quick-boot snapshot" / shrink the data partition in Settings. Android data is never deleted automatically.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
    title: 'Install path contains non-ASCII or special characters',
    hint: 'Switched to the Windows short path automatically. If it still fails, move ApkStart to an English-only folder (e.g. C:\ApkStart).',
  },
  {
    // After a forced kill the AVD directory keeps hardware-qemu.ini.lock / multiinstance.lock,
    // and the emulator refuses to start with a message easily mistaken for a CPU problem. Must precede CPU rules.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'The previous run did not exit cleanly and left a lock file',
    hint: 'ApkStart clears the leftover lock and retries; if it keeps happening, check whether another emulator is using the same runtime.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'CPU lacks instruction sets required by the runtime',
    hint: 'On some older CPUs this is only a warning and boot still works; if it really fails, update the engine in "Runtime" to an older compatible build, or use a PC with VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Quick-boot snapshot is corrupt',
    hint: 'Discarded the old snapshot and cold-booted automatically; a new snapshot is written on the next clean exit.',
  },
];

/** Translate logs into {code,title,hint} for the UI and retry decisions */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'The runtime did not finish booting',
    hint: 'Retried automatically with several parameter combinations. Click "Export diagnostic report" and send the log to the author.',
  };
}

/** Human-readable one-line summary on the settings page so advanced users see what was auto-picked */
function describeProfile(p) {
  return `Auto: ${(p.memoryMB / 1024).toFixed(1)} GB RAM · ${p.cores} cores · ${p.gpu} render · `
    + `${p.accelOk ? 'hardware acceleration' : 'software emulation'} · ${p.snapshot ? 'on-demand snapshot' : 'cold boot'}`
    + `${p.lite ? ' · lightweight container' : ''} · port ${p.port}`;
}

/** Export a diagnostic report (plain text, easy to email / paste into an issue) */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'ApkStart diagnostic report',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '== Host ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Auto configuration ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Diagnosis ==',
    `${d.code}: ${d.title}`,
    d.hint,
    '',
    '== Extra information ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Runtime log (last 300 lines) ==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * Detect whether the Microsoft VC++ 2015-2022 x64 runtime is installed.
 * The Android emulator (Qt6) and qemu both need it; without it the app will not start on other PCs
 * (reporting 0xc0000135 / missing MSVCP140). The installer bundles vc_redist.x64.exe,
 * so this only detects and feeds a clear prompt plus one-click install before launch.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // Check the DLLs first: msvcp140 / vcruntime140 are the two files Qt6 and qemu actually need.
  // File checks avoid spawning reg.exe (blocked by some security software, and slows the 60s self-check),
  // and do not false-report "not installed" when a cleaner removed the registry key.
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* fall back to the registry */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* missing key = not installed */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
