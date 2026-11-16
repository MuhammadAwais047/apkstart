'use strict';
/**
 * Emulator engine: drives Google's official Android Emulator as the ApkStart runtime.
 *
 * The big change from the old version: it no longer assumes one set of flags runs on every machine.
 *  1. doctor.chooseProfile() derives flags from memory/CPU/disk/acceleration state/engine version;
 *  2. failed starts auto-degrade per planVariants() (GPU backend -> software rendering -> minimal-memory cold boot);
 *  3. picks free ports dynamically, clears AVD locks, converts non-ASCII paths to short paths, drops snapshots when the image changes;
 *  4. quickboot snapshots + a small data partition give container-like sharing of a read-only base layer and second-scale restore.
 *
 * The probe callback is supplied by the caller (Runtime) to decide whether Android is really ready.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const userdata = require('./userdata');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Translate emulator/qemu exit codes into human terms on Windows.
 * 0xC0000005 (3221225477) is the most common crash: an access violation, measured to come mostly from the
 * graphics driver / Vulkan backend dying the instant the guest boots; switching to software rendering works around it.
 */
function describeExitCode(code) {
  // code is null when the process was ended by a signal (true for taskkill / adb emu kill on Windows),
  // which is neither 0 ("exited normally") nor obviously an error: return an empty string and let the caller show it as-is.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'Exited normally';
    case 1: return 'Bad launch arguments or environment';
    case 3221225477: return '0xC0000005 access violation, render backend crashed';
    case 3221225725: return '0xC00000FD stack overflow';
    case 3221225781: return '0xC0000135 missing DLL (VC++ runtime / runtime component removed by antivirus)';
    case 3221225506: return '0xC0000022 access denied (driver or permission issue)';
    case 3221225595: return '0xC000007B image bitness mismatch or corrupt DLL';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    // The snapshot's ram.bin is roughly the memory assigned to the VM (2-4GB).
    // A machine whose cold boot is already fast should not pay several GB of disk for it, so save only when it is really slow.
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Persist the "last start failure" to disk.
   * The old version kept it only in memory (this.attempts), so exporting a diagnostic report after restarting ApkStart
   * produced attempts: [] and bootLog: [] - blank, forcing a hunt through the log file. That is also
   * the direct cause of "the report was attached but shows no reason" in issues #20/#25.
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* a failed write does not affect the main flow */ }
  }

  /** Read back the last failure record (for the diagnostic report / pre-boot notice) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe and the system image directory (user runtime first, falling back to the in-repo engine/) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Pick the image: use the generic one (API 34 Play) when present, so users never toggle a "compatibility mode" */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Drop the quickboot snapshot.
   * A snapshot captures both memory and the disk image, so loading an old one after installing an app or clearing data
   * makes the user see "the app I just installed vanished after restart".
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Clear locks left behind by an abnormal exit.
   * Note hardware-qemu.ini.lock is a **directory**, not a file: rmSync(force) cannot delete it,
   * so the emulator keeps reporting "Running multiple emulators with the same AVD" and never starts
   * (one forced kill is enough), so it must be removed recursively.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* busy: skip and retry next time */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Whether the AVD directory really holds a **complete** quickboot snapshot.
   * "directory is not empty" is not enough: an interrupted save leaves a shell with a 12-byte snapshot.pb,
   * the emulator tries to load it, fails (log: "does not have the requested snapshot") and falls back to a cold boot,
   * wasting seconds. This validates by file size and also removes the shell and the legacy default_boot (3GB each).
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // Newer emulators (37.x) write ram.bin; older ones wrote ram.img.
    // Accepting only ram.img is severe: a freshly saved 3GB snapshot gets deleted as a shell,
    // so every boot carries -no-snapshot-load and always cold-boots - half the reason "opening is slow".
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // nothing there to begin with: do not delete anything
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Remove snapshot directories left by old versions or failed renames (default_boot's ram.img can reach 3GB) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Clear orphaned emulators holding the AVD lock.
   * emulator.exe is only a launcher; the real qemu is spawned detached,
   * so killing only our own proc handle often leaves an orphan holding multiinstance.lock,
   * and the next start hits FATAL "Running multiple emulators with the same AVD".
   * Clearing uses two sources: the pid in the AVD lock, and any qemu/emulator whose command line names this AVD.
   */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Fast path (hit by every cold boot):
    //  - no .lock -> no live emulator can hold this AVD, return immediately;
    //  - lock present but no port listening -> just a directory left by the last forced kill, clear it.
    // It used to run wmic unconditionally (1-3 seconds and CPU-hungry), a visible drag on cold boots.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) the pid the emulator wrote into the lock file (most reliable)
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) fallback: find live qemu by process name + port (tasklist/netstat is an order of magnitude faster than wmic)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* no process list: rely on the pid in the lock file */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`Cleaning up ${pids.size} leftover emulator processes`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** Whether any emulator console port in 5554-5620 is listening (a refused connect returns at once, near-zero cost) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Prepare the AVD by writing config.ini. It is rewritten from the current auto config on every start so retries take effect immediately.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Screen size: with hardware acceleration 720x1280@320 is crisp with clear text;
    // pure software rendering drops to 540x960 for frame rate (56% of the area, a visual gap far smaller than the smoothness gap).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM compatible)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // Compare image identity, not absolute paths: the same images moved to another drive/directory are not a new image,
      // otherwise changing the runtime directory would wipe every installed app (see the doctor.imageIdentity comment).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // old userdata is incompatible with the new image (APEX boot loop), so it must be rebuilt
        this.wipePending = true;
      }
    }

    // A changed config fingerprint means the old quickboot snapshot fails to load or shows a black screen, so drop it.
    // Note: this drops the **snapshot** only and must never add -wipe-data - user data holds installed apps and saves.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* first run */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // The delete may be blocked by the OS or security software (snapshot directories are often several GB).
      // On failure, rename it so the emulator stops loading it; cleanup failure must never abort the start.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // Only a changed image (tag / sysdir) needs -wipe-data: old userdata and the new image
    // have incompatible APEX data and would loop on boot. Capacity / resolution / backend changes do not count.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch must be the ABI itself (x86_64 must not be truncated to x86)
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // The old version hardcoded 16G, creating huge files on small or quota-limited disks and slowing the first boot
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // The snapshot is controlled purely by -snapshot apkstart on the command line: a dedicated name, never loaded by accident
      // and never the legacy default_boot (memory state of an API30 image, which always boots into a loop).
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // Orientation/accelerometer sensors must stay off: once enabled, Android auto-rotates from the sensor and turns portrait
      // content sideways (the whole picture tips 90 degrees, text runs vertically, black bars all round). Layout switching now relies only on
      // wm density (changing smallestWidth); sensors are neither needed nor allowed.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfg);

    // /data must be genuinely usable first or everything after is a wait for nothing (see the ensureDataPartition comment)
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Ensure the userdata partition is a **genuinely usable** ext4 - the foundation of "tap an app, reach the home screen in 30 seconds".
   *
   * Why we must do it ourselves (all three were learned the hard way):
   *  1. userdata.img in the system image package is a 1MB all-zero placeholder; real formatting relies on avdmanager calling the SDK's
   *     mke2fs. ApkStart writes config.ini and starts the emulator directly, skipping that step -> /data is all zero ->
   *     kernel "Invalid ext4 superblock on /dev/block/vdc" -> the guest loops in recovery ->
   *     adbd never comes up -> the caller's probe stays pending and finally times out at 240s. Original symptom: minutes of waiting after a tap.
   *  2. The emulator's bundled e2fsck/resize2fs is cygwin e2fsprogs 1.42.12, which **does not understand the encrypt
   *     feature**, exits 8 and refuses to work with the bit set, so "grow the filesystem" must precede restoring the bit.
   *  3. The filesystem must be >= the partition size: at only 64MB, APEX extraction + dexopt fill it at once,
   *     every setxattr then returns ENOSPC -> SELinux labels cannot be written -> netd/media/tombstoned
   *     all exit 1 -> boot stalls on the splash animation and adb stays offline.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* does not exist */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // "Nothing to do" requires both a large enough file and a filesystem that really grew to that size.
      // File size alone misses a real failure mode: qemu-img grew the file but resize2fs failed,
      // leaving a 6GB file with only 64MB usable in Android - which users see as "not enough space installing games".
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // Configured capacity grew (or the filesystem fell short): grow in place, preserving installed apps
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata grow: file ${size} → ${wantBytes}, filesystem ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`Failed to grow userdata (continuing with the existing partition): ${e.message}`);
        // The old partition still works, but the caller must be told "this grow failed" - the settings page must not show success
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // First run / the all-zero placeholder left by old versions / a corrupt image: build a fresh one
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Start without the encrypt bit (the old e2fsck/resize2fs only works that way)
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`Rebuilt userdata: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (4K block, FBE capable)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Best effort: even if growing failed, put the encrypt bit back so FBE can initialise (the partition stays small)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`Failed to rebuild userdata: ${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** The emulator's bundled qemu-img.exe: grow a raw image file to the target size (sparse, instant)
   *  Note the argument order: `qemu-img <command> -f raw <file> <size>`.
   *  Putting -f before the command makes it treat it as a global option and report unrecognized option. */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** The emulator's bundled resize2fs.exe (cygwin build; must run from the bin64 directory to find its DLLs) */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('resize2fs.exe is missing');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** The emulator uses these environment variables to locate the SDK / AVD; non-ASCII paths are converted to 8.3 short paths */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // The AVD directory must match provisioner.paths().avdHome: with a bundled read-only runtime (resources/runtime
    // next to the EXE) root/avd does not exist and is not writable, so the AVD must live in the user data directory.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
    };
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Audio: on by default (so Android app notification and video sound is audible).
      // -no-audio is passed only when the user turned it off explicitly, saving a little CPU.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Disable crash reporting: if a past crash report exists, the emulator shows an "agree to upload" modal,
      // blocking the main thread forever (the log shows Showing crashdialog to get consent).
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // Networking: the AOSP emulator uses QEMU user-mode NAT by default (-netdev user); Android sees
    // virtual 10.0.2.x addresses and egress reuses the host's physical NIC NAT.
    // This mode does **not** create any virtual NIC or virtual switch on Windows
    // (that requires -netdev tap or bridging, which we never enable).
    // So Android apps sit behind a device on the host's NAT; the host network stack is untouched,
    // no driver install and no extra network adapter.
    // Declare no rate limit explicitly: the default is full, but some -gpu / -net combinations pick up
    // the emulator's conservative setting, and video apps (Hongguo, Douyin) visibly lag on their first screen.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // DNS: Android uses 10.0.2.3 by default (forwarded to the host's DNS). With a host VPN / corporate network / some carriers
    // a single lookup can take hundreds of milliseconds, showing up as "the page spins forever before loading". A public
    // DNS is offered as the first choice and the system still falls back. Users can disable it (intranet domain cases).
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // Note: **never pass -no-skin again**. It overrides the -skin above and reverts the panel size to
      // the old value in config.ini - the "switched to landscape in settings but it stays portrait" symptom,
      // plus "the picture occupies only a strip in the top-left". The panel size must come from -skin.
      // The device frame is never drawn anyway (ShowDeviceFrame=no plus the style flags below).
      // Note: -qt-hide-window must not be used. It makes the emulator **not create** that Qt window at all,
      // while the window agent relies on SetParent to embed that window in the app window to show the picture -
      // with it the probe never finds a window and the user sees an all-black app window.
      // Hiding the window is instead handled by the always-on suppression in the window agent (QuietSweep in win/agent.ps1).
    }
    // Pass -snapshot only when a snapshot really exists: on a fresh AVD (or just after a snapshot was dropped) it makes
    // qemu wait forever for a memory state that does not exist: the process lives but never boots -
    // the caller only sees "boot timed out", retries with different flags, and is then blocked by the AVD lock with
    // "Running multiple emulators with the same AVD"。
    // Snapshot flags decide whether the next boot takes 8 or 90 seconds; this is the second fatal point:
    // the old implementation passed -no-snapshot when there was no snapshot, and -no-snapshot also disables **save on exit**,
    // so no snapshot could ever be produced after the first cold boot and every tap meant a full boot.
    // The right flag is -no-snapshot-load: do not load this time (avoiding a wait for a nonexistent snapshot),
    // but still write the memory state to apkstart on exit, so the next start restores directly.
    // A snapshot costs a ~2-3GB ram.bin (users short on disk can turn it off; only start speed is affected)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // After a data reset the old snapshot must not load (the data no longer matches), but **saving a new one must stay enabled**:
      // the network fix depends on "first boot after reset has network -> save a snapshot at once -> restore next time",
      // while the old code pushed -no-snapshot here, disabling saving too, so a snapshot was never stored.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // Network self-healing needs a cold boot this time: the snapshot may have been saved with no network and would restore without it.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    return args;
  }

  /** Spawn one process (no boot wait here; the boot wait lives in start()'s probe loop) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: make the emulator independent of the ApkStart process group.
      // On exit, Electron closes the job object it created and kills the children with it -
      // which shows up as "close ApkStart, reopen it, and it cold-boots for 20+ seconds again". Detached, the emulator stays,
      // is adopted on the next start (see Runtime.adoptExisting), and a tap takes seconds.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? ` (${meaning})` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? ` (${meaning})` : ''}\n`);
      this.proc = null;
      onLog(`Runtime exited (code=${code}${meaning ? `, ${meaning}` : ''})`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu is a detached process: lower its priority once it is really up.
    // Otherwise 2-4 vCPU threads compete with the Windows desktop at Normal priority,
    // and the user's first impression is "open ApkStart and the mouse floats, the whole machine stutters".
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Write the emulator log with size-based rotation so long-term use never fills the disk */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Current state of the /data image (for the settings page; available without booting Android) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* not created yet */ }
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      configuredGB: Number(this.settings?.engine?.dataPartitionGB || 0),
    };
  }

  /**
   * Grow the /data partition to the given size now (the emulator must be stopped or the image is busy).
   * Uses ensureDataPartition's in-place grow path: qemu-img resize + resize2fs,
   * with no rebuild and no loss of installed apps or saves.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    return this.ensureDataPartition(dir, dataMB);
  }

  /**
   * Adjust the priority of this machine's qemu/emulator processes (matching only those whose command line names this AVD).
   * level: idle (container parked) | below (an app is in the foreground) | normal (performance first).
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Force-kill the current attempt (including the qemu process tree) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // The proc handle is often gone already (emulator.exe exits after launching; qemu is detached),
    // and without a name-based sweep the next round is blocked by the AVD lock with FATAL.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Rebuild the adb server on this instance's dedicated port.
   *
   * This is the main culprit behind "opening an app takes two minutes"; the historical implementation just ran kill-server and returned:
   * the emulator connects to the adb daemon on ANDROID_ADB_SERVER_PORT the moment it starts,
   * and if it cannot connect it **never registers the device** - adb devices either lacks emulator-5554
   * or shows it stuck offline (the log line "Unable to connect to adb daemon on port: 5044").
   * The caller's probe never sees sys.boot_completed, waits out a 3-minute timeout and retries,
   * each retry is a full cold boot, and snapshots cannot be saved because the device is offline: a dead loop.
   *
   * So kill first (clearing stale device records), then start, and return only once the port is really listening.
   */
  /** Lets the caller restart the server once when adb transport stalls (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* use the one on PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // On some machines adb start-server returns quickly but the port is not really listening,
    // so wait until it accepts a connection (up to ~3 seconds; normally tens of milliseconds).
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Catch the "spawn then exit immediately" case.
   * With bad flags or a missing DLL the emulator usually exits within a second; if the process lives, return at once
   * instead of a fixed 2.5-second wait - long enough, on a snapshot restore, to finish half the boot.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Force the next start to cold-boot (no quickboot snapshot load).
   *
   * A snapshot also captures NIC state: one saved with no network restores without network
   * every time. Cold-booting once during network self-healing bypasses that bad snapshot.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Add -wipe-data to the next start (used only by "repair network" after several attempts fail).
   * Deleting the userdata image file is not equivalent to the emulator's `-wipe-data`; the latter must be used.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Check whether the VM really has network access.
   *
   * Why this step exists: the Android VM's Wi-Fi config lives in /data and, once corrupted (typically
   * two AndroidWifi entries with colliding network ids in `cmd wifi list-networks`),
   * wlan0 stays NO-CARRIER and never gets an IP. Any page needing network is then a black
   * screen - that is the "Hongguo goes black after tapping agree" report, and it has nothing to do with GPU/rendering.
   *
   * @param {string} [adbPath] explicit adb executable (Runtime has a more authoritative resolver)
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    let adb = adbPath || '';
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() only checks a "version file" that is empty in many installation shapes,
      // so locating bundled platform-tools under the runtime root is more reliable.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Android's multiple routing tables make `ip route`'s main table look empty (the default route is in per-interface tables),
    // and the shell uid is outside the app's network group, so `ping` often falsely reports "Network is unreachable"
    // even when Wi-Fi is connected and apps browse fine. So only "did we get an IPv4 address" counts here,
    // cross-checked against the connection state in `cmd wifi status`; ping is not used.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // Wi-Fi association + DHCP often finish tens of seconds after sys.boot_completed.
      // When the caller passed waitMs, keep waiting instead of declaring "no network" at this instant.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected };
  }

  /**
   * Start + automatic retries.
   * @param {Function} probe async callback returning 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      return { ok: true, reused: true, serial: this.serial, port: this.port };
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('Runtime engine is not installed. Complete setup on the "Runtime" page first.');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('System image not ready. Download the Android system image on the "Runtime" page first.');
    }

    const s = this.settings;
    // Check the disk before booting: the emulator writes the AVD (data partition + snapshot, several GB),
    // so only free space on that disk decides whether a boot is possible; the runtime directory only gets logs and needs far less.
    // It used to take the minimum of the two, so "data moved to D: while C: has 400MB left"
    // was misjudged as low disk - moving the data directory achieved nothing.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Not enough disk space: the drive holding the Android data directory (${avdHome}) has only ${(avdFreeMB / 1024).toFixed(1)} GB left, `
        + `the runtime needs at least ${(needMB / 1024).toFixed(1)} GB free. Open "Settings → System Integration → Android data directory" `
        + 'and move it to a drive with more space (for example D:), or free up disk space. Your apps and saves will not be deleted automatically.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `The drive holding the runtime directory (${loc.root}) has only ${(diskMB / 1024).toFixed(1)} GB left, `
        + 'which is not even enough for logs and temporary files. Free up disk space, or move the "runtime data directory" to another drive.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Make every adb call in this process and the emulator share one server port
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // These four are independent, so run them in parallel: they used to run serially (accel check -> version -> port probe -> adb server reset),
    // wasting 3-5 seconds before a cold boot - exactly the time the user stares at the loading box after a tap.
    // An adb server left by the previous run may still hold stale device records (forcing the new emulator offline),
    // so the reset still happens, just without waiting for it separately.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Shares one entry point with the settings page / diagnostic report, so what is shown is what actually runs
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    const variants = doctor.planVariants(profile).slice(0, maxAttempts);

    // Remember a GPU backend that crashed right after launch and rank it last next time.
    // Measured: on an AMD Radeon 780M, `-gpu host` passes the emulator's own hardware check,
    // but the process exits 1 a dozen seconds after the VM starts (the log only says "AEHD is operational"),
    // wasting 20+ seconds each time before falling back to swangle. The key includes the emulator version,
    // so a runtime upgrade gives it another chance automatically.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`Last time the ${badGpu} render backend crashed on launch; trying ${variants[1].gpu} first this time`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

    // Screen specs stay fixed for the whole start, or each retry with a new resolution would keep wiping snapshots.
    // Resolution comes from doctor's profile ("quality" in settings) and follows the acceleration state when auto.
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Clear orphans before a cold boot: if qemu from the previous run still holds the AVD lock,
    // every attempt immediately hits FATAL "Running multiple emulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // Port conflicts also cause failures, so probe again on every retry
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // Reset the exit code each round: the previous round's 0xC0000005 must not leak into the next round's diagnosis
      this.lastExitCode = null;
      // Logs are split per round too: the in-memory log accumulates across rounds, so a round-1 crash line left at the tail
      // makes round 2 (say a port conflict after a backend switch) look like the same crash.
      const logStart = this._log.length;
      onLog(`Starting runtime (attempt ${i + 1}/${variants.length}: ${plan.label})…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe also takes part in "delete the old snapshot": after a data reset the old snapshot always fails to load
        // (measured as Failed to load snapshot followed by a cold boot), so it must be cleared before rebuilding.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Hook: the caller (main) uses it to start black-window suppression **before** the emulator is launched.
      // The console window appears tens of milliseconds after spawn; scanning afterwards always causes a flash,
      // so it must be enabled here before the process starts.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot applies to this spawn only, so later boots do not degrade into long cold boots
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Bad flags / a missing DLL exit immediately
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}: ${d.hint}`;
        // A full disk is not fixed by different flags: retrying just fails again,
        // and historically the last flag set carried wipe, erasing user data. Stop here and report it honestly.
        if (d.code === 'DISK_FULL') {
          onLog('Not enough disk space; retries stopped (your apps and saves are untouched).');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Acceleration/image conclusions may be stale cached data: drop them and re-probe on the next start
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}; retrying with a different set of parameters…`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // A snapshot restore often finishes in seconds, and a fixed 3-second poll means 1.5 seconds on average before noticing
      // it is ready. The interval starts at 200ms and widens to 1.2 seconds: early boot is caught at once,
      // and a long boot does not burn CPU on polling.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // If adb can run a shell, the kernel is booting; ordinary Vulkan/EGL lines in the log are not failures
        if (state === 'booting') sawBooting = true;
        // Still not connected at 45 seconds with a clear fatal error in the log -> switch plans early instead of waiting 4 minutes
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // One progress line every 15 seconds: the old modulo check could emit two or three duplicate
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Booting… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // This attempt really booted: clear the last failure record so diagnostics do not dig up old history
        this._clearFailure();
        // Always save a quickboot snapshot: the emulator process ends when ApkStart exits (Electron's
        // job object kills children), and whether a snapshot exists decides 25 versus 7 seconds on the next open.
        // After installing an app the installer drops the snapshot, avoiding "the app disappears after restart".
        this.snapshotWorthSaving = true;
        onLog(`Runtime ready (${Math.round(bootMs / 1000)}s, ${plan.label})`);
        // A successful boot is not usable yet: check the network too. Without it, network-dependent pages stay black,
        // and users only say "this app is black", rarely suspecting the network. So check once and state it clearly.
        let network = null;
        try { network = await this.checkNetwork(); } catch (_) { /* a failed check is not a failed start */ }
        if (network && !network.ok) {
          onLog('⚠ The Android VM currently has no network: apps that need internet access (such as short-drama apps) will stay on a black screen.'
            + 'Fix it in "Settings → Repair network" by resetting Android data (the app list is kept and apps reinstall automatically when opened).');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}: ${d.hint}` : 'Boot timed out (first boot may be slow or hardware acceleration may not be active)';
      onLog(`${lastError}; retrying with a different set of parameters…`);
      this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `The runtime could not start after several attempts (${d.title}).\n${d.hint}\n\n`
      + `Attempts: ${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('; ')}\n`
      + `Diagnostic report: ${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Save a quickboot snapshot (the next boot restores memory state directly, like WSA/Tencent's fast start).
   *
   * Timing matters: the old implementation saved 6 seconds after boot, competing with the user's app tap for disk I/O
   * (a snapshot writes 1-3GB) and felt slower. It now saves when idle, triggered by Runtime when
   * the last app window closes; if there was no chance before shutdown, one more attempt is made.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // The emulator's save command may return OK midway through writing, so confirm by file integrity,
    // and only a snapshot.pb actually on disk counts (otherwise the next load fails and wastes seconds).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Schedule one "save the snapshot when idle".
   * Scheduled once; if an app is still in the foreground when it fires, defer until genuinely idle.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // Skip when free space cannot hold the snapshot (memory size + 1GB): forcing it only fills the disk
        // and makes the next boot fail outright. A snapshot only affects start speed; skipping it loses no data.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Skipping snapshot save: ${(freeMB / 1024).toFixed(1)}GB free < ${(needMB / 1024).toFixed(1)}GB required`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Graceful stop: save a quickboot snapshot on slow machines, shut down via the console, then force-kill the tree */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // An adopted instance has no proc handle, yet something really runs on the port: do not just return true and leave
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    if (adbPath && this.snapshotWorthSaving !== false) {
      // Save once more before shutdown: when the idle path had no chance (say the user exits right after installing an app),
      // the next start can still restore from a snapshot instead of cold-booting.
      // Writing 3GB takes seconds to tens of seconds: allow a generous timeout so the snapshot is not killed midway.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // Let it finish its own "flush -> exit" flow. It used to be force-killed after a fixed 6 seconds,
    // cutting the snapshot write short and leaving a shell with ram.img but no snapshot.pb.
    //
    // Note this.proc must not be awaited: emulator.exe is only a launcher that exits after spawning qemu,
    // so treating its exit as "shutdown complete" jumps straight to the force-kill branch. The console port is authoritative.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    return true;
  }

  /**
   * Record a GPU backend that "crashes right after launch" and rank it last on the next start.
   * Applies to auto mode only: an explicit backend choice is respected and never changed silently.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // Software rendering is the fallback, already the slowest/stablest choice, with nothing worse to fall back to
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** Whether anything still runs on this instance's console port (5554) - decides "is it really shut down" */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /** Trigger one snapshot save via adb (returns false on failure; the caller decides whether to retry) */
  _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Return only the log lines produced by "this round's start attempt".
   * The in-memory log accumulates across rounds (the diagnostic report needs every attempt), but the conclusion must use this round only:
   * otherwise round 1's `emulator exit 3221225477` makes any round-2 failure look like the same crash.
   * With no lines this round (the process never started) fall back to the overall tail to give at least some conclusion.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Read the last n lines of emulator.log (used when the in-memory buffer is empty).
   * When the user restarts ApkStart and exports a diagnostic report, this._log in memory is already empty,
   * so the old report was left with a single UNKNOWN line - while the real crash cause sat in the log file.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // Reading from the start can truncate the first line, so drop it
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
