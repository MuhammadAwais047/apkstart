## What this release fixes

### 1. Opening ApkStart made WeChat (and other Qt apps) lose their windows

This was the most serious problem in the previous release. The window agent used to identify its own windows by **window class name**:

- `FindEmulator()` accepted windows whose "class name contains `QWindowIcon`" — which is the class name of **every Qt top-level window**;
- `HideToolWindows()` accepted windows whose "class name contains `QWindowTool`" — and Qt's menus, emoji panels and
  floating mini-windows use exactly `QWindowToolSaveBits`;
- The resident suppressor scanned every 120 ms and called `ShowWindow(h, 0)` on whatever it found; `embed` / `park` also called `SetParent` on them.

WeChat 4.x happens to be Qt 6 (the `Weixin.dll` contains the strings `QWindowToolSaveBits` / `Qt6`),
and its main window class is `Qt51514QWindowIcon` — exactly the same as the emulator's. So "open ApkStart and
the WeChat window disappears / gets embedded into ApkStart as a black block" happened.

**Measured comparison on the same machine** (WeChat 4.1.7.59, main window 296×388):

| Version | WeChat window state |
|---|---|
| 0.3.3 | `hidden` 3.7 seconds after launch, then hidden in all 74 samples |
| 0.3.4 | `visible` throughout both the 45-second and 280-second runs, hidden 0 times |

**The fix: a class name is not an identity, the process path is.**

- A new `scope` command: before suppressing/embedding, the main process sends down "our directories" (the runtime root plus the bundled
  `engine` directory) and the main process pid;
- Every window decision first goes through `IsOurs(pid)`: the process executable must live inside those directories;
- **Without a scope, no window is touched at all** — better to miss one black window than to ever hide someone else's;
- Console black windows are no longer matched fuzzily by "title contains emulator/qemu/netsim"; instead the conhost parent process chain
  must reach the runtime directory, or the title must contain the absolute path of the runtime directory;
- `embed` validates that the host window's pid equals the main process pid and refuses otherwise (preventing a recycled handle from embedding the window into someone else's app);
- The mouse hook now checks `IsWindow(_host)` and the host pid, and lets everything through if the handle is invalid;
- Rotation (Ctrl+←/→) only sends global key presses when its own window is in the foreground; otherwise nothing is sent;
- After the agent process is rebuilt, the scope is re-sent, otherwise the new agent would not dare touch anything.

### 2. A whole package that unzips with a double-click is now on Gitee too (no more part1/part2)

- Compressor changed: `Compress-Archive` (.NET deflate) → 7-Zip `-mx=9`, **105.2 MB → 99.8 MB** for the same directory;
- The bundled `d3dcompiler_47.dll` was removed (Windows 8.1 and later ship a same-named DLL in `System32`, with no measured rendering difference),
  saving another 2.1 MB; `vk_swiftshader` / `vulkan-1` stay — they are the fallback when the GPU driver is unavailable;
- Final size **95.0 MiB**, under Gitee's 100 MB single-file limit, so it can simply be downloaded and unzipped;
- New `build/zip.js`: after packing, it verifies the entry count and total extracted bytes with the app's own zip parser,
  and **fails CI if the package exceeds 100 MiB** — a fatter package breaks the build immediately instead of quietly falling back to split parts.

### 3. "Dual-source automatic selection" was not actually in effect before

Assets with the same name were de-duplicated by name and whichever came first was used; GitHub was ordered first, so **Gitee's same-named URL was dropped outright**.
Once the whole package stopped being split, that meant everything always went through GitHub.

- Same-named assets now merge their `urls` and record a separate `size` per address (the two sources genuinely produce different byte counts);
- Speed is measured before downloading and the best source is chosen; `downloadMulti`'s "only mix sources that declare the same size" now uses the **fastest source's**
  total size as the baseline (it used to take `Math.max`, i.e. always download from the larger source);
- Measured with four candidates on this machine (GitHub direct / ghfast / gh-proxy / Gitee), the fastest was Gitee,
  95.2 MB / 48 seconds (about 2 MB/s).

### 4. Other

- The agent's "window guarding" decision now only recognises processes inside its own runtime, so other emulators (MuMu's / LDPlayer's own emulator.exe)
  no longer make the agent guard for an extra 3 minutes;
- Helper scripts (`check-agent` / `check-console` / `check-windows` / `check-launch-clean` /
  `check-quit-clean`) now send the scope too.

## Verification record

| Item | Result |
|---|---|
| Unit + integration tests | run-tests 3 / auto-test **70 passed, 0 failed** |
| End to end (real runtime + real AVD + Hongguo APK) | install → open → embed all passed; app window appeared in 0.5 seconds; leaked windows **0** in total |
| Coexistence with WeChat (4.1.7.59) | Across emulator start / app install / embedding, WeChat window hidden **0** times |
| Gitee whole package | 95.18 MiB, `Expand-Archive` extracted in 5.2 seconds, md5 of 69 files matched the source directory |
| Downloaded from Gitee for real | 95.2 MB / 48 seconds, zip structure intact |

## Downloads

- Lightweight `ApkStart-v0.3.4-win64-portable.zip` (**95 MB**, unzip and run, runtime downloaded on first launch):
  a **single complete zip** on both GitHub and Gitee, no more assembling parts.
- Full `ApkStart-0.3.4-Setup.exe` (about 1.35 GB, bundles adb / emulator / system image, fully offline after install):
  too large for Gitee's per-file limit, so it is only on GitHub.
