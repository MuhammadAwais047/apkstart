'use strict';
/**
 * Online update: take the latest version from GitHub Releases (RoutineMiku/apkstart), download and replace in place.
 *
 * All three package shapes must be handled:
 *   - Installer (NSIS): download `ApkStart-x.y.z-Setup.exe` and install silently (/S);
 *   - Lite (portable zip, runtime fetched on demand): download `ApkStart-vX-win64-portable.zip`,
 *     extract over the program directory - the runtime directory (%APPDATA%\apkstart\runtime), installed apps
 *     and snapshots all live under the user profile, so replacing program files does not touch them;
 *   - Full (portable with runtime bundled): same as lite, plus resources\runtime in the tree.
 *
 * Replacement cannot happen in this process (the exe is in use), so a PowerShell script is generated
 * and handed to a separate process via EncodedCommand: wait for exit -> copy files -> relaunch.
 * Passing the script as base64 rather than writing a .ps1 avoids the classic problem of a script
 * being decoded as GBK when the path contains non-ASCII (PowerShell 5.1 reads BOM-less scripts as ANSI).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { ZipFile } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const OWNER = 'RoutineMiku';
const REPO = 'apkstart';

/** PowerShell single-quoted string: inner ' must be doubled */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() feeds sources: decides "GitHub or Gitee" and "is there a mirror prefix"
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Package shape: installer (has uninstaller) or portable */
  get flavor() {
    try {
      const un = fs.readdirSync(this.installDir).find((n) => /^Uninstall .*\.exe$/i.test(n));
      if (un) return 'setup';
    } catch (_) { /* ignore */ }
    return 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Check for updates: query GitHub / Gitee concurrently, keep the higher version, union the assets.
   * Real download URLs are speed-ranked again inside prepare().
   */
  /**
   * @param {{force?:boolean}} [opts] force=true skips the 10-minute version cache
   *        (an explicit "check for updates" must return fresh data; the silent startup check uses the cache)
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // Releases carry both the "portable package" and the "runtime bundle" (ApkStart-runtime-*.zip).
    // The fallback .zip match must exclude the runtime bundle: if a release only ships the runtime bundle
    // and no portable package, the old logic extracted it into the program directory (1.5 GB of junk, broken install).
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // Keep parts: a Gitee split package has no single URL; dropping parts leaves "asset without address"
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // Same-named assets exist on both GitHub / Gitee: keep both URLs and let prepare() pick the faster.
          // sizes are per-URL byte counts - the two sources do not produce identical archives.
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // Per-source latest version / reachability lets the UI show which source was used
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * Download and stage the payload: portable extracts to update/<ver>/payload, installer keeps Setup.exe.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('This version has no auto-installable package. Download it manually from the GitHub releases page.');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Gitee caps attachments at 100 MB, so releases split the package into .part1/.part2.
    // Each part is speed-ranked and sourced independently (some from Gitee, some from a GitHub mirror),
    // then concatenated in order - still just "download + extract" from the user's perspective.
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Downloading ${it.asset.name}…` });
      // Candidates = origin + mirror prefix; sample 256 KB from each, then chunk-download from the fastest.
      // This is the only reliable routing when "GitHub direct gives tens of KB/s, a mirror gives MB/s":
      // guessing by domain does not work; speeds vary greatly within a single day.
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // Progress must use the total size of the source actually being downloaded: GitHub and Gitee archives differ
      // (different compressors, several MB apart); the wrong one shows 92% forever then jumps to done.
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti: chunks pulled from "GitHub direct" and "mirror" simultaneously, bandwidth adds up;
      // with a single usable source or no Range support it falls back to single-source chunking.
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Downloading ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Update package extracted' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Installer downloaded' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * Download and assemble a split package.
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Downloading ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + ` (part ${part.index}/${asset.parts.length})${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`Chunk ${part.index} has the wrong size (${buf.length} ≠ ${part.size}); aborted, you can retry`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`Assembled update size mismatch (${doneBytes} ≠ ${total}); aborted, you can retry`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        const target = path.join(dest, n.replace(/\\/g, '/'));
        if (!target.startsWith(path.resolve(dest))) continue;   // guard against zip-slip
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Extracting ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Generate and start the "replace + restart" script; the caller is then responsible for quitting.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] tests may override the pid / skip spawning
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      // Wait for this process to really exit (max 90s), otherwise exe/dll files stay locked
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  $probe = Join-Path $dst ${psq(path.basename(exe))}`,
        `  if (Test-Path $probe) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) { Note 'copy failed' }`,
        // Files removed in the new version do not disappear on overwrite, but keeping them is harmless;
        // only the extraction directory is cleaned to avoid wasting hundreds of MB.
        `Remove-Item -Path $src -Recurse -Force`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      `if (Test-Path ${psq(exe)}) { Start-Process -FilePath ${psq(exe)}; Note 'relaunched' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      `Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force`,
      // A failing cleanup statement (dir already gone / locked by AV) must not make the caller think the update failed
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand uses UTF-16LE base64: non-ASCII paths inside the script survive ANSI decoding
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Do **not** use detached here: some security software / sandbox policies block detached console processes,
    // and the script silently never runs (the UI hangs on "replacing files and restarting").
    // On Windows a parent exit does not kill an ordinary child, so "ordinary child + unref" keeps working
    // after we exit, with better compatibility.
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** When the UI cannot open (or no auto-installable asset exists), hand the release page to the browser */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO };
