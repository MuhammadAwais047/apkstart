'use strict';
/**
 * Turn engine/ into a distributable runtime: build/runtime/
 *
 * The key step is compressing system.img. AOSP's system.img is a 3.1 GB sparse image,
 * mostly zeros, shrinking to ~580 MB with gzip. This dominates the single-file release size.
 * With the emulator (~340 MB after trimming) + Electron + platform-tools the package lands at 1.0-1.1 GB.
 * Uncompressed it would be over 1.4 GB.
 * The cost is a 1-2 minute one-time expansion into the user profile on first launch,
 * implemented by materializeImages() in src/core/provision.js.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Bundled initial /data template (formatted ext4, xz-compressed). See the userdata.img notes below.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Large images use XZ (LZMA2): about 25% smaller than gzip -6 (system.img 1.5 GB -> ~1.1 GB).
 *  Default preset 9e; on dual-core CI set XZ_PRESET=6 to cut time to 1/3 (+3% size).
 *
 *  Implementation notes (lessons learned):
 *   - Use python's lzma (single-threaded, stable). @napi-rs/lzma createCompressStream hangs
 *     at 0 bytes in some environments (18 minutes, no output) - last resort only, with a timeout.
 *   - [the real cause of a 3-hour CI hang] the source must be piped to the child's stdin and closed.
 *     On the python side `shutil.copyfileobj(sys.stdin.buffer, z)` waits for input forever without EOF,
 *     writes nothing to stdout and never exits. Only p.stdout was wired then, and locally an existing .xz
 *     hid it via "skip duplicate compression"; a fresh CI directory always hit it.
 *   - Add a watchdog: any compressor mishap is killed and falls back to gzip; packaging never hangs.
 *   - No python / compression failure -> gzip -9 (slightly larger but never hangs);
 *     materializeImages picks the decompressor by extension and accepts either artifact.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Default 2 hours (3 GB / 2 cores / preset 6 measured ~40 min); on timeout kill and fall back to gzip.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Attach listeners first so a child that exits before our await does not lose the close event.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  (xz compression exceeded ${Math.round(timeoutMs / 60000)} minutes; aborting and switching to gzip -9)`);
      try { p.kill(); } catch (_) { /* already exited */ }
    }, timeoutMs);

    let ok = false;
    try {
      // Key: stdin is the compressor input. pipeline ends p.stdin after reading src,
      // so python gets EOF, flushes the XZ tail block and exits normally.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // Any pipeline error (EPIPE / write failure) kills the child immediately; do not wait for the watchdog.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // A half-written .xz would pollute the output; delete it before falling back.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  (${py} compression failed; switching to gzip -9)`);
  } else {
    console.log('  (python not found; switching to gzip -9 (slightly larger but reliable))');
  }
  // Fallback: gzip -9 (not xz; materializeImages selects by extension at runtime)
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime is up to date (use --force to rebuild)');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('engine/ directory is missing; cannot prepare the runtime');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy emulator / platform-tools (excluding historical artifacts)
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`Copying ${dir}…`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Trim: delete files our fixed launch flags never load (~-400 MB)
  if (!process.argv.includes('--no-slim')) {
    console.log('Slimming the runtime…');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. System images: large ones become .xz (streamed by materializeImages); the rest ship as-is
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt is the GMS license text (~20 MB) and is not needed at runtime
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // userdata.img uses the bundled ext4 template (seed):
            // the official one is 1 MB of zeros, and e2fsck always returns code=8 when the emulator grows it,
            // leaving a 1 MB partition -> guest invalid magic -> read-only /data -> a fresh install never boots.
            // The template is generated once at build time (mke2fs), then travels with the code; CI needs no toolchain.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('userdata.img uses the bundled ext4 template (build/seed)');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // Compress large images once; originals stay out; skip when a sane compressed artifact exists
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // The gzip fallback produces .gz which must also count, or every rebuild re-compresses 3 GB.
              // Threshold is >1 MB rather than a ratio: vendor.img.gz is only ~21 MB and userdata.img is nearly all zeros;
              // a large fixed threshold or a ratio test would misjudge these valid artifacts and re-compress.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`Skipping ${f} (already have ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB)`);
                compressed += 1;
                continue;
              }
              console.log(`Compressing ${f} (${(sizeOf(src) / 1073741824).toFixed(2)} GB) → XZ 9e (slow, one-time)…`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`Done: build/runtime (${(total / 1073741824).toFixed(2)} GB, ${gzCount} large images compressed)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Exposed for regression tests (does not run main's full preparation flow)
module.exports = { xzFile, gzipFile, findPython };
