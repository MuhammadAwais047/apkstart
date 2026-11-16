# ApkStart v0.4.0

> In one line: fixed the regression where Hongguo would not open / stayed black, a single click on the tray now opens the main window, startup got another speed pass, and stray windows during runtime are suppressed consistently.

## 1. Fix: Hongguo would not open / stayed black (a v0.3.9 regression)

**Cause**: to "wait for the network before launching an app", the previous release called the wait logic **with cold-boot retry** inside the launch flow. On a slow network it would "stop the VM → cold boot" while the app launch was about to run `adb install` / `am start` — the device disappeared mid-flight, so:

```
adb.exe: device 'emulator-5554' not found
launch failed com.phoenix.read
```

**Fix**:

- **The launch path only ever waits, never restarts**: wait at most 20 seconds, then launch the app anyway (a slower page is fine; failing outright is not);
- Heavy work such as cold boot / reset only happens when the user actively clicks "Fix network";
- `waitForNetwork` no longer gives up the moment it sees `device-offline` — a freshly rebooted VM needs tens of seconds before adb comes up; it now allows 45 seconds of grace (older versions wrongly reported "repair failed" because of this).

**And "Fix network" is now correct**: measured on this image, only the boot right after `-wipe-data` connects reliably, so it now resets the data directly (the app list is kept and apps reinstall when opened) and **saves a snapshot immediately** after the network comes up — the next restore brings the NIC state back with it.

Measured: after the fix the launch log shows `VM network ready (10.0.2.16)`, tapping "Agree and continue" enters `MainFragmentActivity`, and the home page loads series and the recommendation feed normally.

## 2. Tray: a single click opens the main window

Only double-click used to be bound, so users who single-clicked got no response and assumed the tray icon was broken. A single click now opens the main window directly (right-click is still the menu, double-click unchanged).

## 3. Startup speed

- The launch path no longer does a cold-boot retry, removing waits that routinely took 3–5 minutes;
- The network wait dropped from 60 s to **20 s**, and returns immediately when the device is offline instead of spinning;
- After the network is fixed a "network normal" snapshot is saved, and every later restore starts from it: measured full startup (boot → online → install → embed) takes about **48 seconds**, of which boot is about 20 seconds.

## 4. Stray windows during runtime

The window agent gained a fallback layer: all surplus visible top-level windows created by **processes inside our runtime directory** are hidden consistently (Qt tips, crash dialogs, volume bar, log windows, etc.), keeping only the one emulator main window to embed into the host. The previous implementation named windows one by one by class name, so one missed entry meant one flash.

## 5. Engineering hardening

- `agent.ps1` carries a **UTF-8 BOM** again. Saving it in the ordinary way used to lose the BOM, and PowerShell 5.1 then read Chinese comments as ANSI, possibly merging a comment with the next line of code and making `Add-Type` fail to compile (which showed up as "window agent failed to start / app windows not embedded").
- New regression test: **the window agent script must carry a UTF-8 BOM**, so losing it again fails the tests immediately.

## 6. Measured

- `npm test`: **114 items all passed** (8 + 25 + 81).
- Hongguo: launch → Agree → home page shows the video feed normally (confirmed by screenshot).
- A single click on the tray opens the main window.

## 7. How to upgrade

- Portable: unzip over the old copy; the data directory (default `%APPDATA%\apkstart`) is untouched.
- Installed edition: install over the old copy.
