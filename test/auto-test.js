'use strict';
/**
 * Regression tests for zero-config auto-tuning / container-style slimming (pure Node, no emulator)
 * Run: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js auto parameters]');

  await test('GPU backend chosen by emulator version (new: host first + software fallback; old: swiftshader_indirect)', () => {
    // New versions (37.x/36.4.9+): host is the snappiest; failures auto-degrade to software/swangle
    assert(doctor.gpuCandidates('37.3.8.0')[0] === 'host', '37.x should prefer host');
    assert(doctor.gpuCandidates('36.4.9.0')[0] === 'host');
    assert(doctor.gpuCandidates('37.3.8.0').includes('software'), 'new versions must have a software fallback');
    // 37.x rejects swiftshader_indirect with a GL init failure; it must never be a candidate
    assert(!doctor.gpuCandidates('37.3.8.0').includes('swiftshader_indirect'));
    // Old versions still use swiftshader_indirect
    assert(doctor.gpuCandidates('35.1.4.0')[0] === 'host');
    assert(doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
  });

  await test('low-memory machines auto-downscale (no more hard-coded 4GB / 4 cores)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `memory should be 2048, got ${p.memoryMB}`);
    assert(p.cores === 2, `cores should be 2, got ${p.cores}`);
    assert(p.accel === 'off', 'without hardware acceleration fall back to software emulation');
    assert(p.bootTimeoutMs > 240000, 'software emulation needs a longer boot timeout');
    assert(p.gpu === 'host', `preferred renderer should be host (planVariants degrades on failure), got ${p.gpu}`);
    // When accel is off the last-resort variant must use software rendering, or TCG has no GPU
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'the last resort must use software rendering');
    // Data partition defaults from free disk (4/6/8GB, no longer a fixed 16G) and can be overridden
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `data partition should be 4-8GB, got ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'the data partition size from settings must take effect');
  });

  await test('big-memory machines do not consume memory without bound', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `high-end config must still be capped: ${p.memoryMB}MB / ${p.cores} cores`);
    assert(p.accel === 'auto');
  });

  await test('retry matrix: best to most conservative, including software emulation and cold-boot fallback', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `expected 3-4 variants, got ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'missing the software-emulation fallback');
    // The last variant only skips snapshot loading and uses minimal memory; never -wipe-data:
    // every variant fails when the disk is full, and a wipe would delete the user installed apps (seen in practice).
    assert(v[v.length - 1].snapshot === false, 'the last variant must skip snapshot loading');
    assert(v[v.length - 1].wipe === false, 'no automatic retry may wipe user data');
    assert(v[v.length - 1].memoryMB <= 2048, 'the last variant should drop to minimal memory');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'retry variants must not repeat');
  });

  await test('moving the image to another drive is not a new image: a new sysdir must not wipe user data', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'the path identity of the same image set must match');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'moving drives must not invalidate the snapshot (or every boot pays a cold start)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'a genuine image change must be detected');
  });

  await test('snapshot fingerprint ignores GPU/accel/memory retries (otherwise every retry wipes installed apps)', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('log diagnosis recognizes GPU / acceleration / non-ASCII path / lock-file issues', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('log diagnosis: emulator exit 0xC0000005 is a render-backend crash', () => {
    // Observed in issues #20/#25: exit 3221225477 right after "Userspace boot properties"
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Crash logs also carry render-init lines: the crash verdict must win over GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'the crash verdict must outrank ordinary render logs');
  });

  await test('idle-port probe returns an even port pair', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `bad port: ${p}`);
  });

  await test('auto parameters shown in settings match what runs (37.x no longer shows a deprecated backend)', () => {
    const common = { accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044 };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host', `should be host (degrades on failure), got ${p.gpu}`);
    assert(p.accelOk === true && text.includes('hardware acceleration'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('port 5562'), text);

    // Old engines keep the old backend; advanced parameters typed by the user still apply
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js container-style slimming]');

  await test('inventory of reclaimables: non-x86_64 QEMU, old images, old AVDs, lock files, old snapshots', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'should list non-x86_64 QEMU');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'must never delete x86_64 QEMU');
    assert(paths.some((p) => p.includes('android-30')), 'should list the old API30 image');
    assert(paths.some((p) => p.endsWith('.lock')), 'should list lock files');
    assert(paths.some((p) => p.includes('snapshots')), 'should list old snapshots');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), 'should list inactive AVDs');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), 'must never delete the active AVD config');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun must not delete anything');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'a real cleanup should free space');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), 'inactive AVDs should be removed');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), 'the active AVD must be kept');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU must be kept');
  });

  console.log('\n[adb.js install/launch failure readability]');

  await test('Android 14 rejects old targetSdk apps with clear guidance', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('automatically'), s);
  });

  await test('ARM translation-layer crashes yield actionable guidance', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('ARM translator') && s.includes('compatibility image'), s);
  });

  console.log('\n[sharer stops round-tripping (the disk-filling culprit)]');

  await test('the same file is not pulled back from the device every round', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Real path/state files, but the directories point at a temp dir
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // round 1: new local file -> push it up
    const firstPull = calls.pull;
    await sh.sync();          // round 2
    await sh.sync();          // round 3
    await sh.sync();          // round 4
    assert(calls.push === 1, `should push once, got ${calls.push}`);
    assert(firstPull === 0, `a just-pushed file must not be pulled back immediately; got ${firstPull} pulls`);
    assert(calls.pull === firstPull, `later rounds must not keep pulling; total ${calls.pull}`);
  });

  await test('huge files are never pulled back (the local dir is not a device-cache dump)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'files over 512MB must not be pulled back');
  });

  console.log('\n[adb/sharer file interchange]');

  await test('ls -l parsing handles Android group/date formats', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('remote file list via find+stat in one shot (no reliance on ls date parsing)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `expected 2 files, got ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js streaming extraction of large packages]');

  await test('ZipFile and ZipArchive agree on the same archive (deflate and streaming pipeTo)', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'entry names should match');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'stored entry content should match');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'deflate entry content should match');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'pipeTo streaming output should be complete');
    } finally {
      file.close();
    }
  });

  await test('Zip64: when EOCD uses 0xffff/0xffffffff placeholders, count and offsets come from the Zip64 EOCD', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // local header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // central directory entry: three fields set to 0xffffffff, real values in the Zip64 extra (id=0x0001)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EOCD + locator + classic EOCD (all carry the marker values)
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive should recognize Zip64 entries');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'ZipArchive content should be correct');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'ZipArchive uncompressed size should come from the extra field');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile should recognize Zip64 entries');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'ZipFile content should be correct');
      assert(file.entries.get('hello.txt').localOffset === 0, 'ZipFile local-header offset should come from the extra field');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js zero-config AVD]');

  await test('AVD uses a small data partition + quick boot + modern GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'data partition must not be 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'must not force cold boot anymore');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'snapshots are driven by the -snapshot CLI flag, avoiding a stale default_boot');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'snapshot fingerprint should be written');
  });

  await test('boot args carry auto memory/cores/snapshot and no deprecated GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // When no snapshot exists (fresh AVD / just invalidated) never pass -snapshot:
    // qemu would wait forever for a memory state that is not there: process alive, never boots.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // With no snapshot, only disable loading, not saving: -no-snapshot also disables the save-on-exit,
      // so the first cold boot would never produce a snapshot and every launch is a full boot.
      assert(/-no-snapshot-load/.test(fresh), 'with no snapshot use -no-snapshot-load (skip loading only)');
      assert(!/ -no-snapshot( |$)/.test(fresh), 'with no snapshot never use -no-snapshot (it disables save-on-exit)');
    }
    // Only use quickboot when a snapshot really exists. It must look like a complete snapshot:
    // an interrupted save leaves a tiny snapshot.pb shell; that must count as no snapshot,
    // or the emulator tries to load, fails, falls back to cold boot, and wastes seconds.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // Shell (12-byte pb, no ram.img) must count as "no snapshot"
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'an incomplete snapshot must not count as usable');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'a shell snapshot must fall back to cold boot (skip loading)');

    // Complete snapshot: pb has content + ram.img has data (hasSnapshot cleaned the shell above)
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), 'with a snapshot use quickboot');
    assert(!/-no-snapshot-load/.test(withSnap), 'a complete snapshot must not be skipped');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'wipe must pass -wipe-data');
    // On a data reset: do not load the old snapshot (data mismatch) but **allow saving** a new one.
    // "Repair network" depends on it: first boot after reset has network -> save snapshot -> next start restores.
    // The old implementation passed -no-snapshot here, which also disabled saving, so the fixed network never persisted.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'wipe must not load the old snapshot');
    assert(!/ -no-snapshot( |$)/.test(cold), 'wipe must still allow saving a new snapshot (network repair depends on it)');
  });

  // The window agent script carries large comment blocks. PowerShell 5.1 decodes BOM-less UTF-8
  // as ANSI; mangled non-ASCII can merge a C# comment with the next code line, so Add-Type fails
  // and the agent "fails to start / the app window does not embed". Pinned by this test.
  await test('window agent script must be UTF-8 with BOM (otherwise non-ASCII comments break Add-Type)', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'agent.ps1 is missing the UTF-8 BOM');
  });

  // The emulator window must be a child of the Chromium render layer, not a sibling of the host.
  // As a sibling, Electron keeps raising the web layer, the black backdrop covers Android and eats mouse input
  // (black borders / not filled / dead clicks / cannot accept). Never set a window region on the
  // embedded window either: it breaks hit-testing and exposes black borders after resize.
  await test('embedded window must parent under the web layer and must not set a window region', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'embed must parent to the window found by FindChromeRender');
    assert(/FindChromeRender\(host\)/.test(src), 'must look up the Chromium render child window');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), 'must not set a clip region on the embedded window');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'embed must clear the region left by older versions');
  });

  // Rotation must switch the "physical panel size" and restart; runtime wm size / density alone is wrong.
  //   - wm size: the physical LCD stays portrait -> image lies 90 deg, occupies the top-left strip, taps miss;
  //   - wm density: framebuffer size unchanged -> image does not fill, large blank on the right when maximized.
  await test('landscape must use the physical panel size (lcdFor landscape) and never runtime wm size rotation', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `portrait should be 720x1280, got ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `landscape should be 1280x720, got ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation must not override wm size');
    assert(/wm density 190/.test(body), 'density is kept only as a degraded path');
  });

  await test('game mode must use high priority and disable the global mouse hook', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'game level must raise qemu to High');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'game mode must not install a WH_MOUSE_LL global hook');
  });

  await test('foreground priority must not be below (responsive clicks / no dropped video frames)', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // balanced/performance with an app in front must be normal: below starves qemu,
    // dropping video frames and delaying clicks (the usual "clicks lag" complaint).
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      "beginApp foreground priority should map game->game and the rest->normal");
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      'balanced must no longer land on below');
    // setPriority must run on every beginApp, not just the first (switching back must re-raise too)
    assert(begin.split('setPriority(level)').length >= 2 || /if \(first\)[\s\S]{0,200}cancelSnapshotSave[\s\S]{0,300}setPriority\(level\)/.test(begin),
      'setPriority must run on every beginApp, not only the first');
  });

  await test('save mode should lower the memory cap (less runtime footprint)', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'save mode should cap memoryMB at 2048 (about 1GB RAM + 1GB snapshot disk saved)');
    assert(/!overrides\.memoryMB/.test(doc), 'save-mode memory reduction must yield to a manual value');
  });

  await test('failed downloads must delete leftovers (or the same package re-downloads forever)', () => {
    const dl = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'download.js'), 'utf8');
    assert(/function discardPartial/.test(dl), 'discardPartial is required');
    assert(/chunks\.json/.test(dl), 'discardPartial must delete the chunk sidecar too');
    // The failure paths of download / downloadParallel / downloadMulti all call it
    const calls = (dl.match(/discardPartial\(/g) || []).length;
    assert(calls >= 6, `too few cleanup points (only ${calls}); some paths still leave half files`);
    // Outermost safety net: openStream reject (connection refused / DNS / timeout) must clean up too
    assert(/catch \(e\) \{[\s\S]{0,200}discardPartial\(dest\)[\s\S]{0,80}throw e;[\s\S]{0,40}\}[\s\S]{0,10}\}/.test(dl),
      'download must catch openStream rejections at the outermost level');
  });

  await test('old-version cleanup: finds ApkStart dirs anywhere and never touches the running version', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-left-'));
    try {
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'ApkStart.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('ApkStart-v0.3.9-win64-portable');
      const old2 = mk('ApkStart-win64-portable.prev-2026-01-01T00-00-00-000Z');
      const curDir = mk('ApkStart-v0.5.0-win64-portable');
      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));
      assert(found.includes(np(old1)), 'a normal old-version dir was not found');
      assert(found.includes(np(old2)), 'a leftover .prev packaging backup was not found');
      assert(!found.includes(np(curDir)), 'the running version was classified as old (dangerous)');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('auto-deploy needs a failure cooldown (or every start re-downloads)', () => {
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(/deployFailedAt/.test(mainJs), 'record the last deploy failure time');
    assert(/COOLDOWN_MS|cooldown/.test(mainJs), 'a cooldown window is required');
    assert(/force/.test(mainJs.slice(mainJs.indexOf('async function autoDeploy'))),
      'manual one-click deploy must bypass the cooldown');
  });

  await test('ram.bin written by newer emulators must count as a complete snapshot (or a fresh 3GB save is discarded as a shell)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin should count as a complete snapshot');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), 'with a snapshot use quickboot');
    assert(!/-no-snapshot-load/.test(args), 'a complete snapshot must not be skipped');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('userdata seed image: 4K block + ENCRYPT + self-consistent accounting', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'superblock magic must be 0xEF53');
    // dm-default-key (Android 13 /data metadata encryption) uses 4096-byte logical blocks;
    // a smaller fs block makes mount() return EINVAL - the real cause of "/data will not mount".
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size must be 2 (4096 bytes)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size must equal the block size');
    // Without ext_attr setxattr returns EOPNOTSUPP, SELinux labels cannot be written,
    // and netd / media / tombstoned all exit 1, leaving boot stuck on the animation.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'ext_attr is required');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'free blocks must lie in (0, total)');
    assert(freeInodes === inodes - 10, 'free inodes must exclude the reserved 1-10 (e2fsck checks)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'ENCRYPT must be on by default (required by FBE)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'encrypt:false must clear the bit');
  });

  console.log('\n[display / shortcuts / zero-touch]');
  await test('window mode must actually open a window (or the app lives but shows nothing)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'window mode must not use -no-window');
    // Never pass -no-skin: it overrides -skin, reverting the panel size to the old config.ini value,
    // showing "landscape chosen but still portrait" and "image occupies only the top-left strip".
    assert(!/\s-no-skin(\s|$)/.test(win), 'window mode must not pass -no-skin (it overrides -skin)');
    assert(/-skin \d+x\d+/.test(win), 'window mode must set the panel size explicitly with -skin');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('audio: on by default (no -no-audio); -no-audio only when disabled', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Override the settings getter: default-on must not include -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), 'audio=true must not pass -no-audio');
    // Only when disabled should -no-audio appear
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'audio=false should pass -no-audio');
  });

  await test('forced migration of old config: headless and "exit after launch" no longer apply', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless must migrate to false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch must be false');
    assert(s.autoStart === true && s.autoDeploy === true, 'autostart/one-click deploy default to on');
    assert(s.createStartMenuShortcut === true, 'Start Menu shortcut defaults to on');
  });

  await test('display fit: window and fullscreen share portrait resolution; 9:16 window is resizable', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // Fullscreen does not change the Android resolution (the emulator window aspect is locked by the LCD); it only maximizes
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', 'garbage landscape', area).h > d.sizeFor('window', 'garbage landscape', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Fullscreen: fill the height, compute width from the portrait ratio and center (aspect locked by emulator LCD)
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('adb display commands use wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO and WebP icon fallback both produce a usable ICO', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'the ICO header should declare one image');
    assert(ico.readUInt32LE(14) === png.length, 'embedded PNG length should match');
    assert(ico.slice(22).equals(png), 'the ICO data area should be the original PNG');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP (nativeImage cannot decode) -> without a decode callback fall back to the brand placeholder ICO
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP should still produce an icon');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), 'with decode, the real icon should be used');
  });

  await test('window control script exists and is pure ASCII (avoids mangled non-ASCII paths/titles)', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), 'windowctl.ps1 is missing');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'ps1 must be pure ASCII; non-ASCII is passed as UTF-8 JSON');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile feeds the source into stdin and produces a runtime-extractable image (CI hang regression)', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // small sample uses the fastest preset; do not slow the suite
    process.env.XZ_TIMEOUT_MS = '15000';  // kill within 15s if it really hangs; do not jam CI
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile did not return within 25s (stdin never got EOF?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'the compressed output must not be empty');
    let back;
    if (/\.xz$/i.test(out)) {
      // Do not depend on the @napi-rs/lzma native binding: the Node 20 CI job fails
      // to load it due to a known npm optional-dependencies bug (Node 22 is fine).
      // Read it back with the same python lzma used to compress and verify the XZ magic;
      // runtime extraction compatibility is covered by the real installer end-to-end test.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'must be a valid XZ container');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'produced XZ but python is missing; cannot verify');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'decompressed content must match the source image byte for byte');
  });

  console.log('\n[container.js app-level container]');

  const container = require('../src/core/container');

  await test('system/framework packages are never trimmed; only user apps enter session cleanup', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} should be treated as a user app`);
      else assert(sys, `${p} should be treated as a system package`);
    }
    assert(container.isSystemPackage(''), 'an empty package counts as system, avoiding invalid commands');
  });

  await test('launching an app stops other user apps only; system packages are never touched by default', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `should stop 2 other user apps, got ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'system packages must not be disabled by default');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'launch must not clear background apps, avoiding harm to the just-foregrounded app');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'must not force-stop the system framework');
  });

  await test('package whitelist: a poisoned list cannot produce injected commands', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `only valid package names should be stopped, got ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'no injection fragment may appear');
  });

  await test('deep trim disables background packages, restores fully, and leaves required components alone', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'deep trim should have something to disable');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} must never be disabled`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} must be restorable`);
    }
  });

  await test('container park: clear background + Android idle; state machine covers multiple windows / last close', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'parking should clear cached background processes');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'parking should put Android into idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'the container should park after the last window closes');
  });

  await test('doctor lightweight container: converges vCPU; manual settings win', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // Old logic was floor(cores/4) clamped to 2..3 - an 8-core machine got 2 vCPUs and video apps stuttered.
    // Now balanced gives "half the physical cores, max 4"; save mode fixes 2.
    assert(lite && lite.cores === 4, `a 16-core machine in balanced mode should get 4 cores, got ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `save mode should fix 2 cores, got ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'explicitly disabled should return null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, 'a 2-core machine keeps at least 2 cores');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(manual.cores === 6, 'a manual core count must outrank lightweight mode');
    assert(/lightweight container/.test(doctor.describeProfile(auto)), 'the diagnostic summary should mention the lightweight container');
  });

  await test('global mouse hook is off by default and the agent no longer blocks the message pump', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'the side-button hook must be off in defaults');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'the main process must not install a global hook unconditionally');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'the app window must not install a global hook unconditionally');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'file sync must not run unconditionally in the background');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), 'the hook switch must be idempotent and closable');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), 'the hook must live on a dedicated message thread');
    assert(/GetMessage\(out MSG/.test(agentPs1), 'the hook thread must run a message loop');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'the main loop must not block for 4 seconds');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'the main loop should poll briefly to keep the message pump responsive');
    assert(/now - _embedAt < 8000/.test(agentPs1), 'window sweeps must be time-boxed, not EnumWindows every 2s forever');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'the settings page must expose the lightweight-container option');
  });

  await test('WinAgent.setHook(false) does not spawn the PowerShell agent in the default state', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'disabling should return hooked=false');
    assert(a.ready === null, 'with the default off, no resident agent process may be started for it');
  });

  console.log('\n[mouse button mapping]');

  await test('defaults and old-config migration: right-click back + smooth wheel on, side buttons off', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'right-click back is on by default');
    assert(d.wheel === 'smooth', 'wheel is smooth by default');
    assert(d.side === false, 'side buttons are off by default');
    assert(d.enabled === true, 'at least the right-click mapping needs the hook');
    // Old settings.json without the new keys must produce the same result
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'with everything off no hook should be installed');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'native wheel mode needs no hook');
  });

  await test('hookOptions converges config; disabling zeroes every sub-switch', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false must intercept nothing at all');
    assert(pointer.hookOptions(true).side === true, 'accepts the old boolean form (side buttons)');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('wheel direction: scroll down=finger up, scroll up=finger down; coordinates stay in bounds', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'scrolling down should move content up (finger up)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'scrolling up should move content down (finger down)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'zero displacement produces no command');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x must stay in bounds');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y must stay in bounds');
      assert(s.duration >= 100 && s.duration <= 240, 'swipe duration must be capped');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'fast scrolling must not stretch the gesture indefinitely');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'horizontal wheel should produce a horizontal swipe');
  });

  await test('input command whitelist: only internally built commands pass; injection is blocked', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /Invalid/.test(e.message); }
    assert(blocked, 'an illegal command must be blocked before adb spawns');
    assert(c._input === null, 'a blocked command must not create a resident session');
  });

  await test('the back key prefers the resident input channel and falls back to one-shot adb', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'the normal path must not spawn adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'a resident-channel failure must fall back, not lose the click');
  });

  await test('WheelRouter merges consecutive scrolls into one swipe', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 scroll notches should merge into 1 command, got ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'must produce a valid input swipe');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'the merged gesture still scrolls down');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'no injection after dispose');
  });

  await test('agent script: right-click/wheel interception, wheel merging, foreground scoping, dedicated thread', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), 'must handle right-click and wheel');
    assert(/WM_MOUSEHWHEEL/.test(ps1), 'horizontal wheel must work too');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), 'wheel events must be merged before reporting');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), 'must scope to the foreground root window');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), 'the hook must live on a dedicated message thread');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), 'the main loop must not block for long');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), 'unconfigured mappings must not intercept events');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), 'settings changes must sync to the hook immediately');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'the settings page must expose the button switches');
  });

  await test('WinAgent.setHook sends the button config and does not spawn the agent when disabling', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, 'enabling should send exactly one command');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, 'the config must travel with the hook command');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, 'disabling must uninstall the hook');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, 'with the default off, PowerShell must not start');
  });

  console.log('\n[updater.js online updates]');
  await test('version comparison is numeric segment by segment; v prefix / multi-segment handled', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 should be greater than 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'v prefix does not affect equality');
    assert(cmpVer('0.10.0', '0.9.9') === 1, 'must compare numerically, not as strings');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 is less than 1.0.1');
  });

  await test('install shape picks the asset: installer=Setup.exe, portable=portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', 'no uninstaller means portable');
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert(portable.flavor === 'setup', 'an uninstaller means installer');
    // Asset picking is pure; feed a fake check result to verify the fallback naming rules
    assert(/Setup\.exe$/i.test('ApkStart-0.3.2-Setup.exe'), 'installer asset name matches');
    assert(/portable.*\.zip$/i.test('ApkStart-v0.3.2-win64-portable.zip'), 'portable asset name matches');
  });

  await test('portable build does not treat the runtime bundle (ApkStart-runtime-*.zip) as an update', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // Both assets exist -> must pick the portable package
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'ApkStart-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `should pick the portable package, got ${info.asset.name}`);

    // Only the runtime bundle (portable not uploaded) -> rather no auto-update than a 1.5GB runtime as the app package
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, 'with only the runtime bundle no update asset should be picked');
    assert(info.canAutoApply === false, 'without a usable asset auto-update must be off');
  });

  await test('dual source: candidates include mirror prefixes; a custom prefix outranks the public mirror', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, 'the origin must come first (original order before speed ranking)');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), 'the automatic mirror should be a candidate');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `the custom prefix should be the only one, got ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, 'with auto-mirror off only the direct URL remains');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, 'a missing trailing slash must be added');

    // The mirror only proxies GitHub: Gitee URLs behind the mirror just 403, so they must not be candidates
    const giteeUrl = 'https://gitee.com/daily-miku/apkstart/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'Gitee assets must not get the GitHub mirror prefix');
  });

  await test('dual source: rank by measured speed; keep original order on total failure, losing no URL', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // Inject the speed cache directly so the test does not depend on the network
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `the fastest should rank first, got ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'failed URLs rank last but are kept (one more chance)');
    s.reset();
    assert(s._rankCache.size === 0, 'reset must clear the speed cache (re-measure after a source/network change)');
  });

  await test('dual source: the source archive Gitee attaches (v1.2.3.zip) must never be an installer', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'ApkStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `only ApkStart* assets should survive, got ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Gitee assets have no size field: part groups must still form (or the whole package is dropped)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Gitee release assets carry only name + url, no size (observed)
        assets: [
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `should merge into 1 asset, got ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'ApkStart-v0.3.3-win64-portable.zip', `the asset name should be the whole-package name, got ${a.name}`);
    assert(a.parts && a.parts.length === 2, 'both parts must be kept');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', 'part URL order/content must be right');
    assert(a.size === 0, 'unknown size should be 0 (the UI shows progress by received bytes)');
  });

  await test('part assets must reach updater.asset, or prepare reports "no usable download URL"', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'ApkStart-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'parts must be kept on the asset');
    assert(info.canAutoApply === true, 'with parts the update should be auto-applicable');
  });

  await test('dual source: merge only same-version assets; never pass an old package off as new', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'ApkStart-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `should take the higher version, got ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', 'a same-named asset from an older version must not overwrite the new one');
  });

  await test('window agent: scope joins dirs with semicolons and filters empties (the only input for window ownership)', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // Do not start a real agent: just verify the protocol payload
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `exactly one scope command expected, got ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `empties must be filtered, got ${sent[0].dirs}`);
    assert(r.ok === true, 'a successful scope returns ok');
    // An empty array must not throw: it means "suppress nothing"; the caller decides whether to warn
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'an empty scope must still be deliverable (the agent touches no window)');
  });

  await test('dual source: when both sides carry the same whole package, keep both URLs (or Gitee never gets a turn)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Gitee assets have no size (observed); do not fake it with the GitHub size
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `same-named assets should merge into 1, got ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `both source URLs must be kept, got ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], 'sizes are tracked per URL; unknown stays unknown');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `candidates should include both sources, got ${JSON.stringify(cands)}`);
  });

  await test('multi-source parallel: with different sizes follow the fastest source (do not always pick the larger)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // the source listed first (already speed-ranked)
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // list order = rank() speed order: the first one is the fastest
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `should download the copy from the fastest source (${small.length} bytes), got ${got.length} bytes`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('part update: concatenate in order; abort immediately on size mismatch', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, 'the joined size must equal the sum of the parts');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), 'part 1 content is out of order');
      assert(got.slice(partA.length).every((b) => b === 0x42), 'part 2 content is out of order');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('multi-source parallel: chunks from different sources must join into identical bytes', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // Explicitly wait for the listening callback: listen-then-attach loses an already fired event and the test hangs
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'multi-source output must match the source file exactly');
      assert(r.sources === 2 && r.parallel >= 2, `both sources should be used, got ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'sizes must match');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('multi-source parallel: a retry only fills missing chunks (no 1.4GB re-download)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // count only real data-chunk requests (0-0 probes do not count)
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // Must be two URLs: with one, downloadMulti hands over to single-source chunking (which has resume)
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // Create the state "first two chunks done, last one missing" (3 connections x 1MB chunks)
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'resume should be detected');
      assert(ranged === 1, `only 1 chunk should be fetched; ${ranged} requests observed`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'the resumed file must match the source exactly');
      assert(!fs.existsSync(`${out}.chunks.json`), 'the sidecar file must be removed on completion');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('downloader: no bytes after connect must time out and switch sources, not hang', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // Headers reply normally then silence: the classic "TCP works but throttled/blocked" state
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // Send 1KB then nothing
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'the file must end up complete');
      assert(cost < 15000, `must not hang on a stalled connection; took ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('downloader: switch sources when one runs at tens of KB/s instead of stalling at the last few %', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Slow source: 4KB every 100ms (~40KB/s)
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'content must be correct after switching');
      // A slow source would take 2MB / 40KB/s ~ 50s; switching must happen within seconds
      assert(cost < 15000, `should switch on low speed; took ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('multi-source parallel: with one usable URL fall back to single-source chunking', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Use a just-released port with no listener as the bad source: connections are refused instantly instead of timing out
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // The second URL deliberately points at a dead port: it must be ignored, not fail the package
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'a single source must still complete');
      assert(!r.multi || r.sources === 1, 'a single usable source should not be marked multi-source');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('dual source: version result cached 10 min; force re-queries', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `no repeat request within the cache window; ${calls} requests observed`);
    await s.latest({ force: true });
    assert(calls === 2, 'force must bypass the cache');
    s.reset();
    await s.latest();
    assert(calls === 3, 'reset should trigger a new request');
  });

  await test('dual source: a 403 rate-limited source trips the breaker and is skipped instead of retried every round', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 (rate limited)' },
      ];
    };
    // First call: Gitee returns 403 and trips the breaker
    await s.latest({ force: true });
    assert(giteeCalls === 1, 'the first round should really have queried');
    const reason = s.blockedReason('gitee');
    assert(!!reason, '403 must trip the breaker');
    assert(s.blockedReason('github') === null, 'a healthy source must not be blocked');
    // Requests during the breaker window are skipped (no network)
    assert(/Skipping for now/.test(reason), `the skip reason must be understandable, got: ${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'reset should clear the breaker');
  });

  await test('dual source: on total unreachability fall back to the last result (marked stale, no hard error)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'the first call should be normal');
    s._relTtl = 0;   // expire the cache
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'timeout' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'should fall back to the old result and mark it stale');
  });

  await test('system-image location: a fresh install must land in the runtime dir (CI assembling the runtime relies on it)', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) Fresh install: neither the runtime dir nor userdata has system-images -> use the runtime dir
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `a fresh install should use the runtime dir, got ${p.paths().sysImgRoot}`);

      // 2) Already present in the runtime dir (extracted bundle) -> prefer it
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'an existing runtime-dir copy should win');

      // 3) Only the userdata dir has it (old layout) -> use it
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `the old layout should fall back to userdata, got ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[resource policy / disk allocation / log cap]');

  await test('one resource-policy switch translates to vCPU/priority/resolution', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'smooth mode should not limit cores');
    assert(s.engine.priorityMode === 'game', 'smooth mode should use the low-latency game priority (FPS/video first)');
    assert(s.engine.renderSize === '720x1280', `resolution should be 720p, got ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'save mode should be 540p + lightweight container');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'balanced mode leaves resolution to auto');
  });

  await test('data partition size is configurable and no longer a fixed number', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `should be 12GB, got ${p.dataMB}MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `with ample disk auto should be 6GB, got ${auto.dataMB}`);
  });

  await test('snapshot fingerprint excludes data-partition size (a resize must not invalidate the snapshot or wipe data)', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'changing only the size must not change the fingerprint');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'changing the engine version should change the fingerprint');
  });

  await test('logs rotate past the cap, keeping one backup', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'rotation should happen');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'it should become .1.log');
  });

  await test('log file not ending in .log: rather no rotation than deleting the log', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'when bak and source share a name, rotation must be abandoned');
    assert(fs.existsSync(f), 'the log file must not be deleted');
  });

  await test('boot-failure records persist; a later diagnostic export still shows the real cause', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / hardware accel', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'the exit code should persist');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'the diagnosis should persist');
    assert(back.attempts.length === 1, 'attempt records should persist');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'a successful boot should clear the failure record');
  });

  await test('.xapk split package: stream splits out, parse base, clean temp dir on failure', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Success: two splits inside (base + config); meta comes from the parseable one
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `expected 2 splits, got ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'splits should be written to disk');
      assert(b.meta.package === 'com.example.test', `package ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Failure: no APK split inside -> a clear error, and no temp dir left on the user machine
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /No APK splits/.test(err.message), `should report missing splits, got ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'apkstart-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), 'a failure should clean the temp dir');
  });

  await test('materializeImages: expands .img.gz, skips already-expanded, reports bad images without leaving halves', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40MB of zeros: only tens of KB gzipped, but >32MB expanded - exactly tests the "already expanded" check
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `expected 1 image expanded, got ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'expanded size should be correct');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'uncompressed components should be in place too');
      assert(!fs.existsSync(`${img}.part`), 'success must not leave .part');

      const again = await prov.materializeImages();
      assert(again === 0, `already-expanded should skip; expanded ${again}`);

      // Bad image: must throw MATERIALIZE_FAILED and remove .part (or the next run thinks it is done)
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `a bad image should fail, got ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'a failure must not leave .part');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('after a source/bundle URL change the provisioner cache must be cleared (or a restart is needed)', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Simulate caches after resolving the bundle / engine URL once
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'the bundle URL cache should be cleared');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'the engine/image URL cache should be cleared');
  });

  await test('each boot diagnoses only its own log (a previous crash must not leak into the next boot)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // round 1: 0xC0000005
      { t: 3, line: '--- round 2 ---' },
      { t: 4, line: 'Address already in use' },          // round 2: port busy
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'round 1 should be a crash');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', 'round 2 should be port busy');
    // With no lines this round, fall back to the whole tail; never UNKNOWN outright
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `an empty round should fall back to the whole log, got ${fallback.length} lines`);
  });

  await test('launch component assembly: a full component must not repeat the package (or the icon opens the Android launcher)', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Full component (what apps.json stores after v0.3.4 installs) -> use as-is
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'a full component should be returned as-is');
    // Old data: bare class name / dot-leading class name -> add the package
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'an empty activity should return empty (implicit intent)');
    // resolve-activity output often ends with blank/priority lines: the component must still be found
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'blank lines should be skipped to reach the component');
    assert(parseResolvedActivity('com.other', out) === '', 'another package must not supply the component');
  });

  console.log(results.join('\n'));
  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
