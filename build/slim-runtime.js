'use strict';
/**
 * Runtime slimming: delete emulator files our launch method never loads.
 *
 * The rules follow emulator.js's fixed launch flags:
 *   - x86_64 images only (API30 AOSP)    -> qemu-system-aarch64.exe is unused
 *   - -gpu software (SwiftShader)        -> the vulkan / gles_angle backends are unused
 *   - only a 38px title bar remains       -> the emulator UI's locales and WebEngine panels are unused
 *
 * Network pieces netsimd / netsim / nimble_bridge must stay:
 * they carry Wi-Fi / Bluetooth traffic; without them apps have no network - the floor for "it works".
 *
 * Usage:
 *   node build/slim-runtime.js build/runtime          # safe mode (default)
 *   node build/slim-runtime.js build/runtime --aggressive   # also drop QtWebEngine (-169 MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Safe mode: delete what is genuinely never loaded (~-190 MB).
 * Measured, rollback-verified boundaries (important - do not extend blindly):
 *   - Qt6WebEngineCoreAndroidEmu.dll is a hard (static-import) dependency of emulator.exe; deleting it breaks startup -> keep
 *   - lib64/gles_angle provides vk_swiftshader, needed by SwiftShader rendering -> keep
 *   - deleting lib64/vulkan only falls back to software rendering (boots and renders fine, measured) -> drop, saves 103 MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'arm64 QEMU binary (only x86_64 images are shipped)'],
  // Note: do not delete the whole emulator/lib64/vulkan dir - vulkan-1.dll is the -gpu host loader;
  // without it host fails outright and only software rendering remains (required on an AMD 780M, measured).
  ['emulator/lib64/vulkan/layers', 'Vulkan validation layers (unused with host rendering, -20MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'Shader validation tool (not needed at runtime, -7MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'lavapipe software Vulkan fallback (unused when a system GPU driver exists, -53MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'lavapipe ICD descriptor (-1KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (an identical copy lives in gles_angle, -23MB)'],
  ['emulator/lib64/qt/translations', 'Emulator UI translations (only a 38px title bar remains)'],
  // Note: do not delete emulator-check.exe - emulator -accel-check uses it to detect AEHD/WHPX;
  // without it "no hardware acceleration" forces TCG (boot went from 42s to 10+ minutes, measured).
  ['emulator/qsn.exe', 'QEMU snapshot notification helper (no references from emulator.exe, verified with strings, -34MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'VR panorama environment texture (not needed, -3.7MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR panorama decoration texture (-3.5MB)'],
  ['emulator/resources/Toren1BD.obj', 'VR panorama 3D model (-3.5MB)'],
  ['emulator/resources/macroPreviews', 'Macro preview images (-2.7MB)'],
  ['emulator/resources/default360.mp4', 'Default 360° panorama video (-2.4MB)'],
];

/** Aggressive mode is currently empty: WebEngine is a hard dependency and gles_angle backs software rendering */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* ignore */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} is not a runtime directory (missing emulator/emulator.exe)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  Skipping ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  Removed ${rel} (${(n / 1048576).toFixed(0)} MB) — ${why}`);
  }
  log(`${dryRun ? 'Reclaimable' : 'Freed'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Slim target: ${root} (${aggressive ? 'aggressive' : 'safe'} mode)`);
  slim(root, { aggressive, dryRun });
}
