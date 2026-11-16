'use strict';
/**
 * Portable packaging: produces dist/ApkStart-win64-portable/
 *   ApkStart.exe (renamed electron.exe) + resources/app (this app's source)
 * No installer needed; unzip and run. electron-builder can reuse the same layout later.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Allow an alternate output dir (build elsewhere, then swap, when the target is locked by a running instance)
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', 'ApkStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('Packing portable build →', OUT);
// Never delete the whole tree when the target exists: some environments block bulk deletes, and a failed
// build would lose the last good version. Rename the old dir aside and build fresh; if locked, switch dirs.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('Previous build kept →', backup);
  } catch (_) {
    // Some environments (AV / search indexer / Explorer) hold directory handles for a long time,
    // so renaming the whole dir returns EBUSY; fall back to a versioned dir - equally usable, no collisions.
    OUT = path.join(ROOT, 'dist', `ApkStart-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('Output directory is busy; writing to →', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Electron runtime
console.log('Copying Electron runtime…');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Locale trimming: Electron ships 55 locales (41 MB); this app needs only a few.
//     Keep only zh-CN / zh-TW / en-US and delete the rest (-39 MB, about 15% of the package).
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* a missing locales directory is fine */ }

// 1.2 Files nobody opens: changelogs, debug symbols, unneeded paks (0.1-9 MB each)
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Removable runtime libraries:
//     d3dcompiler_47.dll compiles ANGLE HLSL into GPU instructions, but Windows 8.1+ ships
//     an identically named DLL in System32, and LoadLibrary falls back to it when the bundled one is gone.
//     Removing it renders UI/icons/fonts identically (--smoke screenshots match). Saves 2.1 MB.
//     Note: vk_swiftshader.dll / vulkan-1.dll must stay - without a GPU driver Chromium
//     relies on them and would show a white screen.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* not present anyway */ }
}

// 2. Application itself
console.log('Copying app…');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 3. Optional directories
// Only documentation under engine/ ships; the large runtime parts (emulator, system-images,
// platform-tools, avd) download from official sources on first launch and stay out of the package.
// tools/ holds dev-time self-check scripts (black-window checks, speed tests) and no longer ships.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

// 4. Rename the main executable
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'ApkStart.exe'));

// 5. Version info
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'VERSION.txt'), `ApkStart ${pkg.version}\nBuild time: ${new Date().toLocaleString('en-US')}\n`);

// 6. Size report: printed on every build so the package cannot silently grow
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `Done. ${totalMB.toFixed(0)} MB total (locales saved ${(localeSaved / 1048576).toFixed(0)} MB, `
  + `redundant runtime libraries saved ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('Compress: node build/zip.js dist/ApkStart-win64-portable <output.zip>');
console.log(`Run ${path.join(OUT, 'ApkStart.exe')} to start.`);
