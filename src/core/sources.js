'use strict';
/**
 * Unified download source management for both sources (GitHub / Gitee) plus mirror prefixes.
 *
 * Direct GitHub access from mainland China has two traps:
 *   1. api.github.com often takes tens of seconds or times out - showing as "checking for updates spins forever";
 *   2. asset downloads (objects.githubusercontent.com) throttle per connection, often around 100KB/s -
 *      a 1.5GB runtime bundle would take 4 hours.
 *
 * So no source is presumed primary; every run measures real bytes:
 *   - version info: GitHub and Gitee are queried **concurrently**, and whichever reports the higher version wins;
 *   - download URLs: list every form (direct GitHub / same-name Gitee asset / mirror-prefixed),
 *     download 128KB from each, sort by measured speed and take the fastest.
 *
 * Speed results are cached in memory for 30 minutes (repeated update checks or multi-component downloads need no re-test).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');

const OWNER_GH = 'RoutineMiku';
const OWNER_GITEE = 'daily-miku';
const REPO = 'apkstart';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    api: `https://gitee.com/api/v5/repos/${OWNER_GITEE}/${REPO}`,
    web: `https://gitee.com/${OWNER_GITEE}/${REPO}`,
  },
};

/** Known working GitHub acceleration prefixes. Only measured when the user enables autoMirror and sets no custom one. */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * Sample size for one speed test.
 * 128KB is too small: handshake + TLS already take hundreds of milliseconds, so the measured "speed" mostly measures latency
 * and a high-latency, high-bandwidth source looks slow. 256KB separates the two at acceptable traffic.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Invalid URL')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch a short JSON document (with redirects, timeout and a size cap) */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Really download a small slice of bytes to measure speed.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // Throughput counts only time after the first bytes arrive: the few hundred milliseconds of TLS handshake + DNS are fixed cost,
      // negligible for a 1.4GB package but enough to skew the verdict if mixed into the speed.
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // The asset is smaller than the sample: reaching EOF counts as success
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Put a mirror prefix in front of a GitHub asset URL */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * Gitee caps a release attachment at 100MB and the installer is 105-110MB, so publishing splits it into
 * xxx.zip.part1 / xxx.zip.part2. The parts are restored here into one logical asset:
 *   { name: 'xxx.zip', size: total, parts: [{index, size, urls:[...]}] }
 * Parts must be contiguous from part1, or the set is treated as incomplete and dropped (better a whole package than a corrupt one).
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // Note: Gitee release asset entries carry only name/url, with **no size**.
    // Using "size>0" as the completeness condition drops whole part sets as incomplete (measured),
    // so only contiguous parts with a URL per part are required; unknown sizes show progress by bytes received.
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** Mirror list: user-defined first, then built-in (autoMirror off means user-defined only) */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Version check cache: Gitee's anonymous rate limit is tight (403 after a few calls),
    // and "is there a new version" needs no second-level freshness anyway.
    this._relCache = { at: 0, key: '', value: null };
    this._relTtl = 10 * 60 * 1000;
    // Circuit break: after a source is rate limited or errors, skip it for a while instead of hitting the wall on every start
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** Whether the source is in a circuit-break window; null means usable, otherwise the reason shown to the user */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Skipping for now (no retry for ${Math.ceil((until - Date.now()) / 60000)} min)`;
  }

  /** Latest release per source (concurrent; one failure does not affect the other) */
  /**
   * API-free fallback: follow the 302 from `/releases/latest` to get the tag.
   *
   * Why this must exist: GitHub's anonymous API allows 60 calls per IP per hour,
   * and Gitee's is tighter (measured: 403 Rate Limit Exceeded after a few calls).
   * Behind corporate/campus networks or carrier NAT, users easily hit "update check failed" -
   * while the `releases/latest` web redirect goes through a CDN and consumes no API quota.
   *
   * Once the tag is known, asset names can be assembled by release convention:
   *   ApkStart-<tag>-win64-portable.zip / ApkStart-<version>-Setup.exe / ApkStart-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Assemble a "minimally usable" release from a tag (used without the API) */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `ApkStart-${tag}-win64-portable.zip`,
      `ApkStart-${ver}-Setup.exe`,
      `ApkStart-runtime-${tag}.zip`,
    ];
    // Both GitHub and Gitee support the canonical /releases/download/<tag>/<filename> address
    // (measured: Gitee 302s to a foruda.gitee.com attachment address and serves complete bytes),
    // so usable download URLs can be assembled without the API. Assets absent on Gitee return 404,
    // and the speed ranking skips them automatically.
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const prefs = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const ids = prefs === 'github' || prefs === 'gitee' ? [prefs] : ['github', 'gitee'];
    // A public repository's releases API is readable anonymously; if the repository is private, Gitee returns 404
    // "Not Found Project" (not 401), and only then is a read-only token needed here.
    // Anonymous calls are also rate limited, and interested users can add a token for a higher quota.
    const token = String((this.settings().runtime || {}).giteeToken || '').trim();
    const withToken = (id, url) => (id === 'gitee' && token
      ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      : url);

    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      const skip = this.blockedReason(id);
      if (skip) return { source: id, name: s.name, web: s.web, error: skip };
      try {
        const rel = await getJson(withToken(id, `${s.api}/releases/latest`), 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // With no formal Gitee release, or GitHub blocked, fall back to the first entry in the list
        try {
          const list = await getJson(withToken(id, `${s.api}/releases?per_page=10`), 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* try the API-free fallback next */ }
        // Fallback under rate limiting / blocking: get the tag from the web redirect and assemble asset names by convention
        try {
          const tag = await this._releaseTagViaRedirect(id);
          if (tag) {
            return { source: id, name: s.name, web: s.web, rel: this._syntheticRelease(id, tag), degraded: true };
          }
        } catch (_) { /* the fallback failed too */ }
        const limited = /\b(403|429)\b/.test(e.message);
        if (limited) this._blocked.set(id, Date.now() + this._blockMs);
        const hint = limited
          ? ' (rate-limited; this source is paused for a while)'
          : (id === 'gitee' && !token ? ' (retry later, or set a read-only token in Settings to raise the quota)' : '');
        return { source: id, name: s.name, web: s.web, error: `${e.message}${hint}` };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * Merge the two latest versions: the higher version wins, but the **asset lists are unioned**,
   * so even when Gitee has only metadata and the assets sit on GitHub, both routes are tried.
   */
  async latest({ force = false } = {}) {
    const pref = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const cached = this._relCache;
    if (!force && cached.value && cached.key === pref && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // Rate-limited sources are recorded in the circuit break (here rather than inside fetchReleases so "who provides
    // the result" stays replaceable/testable, while a 403 from any entry point still trips the break)
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'no data'}`).join('; ');
      // Everything failed but a previous result is at hand: better possibly stale version info
      // than a bare error - the user can at least still see the current version and the release page.
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`Cannot reach the update server (${why})`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // Only assets of the same version count (old assets from another source must not be installed).
    // When a whole package and a part set share a name, prefer the whole package: parts need assembly, an extra failure point.
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // Gitee automatically attaches source archives as assets (v0.3.2.zip / v0.3.2.tar.gz),
        // which are not installers; a `\.zip$` rule would download them as updates - so they must be excluded.
        // Our own release assets all start with ApkStart, so whitelisting that prefix is safer.
        if (!/^ApkStart/i.test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // The same asset exists on both sources (the norm now that the package is not split): keep every URL as a candidate.
    // It used to dedupe by name and keep the first - GitHub came first, Gitee's URL was dropped,
    // and "automatically pick the better network source" degraded to GitHub only. Now the measured speed decides (see rank()).
    // Each URL's size is recorded separately: the two sources' packages are not the same bytes (different packer/build machine, several MB apart),
    // and downloadMulti only mixes URLs whose declared total size matches, so the sizes must never be averaged.
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), key: pref, value: result };
    return result;
  }

  /**
   * Candidate URLs for one asset across all sources + mirrors (deduped, order preserved: sources first, then mirrors).
   * Mirrors wrap GitHub URLs only: ghfast / gh-proxy proxy GitHub alone,
   * so prefixing a Gitee link just yields a 403 and one wasted speed test.
   */
  candidates(assetOrUrl) {
    // Accepts three shapes: a single URL, an asset object (url), or a merged asset object (urls array covering both sources)
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * Rank candidate URLs by measured speed. Results are cached for 30 minutes;
   * if every test fails, the original order is kept (so the worst case can still download).
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `Benchmarking ${need.length} download sources…` });
      // Test sequentially, not concurrently: concurrent tests steal each other's bandwidth and the ranking becomes "who grabs hardest"
      // rather than "who is really fast". At 256KB per source a normal test takes about a second.
      // One source is abandoned after 6 seconds (the old 9 seconds times 4 sources meant up to 36 seconds with no byte progress,
      // which users saw as "stuck preparing the runtime"); a failed test only ranks last and never blocks downloading.
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* invalid URL: show it as-is */ }
        onProgress?.({ stage: 'probe', message: `Benchmarking source ${i}/${need.length}: ${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `Fastest source selected: ${new URL(best).host} (about ${(s / 1048576).toFixed(2)} MB/s)`,
      });
    }
    return sorted;
  }

  /** Clear the speed cache (called after a mirror prefix change / network change) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, key: '', value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
