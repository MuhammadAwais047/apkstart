# ApkStart v0.4.3

> In one line: rotated/full screen went from "change the runtime resolution" to "change the physical panel size", so landscape is finally **upright and filled**; whole-machine stutter was fixed too, and a new **game / low-latency mode** was added (prepared for FPS games).

## 1. Rotate / full screen: now genuinely upright and filled

### Why it was always wrong before

The emulator's picture comes from a "physical LCD panel": Qt opens a window at the panel size and pins the picture to the top-left corner. All three earlier approaches were dead ends, and each one maps to a symptom in your screenshots:

| Approach | Result |
|---|---|
| Change `wm size` at runtime | Only the Android logical resolution changes while the physical panel stays portrait → the picture **lies on its side 90°**, occupies a strip at the top left, and tap coordinates are off |
| Change `wm density` at runtime | The framebuffer size is unchanged → the picture **never fills** the window, leaving a large blank area on the right when maximized |
| `adb emu rotate` | Only rotates the picture content; the system stays portrait |

### What it does now

**Rotating = changing `hw.lcd.width/height` and restarting the emulator** (about 30–60 seconds, and only once when you tap rotate):

- Portrait panel `720x1280`, landscape panel `1280x720`;
- The orientation lock `wm user-rotation` is set to match (1 in landscape, 0 in portrait) and sensor auto-rotation is off — with a landscape panel but rotation still 0, the picture would lie on its side;
- The orientation persists in Settings, so reopening ApkStart boots in that orientation;
- **The full-screen button = switch to landscape**: maximize the window plus turn the physical panel landscape, instead of stretching a portrait picture.

### Two real bugs fixed along the way

1. **`-no-skin` overriding `-skin`**: both flags were passed at startup, and `-no-skin` made the panel size fall back to the old value in `config.ini` — that was the direct cause of "switched to landscape in Settings but it is still portrait". `-no-skin` has been removed.
2. **Not filled when maximized**: when Electron maximizes, the host window becomes 1936×1048, but the inner Chrome render layer stays at its old size (measured 532×984), and the emulator window, parented under the render layer, gets clipped by its parent. `Fit` now **first stretches the render layer over the host's whole client area**, then fits the emulator to that size; the window scan also self-heals once per round, so it recovers even if JS loses a resize event.

## 2. Stutter: three costs that slowed the whole machine

1. **Window scan frequency**: during the first 90 seconds after launch it used to enumerate every desktop window every 120 ms (4 `EnumWindows` calls plus process-path queries per round), eating CPU continuously. It is now every 250 ms for the first 10 seconds and **1500 ms** afterwards; game mode lowers it further to **3000 ms**.
2. **Emulator priority**: the default balanced policy pressed qemu down to BelowNormal, and after closing an app even dropped it to **Idle** (the lowest) — which made Android drop frames badly. Closing an app no longer unconditionally drops to Idle.
3. **Global mouse hook**: `WH_MOUSE_LL` calls back synchronously for every mouse event on the desktop, noticeably adding pointer latency. **It is not installed at all in game mode.**

## 3. New: game / low-latency mode

Settings → Performance and resources → **VM priority → "Game / low latency"**:

- The emulator process is raised to **High** priority, so Android rendering and input get the CPU first;
- The global mouse hook is off, so the pointer uses the native input path;
- The window scan drops to 3000 ms, reducing host-side interference;
- The "smooth" resource policy now enters this mode directly too (video/games preferred).

The trade-off is that other programs on the machine get slower, so the default remains "balanced".

## 4. Hardening along the way

- `settings.json` now tolerates a **UTF-8 BOM**. Previously a file with a BOM made `JSON.parse` throw and the whole configuration silently fell back to defaults — users saw "all my settings are gone" with no way to find out why (I hit it myself while testing).
- New regression tests: landscape must come from `lcdFor({landscape})` and must not use runtime `wm size`; windowed mode must use `-skin` and must not pass `-no-skin`; game mode must be High priority and must not install the global hook.

## 5. Measured

- `npm test`: **117 items all passed** (8 + 25 + 84).
- Landscape measured: `wm size` = `Physical size: 1280x720`, `user_rotation=1`, the guest picture **upright, correctly laid out, no black bars**; after maximizing, the host client area is 1920×1032 and the render layer is stretched to match.
- Portrait measured: `720x1280`, `rotation=0`, picture upright and filled.

## 6. How to upgrade

- Portable: unzip over the old copy; the data directory (default `%APPDATA%\apkstart`) is untouched.
- Installed edition: install over the old copy.
