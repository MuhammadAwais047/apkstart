'use strict';
/**
 * Pure computation part of display fitting (unit-testable, no Electron / adb dependency).
 *  - full screen: the Android resolution aligns with the monitor work area and content fills it automatically;
 *  - windowed: keep the portrait preset; Qt rescales as the user drags, and the size is recorded in the app metadata.
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

function defaultBounds(area) {
  const h = Math.round((area.h || 1080) * 0.84);
  const w = Math.round(h * 9 / 16);
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round((area.y || 0) + ((area.h || 1080) - h) / 2),
    w, h,
  };
}

/**
 * Full screen = fill the screen height and centre horizontally.
 * The emulator window's aspect ratio is locked to the LCD at boot (9:16), so a plain SW_MAXIMIZE only yields
 * a left-aligned window of unchanged width; compute a height that fills the screen, then centre it, and visually
 * the app fills the screen with no distortion.
 */
function fullscreenBounds(portrait, area) {
  const p = portraitSize(portrait);
  const ratio = p.w / p.h;
  const h = Math.max(320, Math.round(area.h || 1080));
  const w = Math.max(240, Math.round(h * ratio));
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round(area.y || 0),
    w, h,
  };
}

/**
 * Android-side resolution: both modes keep the portrait preset.
 * Why: the emulator window's aspect ratio is locked to the LCD size at boot (measured: after changing to 1920x1080
 * the window still only accepted 9:16, and squeezing the picture in left black bars or distortion). So "full screen" = maximise
 * the window to fill the screen, "windowed" = freely resizable portrait, and both share one Android resolution,
 * so switching needs no runtime restart and does not re-lay out the app.
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor };
