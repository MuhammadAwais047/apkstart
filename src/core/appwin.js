'use strict';
/**
 * App window: one running Android app = one clean Windows window.
 *
 * The window has only a 38px title bar at the top (rotate / minimise / maximise / close),
 * and the whole area below is the embedded emulator window (SetParent), so the Android desktop is never visible,
 * nor the emulator's own side toolbar, and no second taskbar icon appears.
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');

const TITLEBAR_H = 38;
/**
 * The emulator window carries an 8px grey padding on every side (Qt frame margin),
 * and the real LCD picture starts at +8px. Growing the child window by 16px and offsetting it up/left by 8px
 * pushes that grey ring exactly out of the client area, so the picture sits flush on all sides.
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // The global mouse hook is only installed while the app window is in the foreground with at least one mapping on.
    // pointerConfig is a function: toggling it on the settings page takes effect on the next focus, no restart needed.
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** Target content size for portrait / landscape (scaled down to fit the screen automatically) */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // Leave enough margin: 38 for the title bar, 24 top and bottom, 40 left and right
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // Double safety: never exceed the work area, or the system clips it and it looks like "black bars / not filled"
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height };
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * Open (or reuse) the app window.
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, onClosed }
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen } = o;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      this.win.show();
      this.win.focus();
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    this.portrait = portrait || { w: 540, h: 960 };
    this.state = { label: label || 'App', tip: 'Starting the Android runtime…', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // A page title would overwrite the window title with shell.html's <title>, and the taskbar would no longer know which app this is,
    // so block it and keep the OS title equal to the app name (the taskbar tooltip and Alt+Tab rely on it).
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkStart'); } catch (_) { /* the window may already be destroyed */ }
    });
    this.win.once('ready-to-show', () => {
      this.win.show();
      this._push();
    });

    // When Electron maximises, the window size settles over several steps (OS animation, DPI re-computation),
    // so a single 40ms debounced fit often catches an intermediate state, leaving the embedded picture as a strip in the top-left
    // with a large blank area on the right - exactly the "not filled after maximising" seen in screenshots.
    // Now it converges over several consecutive fit rounds, each recomputed from the latest getContentBounds.
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() finishes the job itself after park completes
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // Close paths that bypass close() (Alt+F4, taskbar close, system shutdown) must still stop the Android app
      // and detach the emulator window. Otherwise the window is gone but the app keeps running in the background, and the next click
      // switches straight to it as "already running", which looks like "it cannot be closed".
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // Install the global hook only while the app window is genuinely in the foreground and at least one mouse mapping is on;
    // uninstall it immediately on blur or close, so ApkStart never slows down the system mouse in the background.
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    if (fullscreen) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // In game / low-latency mode the global mouse hook is not installed at all: WH_MOUSE_LL calls back synchronously
    // for every mouse event on the desktop and clearly adds pointer latency; FPS games need the Qt window to get raw input directly.
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** Mouse mappings changed on the settings page: resync once for the current focus (without reinstalling the hook thread) */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // Window not in the foreground: only uninstall, never let the hook idle in the background
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* the window may have just closed */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * Embed the emulator window into the current window and fill the area below the title bar.
   * Resident suppression stays on: it skips the one already embedded in our window and keeps suppressing the rest (including
   * the qemu / netsimd console windows) - turning it off would just give them another chance to flash.
   * The emulator window is occasionally not created yet (on machines restoring the snapshot too fast), so retry twice here.
   */
  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect()).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // Carry the failure reason out: the caller writes it to app.log, so it is obvious whether "emulator window not found"
    // or "SetParent failed", with no guessing.
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});
  }

  /** Rectangle the emulator child should occupy (physical pixels, with the 8px padding pushed out of view) */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // The -EMU_PAD strip above overlaps the title bar and is clipped by the window agent (see clipTop in agent.fit)
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds how many consecutive fit rounds (each recomputes the latest bounds when the window size changes)
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * Orientation switch (the rotate button in the title bar) = genuinely swapping the "physical panel" between landscape and portrait.
   *
   * Why it has to work this way (lessons from dead ends):
   *   - wm size: only the Android logical resolution changes; the emulator's physical LCD stays portrait,
   *     Qt pins the picture to the top-left -> the picture lies on its side 90 degrees, occupies one strip, has black bars and taps land off-target;
   *   - wm density: the framebuffer size is unchanged, the picture never fills, leaving a large blank area on the right when maximised;
   *   - adb emu rotate: only the picture content rotates; the system stays portrait.
   * The only way to get an upright, filled landscape is to change hw.lcd.width/height to
   * 1280x720 and restart the emulator. That takes about 30-60 seconds, so it is done once with a clear notice.
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] restart implementation injected by the caller
   */
  async rotate(onRestart) {
    if (!this.isOpen) return this.state.landscape;
    const next = !this.state.landscape;
    this.setState({ tip: next ? 'Switching to landscape (restarting the Android runtime, about 30-60 s)…' : 'Switching back to portrait (restarting the Android runtime, about 30-60 s)…', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // the panel size changed, so the window aspect ratio follows; converge over several fit rounds
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // Without an injected restart (or if it fails), fall back to the density approach so at least the layout flips
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** Switch to the given orientation when needed (full screen = landscape, windowed = portrait) */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  toggleMaximize() {
    if (!this.isOpen) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  minimize() { if (this.isOpen) this.win.minimize(); }

  /**
   * Close the window. By default the Android app stops too (saves memory) while the engine is kept, so the next launch is instant.
   *
   * Order matters: detach and hide the emulator window from the host first, then destroy the host.
   * Otherwise Windows re-parents the cross-process child onto the desktop and keeps its previous visibility,
   * leaving a stray "Android Emulator - apkstart5554" black window on the user's desktop.
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
