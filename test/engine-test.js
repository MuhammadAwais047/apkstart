'use strict';
/**
 * Engine and boot-path tests (no real QEMU / adb / Android required)
 * Covers: downloader (incl. resume), ZIP extraction, env checks, QEMU args, monitor protocol
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// Isolate test data dirs so real user config is never touched
const TMP = path.join(os.tmpdir(), `apkstart-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  console.log('\n[download.js]');
  const { download, downloadParallel, head, sha256File } = require('../src/core/download');

  // Local HTTP server simulates a download source (with Range resume)
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': payload.length - start,
        });
        return res.end(payload.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': payload.length });
      return res.end(payload);
    }
    // Fully supports start-end Range (for the parallel-chunk test)
    if (req.url === '/ranged.bin') {
      server.rangeHits = (server.rangeHits || 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        return res.end(payload);
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
      });
      return res.end(payload.subarray(start, end + 1));
    }
    // Explicitly does not support Range
    if (req.url === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'none' });
      return res.end(payload);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/big.bin' });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('full download + follow redirects', async () => {
    const dest = path.join(TMP, 'dl1.bin');
    await download(`http://127.0.0.1:${port}/redirect`, dest);
    assert(fs.statSync(dest).size === payload.length, 'size mismatch');
  });

  await test('resume (partial file already present)', async () => {
    const dest = path.join(TMP, 'dl2.bin');
    fs.writeFileSync(dest, payload.subarray(0, 100000));
    let lastPercent = 0;
    await download(`http://127.0.0.1:${port}/big.bin`, dest, {
      onProgress: (p) => { lastPercent = p.percent; },
    });
    assert(fs.statSync(dest).size === payload.length, `size after resume ${fs.statSync(dest).size}`);
    assert(fs.readFileSync(dest).equals(payload), 'resumed content mismatch');
    assert(lastPercent > 50, 'progress never reported');
  });

  await test('HEAD probe + SHA256', async () => {
    const h = await head(`http://127.0.0.1:${port}/big.bin`);
    assert(h.size === payload.length, 'HEAD size mismatch');
    const sum = await sha256File(path.join(TMP, 'dl1.bin'));
    assert(/^[0-9a-f]{64}$/.test(sum), 'malformed sha256');
  });

  await test('failed SHA256 verification cleans up the file', async () => {
    const dest = path.join(TMP, 'dl3.bin');
    let threw = false;
    try {
      await download(`http://127.0.0.1:${port}/big.bin`, dest, { expectSha256: 'deadbeef'.repeat(8) });
    } catch (_) { threw = true; }
    assert(threw, 'should throw');
    assert(!fs.existsSync(dest), 'a failed check should delete the file');
  });

  await test('parallel chunked download: concatenated content matches', async () => {
    const dest = path.join(TMP, 'dl4.bin');
    server.rangeHits = 0;
    let maxPercent = 0;
    const r = await downloadParallel(`http://127.0.0.1:${port}/ranged.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
      onProgress: (p) => { maxPercent = Math.max(maxPercent, p.percent); },
    });
    assert(fs.readFileSync(dest).equals(payload), 'content mismatch after joining chunks');
    assert(r.parallel > 1, `parallel not enabled: ${r.parallel}`);
    assert(server.rangeHits >= r.parallel, `too few ranged requests: ${server.rangeHits}`);
    assert(maxPercent > 0, 'progress never reported');
  });

  await test('falls back to a single stream when Range is unsupported', async () => {
    const dest = path.join(TMP, 'dl5.bin');
    const r = await downloadParallel(`http://127.0.0.1:${port}/norange.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
    });
    assert(fs.readFileSync(dest).equals(payload), 'content mismatch after fallback');
    assert(!r.parallel, 'must not use parallel');
  });

  server.close();

  console.log('\n[provision.js]');
  const { Provisioner } = require('../src/core/provision');
  const store = require('../src/core/store');

  await test('default runtime dir lives under the data dir', async () => {
    const p = new Provisioner('C:/fake/app');
    assert(p.paths().root.startsWith(store.DATA_DIR), `bad path: ${p.paths().root}`);
    assert(p.paths().qemuExe.endsWith('qemu-system-x86_64.exe'), 'bad qemu path');
    assert(p.paths().adbExe.endsWith('adb.exe'), 'bad adb path');
  });

  await test('empty-env check: adb not ready, component shape intact', async () => {
    const p = new Provisioner(path.join(TMP, 'nonexistent'));
    const env = await p.checkEnv();
    assert(env.adb.ok === false, 'adb must not be ready');
    // QEMU may already be installed system-wide (e.g. winget to Program Files); it should be found
    if (env.qemu.ok) assert(env.qemu.version, 'a ready qemu must report a version');
    assert(env.ready === false, 'must not be ready');
    assert(typeof env.hypervisor.whpx === 'boolean', 'missing hypervisor info');
  });

  await test('built-in ZIP extraction works', async () => {
    const { ZipArchive } = require('../src/core/zip');
    // Build a minimal stored-mode zip
    const name = Buffer.from('platform-tools/adb.exe');
    const data = Buffer.from('fake-adb-binary');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 14);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt32LE(data.length, 20);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zipPath = path.join(TMP, 'pt.zip');
    fs.writeFileSync(zipPath, Buffer.concat([loc, name, data, cen, name, eocd]));

    const out = path.join(TMP, 'unzip');
    const p = new Provisioner(TMP);
    await p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', 'extracted content mismatch');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'zip read failed');
  });

  await test('relative urls in SDK indexes are expanded to absolute', async () => {
    const { absUrl, baseOf, SOURCES } = require('../src/core/provision');
    // repository2-3.xml (emulator) is relative to the repo root
    assert(absUrl('emulator-windows_x64-16847572.zip') === `${baseOf(SOURCES.sdkIndex)}emulator-windows_x64-16847572.zip`,
      'emulator relative path not expanded');
    // sys-img indexes are relative to sys-img/android/, not the repo root
    const sysBase = baseOf(SOURCES.sysImgIndexes[0]);
    assert(sysBase.endsWith('/sys-img/android/'), `bad sys-img base dir: ${sysBase}`);
    assert(absUrl('x86_64-30_r11.zip', sysBase) === 'https://dl.google.com/android/repository/sys-img/android/x86_64-30_r11.zip',
      'sys-img relative path expanded wrongly');
    // Absolute urls are returned untouched
    assert(absUrl('https://example.com/a.zip') === 'https://example.com/a.zip', 'absolute url was rewritten');
  });

  await test('resolved emulator / system-image urls are downloadable absolute URLs', async () => {
    const p = new Provisioner(TMP);
    const emuUrl = await p.resolveEmulatorUrl();
    const imgUrl = await p.resolveSysimgUrl();
    for (const u of [emuUrl, imgUrl]) {
      assert(/^https?:\/\//i.test(u), `not an absolute URL: ${u}`);
      assert(/\.zip$/i.test(u), `not a zip: ${u}`);
    }
    assert(/windows_x64/i.test(emuUrl), `wrong emulator platform: ${emuUrl}`);
  });

  await test('AVD config uses 64-bit arch (x86_64 must not be truncated to x86)', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(TMP);
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2 });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg), `hw.cpu.arch should be x86_64, got: ${cfg.match(/^hw\.cpu\.arch=.*$/m)}`);
    assert(/^abi\.type=x86_64$/m.test(cfg), 'abi.type should be x86_64');
    assert(/^image\.sysdir\.1=\S*system-images\//m.test(cfg), 'image.sysdir.1 missing');
  });

  await test('install-failure translation: NO_MATCHING_ABIS yields actionable guidance', async () => {
    const { friendlyInstallError } = require('../src/core/adb');
    const out = friendlyInstallError(
      'Performing Streamed Install\nadb.exe: failed to install x.apk: '
      + 'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    );
    assert(out.includes('ARM native libraries'), `should explain the ARM native-library issue: ${out}`);
    assert(out.includes('INSTALL_FAILED_NO_MATCHING_ABIS'), 'the original error code must be kept');
    const other = friendlyInstallError('Failure [INSTALL_FAILED_INVALID_APK: x]');
    assert(other.includes('corrupt') || other.includes('incomplete'), `unknown errors should still be readable: ${other}`);
  });

  await test('image validation: distinguishes valid ISO9660 / corrupt / incomplete', async () => {
    const p = new Provisioner(TMP);
    const mk = (file, size, writeMagic) => {
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, size);
      if (writeMagic) {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 0x8000);
        fs.writeSync(fd, Buffer.from('CD001', 'latin1'), 0, 5, 0x8001);
      }
      fs.closeSync(fd);
      return file;
    };

    const good = mk(path.join(TMP, 'good.iso'), 450 * 1024 * 1024, true);
    const a = p.inspectIso(good);
    assert(a.ok && a.iso9660, `valid ISO rejected: ${a.reason}`);

    const broken = mk(path.join(TMP, 'broken.iso'), 450 * 1024 * 1024, false);
    const b = p.inspectIso(broken);
    assert(!b.ok && /ISO9660/.test(b.reason), `corrupt image not blocked: ${JSON.stringify(b)}`);

    const partial = mk(path.join(TMP, 'partial.iso'), 2 * 1024 * 1024, true);
    const c = p.inspectIso(partial);
    assert(!c.ok && /did not finish/.test(c.reason), `incomplete image not blocked: ${JSON.stringify(c)}`);

    for (const f of [good, broken, partial]) fs.rmSync(f, { force: true });
  });

  await test('remote stat list parsing (real mtime, prevents endless re-upload)', async () => {
    const { parseStatList } = require('../src/core/adb');
    const rows = parseStatList('1794309868|1234|./a.txt\n1794309900|99|./sub/b.png');
    assert(rows && rows.length === 2, `bad row count: ${JSON.stringify(rows)}`);
    assert(rows[0].rel === 'a.txt' && rows[0].size === 1234, 'first row fields wrong');
    assert(rows[1].rel === 'sub/b.png', 'subdirectory relative path wrong');
    assert(rows[1].mtime === 1794309900000, 'mtime not converted to milliseconds');
    assert(parseStatList('ls: /nope: No such file') === null, 'non-stat output should return null so callers can fall back');
    assert(Array.isArray(parseStatList('')) && parseStatList('').length === 0, 'an empty dir should return an empty array');
  });

  console.log('\n[engine.js]');
  const { Runtime } = require('../src/core/engine');

  await test('QEMU args: install mode mounts the ISO and boots from CD', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: true };
    store.saveSettings({
      runtime: { isoPath: 'C:/img/android.iso', diskPath: 'C:/img/disk.qcow2' },
      engine: { memoryMB: 4096, cores: 4 },
    });
    const args = rt.buildArgs({ install: true }).join(' ');
    assert(args.includes('-cdrom C:/img/android.iso'), 'missing -cdrom');
    assert(/order=d/.test(args), 'should boot from CD');
    assert(/accel=whpx/.test(args), 'should use WHPX');
    assert(/-cpu host/.test(args), 'WHPX should use the host CPU');
    assert(/hostfwd=tcp:127\.0\.0\.1:5555-:5555/.test(args), 'missing adb port forwarding');
    assert(args.includes('-monitor tcp:127.0.0.1:5556'), 'missing monitor');
    assert(/-m 4096/.test(args), 'wrong memory size');
  });

  await test('QEMU args: normal boot starts from disk', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false }).join(' ');
    assert(!args.includes('-cdrom'), 'ISO must not be mounted');
    assert(/order=c/.test(args), 'should boot from disk');
    assert(/accel=tcg/.test(args), 'falls back to TCG without WHPX');
    assert(/-cpu max/.test(args), 'TCG should use max CPU');
    assert(args.includes('if=virtio,format=qcow2'), 'wrong disk args');
  });

  await test('headless mode hides the VM window', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ headless: true }).join(' ');
    assert(args.includes('-display none'), 'should have no window');
  });

  await test('QEMU monitor protocol: handshake and send a command', async () => {
    // Fake QEMU monitor: reply "(qemu) " on connect, "ok" after a command
    const srv = net.createServer((sock) => {
      sock.write('QEMU 8.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
      sock.on('data', (d) => {
        srv.lastCmd = d.toString().trim();
        sock.write('ok\r\n(qemu) ');
      });
    });
    await new Promise((r) => srv.listen(5556, '127.0.0.1', r));

    const rt = new Runtime(TMP);
    await rt.monitorCmd('system_powerdown');
    assert(srv.lastCmd === 'system_powerdown', `got: ${srv.lastCmd}`);
    await new Promise((r) => srv.close(r));
  });

  await test('ensure returns needsSetup when no system image is installed', async () => {
    store.saveSettings({ runtime: { installed: false }, engine: { mode: 'builtin' } });
    const rt = new Runtime(TMP);
    // A fake adb makes isOnline fail fast
    const r = await rt.ensure({ onLog: () => {} });
    assert(r.ok === false, 'must not be ready');
    assert(['provision', 'install'].includes(r.needsSetup), `needsSetup=${r.needsSetup}`);
  });

  await test('prewarm and click race starts the runtime once (idempotent, one VM)', async () => {
    const rt = new Runtime(TMP);
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.emulator.setPriority = async () => 0;
    let calls = 0;
    rt._ensureInner = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, engine: 'emulator' };
    };
    // Prewarm (auto-runs 4s after start) and the user clicking an app (ensure) collide
    const [a, b] = await Promise.all([rt.prewarm({}), rt.ensure({})]);
    assert(calls === 1, `boot triggered ${calls} times; only one emulator should start`);
    assert(a && a.ok && b && b.ok, 'both paths should get a ready result');
  });

  await test('readiness gate: must wait for boot_completed + package manager', async () => {
    const rt = new Runtime(TMP);
    const calls = [];
    const fake = {
      isOnline: async () => true,
      connect: async () => true,
      shell: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('sys.boot_completed')) return '1';
        if (cmd.includes('pm path android')) return 'package:/system/framework/framework-res.apk';
        return '';
      },
    };
    const r = await rt.waitAndroidReady(fake, 5000, () => {});
    assert(r.ok, 'should be reported ready');
    assert(calls.some((c) => c.includes('sys.boot_completed')), 'boot_completed was not checked');
    assert(calls.some((c) => c.includes('pm path android')), 'package manager was not checked');
  });

  await test('reports the stage (kernel) while the system is still booting', async () => {
    const rt = new Runtime(TMP);
    const fake = { isOnline: async () => true, connect: async () => true, shell: async () => '0' };
    const r = await rt.waitAndroidReady(fake, 1200, () => {});
    assert(!r.ok && r.stage === 'kernel', `should stop at the kernel stage: ${JSON.stringify(r)}`);
  });

  console.log('\n[provision.js play image / full build]');

  await test('playImageInfo validates API 34 play-image completeness', async () => {
    const dir = path.join(TMP, 'apkstart', 'runtime', 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    const prov = new Provisioner(path.join(__dirname, '..'));
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(64));
    assert(!prov.playImageInfo().ok, 'an undersized image must not be reported ready');
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(301 * 1024 * 1024));
    const info = prov.playImageInfo();
    assert(info.ok && info.api === '34' && info.tag === 'google_apis_playstore', `API 34 play image should be ready: ${JSON.stringify(info)}`);
  });

  await test('full build ships Douyin brand assets and a contact entry', async () => {
    const root = path.join(__dirname, '..');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'assets', 'douyin-qr.jpg')), 'missing the Douyin QR image');
    assert(fs.existsSync(path.join(root, 'build', 'fetch-runtime.js')), 'missing the full-build runtime assembly script');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(html.includes('douyin-qr.jpg'), 'the about section does not reference the Douyin QR');
    assert(html.includes('https://v.douyin.com/9TIIxVCANig/'), 'missing the Douyin homepage link');
  });

  console.log(results.join('\n'));
  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
