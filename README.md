# ApkStart

<p align="center"><img src="docs/images/logo.png" alt="ApkStart Logo" width="160" /></p>

[![CI](https://github.com/RoutineMiku/apkstart/actions/workflows/ci.yml/badge.svg)](https://github.com/RoutineMiku/apkstart/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/RoutineMiku/apkstart?include_prereleases&sort=semver)](https://github.com/RoutineMiku/apkstart/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6.svg)](#)

**An Android app runner for Windows — install and use Android apps the way you use native Windows software.**

- 🖱️ **Double-click an .apk to install**: once the .apk association is registered, double-clicking an APK in Explorer parses it, installs it and creates a desktop icon — without ever opening an emulator UI.
- 🧩 **One desktop icon per app**: the icon is extracted offline from inside the APK and converted to a multi-size ICO. Double-clicking the icon launches that app directly, just like opening a native Windows program.
- 🪟 **An app is a window**: the runtime starts in **windowed** mode (headless mode gets no VSYNC from Android, so the app process is alive but the screen stays blank). ApkStart retitles that window, gives it the real app icon and lays it out in portrait ratio — so it becomes a standalone app window. **Fullscreen** fills the screen height and centers itself; **window mode** can be dragged and resized freely, remembering each app's size.
- 🔍 **Findable in Windows search**: installation creates both a desktop shortcut and a Start menu shortcut (`Programs\ApkStart\`), so typing the app name in Start search takes you straight there, and the taskbar groups by app.
- 📁 **Shared data**: `%USERPROFILE%\ApkStartShared` is continuously synced both ways with `/sdcard/ApkStartShared` inside Android, so files an Android app saves show up on the host immediately.
- 🪶 **Extremely light**: the shell itself has zero third-party dependencies (even ZIP / PNG / ICO / AXML parsing is hand-written); the runtime starts on demand and is reclaimed when idle. You can also reuse an existing Android runtime on your machine, adding zero extra footprint.

![Main window](docs/images/app.png)

```
┌────────────────────────────────────────────────────────────┐
│  Desktop icon (real app icon, .lnk)                        │
│      │  double-click                                       │
│      ▼                                                     │
│  ApkStart.exe --launch <package>                           │
│      │  Runtime not running? → start it (Android Emulator  │
│      │  + API 34)                                          │
│      ▼                                                     │
│  Launch via the LAUNCHER entry the system resolves         │
│  (not the main Activity inside the APK)                    │
│      │  Watch for 18 s; on crash: retry / reset data /     │
│      │  grant missing permissions                          │
│      ▼                                                     │
│  Emulator window = app window (retitled, re-iconed,        │
│  portrait ratio, centered in fullscreen)                   │
└────────────────────────────────────────────────────────────┘
```

## Download and run (no build required)

Both sources carry identical content; from China, Gitee is usually faster:

- GitHub: [github.com/RoutineMiku/apkstart/releases](https://github.com/RoutineMiku/apkstart/releases)
- Gitee: [gitee.com/daily-miku/apkstart/releases](https://gitee.com/daily-miku/apkstart/releases) (much faster direct connection inside China)

Installers:

- **`ApkStart-v*-Setup.exe`** (about 1.3 GB): **a single EXE with the complete runtime** (adb / Android Emulator / system image). After installation, the first launch expands the image into your user directory, and **nothing is downloaded afterwards**. It installs into the current user directory and does not require administrator rights.
- A lightweight `ApkStart-v*-win64-portable.zip` (**95 MB**, about 226 MB unpacked) is also available: it downloads the runtime in the background on first launch. The runtime download source is **this project's own GitHub Release** (`ApkStart-runtime-*.zip`, the full bundle), not dl.google.com; it only falls back to the official sources when the bundle is unavailable.

### Online update (picks the faster source automatically)

Settings → **Software update** → "Check for updates", or right-click the tray icon → "Check for updates". When a new version appears, click "Update now".

- The installer edition downloads `ApkStart-v*-Setup.exe` and installs silently.
- The lightweight edition downloads `ApkStart-v*-win64-portable.zip` and unpacks it over the **program directory**. The runtime directory (`%APPDATA%\apkstart\runtime`), installed apps and snapshots do not live in the program directory, so updates lose nothing.
- The replacement is performed by a separate PowerShell script (wait for the main process to exit → overwrite → relaunch). There is **no "please close the program manually" dialog**, and no emulator window is left behind on the desktop.

The update path does not hard-wire GitHub; it **measures and picks a source on every run**:

1. Ask both GitHub and Gitee for their latest version and take the higher one (a timeout or block on one source does not affect the other).
2. List "direct source / same-named asset on Gitee / mirror prefix" as candidates and really download 256 KB from each to measure speed, counting throughput only **after the first byte arrives** (handshake time is excluded, otherwise a high-latency high-bandwidth source would be misjudged as slow).
3. Sort by measured speed, download in parallel chunks from the fastest one, and fail over to the next on error.

The "Download and update source" setting can force a single side (useful on corporate networks that only allow one domain), disable public acceleration mirrors, or use your own mirror prefix. Gitee caps attachments at 100MB per file; the portable bundle compressed with 7-Zip deflate (`-mx=9`) is **95.0MB**, so the Gitee build is also a single archive you can unzip directly (older releases had to be split into `.part1/.part2` and reassembled by hand; that approach is retired). The same-named bundles on the two sources are not byte-identical in size, but the client downloads from only one source per update and never mixes chunks.

Both repositories are public, and the Gitee release list is readable anonymously — no token is needed. (Only when Gitee rate-limits you with 403/429 do you need to enter a read-only token in Settings to raise the quota.)


**Defaults out of the box** (nothing to look up in Settings):

- Starts with Windows and stays in the tray; double-clicking a desktop icon goes straight into the app.
- Installing an APK creates **desktop + Start menu** shortcuts, so Windows search finds the app name directly; shortcuts missed by older versions are backfilled on startup.
- App windows are natively rendered (not screencast): **fullscreen** fills the screen height and centers while keeping the phone ratio undistorted; **window mode** stays portrait, can be dragged and resized freely, and remembers each app's size. Press `F11` or use the tray menu to switch at any time.
- Runtime permissions requested by the app are granted automatically after installation, so it never stalls on a system permission dialog; if an app crashes, ApkStart retries automatically and, when necessary, resets app data before relaunching.
- **Networking uses the host's network directly**: the Android side uses QEMU user-mode NAT and egress reuses the host's physical adapter, so **no virtual NIC or virtual switch is created on Windows** (no driver installation, no extra network adapter). No network setup or downloads are required.

## Build from source

```powershell
# 1. Install dependencies (including the Electron runtime)
npm install

# 2. Start the app and complete runtime deployment (one-time download of adb / Android Emulator / system image)
npm start

# 3. (Optional) Register double-click installation for .apk
npm run assoc:on

# 4. Pack the portable build (no installer, ready to distribute)
npm run pack
# Output: dist/ApkStart-win64-portable/ApkStart.exe
# 5. Compress to a release zip (use this script; Compress-Archive makes it 5MB larger and it will not fit on Gitee)
node build/zip.js dist/ApkStart-win64-portable ApkStart-win64-portable.zip
```

### Single-file EXE (bundled complete runtime, offline after install)

If you want "ship one EXE, the other side double-clicks and it runs, no download wait", use this path:

```powershell
# First turn engine/ into a distributable runtime (system.img gets xz/LZMA2 extreme compression, 3.1GB -> about 1.1GB;
# also trim unused parts of the emulator: arm64 QEMU, Vulkan backends, translations, qsn/self-check tools, VR assets)
npm run runtime

# Then build the installer EXE (electron-builder nsis target, installs into the current user directory)
npm run build:exe
# Output: dist/release/ApkStart-<version>-Setup.exe
```

Size breakdown (measured): Electron about 180MB, trimmed emulator about 480MB, xz-compressed system image about 1.1GB — the final installer is about 1.32GB (roughly 490MB saved versus gzip). The hard floor is the system image itself (it is the Android system, and a verity-protected image, so GMS components cannot be trimmed from outside). Networking uses host NAT by default and creates no virtual adapter, so no extra drivers are needed.

The first launch expands the xz image into `%APPDATA%\apkstart\system-images` (about 20 seconds, one time only); afterwards it is reused as-is. AVDs and installed apps always live in `%APPDATA%\apkstart\avd`, so even if the portable build unpacks to a temporary directory each time, nothing is lost.

## Runtime notes: fully self-contained, no third-party emulator required

ApkStart is a **self-hosting** project: every runtime component is downloaded, verified and managed by the app itself (under `%APPDATA%\apkstart\runtime`). The lightweight edition prefers the full bundle from **this project's GitHub Release** (`ApkStart-runtime-*.zip`) and falls back to the official sources below only when the bundle is unavailable:

| Component | Source | Size | Purpose |
|---|---|---|---|
| adb (platform-tools) | official dl.google.com | ~8 MB | Install/launch Android apps |
| Android Emulator | official dl.google.com (8-thread parallel download) | ~440 MB | Runtime engine (device model and GPU translation included) |
| Android 14 generic system image (Google Play x86_64) | official dl.google.com | source image ~3.1 GB (~1.1 GB as xz) | The single base layer: x86 apps, ARM-library-only apps and GMS all run; the image is the system, nothing to install |
| AEHD driver (optional) | official dl.google.com | ~0.2 MB | Hardware acceleration (or use Windows "Virtual Machine Platform" / WHPX) |

On first use, the "Runtime" page walks you through this deployment (**one-click setup**):
1. adb, the runtime engine and the system image are downloaded automatically (10+ MB/s measured from the official source);
2. **boots automatically** when deployment finishes; afterwards desktop icons start it silently.

![Runtime setup wizard](docs/images/setup.png)

**Device compatibility (handled automatically, no intervention)**

- Without hardware acceleration it falls back to software emulation; failed starts are retried automatically with up to 4 parameter sets ("render backend → acceleration mode → memory/cold boot").
- `-gpu` is chosen by engine version (`software` for 37.x, `swiftshader_indirect` for older builds) instead of deprecated modes.
- Memory/cores are derived from physical RAM (2–4 GB / 2–4 cores); the data partition drops from 16 GB to 4 GB; ports are picked dynamically from free ones; non-ASCII paths are converted to short paths automatically; stale AVD lock files are cleaned up.
- Failure reasons are translated into plain English with suggested fixes; Settings can "Export diagnostic report".
- Large downloads use **8-thread chunking with resume** by default; sources without Range support fall back to a single stream.
- Advanced users can switch to "Connect an existing runtime" in Settings (reusing the adb port of WSA or another emulator), but this is optional, never a dependency.
- Advanced path: Settings also offers "Connect an existing runtime", reusing the adb port of another emulator already running on your machine (WSA / MuMu / etc.).

**Container-style low-cost operation**

- **Read-only base layer**: `system-images/` exists once per machine and is shared by all apps, so AOSP and compatibility images are no longer stored side by side.
- **Thin writable layer**: each AVD uses differential userdata plus named quickboot snapshots; after the last app window closes (when idle) the memory state is saved as a snapshot, so the next boot restores instead of cold-starting.
- **Idle prewarm (on by default)**: like WSA or Tencent App Store PC edition, ApkStart boots the Android environment in the background as soon as it starts (window hidden throughout), so opening an app costs only an `am start`. The trade-off is about 1 GB of idle memory; it can be turned off in Settings.
- **Faster cold boot**: acceleration and engine-version probes are cached on disk (invalidated by exe fingerprint), pointless `wmic` process enumeration is skipped, the boot probe uses an adaptive interval (starting at 350ms), and guest-side preparation commands are merged into a single adb round trip — saving 5–10 seconds per start.
- **`/data` is created by ApkStart itself**: the `userdata.img` in the official system image is just a 1 MB zero-filled placeholder, and formatting used to be done by SDK tools. Launching `emulator.exe` directly skips that step, so `/data` fails to mount and the guest falls into a recovery reboot loop — the symptom is "still not opening after several minutes". ApkStart now creates its own ext4 with 4 KB blocks, `ENCRYPT` (file-based encryption) and `ext_attr` (SELinux labels), and grows it to the configured capacity with the bundled `qemu-img` + `resize2fs`. Measured: ~23 s cold boot, ~10 s with a snapshot hit.
- Snapshot integrity check: empty shells left by an interrupted save (a `snapshot.pb` of a few dozen bytes) are detected and cleaned up. Newer emulators write `ram.bin` (older ones `ram.img`); both names are recognized, so a freshly saved 3 GB snapshot is no longer mistaken for an empty shell and deleted.
- **Command windows never appear**: qemu's console window belongs to `conhost.exe`, whose pid does not match qemu's, so a pid allowlist cannot hide it; the emulator's network daemon `netsimd` also pops its own black window. ApkStart now enables resident suppression **before** starting the emulator, backs it up by window class/title (emulator / qemu / netsim), and scans every 120 ms for the first 90 seconds after boot.
- **Opening an app shows only the app**: the emulator main window (`Android Emulator - apkstart5554`) never appears on the desktop on its own — it is either suppressed/hidden or already `SetParent`-embedded into the app window. Closing an app window first detaches it from the host and hides it, **then** destroys the host (in the reverse order Windows re-parents it to the desktop and shows it); after the app exits, the window agent keeps watching for up to 3 minutes so an emulator that died mid-boot cannot flash a black window seconds later.
- **On-demand downloads**: the generic image is only fetched when an ARM-native-only app appears; split packages (`.apks` / `.xapk`) are installed automatically with `install-multiple`.
- **Reclaimable**: non-x86_64 QEMU targets (~400 MB) are trimmed at build time; the Settings page can clean old images, old snapshots, lock files and leftover AVDs.

## Directory layout

```
apkstart/
├─ src/
│  ├─ main.js              Main process: windows / tray / single instance / CLI dispatch / IPC
│  ├─ preload.js           Secure bridge
│  ├─ ui/                  Renderer (plain HTML/CSS/JS, no framework)
│  └─ core/
│     ├─ zip.js            Minimal ZIP reader (extract on demand)
│     ├─ axml.js           Android binary XML parser
│     ├─ arsc.js           resources.arsc table parser (resolves app name / icon path)
│     ├─ apk.js            APK metadata: package name / version / launcher Activity / icon / ABI
│     ├─ png.js            Zero-dependency PNG encoder + generated app icon
│     ├─ shortcut.js       Multi-size ICO generation + .lnk shortcuts
│     ├─ assoc.js          .apk file association (HKCU, no admin rights)
│     ├─ adb.js            adb client (install / launch / sync / screenshot / ...)
│     ├─ engine.js         Runtime management: probing / emulator hosting / idle reclaim
│     ├─ sharer.js         Two-way sync between the host and Android shared folder
│     ├─ installer.js      Install pipeline orchestration
│     └─ store.js          App list and settings persistence
├─ engine/                 Runtime component download cache (emulator / system-images / platform-tools)
├─ tools/platform-tools/   Where the portable adb lives
├─ test/                   Unit tests + Electron integration tests + smoke screenshots
├─ build/pack.js           Portable build packaging
└─ scripts/assoc.js        .apk association CLI switch
```

## Command line

```
ApkStart.exe                      Open the main window
ApkStart.exe <path\to.apk>        Install an APK
ApkStart.exe --launch <package>   Launch an app directly (used by desktop shortcuts)
```

## Tests

```powershell
npm test                                   # Pure Node unit tests + engine pipeline tests (no network)
npm run test:boot                          # Real boot test: a 61MB Alpine guest verifies QEMU args / disk creation / graceful shutdown
npm run selftest                           # Runtime self-check after Android is installed: install -> launch -> screenshot -> shared folder
electron test/electron-integration.js      # ICO / shortcut integration tests
electron . --smoke test\shot.png           # Start the app and take a screenshot (UI smoke test)
```

`npm run selftest` is the acceptance command once the system is installed: it checks the current device in order — adb connection, Android version, freeform support, two-way shared-folder sync — and with `--apk some-app.apk` it also runs the full install → standalone window launch → foreground confirmation → screenshot.

## Design trade-offs (honest notes)

- **Not a hypervisor written from scratch**: the Android kernel, GPU translation and the ART runtime are years of engineering. This project stands on the shoulders of AOSP/QEMU/adb and concentrates its effort on a native-app-level experience — the same architectural approach used by Tencent App Store PC edition and Google Play Games on PC.
- **The shared folder is synced, not mounted**: Windows cannot mount an NTFS directory on the Android side without root, so sub-second two-way sync delivers an equivalent experience.
- **ARM-only apps / ByteDance apps**: enabling "ARM compatibility mode" in Settings switches to the **Android 14 (API 34) Google Play image** (which bundles a newer ndk_translation layer), allowing apps that ship only ARM native libraries to install and run. **Measured: Hongguo Free Short Dramas (com.phoenix.read, arm64-v8a-only) installs, loads its recommendation feed and plays video** — on the older API 30 image it hits a protective assertion in the translation layer (`DoBadTrampoline` SIGABRT) triggered by ByteDance's non-standard signal handler; the newer translation layer in the Android 14 image fixes this. A few apps carry deeper anti-emulator checks (for example verifying genuine sensors/baseband) and may still be limited; when an install fails or a launch crashes, ApkStart gives a plain-English explanation.

| Hongguo Free Short Dramas running in compatibility mode (Android 14 · AEHD hardware acceleration) |
|:---:|
| ![Hongguo short dramas running in ApkStart compatibility mode](docs/images/compat-hongguo-playing.png) |

## About the author

ApkStart is developed and maintained by **RoutineMiku**.

- GitHub: <https://github.com/RoutineMiku/apkstart>
- WeChat Official Account: scan the QR code to follow

<p align="center"><img src="docs/images/brand.png" alt="About panel: official account QR code and project links" width="560" /></p>

<p align="center"><i>Powered by <b>RoutineMiku</b></i></p>

## Contributing

Issues and PRs are welcome. The shell stays free of third-party dependencies; please run `npm test` before submitting. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[MIT](LICENSE). Release packages contain only ApkStart's own code and the Electron runtime; they do not distribute Android system images, QEMU binaries or Google components. Those are downloaded from official sources by the user's machine on first launch, under their respective licenses.
