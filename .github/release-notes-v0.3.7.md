# ApkStart v0.3.7

> In one line: fixed the **close button at the top right of an app window (closing must really end the Android app)**, and changed **VM networking** from "wait and hope" to "automatic self-healing"; the CI token for syncing to Gitee is configured too.

## 1. Fix: the top-right window button now really closes the app

**Problem**: clicking the ⨯ in the title bar made the window disappear, but the Android app kept running in the background; opening that app again looked like it "had never been closed".

**Cause**: `shell:close` called Electron's `win.close()` directly, bypassing the cleanup logic in `AppWindow.close()`. The window's `closed` event only cleared internal state — it **neither `force-stop`ped the Android app nor detached the emulator window from the host**. The same applied to Alt+F4 or closing from the taskbar.

**Fix**:

- The ⨯ button now goes through `appWin.close()`: first detach and hide the emulator window, then `am force-stop` the Android app;
- The `closed` event gets the same cleanup (covering Alt+F4, taskbar close, system shutdown and other paths);
- Rotation / minimize / maximize logic is unchanged.

**Measured**: after sending `WM_CLOSE` to the app window, `pidof com.phoenix.read` went from `5152` to **empty**, and the foreground returned to the Android launcher — the app really exited.

## 2. Networking: no longer luck-based, now self-healing

The previous release already established that "black screen after tapping Agree in Hongguo" = the VM has no network. But at that time it only "waited a bit longer", and a boot where Wi-Fi simply never associated still timed out.

This release makes network handling **escalate automatically from the cheapest step to the most expensive**:

1. **Wait for the network before launching an app** (up to 60 s, with progress in the log);
2. If that fails, **cold-boot the VM once** (`-no-snapshot-load`, bypassing a quick-boot snapshot that may have been saved without a network), then wait up to 180 s;
3. As soon as the network is up, **save a snapshot immediately**, so the NIC state is restored with it next time;
4. "Settings → Fix network" uses the same flow; only if the first two steps both fail does it **reset the Android data** (the app list is kept and apps reinstall automatically when opened, but in-app logins/records are lost).

> On "raise the Android version": this release did not change the image. The reason is that changing the image would force every user to re-download 1.5 GB,
> while the measured root problem is **slow or occasionally failing Wi-Fi association in the emulator**, not the Android version itself;
> "wait + cold-boot self-healing" covers the same scenarios without growing the package. If a particular image version later proves more stable,
> it can be migrated in a separate release.

## 3. CI: the Gitee sync token is configured

The Actions secret `GITEE_TOKEN` has been written to the GitHub repository, so from now on a `v*` tag release will make the Release workflow
sync the portable package to Gitee automatically, with no manual script runs.

## 4. Measured

- `npm test`: **113 items all passed** (8 + 25 + 80).
- After closing the window, `pidof com.phoenix.read` is empty (the app really exited).
- Network-ready log: `VM network ready (10.0.2.16)`, after which the Hongguo home page renders normally.

## 5. How to upgrade

- Portable: unzip over the old copy; the data directory (default `%APPDATA%\apkstart`) is untouched.
- Installed edition: install over the old copy.
