# ApkStart v0.3.5 release notes

> This release fixes a series of defects confirmed during a code walkthrough on top of v0.3.4; all of them were measured on this machine.

## What this release fixes

### 1. APKs larger than 2 GB could not be installed (#21)
The old APK parser read the whole file into memory, so anything above 2 GB hit Node's single-Buffer limit,
showing up as "clicked install, an English error popped up, and the spinner in the corner kept spinning".

- Parsing moved to a **file-backed ZIP reader**: only the central directory is read, and the manifest/resource table/icons are read on demand,
  dropping peak memory from "the size of the package" to "a few MB";
- `.apks` / `.xapk` split packages are also unpacked as streams (each part is extracted to disk as it is decompressed),
  and the temporary directory is cleaned up on failure;
- The `adb install` timeout changed from a fixed 4 minutes to **scaling with package size** (about 5 minutes for a 2 GB package, capped at 20 minutes),
  so large packages on slow disks are not misjudged as failed;
- Install-failure messages now all go out through the main process event channel, and the "installing…" spinner is cleared,
  so no endlessly spinning progress bar is left behind after an error.

### 2. ZIP compatibility for large image packs / large update packages

- **ZIP64** support added (EOCD locator + extended field id=0x0001):
  entries are no longer silently dropped past 65,535, and offsets/sizes of oversized entries are read from the extended field.

### 3. Deployment "stuck preparing the runtime" / "stopped at 99% and re-downloaded a whole image set"

- Source selection speed tests changed from "30 seconds with no feedback" to **progress reported per source** (source i of n),
  with at most 6 seconds per source; an unreachable port only moves to the end and does not affect the download;
- Before downloading the runtime pack it now says "fetching runtime version info…";
- A failed system-image extraction is **no longer swallowed silently**: it reports an explicit error naming the file,
  instead of "progress stuck at 99% → jump back and re-download 1.4 GB from the official source";
- Image extraction now **writes `.part` first and renames atomically**: a power loss or program kill mid-way no longer leaves a
  half-written system.img that "looks complete";
- The "already extracted" test changed from "larger than 32 MB" to "at least as large as the archive",
  so a truncated image is extracted again;
- The disk guard now accounts for the whole runtime pack (a 1.5 GB archive plus 3.3 GB extracted, both present at peak),
  and an insufficient disk gets an actionable message up front instead of failing halfway through the download.

### 4. Changing "runtime data directory" in Settings still downloaded to the old directory (#23)

When the portable program directory had a `runtime/` next to it, the old version overwrote the user's chosen `runtime.dir`
with that bundled runtime at startup. Now: **as long as the user explicitly set a directory and it contains an emulator,
that choice is always respected**; automatic takeover only happens when "nothing was set" or "the set directory is no longer usable".

### 5. Online update could treat the 1.5 GB runtime pack as the program package

Releases carry both the portable package and `ApkStart-runtime-*.zip`. The old fallback `.zip` match
did not exclude the latter, so a release where the portable package failed to upload would have the updater extract the runtime pack into the program directory.
The fallback match now explicitly excludes `runtime` assets; when no usable asset exists it honestly says "please download manually from the release page".

### 6. After a failed boot, the diagnostic report showed no cause (#20 / #25)

The old version kept "boot attempt records / diagnostic conclusions" only in memory, so if the user restarted ApkStart before exporting the report,
it contained `attempts: []` and `UNKNOWN`, leaving the author to dig through logs.

- On boot failure, **attempts / diagnostic conclusion / exit code** are persisted to
  `%APPDATA%\apkstart\logs\last-failure.json` (cleared by the next successful boot);
- The diagnostic report includes the persisted record, the exit-code meaning, and the tail of `emulator.log`
  (when the in-memory log is empty it reads the last 300 lines straight from the file);
- New **`0xC0000005` (decimal 3221225477) diagnostic rule**: classified as "render backend crash",
  advising a graphics driver update / lower quality, instead of the vague "runtime failed to finish booting";
- That class of crash **automatically retries with a more conservative render backend and remembers it**
  (`engine.badGpu`, invalidated per emulator version), so the next boot does not hit it first again;
- The runtime panel in Settings shows "last boot failed: …" directly, without waiting for an exported report.

### 7. Uninstalling ApkStart wiped the user's pre-existing .apk file association

The old version unconditionally cleared the `.apk` default program on un-association (the code comment's promise of "only when it still points at us"
was not implemented). Now:

- On registration the previous default program is saved to `HKCU\Software\ApkStart\assocPrev`;
- On un-association it is **restored first**; only when no record exists and it still points at ApkStart is it cleared;
- Measured locally: the previous association was `MuMuPlayer.apk`, and registration → un-association restored it exactly.

### 8. Icons: formats beyond WebP, and "silently used a placeholder"

- Icon candidate formats now include `jpg/jpeg`;
- Adaptive icon / `layer-list` XML now searches recursively for bitmaps (up to 3 levels),
  instead of always falling back to the brand placeholder;
- When nothing can be decoded, the install-complete message explicitly says "the icon could not be parsed, the shortcut uses a placeholder for now",
  rather than leaving the user to guess from a green triangle.

### 9. After a fresh install, clicking the desktop icon showed only the Android launcher

An upstream bug found in testing (also present in v0.3.4): after installing an app, the launch entry recorded in `apps.json` was
the "full component" (`com.foo.bar/com.foo.bar/.MainActivity`), and launch prepended the package name again,
so `am start -n` received `com.foo.bar/com.foo.bar/com.foo.bar/.MainActivity` and
the system cancelled the launch outright (log `result code=-92`) — leaving the Android launcher in the window.

- New `componentArg()`: a full component is used as-is, and only a bare class name gets the package name prepended; both historical data shapes are supported;
- `parseResolvedActivity()` now scans every line (`resolve-activity` output often ends with a blank line),
  so it no longer misjudges "could not resolve" because the last line is empty;
- Measured: after reinstalling Hongguo, clicking the desktop icon put `mCurrentFocus` correctly on
  `com.phoenix.read/...SplashActivity`, and the window showed the app's own UI (no longer the launcher).

### 10. Log rotation boundary

- When the log filename does not end in `.log`, rotation used to "delete first, then rename", losing the log;
  rotation is now skipped instead (better a bigger log than a lost one).

### 11. Other
- New "synthetic APK" test fixture (`test/lib/make-apk.js`): a hand-built binary AXML manifest +
  a PNG icon + ABI directories, so the parsing stack is covered even when real APK fixtures are missing;
- New/extended regression cases: Zip64, .xapk split packages, materializeImages,
  update asset selection, `0xC0000005` diagnostics, log boundaries, persisted failure records, WebP icon fallback;
- `npm test` grew from 98 to **113 items, all green**.

## Verification record

| Item | Result |
|---|---|
| `npm test` | 113 passed / 0 failed (8 + 25 + 80) |
| `electron test/electron-integration.js` | ICO / .lnk / WebP fallback all passed |
| Real cold start | ready in 25.0 s (`sys.boot_completed=1`) |
| Snapshot hit | 5–6 s |
| Graceful shutdown | `code=0`, `hasSnapshot=true` |
| Real-device APK parsing | Hongguo Short Dramas 7.4.3.32 / `res/b/a3.webp` / arm64-v8a correct |
| 2.15 GB APK parsing | done in 18 ms, process RSS 47 MB (the old version had to read all 2.2 GB into memory) |
| Fresh install + desktop icon launch | after reinstalling Hongguo, clicking the icon: `mCurrentFocus` = `com.phoenix.read/...SplashActivity`, the window shows the app UI (before the fix: the Android launcher) |
| Runtime self-test `npm run selftest -- --apk` | **13 of 13 passed**: adb / engine / image / AEHD, Android 14 API34, freeform, two-way shared-directory sync, parse → install → launch in its own window → screenshot |
| `tools/check-launch-clean.js` | install + open: app window appears in **0.5 s**, emulator/console windows appeared **0** times in total |
| Install pipeline | packaged build given a 153 MB APK: parse/install/icon/shortcut done in 22 s; desktop + Start menu .lnk Target/Args/Icon all correct |
| No window leaks | `check-quit-clean`: throughout boot plus 8 s after quit, visible emulator/console windows **0** |
| Registry association | previous association locally `MuMuPlayer.apk`, restored exactly after register → un-associate |
| Packaged build | 226 MB portable package, UI smoke test passed |

## Known limitations

- The **root cause** of `0xC0000005` still lies on the graphics driver / Vulkan backend side; this release does
  "switch backends automatically + state the cause clearly". If a machine still crashes every time, share the new diagnostic report and it can be pinpointed.
- Icon parsing still does not support `shape`/vector drawables (it falls back to a placeholder, and says so honestly).
- The `.apk` association lives in HKCU (no admin needed); if another program on the system keeps taking the association back,
  the system "Default apps" setting wins.
