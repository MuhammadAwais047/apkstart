# ApkStart v0.3.9

> In one line: changed **landscape/portrait switching** from "rotating the picture" to a real **phone / tablet layout switch**, fixed full screen not going landscape, taps not registering, and a black strip appearing when clicking title-bar buttons; also added **storage reclamation**.

## 1. Landscape/portrait and full screen: a real layout switch

**The old problem**: after tapping rotate (or full screen) the picture lay on its side, clockwise or counter-clockwise, while the app did not re-layout and could not be set upright; and full screen did not go landscape automatically.

**Root cause**: the old implementation was "change `wm size`, then have the window agent send Ctrl+← to the emulator". Ctrl+← only rotates **the emulator's picture** 90°, with the Android-side layout completely unchanged — hence "the picture lying down". On top of that, the AVD template hard-coded `hw.sensors.orientation=no`, so Android did not allow rotation at all and only picture rotation could fake it.

**What it does now**:

- Only the **logical display size** (`wm size`) is changed, so Android re-lays out for the new width:
  - Portrait 720×1280 @320dpi ≈ **360dp wide → phone layout**;
  - Landscape 1280×720 @320dpi ≈ **640dp wide → tablet / two-pane layout** (Android's tablet threshold is 600dp);
- At the same time `wm user-rotation lock 0` keeps the picture upright always, so nothing ever lies on its side;
- **The picture-rotation step is gone**, so the picture and the layout always agree;
- The window recomputes its aspect ratio for the new resolution and re-fits, leaving no black bars;
- **The full-screen button now switches to landscape (tablet layout) automatically**, and exiting full screen returns to portrait phone layout; the "display mode" switch in Settings behaves the same;
- The AVD config is now `hw.sensors.orientation=yes` + `hw.sensors.accelerometer=yes`, so future machines are no longer locked to portrait.

## 2. Fix: black strip appearing when clicking the four title-bar buttons

The emulator's Qt window is one ring larger than the real LCD (8 px gray border on each side). To keep the gray border out of the picture, the old approach overflowed the child window by 8 px up/left — and those 8 px sat exactly under the title bar; when a button was clicked the window agent raised the emulator window, so the overflow drew a **black strip** below the title bar.

**Fix**: the embedded emulator window now has **window region clipping** (`SetWindowRgn`), cutting away the 8 px that overflow into the title bar. However it is raised, it can no longer draw over the title bar.

## 3. Fix: taps not registering / could not hit "Agree and continue"

This shares a root cause with the two problems above: once the picture was rotated 90°, the window agent's coordinate mapping was still "portrait", so tap positions were shifted overall and it looked like "nothing happens when I tap". With the layout switch corrected, tapping works normally again.

While at it, the cost of "waiting for the network" was reduced: the cold-boot retry now happens **at most once per process**, and the initial wait dropped from 60 s to 25 s — previously opening an app could mean several extra minutes, now it is a few seconds in the normal case.

## 4. Storage footprint optimisation

"Clean up old-version leftovers" now also reclaims **abandoned quick-boot snapshots**:

- The `default_boot` left over from older versions (one ram.img of about **3 GB**);
- `*.stale-*` leftovers that could not be deleted and were renamed;
- The snapshot in use (`apkstart`) is never touched.

Measured on the development machine, reclaimable items totalled about **4.65 GB** (6 old version program directories + 1 abandoned snapshot).

## 5. Measured

- `npm test`: **113 items all passed** (8 + 25 + 80).
- After `wm size 1280x720` the framebuffer measured **1280×720** and the picture was upright (confirmed by screenshot).
- The app window embedded with `embedded=true`; after closing the window `pidof` is empty (the previous release's fix still works).

## 6. How to upgrade

- Portable: unzip over the old copy; the data directory (default `%APPDATA%\apkstart`) is untouched.
- Installed edition: install over the old copy.
