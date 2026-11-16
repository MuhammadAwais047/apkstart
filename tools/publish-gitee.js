'use strict';
/**
 * Sync a release to Gitee.
 *
 * Why this script: Gitee caps release attachments at 100 MB per file (104,857,600 bytes allowed,
 * 104,800,000 uploads fine). The 7-Zip portable package is ~99.6 MB, so a single complete zip
 * can be uploaded and extracted directly - no more part1/part2 (which must be concatenated in order;
 * manual downloaders cannot use them). Only a genuine over-limit package falls back to parts, and the
 * app's updater accepts both.
 * The Setup installer (1.4 GB) and runtime bundle (1.4 GB) are far over the limit and stay on GitHub -
 * the app unions assets across sources, so updates still work.
 *
 * Usage:
 *   GITEE_TOKEN=xxxx node tools/publish-gitee.js v0.3.3 D:/dist
 *     v0.3.3   tag to publish (must already be pushed to Gitee)
 *     D:/dist  directory holding ApkStart-v0.3.3-win64-portable.zip (optional; --zip also works)
 *
 *   node tools/publish-gitee.js v0.3.3 --zip D:/x.zip --notes notes.md
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'daily-miku';
const REPO = 'apkstart';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const HARD_LIMIT = 100 * 1024 * 1024;  // Gitee attachment size cap (100MiB, verified)
const PART_LIMIT = 99 * 1024 * 1024;   // part size when splitting is unavoidable; 1MB left for multipart headers

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

async function api(method, p, body) {
  const token = process.env.GITEE_TOKEN;
  if (!token) throw new Error('GITEE_TOKEN environment variable is missing');
  const url = `${API}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* may be an empty response */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json || {};
}

/** Split a large file; returns the array of resulting paths */
function splitFile(file, limit) {
  const size = fs.statSync(file).size;
  if (size <= limit) return [];
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    let index = 1;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(limit, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const p = `${file}.part${index}`;
      fs.writeFileSync(p, buf);
      out.push(p);
      offset += len;
      index += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * Upload a single attachment.
 * A 95 MB package goes up in one POST (Gitee has no chunked upload), and on mainland links it easily
 * dies halfway with fetch failed - there used to be no retry, so one hiccup meant re-running everything
 * (and deleting old attachments first). So: 3 retries with growing backoff.
 */
async function upload(releaseId, file, attempts = 3) {
  const token = process.env.GITEE_TOKEN;
  const name = path.basename(file);
  const buf = fs.readFileSync(file);
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('file', new Blob([buf]), name);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      // 4xx (except 429) is not worth retrying: bad token, name conflicts etc.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Upload ${name} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      lastErr = new Error(`${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
      if (/^Upload .* failed/.test(e.message)) throw e;
    }
    if (i < attempts) {
      const wait = i * 8;
      console.warn(`   Upload attempt ${i} failed (${lastErr.message}); retrying in ${wait}s...`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(`Upload ${name} failed after ${attempts} attempts: ${lastErr && lastErr.message}`);
}

(async () => {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error('Usage: GITEE_TOKEN=xxx node tools/publish-gitee.js v0.3.3 [--zip path] [--notes file]');
    process.exit(1);
  }
  const dir = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  let zip = arg('--zip', '');
  if (!zip && dir) {
    const hit = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((n) => /portable\.zip$/i.test(n))
      : '';
    if (hit) zip = path.join(dir, hit);
  }
  if (!zip || !fs.existsSync(zip)) {
    console.error(`Portable package not found: ${zip || '(not specified)'}. Use --zip or place the zip in ${dir}`);
    process.exit(1);
  }
  const notesFile = arg('--notes', '');
  const body = notesFile && fs.existsSync(notesFile)
    ? fs.readFileSync(notesFile, 'utf8')
    : `Portable package (single zip, unzip and run; in-app updates included). Full installer and runtime bundle are on GitHub Releases.`;

  console.log('1) Find/create release', tag);
  const list = await api('GET', `/releases?per_page=50`);
  let rel = (Array.isArray(list) ? list : []).find((r) => r.tag_name === tag);
  if (!rel) {
    rel = await api('POST', '/releases', {
      tag_name: tag,
      name: tag,
      target_commitish: 'main',
      body,
    });
    console.log('   created id =', rel.id);
  } else {
    console.log('   exists id =', rel.id);
  }

  // Re-publishing the same version (rebuilt after code changes) must delete old attachments first, or the page
  // shows both old and new part1/part2 and clients pick one by luck.
  if (process.argv.includes('--replace')) {
    console.log('2) Remove same-named old attachments');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    const olds = (Array.isArray(list) ? list : []).filter((a) => /^ApkStart-.*\.zip(\.part\d+)?$/i.test(a.name || ''));
    for (const a of olds) {
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   delete', a.name);
    }
  }

  const zipSize = fs.statSync(zip).size;
  if (zipSize > HARD_LIMIT) {
    console.warn(`WARNING: portable package ${(zipSize / 1048576).toFixed(1)} MB exceeds the Gitee per-file cap and must be split;`
      + 'manual downloaders must concatenate the parts; run `node build/zip.js` first or slim the package.');
  }
  console.log('3) Prepare upload (whole package first; split only if over the cap)');
  const parts = splitFile(zip, PART_LIMIT);
  const files = parts.length ? parts : [zip];

  // A version may switch packaging (whole <-> parts): delete the same-named attachment of the other form,
  // or the release carries both `x.zip` and `x.zip.part1/part2` and clients pick by luck.
  // --replace would clear other versions too; this only clears the other form of this package name.
  {
    const base = path.basename(zip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const other = parts.length ? new RegExp(`^${base}$`, 'i') : new RegExp(`^${base}\\.part\\d+$`, 'i');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    for (const a of Array.isArray(list) ? list : []) {
      if (!other.test(a.name || '')) continue;
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   delete the other-form attachment', a.name);
    }
  }

  for (const f of files) {
    console.log(`   upload ${path.basename(f)} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
    // eslint-disable-next-line no-await-in-loop
    await upload(rel.id, f);
  }
  for (const p of parts) fs.rmSync(p, { force: true });
  console.log(`\nDone: https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
