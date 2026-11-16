# ApkStart code walkthrough (for taking over development)

> Aimed at engineers who will **keep writing code in this project**. The goal is not to restate the README, but to answer three questions:
> **which layers the code has, which path each key action really takes, and where a change is most likely to break something**.
>
> Generated: 2026-11-14 · corresponds to **v0.3.5** (continued from v0.3.4 at commit `e1db34b`) · repository `RoutineMiku/apkstart`
> Baseline: `src/**` is 41 files, about 14,845 lines (js/html/css/ps1); `npm test` = **70 passed / 0 failed**.
>
> **How to read this documentation set**
> - Read this file first (overview + key call chains + problem map, about 360 lines);
> - Changing "install / parsing / icons / shortcuts" → `CODE-WALKTHROUGH-PARSE.md`;
> - Changing "download / deployment / source switching / online update / path rules" → `CODE-WALKTHROUGH-RUNTIME.md`;
> - Changing "boot / window embedding / mouse buttons" → sections 2.3–2.6 here + `docs/ARCHITECTURE.md`.

---

## 0. One-page overview

| Question | Answer |
|---|---|
| What is this | An "Android app runner" for Windows: an Electron shell plus a bundled Android runtime (Google Android Emulator / QEMU full-system virtualization) that installs each Android app as a desktop icon and opens it as a standalone Windows window |
| Architecture in one sentence | **The Electron main process orchestrates, `core/*` provides domain capabilities, a PowerShell window agent does the dirty Win32 work, and the renderer only draws UI** |
| What it does not do | No home-grown hypervisor, no Linux kernel/GPU translation, no NTFS mounting (the shared folder uses sync instead), no dependency on third-party emulators |
| Key dependencies | Zero third-party runtime dependencies with hand-written parsers (zip/AXML/ARSC/PNG/ICO); only `@napi-rs/lzma` (to unpack .xz images) + Electron |
| Where the data lives | Code data `%APPDATA%\apkstart` (settings.json / apps.json / icons / apks / logs), runtime `runtime.dir` (drive can change), AVDs `runtime.avdDir` (drive can change) |
| Where the version comes from | `package.json:version`, read via `app.getVersion()`; CI triggers releases on tags `v*` |

---

## 1. Repository structure

```
apkstart/
├─ src/
│  ├─ main.js                1790 lines  Electron main process: windows/tray/single instance/CLI/IPC/lifecycle
│  ├─ preload.js              130 lines  contextBridge security bridge (the renderer's only entry point)
│  ├─ ui/                              Renderer (plain HTML/CSS/JS, no framework)
│  │  ├─ index.html / app.js           Main window (app list + settings dialog), app.js 1490 lines
│  │  ├─ shell.html / shell.js/css     App window shell (38px title bar + launch overlay)
│  │  └─ assets/                       logo / appicon.ico / QR codes
│  └─ core/                            Domain layer (pure Node where possible, no Electron dependency)
│     ├─ orchestration  installer.js engine.js container.js
│     ├─ runtime        emulator.js provision.js userdata.js doctor.js layers.js
│     ├─ device         adb.js android.js sharer.js notify.js display.js
│     ├─ window         appwin.js agent.js win/agent.ps1 win/priority.ps1 windowctl.js pointer.js
│     ├─ parsing        zip.js axml.js arsc.js apk.js png.js shortcut.js assoc.js
│     └─ download/update download.js sources.js updater.js store.js logfile.js
├─ build/                     Packaging pipeline (pack.js / prepare-runtime.js / slim-runtime.js / zip.js / seed/)
├─ test/                     run-tests.js(8) + engine-test.js(11) + auto-test.js(53) + a set of live probe scripts
├─ tools/                    Release and live-check scripts (publish-gitee.js, check-*.js, e2e-boot.js)
├─ docs/                     ARCHITECTURE.md, images/, promo/, this file
├─ engine/                   Runtime download cache (gitignored, README only)
└─ .github/workflows/        ci.yml (dual Node testing), release.yml (portable + full + Gitee sync)
```

**Layering direction** (upper layers may depend on lower ones only):

```
ui/*  ──preload(contextBridge)──▶  main.js
main.js ──▶ installer.js / engine.js / appwin.js / updater.js / sharer.js …
installer.js ──▶ apk.js ──▶ zip.js / axml.js / arsc.js / png.js / shortcut.js
engine.js ──▶ emulator.js ──▶ provision.js(path/disk guard) + userdata.js(ext4) + adb.js
appwin.js ──▶ agent.js ──TCP JSON──▶ win/agent.ps1(C# P/Invoke)
All layers ──▶ store.js (settings/app-list persistence)
```

---

## 2. Key call chains (read these before changing code)

### 2.1 Double-click an APK → installed and a desktop icon appears

```
Double-click a .apk in Explorer
 → HKCU\Software\Classes\ApkStart.apk (registered by assoc.js, no admin rights)
 → ApkStart.exe "C:\x\a.apk"
 → main.js parseArgs() → runInstall(filePath)              main.js:537
     ├ re-entrancy guard: installBusy (repeated clicks/drops run only once)   main.js:540
     ├ installer.install()                                 installer.js:141
     │   ├ /\.(apks|xapk)$/ → parseBundle() (unpack split parts to a temp dir) installer.js:26
     │   ├ parseApk()  →  zip.js → axml.js → arsc.js        apk.js:75
     │   ├ isArmOnly(meta) && no Play image →
     │   │     ensureCompatImage() + switchToCompat()        installer.js:159
     │   └ runtime.ensure()  →  see 2.3
     ├ installer.finishInstall()                            installer.js:179
     │   ├ emulator.invalidateSnapshot() (old snapshots are invalid after install)
     │   ├ adb install -r -g -t (on NO_MATCHING_ABIS, switch to the compat image and retry)
     │   ├ write icon PNG + iconToIco() (WebP is decoded by the renderer) main.js:213 decodeIcon
     │   ├ back up the APK to apks/ (for automatic reinstall later)
     │   ├ resolveLauncher(): trust the LAUNCHER resolved by the system    adb.js
     │   ├ store.upsertApp()
     │   └ createShortcut(): two .lnk files, desktop + Start menu        installer.js:286
     └ notify / refresh the Explorer icon cache
```

**Why `resolveLauncher` must run after installation**: the "main Activity" parsed from the APK is often not the real LAUNCHER (for Hongguo Short Dramas it is `SplashActivity`, not `MainFragmentActivity`); using the wrong entry skips initialization → the app crashes 3–8 seconds later. See `docs/ARCHITECTURE.md`.

### 2.2 Double-click a desktop icon → the app window appears

```
<app name>.lnk → ApkStart.exe --launch <pkg> (the .lnk is written by shortcut.js with an AppUserModelId)
 → main.js parseArgs() accepts only the com.foo.bar form               main.js:201
 → instance already running? second-instance → runLaunch()             main.js:1477
 → runLaunch(pkg)                                                      main.js:606
     ├ openAppWindow(): immediately open a title-bar-only window + launch overlay main.js:286
     ├ armAgent(): first give the window agent a scope and enable resident suppression main.js:1547
     ├ installer.launch()                                             installer.js:385
     │   ├ runtime.ensure() (see 2.3)
     │   ├ beforeStart → prepareForeground() (immersive mode / disable animations / dismiss keyguard)
     │   ├ app not in the current runtime? reinstall automatically from the backup APK installer.js:404
     │   ├ grantRuntimePermissions()
     │   └ startApp() + staysAlive() (25s window / 4s continuous survival)
     │        on failure retry 3 times → pm clear + grant permissions → launch once more
     │        crash with evidence(APP_CRASHED) → switch to the compat image and retry
     ├ appWin.embed(): SetParent the emulator window in              appwin.js:213
     └ runtime.beginApp(pkg): stop other apps, raise priority, start sync/notifications engine.js:901
```

**Embedding is not "screencasting"**: it `SetParent`s the emulator's own Qt child window into the Electron host window, then `SetWindowPos`es it to the client-area rectangle. Therefore:
- the picture is natively rendered at native 60fps, and mouse/keyboard input goes straight to the guest;
- `app.disableHardwareAcceleration()` is mandatory, otherwise Chromium's DirectComposition layer covers the child window (`main.js:72`);
- when closing, you must **park first (`SetParent(NULL)` + `SW_HIDE`) and then destroy the host**, otherwise Windows re-parents the child window to the desktop (`appwin.js:318` / `agent.ps1:990`).

### 2.3 `runtime.ensure()`: what one boot actually does

`engine.js:796 _ensureInner()`, tried in order; **the first successful step returns**:

1. `client.isOnline()` → a device is already online: call `prepare()` and reuse it;
2. `adoptExisting()` (`engine.js:708`) → scan emulator ports that are still alive (`tasklist` + `netstat` to find qemu's listening port instead of guessing 5554), `adb kill-server`, then `connect` each one and check `getprop sys.boot_completed`; adoptable instances are reused directly;
3. `adb devices` already lists `emulator-NNNN` → reuse it;
4. process exists but the device is offline → `emulator.stop()` and start over;
5. `engine.mode === 'attach'` → probe the common ports of WSA/MuMu/LDPlayer/Nox/MEmu (advanced path);
6. default path:
   - `provisioner.materializeImages()` expands the `.xz/.gz` system image (already-expanded images pass instantly);
   - `checkEnv()` checks whether adb/emulator/sysimg are all present;
   - `killOrphanEmulators()` clears leftover qemu processes (otherwise the AVD lock causes FATAL);
   - `bootEmulator()` → `emulator.start()` (see 2.4) → on success `prepare()` (ensureFreeform + watchdog) → save an idle snapshot 20s later.

The outer `ensure()` is an **idempotent Promise** (`engine.js:787`): prewarming and a user click at the same time start only one machine, avoiding an AVD lock conflict.

### 2.4 `emulator.start()`: a boot loop with automatic fallback

The core of `emulator.js` is "`doctor.planVariants()` produces up to 4 parameter sets → try them one by one → judge each with probe → move to the next set on process crash/fatal log":

- parameters are derived by `doctor.chooseProfile()` (memory/cores/LCD/GPU/data partition/port); `liteMode` caps vCPUs at a quarter of physical cores (2–3);
- `gpuMode=auto` picks the backend by emulator version (`host` for 37.x, `swiftshader_indirect` for older builds), with `software` as the floor;
- `badGpu` remembers the backend that "crashed right after launch" last time (the key includes the emulator version, so upgrades invalidate it automatically);
- each probe round sends **one** adb command (`getprop sys.boot_completed; pm path android`); after 6 consecutive failures it calls `resetAdbServer()` to self-heal;
- **the `/data` partition is created by ApkStart itself** (`userdata.js` + `ensureDataPartition()`, `emulator.js:348`): the `userdata.img` in the official image is only a 1MB zero-filled placeholder, and launching `emulator.exe` directly skips formatting → the guest falls into a recovery reboot loop. So the first boot writes a 4KB-block ext4 by hand (with `FILETYPE|ENCRYPT` and `ext_attr`) and grows it to the configured capacity with the bundled `qemu-img resize` + `resize2fs`.

### 2.5 Storage/path rules (every drive-change issue lives here)

| Concept | Code location | Default | Drive can change |
|---|---|---|---|
| Code data directory `DATA_DIR` | `store.js:10` | `%APPDATA%\apkstart` | No (caches are moved to the AVD drive by `relocateUserDataIfCrowded()` when C: is tight, `main.js:50`) |
| Runtime root `paths().root` | `provision.js` | `DATA_DIR\runtime` | Yes: `runtime.dir` |
| AVD directory `paths().avdHome` | `provision.js` | `DATA_DIR\avd` | Yes: `runtime.avdDir` |
| System image expansion directory `paths().sysImgRoot` | `provision.js` | `DATA_DIR\system-images` | Follows the runtime root (**must use the same rules as `materializeImages`' destRoot**; two copies once ended up on C:) |
| Shared folder | `store.js:99` | `%USERPROFILE%\ApkStartShared` | Yes: `sharedDir` |

### 2.6 Window agent (`agent.ps1`): why it exists

Node's `windowsHide` cannot reach the `qemu` / `netsimd` console windows that the emulator detaches on its own (the windows belong to `conhost.exe`, whose pid does not match). So there is a **resident PowerShell process** embedding C# + P/Invoke, driven over local TCP with one JSON per line:

| Command | Effect |
|---|---|
| `scope {dirs, pid}` | Declares "processes in these directories are ours" + the main process pid. **Without a scope it touches no window at all** |
| `embed {host,x,y,w,h}` | `SetParent` + `SetWindowPos` into the host window; rejects if the host pid is not the main process (`host-not-ours`) |
| `fit` | Re-layout the child window when the host resizes/moves |
| `park` | Detach + hide (must happen before the host is destroyed) |
| `boothide on/off` | Resident suppression: periodically `ShowWindow(0)` the emulator main window/toolbar/console black windows, skipping the embedded one |
| `hook on/off {right,wheel,side}` | Global mouse hook (right-click back / wheel merging / side buttons), **installed only while an app window is in the foreground, uninstalled on focus loss** |
| `rotate` / `hide` / `show` / `probe` / `windows` / `consoles` / `quit` | Everything else |

**The core lesson from v0.3.4: a class name is not an identity; the process path is.** The old build recognized windows by `QWindowIcon`, and WeChat 4.x is Qt6 with exactly the same class name → "open ApkStart and the WeChat window disappears". Now every decision first passes `IsOurs(pid)` (`agent.ps1:168`), and console black windows go through the conhost parent-process chain + a title containing a scope directory (`agent.ps1:219`).

---

## 3. Layer responsibilities and key interfaces

### 3.1 `main.js` (main-process orchestration)

| Area | Lines | Notes |
|---|---|---|
| Pre-start decisions | 40-72 | `relocateUserDataIfCrowded()` (move caches when C: is tight), `disableHardwareAcceleration()` |
| Full-edition auto-adoption | 97-171 | A `runtime/` directory + any complete image next to the exe → write `runtime.dir` and enable compatibility mode automatically; requires `sameTree` (only trusts the current EXE's directory tree), preventing a moved portable build from reusing an old bundle |
| Single instance + arguments | 196-209, 1473-1482 | `--launch <pkg>` / `<path.apk>` / `--autostart`; second-instance is dispatched to the running instance |
| Tray | 468-530 | First 8 apps directly, fullscreen toggle, rebuild shortcuts, check for updates, quit |
| Install | 537-573 | `runInstall()`: re-entrancy guard + a system notification popped only once per error |
| Launch | 606-662 | `runLaunch()`: see 2.2 |
| Update | 579-604 | `runUpdate()`: `updater.prepare()` → `apply()` → exit and let the script take over |
| IPC | 702-1469 | About 120 channels grouped by domain (apps/apk/settings/display/runtime/provision/doctor/android/update/window/shell) |
| Lifecycle | 1484-1790 | `whenReady` wires up all objects; `before-quit` exits in two phases (park windows first, then quit for real) |

**IPC naming convention**: `domain:action`; the renderer may only call through `window.apkstart.*` exposed by `preload.js`, and event pushes are allowlisted (`preload.js:120`).

### 3.2 `core/engine.js` (runtime lifecycle)

Exports `class Runtime`: `ensure / prewarm / boot / stop / adoptExisting / beginApp / endApp / status / diagnostics / cleanup / dispose`.
Key invariants:

- `ensure()` and `prewarm()` are both idempotent Promises;
- `dispose()` **never force-kills qemu** (killing it truncates a quickboot snapshot being written → next boot can only be cold);
- an adopted instance has no local proc handle, so `vmRunning` must also check `adb isOnline()`, otherwise the watchdog can never reclaim it;
- the idle-reclaim watchdog runs every 60s: it stops only when `idleShutdownMinutes` has elapsed and no app is active.

### 3.3 `core/emulator.js` (emulator adapter)

Responsibility: AVD creation/parameter generation/process launch/probe/snapshots/priority/ports/orphan cleanup/data partition. Public API: `start/stop/running/scheduleSnapshotSave/saveSnapshotNow/cancelSnapshotSave/invalidateSnapshot/ensureDataPartition/resizeDataPartition/dataInfo/setPriority/killOrphanProcesses/resetAdbServer/versions`.
Pitfalls are concentrated in the header comment (`emulator.js:330-347`): block size must be 4096, the `encrypt` bit must be applied last, `ram.bin` vs `ram.img`, and `emulator.exe` is only a launcher.

### 3.4 `core/adb.js` (device operations)

`class AdbClient`: `isOnline/shell/exec/install/installMultiple/uninstall/startApp/forceStop/clearData/runningPackages/wmSize/setOrientation/keyBack/keyForward/input/prepareForeground/grantRuntimePermissions/dismissPermissionDialog/resolveLauncher/ensureFreeform/devices/connect/killServer`.
Performance key: a **resident `adb shell` input channel** (`input()` uses `echo __APKSTART_<id>__` for replies/backpressure); right-click back and wheel input no longer spawn one adb process per notch.

### 3.5 `core/installer.js`

See 2.1. Two additional "auto-repair" paths are worth remembering: `switchToCompat()` (after switching images, reinstall already-installed apps from their backup APKs) and `ensureShortcuts()` (backfill icons/shortcuts that older versions failed to create).

### 3.6 `src/ui/`

- `app.js`: a single-file state machine (a `state` object plus a set of render functions), no framework; every backend call is `await window.apkstart.xxx()`;
- install progress: `installFiles()` uses a sticky toast + the `install:progress` event, and **on failure calls `off()` before `dismiss()`** (this was the cause of the old "failure message loops forever");
- `shell.html/js`: the app window shell, with only rotate/minimize/maximize/close buttons + a launch overlay.

### 3.7 Persistence `core/store.js`

`getSettings()` runs `deepMerge(DEFAULT_SETTINGS, disk values)` every time and **force-migrates** three historical settings (`headless=false` / `hideAfterLaunch=false` / `freeform=false`);
`saveSettings()` writes tmp + rename (atomic write) and handles the translation of `resourceMode` → `liteMode/priorityMode/renderSize`.
`apps.json` is an array `{ apps: [...] }`; `upsertApp` merges by `package`.

---

## 4. Build / release pipeline

| Command | Script | Output |
|---|---|---|
| `npm run pack` | `build/pack.js` | `dist/ApkStart-win64-portable/` (~226MB unpacked; downloads the runtime on first launch) |
| `node build/zip.js <dir> <zip>` | `build/zip.js` | 7-Zip `-mx=9` archive + self-verification with the app's own zip parser; **fails outright above 100MiB** (Gitee per-file limit) |
| `npm run runtime` | `build/prepare-runtime.js` | `build/runtime/` (slimmed emulator + xz/gz images + `build/seed/userdata.img.gz`) |
| `npm run build:exe` | the two steps above + `electron-builder --win nsis` | `dist/release/ApkStart-<ver>-Setup.exe` (~1.32GB, bundled runtime) |
| `npm test` | `run-tests.js` + `engine-test.js` + `auto-test.js` | 70 pure Node tests |
| `npm run test:boot` | `test/boot-test.js` | Real Alpine guest boot verifying QEMU arguments/disk creation/graceful shutdown |
| `npm run selftest` | `scripts/selftest.js` | End-to-end acceptance on an installed device (adb/version/freeform/shared folder; `--apk` runs install → launch → screenshot) |

`.github/workflows/ci.yml`: Windows × Node 20/22 runs `npm test` + `test/pointer-hook-logic.ps1` (to keep the mouse buttons from being broken).
`.github/workflows/release.yml`: tag `v*` → `build` job (portable zip → GitHub Release → sync to Gitee; a missing `GITEE_TOKEN` fails outright instead of silently skipping) + `full` job (assemble runtime → xz → NSIS Setup → upload Release + runtime bundle zip).

**Release checklist** (summarized from past incidents):
1. `package.json` version must be bumped (otherwise the client says "already up to date");
2. If `.github/release-notes-<tag>.md` exists it is used, otherwise `--generate-notes`;
3. The `full` job takes ~40 minutes (xz compressing 1.1GB);
4. Gitee is published with `tools/publish-gitee.js`, preferring a single archive and splitting only when over the limit;
5. After release, verify "release package == code": check that `agent.ps1` inside the zip contains `SetScope`/`IsOurs`, and check the `package.json` version.

---

## 5. Tests and live verification tools

- **Pure Node regression** (always run in CI): `test/auto-test.js` covers the doctor parameter matrix, the container state machine, the downloader/dual-source logic, pointer logic, log rotation, etc.;
- **Live probes** (run manually on a real machine; cannot run in the sandbox): `tools/check-windows.js` (window leaks during boot), `check-console.js` (black windows), `check-launch-clean.js` (install + open + embed), `check-quit-clean.js` (leftovers after exit), `check-update.js` (real GitHub API), `e2e-boot.js` (cold/hot boot timing);
- **UI smoke**: `electron . --smoke out.png`, with `--settings` / `--perf` / `--download` capturing the respective settings sections;
- **PowerShell logic tests**: `test/pointer-hook-logic.ps1` drives the hook callback through reflection; `agent-compile.ps1` only verifies that the C# compiles.

> Measured environment on this development machine: **Node 22.22.2 / npm (`.workbuddy/binaries/node`)**, **PortableGit 2.55**, Electron 33.4.11 (`node_modules/electron/dist`), runtime `D:\ApkStartRuntime` (emulator 37.3.9.0 + AEHD Operational), AVDs `D:\ApkStartData`, data `%APPDATA%\apkstart`.

---

## 6. Current problem map (what to look at first when taking over)

### 6.1 Known hot bugs (matching GitHub issues)

| Issue | Symptom | Code location identified |
|---|---|---|
| #21 Install 2GB+ hangs | Large APK errors and "the bottom-right spinner keeps turning" | `apk.js:78` `fs.readFileSync(filePath)` reads the whole package, hitting Node's single-Buffer limit; should use the existing `ZipFile` in `zip.js` (fd-based streaming read of the central directory) |
| #20 / #25 Cannot boot (0xC0000005) | After printing Userspace boot properties, the emulator `exit 3221225477` | Both cases are NVIDIA + emulator 37.3.9.0 + `-gpu host`; this machine runs the same version and can reproduce it in place |
| #26 Install too slow / stuck preparing runtime | First deployment stalls on downloads | `provision.installRuntimePack()` / the per-component official-source path; Gitee rate-limit trip |
| #23 Portable build still downloads to AppData after setting the runtime directory | Inconsistent path rules | The linkage between `paths().root` and `materializeImages` / `sysImgRoot` (see 2.5) |
| #27 / #28 WeChat and UU Remote windows get hidden | Fixed in v0.3.4 (scope/IsOurs) | `agent.ps1:168`; users only need to upgrade |
| PR #18 / #22 | Duplicates of already-merged work | #18 was superseded by `b3fc7c2`; #22's `_qemuImg` argument order was fixed at `emulator.js:403` |

### 6.2 Confirmed implementation defects (found line by line while reading, not yet fixed)

| # | Location | Defect | Impact |
|---|---|---|---|
| 1 | `apk.js:78` / `installer.js:27` | `fs.readFileSync` reads the whole APK | Must explode at 2GB+ (issue #21); parsing large packages is also risky on low-memory machines |
| 2 | `zip.js` throughout | **No Zip64** (`zip.js:29-30,37,161-162,180`) | More than 65535 entries silently drops entries; a single entry >4GiB throws `RangeError` (system images/update packages will hit this sooner or later) |
| 3 | `assoc.js:62-63` | The "preserve the user's existing association" promised in the comment does not exist; uninstall unconditionally clears the `.apk` default | The user's original APK association is wiped; the module has zero tests |
| 4 | `logfile.js:19-21` | When `bak === file` it deletes before renaming | Non-`*.log` filenames lose logs (`appLog` happens to be `app.log`, which is why it never surfaced) |
| 5 | `provision.js:531` + `sources.js:412` | Deployment pins `percent:1` at the start, then measures each address **serially** for up to 9s | 4 candidates = 30s+ of zero progress → users think it is "stuck preparing the runtime" (issue #26) |
| 6 | `provision.js:575-576` / `:790` | `.xz` expansion failures are swallowed by two `catch` layers | Progress sits at 99%, then jumps back to "download from the official source", wasting a full 1.4GB download |
| 7 | `provision.js:262-277` | `guardDisk`'s `need` table lacks a `'runtime'` entry and estimates only 1536MB | The bundle plus expansion is really about 5GB; the guard passes and the disk can still fill up |
| 8 | `updater.js:80` | Portable-edition fallback `/\.zip$/i` | A release containing only `ApkStart-runtime-*.zip` is mistaken for an update package and unpacked into the program directory |
| 9 | `main.js:165-168` | `bootstrapBundledRuntime()` overwrites the user-set `runtime.dir` when the portable directory contains `runtime` | "Set the runtime directory and it still downloads to AppData" (issue #23) |
| 10 | `main.js:213` / `shortcut.js:120` | WebP icons depend on a hidden BrowserWindow to decode | In pure Node / no-GUI contexts it silently degrades to a brand placeholder, and "decoding failed" is indistinguishable from "no icon" |
| 11 | `apk.js:29,67` | The icon format allowlist has only `.png`/`.webp` and does not recurse into XML `<bitmap>` | `.jpg` icons and adaptive-icon combinations extract the wrong image |
| 12 | `arsc.js:65-77` | Config scores are guessed constants (`anydpi` penalty 500, `language` penalty 40) | Chinese apps may get an English name; the three entry encodings have zero tests and silently fall back to defaults on error |

### 6.3 Structural improvements (for the next phase)

1. **Unify the large-file path**: switch `apk.js` / `installer.parseBundle()` to the existing `ZipFile` (fd streaming, from `zip.js:128`) — peak memory drops from "file size" to "a few MB", which also removes the 2GB ceiling. Note the two classes differ in `read()` semantics (`ZipArchive` returns null / `ZipFile` throws), so add `has()` checks when replacing;
2. **Add Zip64**: when the EOCD contains `0xffff/0xffffffff`, locate the Zip64 EOCD (`0x06064b50`) and locator (`0x07064b50`) and replace the 4 fields with u64;
3. **Split large files**: split `main.js` (1790 lines) into `src/main/ipc/*.js` by domain; split `emulator.js` (1064 lines) into "parameter matrix / snapshots / data partition";
4. **Weak diagnostics** (`attempts: []`, `bootLog: []` in #20/#25 reports): on failure, write `emulator.attempts` and the tail of emulator.log into the diagnostic report, and translate exit codes into plain English (`3221225477` = 0xC0000005 access violation);
5. **GPU compatibility layer**: `-gpu host` crashes on some NVIDIA drivers + emulator 37.3.9; extend the `badGpu` mechanism with "exit code 0xC0000005 → downgrade automatically and remember";
6. **Test gaps** (ordered by risk): AXML/ARSC have no synthetic byte-level cases (the whole section is skipped when real APK fixtures are missing → zero CI coverage), `arsc.resolve()` has zero assertions, `.apks/.xapk` have no cases, `assoc.js` has zero coverage, `pngToIco`/`writeShortcut` are not in `npm test`;
7. **Gitee assets differ from GitHub** (for v0.3.4 Gitee only has the portable package): the release flow already has `publish-gitee.js`, but CI needs the `GITEE_TOKEN` secret to avoid failing.

### 6.4 Most fragile links in the deployment chain (11-item quick reference)

| Symptom (user's view) | Code location | Mechanism |
|---|---|---|
| Stuck at "preparing runtime" 1–3% | `provision.js:531` + `sources.js:412` | Serial speed tests, no byte progress |
| Stops at 99% then jumps back to "use official source" | `provision.js:575-576,790` | `.xz` expansion failure swallowed |
| "Set the runtime directory and it still downloads to AppData" | `provision.js:217-224,726` + `main.js:165-168` | `sysImgRoot`'s three branches keep the old directory + full-edition adoption overwrites the setting |
| Disk is big enough but it reports no space | `provision.js:262-277` | The guard only estimates 1.5GB |
| Progress stuck at 95% | `download.js:446-503` | Slow source drags the tail chunk; low-speed source switching + guaranteed settle already added |
| The whole download is wasted after a connection drop | `download.js:155,188-191` | Seeing a partial file downgrades to a single stream |
| Update stuck at "replacing program" | `updater.js:271,280-285,315-323` | The overwrite script **must not be detached**; security software blocks it |
| 1.5GB of extra files in the program directory | `updater.js:80` | The runtime bundle is treated as an update package |
| A Gitee release has no installer | `release.yml` + `sources.js:172-204` | A missing token fails outright; parts must be numbered part1..N contiguously |
| Still using the old address after switching sources | `main.js:819-825` | `provision._cache.*` has no invalidation entry; a restart is required |
| AVD judged "already in use" | `layers.js:87-90` + `engine.js:856` | Leftover `*.lock`; the cleanup panel reclaims it |

> **Three "look here first" notes for the next maintainer**
> 1. One function explains 80% of deployment problems: `Provisioner.checkEnv()` (`provision.js:367`);
> 2. There is exactly one place for path rules: `Provisioner.paths()` (`provision.js:197`); any new code writing runtime files must get its paths from there;
> 3. Download strategy is centralized in `Sources` + `downloadMulti`; do not write a second copy inside `provision.js`.

### 6.5 Local fix log (v0.3.5-dev, unreleased, not pushed)

2026-11-14, second development round: local workspace only; `npm test` grew from **98 to 113, all green**
(run-tests 3→8 + engine-test 25 + auto-test 70→80, adding regression cases for synthetic APK / .xapk split packages /
materializeImages / Zip64 / update assets / 0xC0000005 / log edge cases / failure persistence / launch component stitching),
plus one real end-to-end verification of cold boot (25s) / hot boot (5s, snapshot hit) / graceful shutdown (snapshot saved);
**measured on a 2.15GB synthetic APK: parse 18ms, process RSS 47MB** (the old path needed about 2.2GB of contiguous memory),
`assoc` was exercised against the real local registry in a "backup → register → unregister → restore" loop
(the machine's original association was `MuMuPlayer.apk`, restored exactly).

| # | What was fixed | Location | Why |
|---|---|---|---|
| 1 | `parseApk` / `parseBundle` switched to the file-based streaming ZIP reader | `apk.js:80-95`, `installer.js:27-60` | 2GB+ APKs no longer hit Node's single-Buffer limit; each part of a split package is also streamed to disk |
| 2 | ZIP supports Zip64 (EOCD locator + extra id=0x0001) | `zip.js:9-92`, `zip.js:151-236` | More than 65535 entries is no longer silently truncated; huge entries no longer overflow or lose offsets |
| 3 | `adb install` timeout scales with package size (capped at 20 minutes) | `adb.js:105-114` | Pushing + dexopt of a 2GB package exceeds a fixed 4 minutes |
| 4 | Deployment: speed tests now report progress (source i of n, 6s each) | `sources.js:408-424` | "Stuck preparing runtime" is no longer 30 seconds without progress |
| 5 | Image expansion failures are no longer swallowed; write `.part` + atomic rename; "already expanded" now means not smaller than the archive (partial images are re-extracted) | `provision.js:766-826` | The old build sat at 99% then went back to the official source for another 1.4GB; a partial system.img was treated as complete |
| 6 | `guardDisk('runtime')` gains a 5000MB estimate | `provision.js:262-268` | The bundle plus expansion peaks at about 4.7GB; the old estimate was 1.5GB |
| 7 | A user-set runtime directory is no longer overwritten by a bundled runtime | `main.js:136-162` | Issue #23 "set the directory and it still downloads to AppData" |
| 8 | Updater fallback `.zip` excludes `ApkStart-runtime-*.zip` | `updater.js:73-88` | Prevents a release missing the portable package from unpacking the 1.5GB runtime bundle as a program package |
| 9 | 0xC0000005 diagnostic rule + automatic GPU downgrade + failure persistence | `doctor.js:320-330`, `emulator.js` (`describeExitCode` / `_persistFailure` / `lastFailure` / `tailLogFile`), `engine.js:diagnostics` | Issues #20/#25: the root cause of `attempts: []`, `bootLog: []` and UNKNOWN was that the data only lived in memory |
| 10 | `assoc` restores the user's original `.apk` association on uninstall | `assoc.js:40-135` | The old implementation unconditionally cleared the default (the protection promised by the comment did not exist) |
| 11 | Log rotation `bak === file` boundary guard | `logfile.js:15-30` | Non-`.log` filenames were deleted before rename, losing logs |
| 12 | Icons: jpg added to the allowlist, XML icons recursed 3 levels, placeholders distinguishable with a soft warning | `apk.js:27-115`, `shortcut.js:109-140`, `installer.js:210-235,289-300` | `.jpg`/adaptive-icon/layer-list icons no longer all become placeholders; users are told when extraction really fails |
| 13 | Install-failure UI: errors are funneled through `install:error` and the "installing" spinner is cleared | `ui/app.js:469-520,1446-1460`, `main.js:566` | Issue #21 "it errored but the bottom-right spinner keeps turning" |
| 14 | New "synthetic APK" regression test: self-made AXML manifest + PNG icon + ABI directories, covering `attributeStart` base, non-namespaced `package`, integer attributes and launcher Activity resolution; `.xapk` split packages and `materializeImages` (expand/skip/no partial image on failure) have dedicated cases | `test/lib/make-apk.js`, `test/run-tests.js`, `test/auto-test.js` | axml/apk had zero CI coverage when real APK fixtures were missing; image expansion is the most fragile deployment step |
| 15 | **After a fresh install, clicking the icon shows only the Android launcher**: `startApp` unconditionally concatenated `${pkg}/${activity}`, while `resolveLauncher`/new install records store the full component `pkg/class` → the `am start` component became `pkg/pkg/class` and the system cancelled it (result code=-92). Added `componentArg()` to normalize both forms and `parseResolvedActivity()` to tolerate trailing blank lines/priority lines | `adb.js:105-131,520`, `test/auto-test.js` | This is an **upstream bug** found during live testing (also present in v0.3.4); it only affects "apps that were freshly installed/reinstalled", while old apps.json entries (bare class names) do not trigger it |

> Still not done (left for the next round): split `main.js` IPC, split `emulator.js`, make `arsc` config scoring configurable,
> extract the tray/update menus from `main.js` (1790 lines), synthetic byte cases for `arsc.js` (`axml.js`/`apk.js`
> are already covered by the "synthetic APK" cases in `test/run-tests.js` and no longer need external fixtures).

---

## 7. Appendix: module quick reference

### 7.1 `src/core` export signatures

| Module | Main exports |
|---|---|
| `store.js` | `DATA_DIR/ICON_DIR/APK_DIR`, `getSettings/saveSettings/getApps/saveApps/upsertApp/removeApp/getApp/iconPath/apkPath/ensureDirs/DEFAULT_SETTINGS` |
| `engine.js` | `class Runtime`, `MONITOR_PORT` |
| `emulator.js` | `class EmulatorEngine` |
| `provision.js` | `class Provisioner` (`paths/checkEnv/installAdb/installEmulator/installSystemImage/installPlayImage/installAehd/installQemu/materializeImages/installRuntimePack/guardDisk/emulatorAccel/hypervisor`) |
| `installer.js` | `class Installer`, `accentOf` |
| `adb.js` | `class AdbClient`, `friendlyInstallError`, `friendlyLaunchError` |
| `apk.js` | `parseApk` |
| `zip.js` | `class ZipArchive` (whole package in memory), `class ZipFile` (fd streaming) |
| `appwin.js` | `class AppWindow`, `TITLEBAR_H` |
| `agent.js` | `class WinAgent`, `AGENT_SCRIPT` |
| `doctor.js` | `hostInfo/freeDiskMB/gpuCandidates/lcdFor/shortPath/liteProfile/chooseProfile/overridesFromSettings/autoProfile/planVariants/isPortFree/snapshotKey/imageIdentity/diagnose/describeProfile/writeReport/vcRedistOk` |
| `updater.js` | `class Updater` (`check/prepare/apply`, `repoUrl`) |
| `sources.js` | Dual-source enumeration/speed test/cache/circuit breaker (details in `_wip-provision-stack.md`) |
| `download.js` | `downloadMulti` / single stream / resume / watchdog (details in the same file) |
| `container.js` | `nextSessionState/buildSessionCommands/buildIdleCommands/buildRestoreCommands/NEVER_TRIM` |
| `pointer.js` | `pointerOptions/hookOptions/wheelToSwipe/WheelRouter/isInputCommand` |
| `layers.js` | `summary/prune` (container layer inventory and reclamation) |

### 7.2 Related documents

- `docs/ARCHITECTURE.md`: user-facing architecture and design trade-offs (including the "container model" and "mouse buttons" sections);
- `docs/CODE-WALKTHROUGH-PARSE.md`: **file-by-file walkthrough of the offline parsing stack** (zip / AXML / ARSC / PNG / apk / shortcut / assoc / version / logfile / display), with each file's interface signatures, line-level pitfalls, call sites, test coverage and memory profile;
- `docs/CODE-WALKTHROUGH-RUNTIME.md`: **file-by-file walkthrough of the download/deployment/update stack** (sources / download / provision / updater / store / layers / notify / android), covering dual-source selection, chunked mixed-source downloads, resume, path rules, the update overwrite script and a 14-item deployment troubleshooting table.

### 7.3 What requires a real machine to verify (not covered by the sandbox/CI)

- The full boot flow and window leaks: `tools/check-windows.js`, `check-console.js`, `check-launch-clean.js`, `check-quit-clean.js`;
- Cold/hot boot timing: `tools/e2e-boot.js` (historical data: cold boot ~23s, snapshot hit ~5s, end-to-end including pre-probe 30.7s / 13.7s);
- The update path: `tools/check-update.js` (real GitHub API + real overwrite script);
- Mouse buttons, embedding, rotation: `test/pointer-hook-logic.ps1`, `test/embed-probe*.ps1`, `test/win-*.ps1`.
