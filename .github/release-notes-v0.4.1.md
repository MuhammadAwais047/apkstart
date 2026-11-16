# ApkStart v0.4.1

> In one line: found and cured the whole symptom group "black bars after rotating / app not filling the window / taps not registering / unable to tap Agree" — they actually had **one cause**: the embedded emulator window and the Electron web layer are sibling windows, and the web layer always sat on top.

## 1. The real root cause

A hit test with `WindowFromPoint` at the centre of the picture returned **not the emulator window** but `Chrome_RenderWidgetHostHWND` (Electron's web render layer).

In other words: that black web-layer surface was lying over the Android picture the whole time, and swallowing all mouse events. Hence at the same time:

| What the user saw | Actual cause |
|---|---|
| Black bars around the picture / not filling it | The web layer's black surface covered the embedded picture, or only part of it showed |
| Taps not registering, or off-target | The mouse hit the web layer and never reached Android |
| Unable to tap "Agree and continue" | Same as above (`adb input tap` worked because it uses logical coordinates and bypasses the host) |
| Worse after rotating / going full screen | Resizing triggers a Chromium repaint, which raises itself to the top again |

In v0.3.9 I tried to clip that 8 px title-bar strip out of the picture with `SetWindowRgn`, which instead **broke hit testing on the Qt/GL child window** and left the region out of sync with the window size after a resize — that was the direct source of this release's problems.

## 2. Fixes

1. **Removed the `SetWindowRgn` clipping**, and instead explicitly clear any region left over from older versions in `Embed()`. The title-bar overflow is naturally covered by the host's own title bar.
2. **Parent the emulator window to the web render layer** (rather than being a sibling child of the host). A child window naturally has Z-order and mouse hit-testing priority over its parent, so the web layer can never cover the picture or eat clicks again.
   - The web layer may not exist yet at embed time, so it is re-parented in both `Fit()` and the resident scan to guarantee it takes effect.
3. **Narrowed `HideStrayWindows`**: it only hides clear popup types (Qt tool windows / consoles) and never touches `QWindowIcon` / `subWin` (that is the LCD being shown), so the picture is never mistakenly hidden into black.
4. **Raise the window to the front after startup completes** (a brief topmost, then revert): avoids another window (a browser, etc.) covering it and causing "black screen + taps not working".
5. **Window size when rotating**:
   - `setContentSize` has no effect while maximized, so it now calls `unmaximize` before resizing; otherwise a landscape picture gets crammed into a portrait window = black bars / not filled;
   - The target size is clamped to the screen work area;
   - Qt re-lays out several times after a `wm size` change, so it now settles over 6 consecutive `Fit` rounds, completely eliminating leftover black bars.

## 3. Measured (this time with real end-to-end interaction, not adb simulation)

- Clicked "Agree and continue" with a **real mouse** → entered `MainFragmentActivity` → tapped through to the `ShortSeriesActivity` playback page;
- `PrintWindow` captured the host window: the Android picture **fills the entire area below the title bar, with no black bars and no empty margins**, and video / like / comments / episode list / the four title-bar buttons all work;
- `WindowFromPoint` at the centre of the picture returns the emulator window (before the fix it returned the web layer);
- `npm test`: **115 items all passed** (8 + 25 + 82), with two new regression tests pinning "the embedded window must be parented under the web layer and must not set a region".

## 4. Engineering hardening

- `agent.ps1` keeps its UTF-8 BOM (losing the BOM makes PowerShell 5.1 read Chinese comments as ANSI, `Add-Type` fails to compile → the window agent fails to start);
- New regression tests: verify `SetParent(emu, parent)` / `FindChromeRender` exist, `CreateRectRgn(0, clipTop)` does not, and the region is cleared on embed.

## 5. How to upgrade

- Portable: unzip over the old copy; the data directory (default `%APPDATA%\apkstart`) is untouched.
- Installed edition: install over the old copy.
