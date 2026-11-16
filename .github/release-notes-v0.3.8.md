# ApkStart v0.3.8

> In one line: added a **good-looking welcome card at startup** (reminding you everything is ready when launching at boot), fixed **some users being unable to check for updates**, added **cleanup of leftovers from old versions**, and gave the whole UI a polish pass.

## 1. New: welcome card at startup

When ApkStart starts automatically at boot or is opened manually, a lightweight welcome card appears:

- A brand gradient header image plus a dynamic greeting (Good morning / Good afternoon / Up late…);
- Three metrics at a glance: **installed apps / Android runtime status / device port**;
- Two of the most useful tips right then (how to install when no apps are installed; how to use windows when apps are installed);
- When a new version is found, it is announced right here instead of a separate bubble in the corner;
- At the bottom you can tick **"Do not show automatically on next launch"**, or click "Open settings" directly.

Display rules: always shown on auto-start at boot; at most once per day when opened manually; never again once the box is ticked.

## 2. Fix: some users could not check for updates

**Cause**: version info depends on both providers' APIs. GitHub's anonymous API allows only 60 calls per IP per hour; Gitee's anonymous API is tighter still — a few consecutive calls and it returns `403 Rate Limit Exceeded`. Behind corporate networks / campus networks / carrier NAT, users easily get rate-limited on both sources, and the UI only said "update check failed".

**Fix**:

- A new **API-free fallback**: follow the 302 redirect of `releases/latest` to get the version number (via the CDN, consuming no API quota), then build the download URL by the release convention;
- Both GitHub's and Gitee's canonical `/releases/download/<tag>/<filename>` URLs can be assembled (measured: Gitee 302s to the attachment's direct link and the full byte count downloads);
- On a failed check the UI is no longer blank but offers an **"Open download page"** button; `app:updateOpen` now also allows `gitee.com`, so users in mainland China are not blocked.

## 3. New: clean up leftovers from old versions

Settings → System integration → **"Clean up old-version leftovers"**:

- Scans **old version program directories** (`ApkStart-vX.Y.Z-win64-portable` etc. next to it, which must actually contain `ApkStart.exe`; the currently running version is never touched);
- Scans **dead registry uninstall entries** (entries whose `InstallLocation` or uninstaller no longer exists);
- Scans **temporary packages left by update downloads** (`%APPDATA%\apkstart\update` and `ApkStart-*.zip` etc. in the temp directory);
- Lists the items and reclaimable space first, deletes only after confirmation, and honestly reports "N items were in use and could not be deleted".

Only provably safe cleanup is done — **no user data, never the current version**.

## 4. Hide the scattered little popups at startup

- The "new version found" system notification at startup is gone, folded into the welcome card;
- The old startup hints spread across several toasts / bubbles are now just this one card;
- Console black-window suppression stays (emulator / netsimd / adb console windows are still hidden).

## 5. UI polish

- New palette: emerald brand color plus a soft neutral base, with a very light brand glow in the background;
- The title bar becomes **frosted glass**, and the window icon is a vector brand mark (readable as a "play button" even at small sizes, no longer a blurry dark square);
- App cards: larger radii, hover lift with a brand-colored outline, icons with a drop shadow;
- Buttons: primary gradient with an inner highlight, secondary buttons lighter;
- Modals, section titles, scrollbars and the status bar all redone consistently;
- The welcome card uses the same design language (gradient header + glow + dot matrix texture).

## 6. Measured

- `npm test`: **113 items all passed** (8 + 25 + 80).
- Smoke screenshots: main window and welcome card both render correctly (see the release page screenshots).
- "Clean up old-version leftovers" found 6 old version directories, about 1.3 GB, on the development machine, and correctly excluded the currently running version.

## 7. How to upgrade

- Portable: unzip over the old copy; the data directory (default `%APPDATA%\apkstart`) is untouched.
- Installed edition: install over the old copy.
