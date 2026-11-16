'use strict';
/**
 * Windows window agent: talks to the resident process in src/core/win/agent.ps1.
 *
 * Why not spawn a PowerShell for every call: resizing the window while it follows the mouse happens constantly,
 * and starting powershell.exe takes 150-300 ms each time, which makes dragging visibly stutter.
 * So the agent is started once and then spoken to over loopback TCP (one JSON per line), with a round trip under 2 ms.
 *
 * The agent can optionally own a WH_MOUSE_LL mouse hook: right button = back / wheel = swipe / side buttons = forward and back.
 * That hook is global and sees every mouse event in the system, so it is only installed while the app window is in the foreground
 * and at least one mapping is enabled; it is uninstalled on focus loss, and the callback only handles the 7 messages we care about.
 * See setHook(on, opts).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** Start the agent and wait for the TCP connection (idempotent) */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('Window agent unavailable')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('Window agent exited');
        if (wasReady) this.emit('exit');
        fail(new Error('Window agent failed to start'));
      });
      setTimeout(() => { if (!settled) fail(new Error('Window agent start timed out')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Window agent connection lost');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // Events carry a payload (wheel dx/dy/nx/ny); older listeners simply ignore the extra arguments
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Send one command and wait for the reply */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('Window agent not connected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Window agent timeout: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- Convenience methods ----------------

  /**
   * Declare "which directories' processes count as ours".
   * Must be called before bootHide / embed: the window agent may only touch windows created by these processes.
   * When omitted (or empty) the agent touches no window at all - better to occasionally miss a black window
   * than to hide or embed a window of another Qt app (WeChat 4.x is Qt6, as are MuMu and music players).
   * @param {string[]} dirs runtime root directory / the bundled engine directory
   * @param {number} [appPid] main process pid: the agent may only embed windows into this process's window,
   *        and uses it to decide whether the window under the mouse is ours (guards against handle reuse)
   */
  async scope(dirs, appPid) {
    const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const req = { cmd: 'scope', dirs: list.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /** Embed the emulator window into the host window at x,y,w,h (host client-area coordinates) */
  async embed(hostHwnd, rect) {
    return this.call({
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    });
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // The emulator's Qt window has an EMU_PAD frame around the LCD, so we let it overflow up/left to push
      // that frame out of the client area; the strip over the title bar is clipped away (otherwise black edges appear when using the title-bar buttons).
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** Tell the agent to enter low-latency mode: much lower window scan rate, leaving CPU for Android rendering */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  async detach() { return this.call({ cmd: 'detach' }, 5000); }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** List the currently visible top-level windows (to verify "only our UI / only the Android app window") */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * Detach and hide the prime suspect window.
   * Must be called before the host window is destroyed: when a parent window is destroyed, Windows re-parents cross-process children onto the desktop
   * and keeps their previous visibility - that is exactly where the stray "Android Emulator" black window on the desktop comes from.
   * The agent may be busy (compiling C#), but the window must still be closed, so there is a hard 700 ms cap here.
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * Enable "resident suppression": the emulator main window (QWindowIcon), its toolbar and the qemu / netsimd console windows
   * are never allowed to show, except the one embedded into our window.
   * This is what makes "launch the app, see only the app UI" work: the emulator detaches qemu / netsimd
   * console children that Node's windowsHide cannot reach, so only the window agent can keep them suppressed periodically.
   * The emulator also runs with -qt-hide-window (hidden at creation), a second safety net, so not even the first frame flashes.
   *
   * maxWaitMs: the agent itself has to be compiled and started (hundreds of ms, or tens of seconds in bad cases). The call site is
   * "before the emulator starts", so a dead agent must never stall startup; hence this hard cap.
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** Turn resident suppression off (normally no longer needed: after embedding it skips the embedded window automatically) */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * Global mouse hook switch (idempotent).
   * Only installed while the app window is in the foreground and at least one mapping is on; changing opts does not reinstall the thread,
   * only the new switches are sent to the resident agent, so repeated focus changes or settings edits do not thrash the hook.
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // While off by default, do not start a PowerShell process just to "turn it off" (zero cost on cold start)
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // Uninstall the global hook before ending the process: even if the agent is killed, no hook is left behind in the system
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // Deliberately do not kill the agent process: after the connection drops it enters "guard" mode (see
    // _lingerUntil in agent.ps1). The emulator may still be booting and only show its window tens of seconds later; if the
    // agent were already gone, a black Android Emulator window would be left on the desktop. After the emulator process exits
    // the agent exits by itself, guarding for at most 3 minutes.
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
