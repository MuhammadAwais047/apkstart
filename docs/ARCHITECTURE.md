# Architecture

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Presentation  src/ui (HTML/CSS/JS)  ←→  preload (contextBridge) │
├─────────────────────────────────────────────────────────────┤
│ Orchestration  src/main.js (windows/tray/CLI dispatch)      │
│                installer.js (install pipeline)              │
├─────────────────────────────────────────────────────────────┤
│ Domain         engine.js (runtime lifecycle/probe/idle reclaim) │
│                adb.js (device operations)  sharer.js (file sync) │
├─────────────────────────────────────────────────────────────┤
│ Offline parse  zip.js → axml.js / arsc.js → apk.js          │
│                png.js / shortcut.js (icons and shortcuts)   │
├─────────────────────────────────────────────────────────────┤
│ Engine adapters  bundled QEMU (WHPX/TCG) │ image import │ existing runtime (optional) │
└─────────────────────────────────────────────────────────────┘
```

## Key flows

### 1. Install by double-clicking an APK

```
Double-click a .apk in Explorer
  → HKCU\Software\Classes\ApkStart.apk\shell\open\command
  → ApkStart.exe "C:\...\xxx.apk"
  → main.js parseArgs → runInstall
      1. apk.js: offline parsing (zip → manifest AXML → arsc to resolve label/icon)
      2. engine.ensure(): start/probe the runtime if it is not ready
      3. adb install -r -g -t
      4. Icon → PNG (icons/) + multi-size ICO (icons/*.ico)
      5. shell.writeShortcutLink creates the desktop .lnk (--launch <pkg>)
      6. store.upsertApp records the metadata
```

### 2. Launch from a desktop icon (native experience)

```
Double-click <app name>.lnk
  → ApkStart.exe --launch <pkg>
  → the single-instance lock merges into the running instance (or quietly starts a new one)
  → adb am start --windowingMode 5 -n <pkg>/<activity>
  → standalone freeform window
  → the shell window hides/exits automatically, leaving no extra UI
```

### 3. Shared data

```
Host %USERPROFILE%\ApkStartShared  ⇄  Android /sdcard/ApkStartShared
  incremental two-way sync (decided by mtime+size), 8s polling + triggered by key actions
```

## Why not use off-the-shelf libraries

| Need | Usual approach | What ApkStart does | Reason |
|---|---|---|---|
| Read APK metadata | aapt2 / apk-parser | Hand-written zip+AXML+ARSC | Zero dependencies, no SDK install, no external process at startup |
| Convert icons to ICO | ImageMagick/sharp | nativeImage resize + hand-written ICO container | Avoids an 80MB native dependency |
| File association | Installer writes HKLM | HKCU + SHChangeNotify | No admin rights, can be toggled in Settings anytime |
| Emulator | Bundle all of VirtualBox | Engine adapter layer | Reusing an existing runtime costs nothing; the QEMU route keeps a controllable system-image approach |

## Stability design

- Every adb call has a timeout and normalized errors (AdbError).
- Runtime probing runs in parallel with a 4s timeout and degrades automatically on failure.
- QEMU idle watchdog: the runtime is reclaimed only when no foreground app exists and the configured number of minutes has passed; it is never reclaimed while an app is running.
- Settings and app-list writes use atomic tmp+rename.

## App-level container model (performance)

### The boundary versus a "real container"

Huawei Zhuoyitong / WSA / Anbox are **containers or compatibility layers**: the host kernel is shared with the guest,
system services start on demand, and in theory only the services an app depends on need to be loaded.
ApkStart's base is Google Android Emulator (full-system QEMU virtualization), so the
Linux kernel, zygote and system_server must boot as a whole once — **loading only the system services an app
needs is impossible**, and no amount of upper-layer code can work around that.

But the "heaviness" users feel does not come from those resident services; it comes from four other things.
Solve them and the experience is equivalent to "starting only the environment the app needs each time":

| Real burden | How it is handled | Where |
| --- | --- | --- |
| Reboot the whole Android for every app opened (40–142s, CPU and disk pegged) | The environment boots once and stays resident; a detached qemu survives ApkStart exiting, and the next `adoptExisting()` takes it over plus quickboot snapshots, so opening an app costs only `am start` + attaching the window | `engine.js` / `emulator.js` |
| Previously opened apps stay in the background eating memory and network | Opening a new app runs `am force-stop` on other user apps; closing the last window runs `am kill-all` + `deviceidle force-idle` | `container.js` / `Runtime.beginApp()` / `endApp()` |
| qemu competes with the Windows desktop for CPU at Normal priority | Lowered to `BelowNormal` after start, and to `Idle` when the container parks; vCPUs are capped at a quarter of physical cores (2–3 cores) | `win/priority.ps1` / `doctor.liteProfile()` |
| Sync, notifications and window polling still run at full rate with no app open | File sync and the notification bridge run only while an app window exists; window polling is limited to the first 8 seconds after embedding; the socket main loop uses 50ms short polling | `main.js` / `win/agent.ps1` |

### About "translating APKs to x86"

This step **does not happen every time an app opens**, and it is already built in:
- The system image is x86_64, so x86 native APKs run directly;
- ARM-only APKs rely on the native bridge in the image (the ARM→x86 binary translation layer shipped with the Google Play image), which completes **at install time** and is called on demand at run time;
- ApkStart therefore does not need to — and should not — "translate" again on every launch.
  Translating on every open would in fact be the slowest design.

### Root cause of mouse drift / system-wide lag (fixed)

`win/agent.ps1` used a `WH_MOUSE_LL` global low-level mouse hook to implement "side button = back",
but installed it on the window-service thread that also blocks in `sock.Poll(4000)`.
Every Windows mouse event had to wait synchronously for that thread, up to 4 seconds;
the hook was not uninstalled when a window closed either, so it kept slowing the whole system as long as ApkStart was alive.
Combined with the first-run I/O spike from `.xz` expansion / `e2fsck` / `resize2fs`,
the foreground could barely get any resources.

Fixes:
- The hook is no longer unconditionally resident: it is installed only on a **dedicated message thread** (`GetMessage` loop), and only while an app window is in the foreground and at least one mouse mapping is enabled; it is uninstalled immediately on focus loss or close; the callback handles only
  7 target messages and passes everything else (including all left-button events) straight through with one `CallNextHookEx`;
- Service main loop changed from `Poll(4000)` to `Poll(50)`;
- `EnumWindows` + `SetWindowPos(SWP_FRAMECHANGED)` changed from "every 2 seconds, forever" to
  "within 8 seconds after embedding, and no longer forcing a non-client area recompute";
- First deployment is delayed by 20 seconds to avoid competing with cold boot for I/O.

### Mouse buttons (left = confirm / right = back / wheel = scroll)

The app window embeds the emulator's Qt child window; its native mapping is:

| Input | Native Qt behavior | How ApkStart handles it |
| --- | --- | --- |
| Left button | Finger tap / press-and-drag = swipe | **Not intercepted at all**, passed straight through; this is the "confirm" |
| Right button | Also treated as a tap, easy to trigger by accident | Intercepts `WM_RBUTTONDOWN/UP/DBLCLK` and sends `input keyevent 4` (back) |
| Wheel | Sends one touch event per notch, making the screen jitter | Intercepts `WM_MOUSEWHEEL/MOUSEHWHEEL` and merges them into one `input swipe` per 60–90ms window |
| Side buttons | None | Optional: map to back / forward (off by default) |

Wheel merging happens in `win/agent.ps1` (`PushWheel` / `FlushWheel`) and translation happens in
`core/pointer.js` (`WheelRouter` → `wheelToSwipe`). Injection goes through `AdbClient.input()`
and a **resident `adb shell`**, using `echo __APKSTART_<id>__` for replies and backpressure, so
it does not `execFile` an adb process per notch and swipe commands do not queue up in the shell.
Coordinates are mapped from the cursor's normalized position inside the LCD; horizontal wheel input produces horizontal swipes, and the resolution refreshes automatically after rotation.

The hook is installed only while an app window is in the foreground and uninstalled when switching back to the desktop or closing the window; turn off right-click-back, smooth wheel and side buttons and no global hook is installed at all.

### Configurable options (Settings → Mouse buttons / Performance and lightweight container)

| Option | Default | Description |
| --- | --- | --- |
| `engine.mouseRightBack` | `true` | Right button = Android back; disabling it restores Qt's "right button is also a tap" |
| `engine.mouseWheelMode` | `smooth` | `smooth` merges and injects / `native` hands each notch to Qt / `off` does not intercept |
| `engine.mouseSideButtons` | `false` | Side buttons = back / forward; with all three disabled no global hook is installed |
| `engine.liteMode` | `true` | Caps the vCPU quota; disabling it allocates more cores according to the machine |
| `engine.priorityMode` | `balanced` | With `performance`, qemu runs at Normal priority |
| `engine.deepTrim` | `false` | Additionally `pm disable-user`s a batch of system background packages; automatically `pm enable`s them when turned off |

Deep trim deliberately leaves essential components such as `gms` / `systemui` / WebView / IME untouched
(see `container.NEVER_TRIM`), so apps that depend on push and sign-in do not keep throwing errors.

### Lifecycle of one session

```
Cold boot (first time only, or after the AVD is deleted)
  materializeImages → e2fsck/resize2fs → boot_completed → saveSnapshot
        ↓
Open app A: ensure() takes over the resident environment → am start A → attach window
            → beginApp(A): stop other user apps, raise priority, start sync/notifications
        ↓
Switch to app B: beginApp(B) → am start B (Android is not restarted)
        ↓
Close the last window: endApp() → force-stop → am kill-all → deviceidle
            → qemu drops to Idle → stop sync/notifications (container parks, no shutdown)
        ↓
Idle longer than idleShutdownMinutes: the watchdog shuts the runtime down
(adopted instances used to be unreclaimable because there was no local proc handle; fixed)
```
