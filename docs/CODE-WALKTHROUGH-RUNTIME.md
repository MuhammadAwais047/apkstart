# Runtime stack code walkthrough (sources / download / provision / updater / store / layers / small utilities)

> Code version: `package.json` = **0.3.5**, `main` = `src/main.js`.
> Line numbers refer to the current working copy (`D:\apkstart-dsh\apkstart`); files may have changed, so look up the function name and re-check the line number before quoting.
> Scope: `src/core/{sources,download,provision,updater,store,layers,logfile,notify,android,display}.js`,
> plus the callers `src/main.js` / `src/core/{engine,emulator,installer}.js` and `test/`.
> This document states code facts only; "yes" = has a test, "no" = no coverage.

Dependency direction (important, to avoid circular requires):

```
main.js ──> engine.js ──> provision.js ──> sources.js ──> version.js
   │            │              │  │
   │            │              │  └──> download.js
   │            │              └─────> store.js / doctor.js / zip.js
   │            ├──> emulator.js ──> provision.js / logfile.js
   │            └──> layers.js ──> store.js (lazy require inside summary)
   ├──> updater.js ──> sources.js / download.js / zip.js / version.js
   ├──> installer.js ──> store.js / provision.js (via runtime.provisioner)
   └──> android.js / notify.js / display.js / logfile.js
```

The reason `version.js` exists on its own is written in `version.js:2-4`: to keep `updater` and `sources` from requiring each other in a cycle.

---

## 1. `src/core/sources.js` — GitHub / Gitee dual source + mirrors + speed test + circuit-breaker cache

### Responsibility
Abstracts "read version info" and "get download URLs" into a set of candidate URLs ordered by **measured byte throughput**, and briefly trips a circuit breaker for sources that are rate-limited or erroring.

### Public interface

| Export | Signature | Notes |
|---|---|---|
| `Sources` | `new Sources(settingsFn)` | `settingsFn: () => settings`, read fresh on every decision (settings are not cached) |
| `Sources#blockedReason` | `(id: 'github'\|'gitee') => string\|null` | `null` = usable; otherwise returns the reason string `temporarily skipped (not retried for N minutes)` (230-234) |
| `Sources#fetchReleases` | `() => Promise<Array<{source,name,web,rel?,error?}>>` | Uses `sourcePreference` to decide whether to ask one side or both, `Promise.all` in parallel (237-271); can be overridden by tests |
| `Sources#latest` | `({force=false}) => Promise<Merged>` | Merged version info (see below), 10-minute cache (277-364) |
| `Sources#candidates` | `(assetOrUrl: string\|{url}\|{urls:[]}) => string[]` | Original source first, mirrors after, deduplicated with order preserved (371-393) |
| `Sources#rank` | `(urls, {onProgress}) => Promise<string[]>` | Descending by measured speed cached for 30 minutes; ≤1 URL returns immediately (399-432) |
| `Sources#reset` | `() => void` | Clears the speed cache + version cache + breaker (435-439) |
| `SOURCES` | `{github:{id,name,api,web}, gitee:{...}}` | Constants with the owner hardcoded at 22-24 |
| `measure` | `(url, {bytes=256*1024, timeoutMs=9000}) => Promise<{url,ok,got,ms,ttfb,speed,error?}>` | Actually downloads 256KB to measure throughput (108-157) |
| `withMirror` | `(url, prefix) => string` | Adds a trailing slash to the prefix; returns `''` for a non-`http(s)://` value (160-164) |
| `mirrorList` | `(settings) => string[]` | A custom prefix wins exclusively → otherwise the built-in mirrors while `autoMirror!==false` (207-213) |
| `KNOWN_MIRRORS` | `['https://ghfast.top/','https://gh-proxy.com/']` | 42-45 |

The structure returned by `latest()` (350-361):

```js
{
  version, tag, name, notes, htmlUrl, publishedAt,
  assets: [{ name, size, url, urls: string[], sizes: { [url]: bytes },
             parts?: [{index,size,urls:[]}], partial?: bool, source }],
  sources: [{ source, name, tag }],      // sources that took part in the merge
  unreachable: [{ source, name, error }],
  bySource,                              // winning source
  stale?: true, staleReason?             // every source failed but an old result is at hand (296)
}
```

### Key internals

**1) Version lookup = ask both sides in parallel + fall back to the list endpoint (248-269)**
- First `${api}/releases/latest`; on failure `${api}/releases?per_page=10` and take the first non-`draft` entry;
- A private Gitee repository answers **404 "Not Found Project"** (not 401); in that case the read-only `runtime.giteeToken` can be filled in (`243-246` appends `access_token`);
- Only `403/429` records a breaker, `_blockMs = 15min` (226, 263). **The breaker is also recorded again inside `latest()`** (286-290); the comment says this lets tests replace "who provided the result" (that is how auto-test injects it).

**2) Merge strategy**
- The version is the highest by `cmpVer` (299), then **only assets of that version are kept** (307-310);
- Asset allowlist: `/^ApkStart/i` (316), excluding the source archives Gitee attaches automatically;
- Same-name assets from different sources merge into `urls[]` and **record `sizes{}` per URL** (334-348) — the two sources compress to different byte counts, so they must never be averaged;
- If the same version has both a full package and parts, **the full package wins** (326-327);
- If every source fails but `_relCache.value` exists → return the old result flagged `stale` (292-298), so the UI does not have to show an error.

**3) Three cache layers**

| Cache | Field | TTL | Invalidated by |
|---|---|---|---|
| Speed test | `_rankCache: Map<url,{at,ok,speed}>` | 30min (219) | `reset()`; `ok=false` is cached too and sorts as -1 (418-421) |
| Version | `_relCache: {at,key,value}` | 10min (223) | `key` mismatch (`sourcePreference` changed) / `force` / `reset()` |
| Breaker | `_blocked: Map<sourceId, untilMs>` | 15min (226) | `reset()` |

**4) Speed tests are serial (408-417)**: the comment states plainly that running them concurrently makes them steal each other's bandwidth, so the result becomes "whoever grabs hardest". The cost is a worst case of `candidate count × 9s` (the `timeoutMs` of `measure`).

**5) Throughput counts only the time after the first byte (120-122)**: `span = now - (firstAt || t0)`, excluding fixed TLS/DNS overhead; otherwise a "high latency but high bandwidth" source would be misjudged as slow.

**6) Reassembling parts in `groupParts` (172-204)**: `xxx.zip.part1/.part2` → a logical asset `{name, size=Σ, parts:[{index,size,urls:[]}], partial:true}`; a missing URL or a non-contiguous index marks it `broken`, which `list` filters out; the `broken` list is returned but `latest()` **does not expose it**.

### Pitfalls and invariants

- **Gitee's 100MiB per-file limit** (comment at 172-204, `.github/release.yml:36-44,78-100`): anything over it is split into `.part1/.part2`; `updater._downloadParts` stitches them back.
- **Gitee asset entries carry no `size`** (198-201): so "integrity" only requires "parts contiguous + each part has a URL", never `size>0`; when the size is unknown progress is shown by bytes received.
- **Source archives `v1.2.3.zip` / `.tar.gz` show up among the assets** (313-316): the `^ApkStart` allowlist blocks them; a suffix match like `\.zip$` would download the source archive as an update package.
- **Mirrors can only wrap GitHub URLs** (366-369, 385-390): ghfast / gh-proxy proxy GitHub only, so appending a Gitee URL just yields 403 after a wasted speed test.
- **Same-name assets must keep every URL** (329-333): the old behavior deduplicated by name ("first one wins"), GitHub came first → Gitee addresses were dropped → automatic source selection degenerated to GitHub only.
- `SAMPLE_BYTES = 256KB` (52), yet the comment at `provision.installRuntimePack:532` still says "128KB" — **the comment is stale; the implementation uses 256KB**.
- In `measure`, `openUrl` returns `res` (the stream), and `done()` calls `req.destroy()` on the stream rather than the request object (`req = res` at 115-132); it works, but the naming is misleading.
- `groupParts` also marks `part0` (starting at 0) as `broken` (196 requires `index === i+1`).
- Invariant: the first item of `candidates()` is always **the original source URL** (380-382) and `rank()` only sorts when `length>1` (401) — the guarantee that "in the worst case a direct download still works".

### Call sites
- `src/core/provision.js:16` (require), `:145` (`new Sources(() => store.getSettings())`), `:149-151` (`get sources`), `:535` (`rank`), `:588` (`candidates`, `_downloadUrls`).
- `src/core/updater.js:23,47` (`new Sources(this.settings)`), `:74` (`latest`), `:140-141` (`candidates`+`rank`), `:191-196` (per-part `candidates`+`rank`).
- `src/main.js:819-825`: changing `sourcePreference/mirrorPrefix/autoMirror` in settings → `updater.sources.reset()` + `provisioner.sources.reset()`. **Note** that this does not clear `provisioner._cache.pack / emulatorUrl / sysimgUrl / playUrl` (see the pitfalls in §3).

### Test coverage (`test/auto-test.js`)
- yes `:843` candidate URLs include mirror prefixes, and a custom prefix takes precedence over public mirrors
- yes `:864` speed-test results are sorted by speed, and when everything fails the original order is kept without dropping usable URLs (also verifies `reset()`)
- yes `:878` the source archive Gitee attaches automatically (`v1.2.3.zip`) must never be treated as an installer
- yes `:901` Gitee assets have no `size`: a part group must still form
- yes `:926` part assets must be carried all the way to `updater.asset`
- yes `:949` when merging versions only assets of that version are accepted
- yes `:976` when the same-name full package exists on both sides, both URLs are kept
- yes `:1282` the version result is cached for 10 minutes and `force` re-queries
- yes `:1300` a 403 trips the breaker, `blockedReason` explains it, and `reset()` clears it
- yes `:1323` when every source is unreachable the previous result is returned (`stale`)

---

## 2. `src/core/download.js` — single stream / chunked / multi-source parallel + resume + watchdog

### Responsibility
A four-tier downloader built only on `http/https/fs`: single-stream resume → single-source chunking → multi-source chunking (bandwidth aggregation) → try the next source; all with an idle watchdog and a "must settle" guarantee.

### Public interface

| Export | Signature | Returns |
|---|---|---|
| `openStream` | `(url, {method='GET', headers={}, redirects=0}) => Promise<IncomingMessage>` | Follows 301/302/303/307/308 (≤6 hops), 30s socket idle timeout (15-36) |
| `head` | `(url) => Promise<{status,size,type,error?}>` | Never throws; `status:0` on failure (38-50) |
| `sha256File` | `(file) => Promise<hex>` | 52-60 |
| `download` | `(url, dest, opt) => Promise<{file,size}>` | `opt = {onProgress,signal,expectSha256,retries=2,idleMs=30000}` |
| `downloadParallel` | `(url, dest, opt) => Promise<{file,size,parallel:n}>` | `opt += {connections=8,minChunk=1MB,retries=3}` |
| `downloadAny` | `(urls, dest, opt) => Promise<{file,size,url}>` | Tries each in turn, throws an aggregate error when all fail (314-326) |
| `downloadMulti` | `(urls, dest, opt) => Promise<{file,size,parallel,sources,multi,resumed}>` | `opt += {minChunk=2MB,retries=6,idleMs=20000,slowAfterMs=45000,slowBps=120*1024}` (338-548) |
| `downloadAnyParallel` | `(urls, dest, opt) => Promise<{file,size,url}>` | Calls `downloadParallel` for each in turn (551-563) |

`onProgress` payload: `{got,total,percent,speed,eta}` (`downloadMulti` additionally includes `sources`).

### Key internals

**1) `download()`: single stream + resume (68-173)**
- Before each attempt `statSync(dest).size` → `Range: bytes=existing-` (75-77);
- `416` is treated as "already complete" and breaks immediately (82-86);
- `200` with `existing>0` = the server does not support resume → `rmSync` and rewrite (97-100);
- Non-200/206: at most `retries=2` retries with a **fixed 1500ms backoff** (87-90);
- Idle watchdog `idleMs` (default 30s): `kick()` resets it on every data chunk; on timeout `res.destroy()` + `finish(Error('connection stalled (no data for a long time)'))` (112-130). The comment (109-111) records the reason: when a connection goes silent, `res` neither `end`s nor `error`s, `pipe` never `finish`es, and the whole download hangs with no error;
- `signal.abort` → `res.destroy(new Error('cancelled'))` (132-133);
- On completion it forces `onProgress({percent:100})` (162-163); a mismatched `expectSha256` → delete the file + throw (165-171).

**2) `downloadParallel()`: single-source chunking (180-311)**
- An existing non-empty file → fall back to `download()` directly, to avoid losing chunk state (188-191);
- Range probe: `Range: bytes=0-0`; parallel only with 206 + `content-range`; `total < minChunk*2` also falls back to a single stream (193-210);
- `n = min(connections, ceil(total/minChunk))`, `per = ceil(total/n)` (212-213);
- `ftruncateSync(fd,total)` creates the empty file first, then each chunk does a positioned `fs.writeSync(fd, buf, 0, len, pos)` (219-220, 268);
- Each chunk gets at most `retries=3` with a `800 * tries` ms backoff (285-300);
- Final check `size === total`, otherwise throws "download incomplete" (307-310).

**3) `downloadMulti()`: multi-source chunking (338-548)**
1. `list = dedupe(urls)`; if there is only one → `downloadParallel` (350-352);
2. `Promise.all` probes the `content-range` total size of every URL in parallel (355-365); if none supports Range → `downloadAnyParallel` (367-370);
3. **The baseline total comes from `usable[0].total`**, i.e. the first one after `rank()` (the fastest source), not `Math.max` (371-377); only sources with `total === that value` are mixed in (378-381);
4. `n = clamp(2..connections, ceil(total/minChunk))`; chunks are assigned round-robin over the sources by `i % same.length` (384, 409-416);
5. **Chunk-resume sidecar** `${dest}.chunks.json` (391-405): trusted only when `m.total===total && m.n===n && dest size===total`; otherwise the file and the sidecar are deleted and the download restarts. Completed chunks do `doneSet.add(c.start)` + `saveMeta()` (518-520);
6. On resume the completed chunks are counted into `got`, so progress does not restart at 0 (425-427);
7. **Slow-source switching**: once a chunk has run for `slowAfterMs=45s` with an average below `slowBps=120KB/s` and `c.rotates < 2` → `res.destroy()` + throw "this source is too slow… retrying with another source", keeping `c.pos` (446-451, 492-503). The comment names the symptom: **"stuck at 95% and not moving"**;
8. Each chunk gets `retries=6` (the comment notes 3 was not enough when "two of three sources occasionally stall"); on failure `c.src += 1` switches source with a `600 * tries` backoff (523-534);
9. On failure it `saveMeta()`s before throwing (526-528); on success it `rmSync(meta)`s (542).

**10) The double "must settle" guarantee**: `fetchChunk` maintains its own `settled` + `finish()`, and the watchdog calls `finish` directly, because `res.destroy(err)` sometimes emits only `close` and no `error` (466-480).

### Pitfalls and invariants

- **Multi-source can only mix sources with "the same declared total size"** (371-381), otherwise it would stitch a corrupt file; when the sizes differ (GitHub and Gitee compress separately) it uses only the fastest.
- **`c.rotates` must be explicitly initialized to 0** (comment at 415): `undefined < 2` is `false`, so the source-switch logic would never fire (a historical bug).
- **Only one source switch is allowed per request** (459-463): after `destroy` a connection may still deliver buffered packets, which would re-trigger the switch and skip past sources.
- **Resume only applies to `download()` and `downloadMulti`**; `downloadParallel` degrades to a single stream when it sees a partial file (188-191) — a design trade-off, not a bug.
- `provision.installQemu:1100` passes `{ resume: true }`, but `download()` has no `resume` option at all (69); resume is automatic, so **that parameter is ineffective/legacy**.
- `downloadMulti` does not handle `opt.signal` (only `download()` does); cancelling a multi-source download today is only possible through timeouts or errors.
- The `416` branch of `download()` breaks and treats "the existing file" as complete (82-86); if `existing > total` (a previous bad write) it will not self-heal, and only `expectSha256` can catch it.
- `openStream`'s `timeout: 30000` is a socket idle timeout; **there is no separate connect timeout**, so a stuck DNS lookup relies on the outer `measure/rank` timers.
- The UA is `ApkStart/0.2` at `download.js:13` and `ApkStart/0.3` at `sources.js:64` — inconsistent (no functional impact, only logs/server statistics).
- Invariant: every download function's `onProgress` is guaranteed to be called once with `percent:100` before a successful return (163, 308, 545), so the UI never parks at 99%.

### Call sites
- `src/core/provision.js:14` (require), `:434` `downloadAny` (adb), `:541` `downloadMulti` (runtime bundle), `:912` `downloadAnyParallel` (emulator), `:1010` (play image), `:1052` (aehd), `:1143` (ISO), `:628-629`/`:1071-1072` `openStream` (fetching indexes/directory pages), `:1226-1228` `head` (`probeSources`).
- `src/core/updater.js:20,150` (`downloadMulti` for the update package), `:198` (`downloadAnyParallel` for each part).
- `test/engine-test.js:32`; `test/boot-test.js:23,38` (really downloads the ISO, via `test:boot`).

### Test coverage
`test/engine-test.js`
- yes `:83` full download + redirect following
- yes `:89` resume (an existing partial file)
- yes `:101` HEAD probe + SHA256
- yes `:108` a failed SHA256 check cleans up the file
- yes `:118` parallel chunked download: multiple connections produce identical content
- yes `:133` falls back to a single stream when the source does not support Range

`test/auto-test.js` (starts a local HTTP server and transfers real bytes)
- yes `:995` multi-source parallel download: when two sources differ in size, follow the fastest
- yes `:1068` different chunks pulled from different sources must stitch into exactly the same bytes
- yes `:1108` a retry after failure only fetches the missing chunks (sidecar)
- yes `:1155` if not a single byte arrives after the connection is established, it must time out and switch sources instead of hanging
- yes `:1198` switch source when one source runs at only tens of KB/s, instead of freezing at the last few percent
- yes `:1251` falls back to single-source chunking when only one usable URL exists
- yes `:1033` part update packages are stitched back in order and aborted immediately on a size mismatch (`updater._downloadParts`)

---

## 3. `src/core/provision.js` — runtime bootstrap (adb / emulator / system image / qemu / aehd)

### Responsibility
Without depending on a third-party emulator, take adb, emulator, system image, AEHD, QEMU and the virtual disk through "download → verify → extract/install → write to disk", and manage uniformly where those files go (`paths()`), whether there is enough space (`guardDisk`), and whether they are installed correctly (`checkEnv`).

### Public interface (`class Provisioner`, exports `{Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf}`)

| Member | Signature | Notes |
|---|---|---|
| `constructor` | `(appRoot)` | 140-146; internally `_sources = new Sources(() => store.getSettings())` |
| `get sources` | `Sources` | 149-151, shares the mirror/speed settings with updater |
| `get root` | `string` | `settings.runtime.dir` or `%APPDATA%\apkstart\runtime` (192-195) |
| `paths()` | `Paths` | 197-245, see the table below |
| `ensureDirs()` | `Paths` | Creates root/qemu/platform-tools/images/_tmp/avdHome (247-253) |
| `guardDisk` | `(component, targetDir) => Promise<freeMB>` | Throws a plain error when space is low (262-277) |
| `hypervisor` | `() => Promise<{whpx,dll,hypervisorPresent,note}>` | Only millisecond-level file checks (281-296) |
| `adbVersion` / `qemuVersion` / `emulatorVersion` | `() => Promise<{ok,path,version}>` | Each with a 30s in-memory cache (298-338, 687-714) |
| `inspectIso` | `(file) => {ok,iso9660,rawImage,size,reason,magic}` | Reads `CD001` at `0x8001` (341-365) |
| `checkEnv` | `() => Promise<Env>` | 367-424; the UI's entire "status" view depends on it |
| `installAdb` | `(onProgress) => {ok,path,version}` | 428-456 |
| `resolveRuntimePack` | `() => {url,name,size,tag,page,from}` | 476-516; finds `ApkStart-runtime-*.zip` on Gitee/GitHub concurrently |
| `installRuntimePack` | `(onProgress) => {ok,name,tag}` | 522-580; the lightweight edition's one-click deploy |
| `extractZip` | `(zipPath,destDir,{onEntry}) => destDir` | 591-622; >64MB uses the file-based zip, large entries streamed |
| `resolveEmulatorUrl` / `resolveSysimgUrl` / `resolvePlayUrl` / `resolveQemuUrl` | `() => Promise<string>` | Resolved dynamically from Google's index/directory pages, falling back to constants |
| `materializeImages` | `(onLog) => Promise<count>` | 722-794; `.img.xz/.gz` → `.img` (only once) |
| `systemImageInfo` / `playImageInfo` | `() => {ok,dir,size,api,tag?,note?}` | 797-839 / 972-980 |
| `emulatorAccel` | `() => Promise<{ok,kind,note,...}>` | 845-902; `-accel-check` + on-disk cache |
| `installEmulator` | `(onProgress) => {ok,path,version}` | 905-937 |
| `ensurePlatformTools` / `adbVersionPath` | `() / () => bool / string` | 940-955 / 957-963 |
| `installSystemImage` | `(onProgress)` | 966-969, equivalent to `installPlayImage` (there is only one base image) |
| `installPlayImage` | `(onProgress) => playImageInfo` | 1004-1044, also cleans up `android-30` |
| `installAehd` | `(onProgress) => {ok,dir,installer}` | 1047-1062, downloads only, does not install |
| `installQemu` | `(onProgress) => {ok,path,version}` | 1090-1130, NSIS `/S /D=` silent install |
| `downloadIso` / `inspectImage` / `importIso` / `importDisk` | | 1134-1195 (QEMU route) |
| `createDisk` | `(sizeGB=24, onProgress)` | 1199-1220, `qemu-img create -f qcow2` |
| `probeSources` | `() => {adb,qemu,iso}` | 1224-1231, HEAD probes the three fixed URLs |
| `envCacheGet/Set`, `invalidateEnvCache`, `_envKey` | | 154-188, on-disk environment probe cache |

`paths()` returns (225-245):

```js
{ root, qemuDir, qemuExe, qemuImg,
  adbDir, adbExe,
  emulatorDir, emulatorExe,
  sysImgRoot,                       // ★ see the three branches below
  sysImgDir: <sysImgRoot>/android-34/google_apis_playstore/x86_64,
  avdHome, aehdDir,
  imagesDir, iso, disk, tmp,
  sysTag:'google_apis_playstore', sysApi:'34', sysAbi:'x86_64' }
```

`checkEnv()` returns (387-423):

```js
{ adb:{ok,path,version,required}, emulator:{ok,path,version,required,note},
  sysimg:{ok,dir,size,api,required,note}, playImage:{ok,dir,size,...},
  accel:{ok,kind,note}, qemu:{ok,...}, iso:{ok,path,size,iso9660,reason,...},
  disk:{ok,path,size,note}, hypervisor:{...},
  ready, engine:'emulator'|'qemu'|'none', paths }
```
`ready = adb.ok && (emulatorReady || qemuReady)`; `emulatorReady = emulator.ok && (sysimg.ok || playImage.ok)` (384, 420).

### Key internals

**1) The three path rules in `paths()` (197-245) — the single authority on "which drive the images land on"**

- `root`: `settings.runtime.dir`, or `%APPDATA%\apkstart\runtime` when empty (192-195).
- `avdHome` (237): `settings.runtime.avdDir`; failing that, **if root is not under `DATA_DIR`** use `<DATA_DIR>/avd`, otherwise `<root>/avd` (202-209). The reason (202-206): a single-file release unpacks its runtime into a temp directory, and putting AVDs there would lose every app on exit.
- `sysImgRoot`, three branches (217-224):
  1. `<root>/system-images` exists → use it (the bundle extraction product);
  2. otherwise `<DATA_DIR>/system-images` exists → use it (old users / single-file release layout);
  3. neither exists → **land in `<root>/system-images`** (fresh install; the comment notes CI assembles the runtime this way and that `DATA_DIR` may be redirected to a temp directory).

**2) `materializeImages()` (722-794)**
- The source directory is fixed at `<root>/system-images` (723) while **the destination is `this.paths().sysImgRoot`** (726); the comment explicitly requires both to follow the same rules, otherwise you get "the bundle extracted to D: while the images expanded back to C: AppData" (measured once: 1.2GB + 3.3GB coexisting).
- Walk: `.img.xz` takes precedence over `.img.gz` (the `found` Map, 729-741); other files (`kernel-ranchu` / `ramdisk.img` / uncompressed `.img`) **must be copied as well** (728, 751-760), otherwise the emulator reports "system image missing".
- "Already expanded" test: `fileSize(dest) > 32MB` skips (765).
- `.xz` extraction must bypass the package's ESM entry (771-781): `require.resolve('@napi-rs/lzma')` to get the directory, then `require(dir/index.js)`; the comment explains that Electron's Node 20 does not support `require('stream-polyfill.mjs')` and that `exports` does not allow writing `/index.js` directly.
- A single failed image only calls `onLog('failed to expand image: …')` (790) and **does not throw upwards**.

**3) `installRuntimePack()` (522-580) — the lightweight edition's "one click"**
- `resolveRuntimePack()`: a custom `settings.runtime.runtimePackUrl` wins (477-478, `size:0`); the result is cached in `this._cache.pack` and **never invalidated** (479, 514);
- Concurrently queries GitHub/Gitee `releases?per_page=15`, looks for `/^ApkStart-runtime-.*\.zip$/i` among `assets`, and takes the highest tag by `cmpVer` (487-515);
- `guardDisk('runtime', p.root)` (525) → **`'runtime'` is not in the `need` table**, so it falls to the default 512MB + 1024MB buffer = 1536MB (264-266);
- `rank(this._downloadUrls(pack.url))` speed test (534-536), falling back to the original candidates on failure;
- `downloadMulti(urls, tmp/runtime-pack.zip, {connections: settings.runtime.downloadConnections||8})` (529, 541-555); **
  progress mapping `percent = clamp(1..90, pct*0.9)`** (551);
- Size gate: `< 200MB` throws "runtime bundle download incomplete, retry/resume"(556);
- `extractZip(zip, p.root, {onEntry})` (559-565), progress 91→99;
- Writes the marker `<root>/.runtime-pack.json` (`{name,tag,at,from}`) and deletes the zip (566-571);
- **Immediately** calls `materializeImages(...).catch(() => 0)` (573-576); the comment explains that otherwise the following `checkEnv()` would think no image is installed and download another 1.4GB from Google;
- Returns `{ok,name,tag}`, progress 100.

**4) `extractZip()` (591-622)**
- `fileSize > 64MB` → `new ZipFile(path)` (no whole-package load); otherwise `new ZipArchive(fs.readFileSync(...))`;
- A single entry with `uncompSize > 64MB` goes through streaming `zip.pipeTo()`, the rest use `fs.writeFileSync(zip.read())`;
- `finally { zip.close() }` (618-620).

**5) `checkEnv()` (367-424)**: `Promise.all` starts 5 probes (adb/qemu/hypervisor/emulator/accel), then adds `inspectIso`, `fileSize(disk)`, `systemImageInfo()` and `playImageInfo()`; `sysimg.ok` is defined as `systemImageInfo().ok || playImageInfo().ok` (381-399).

**6) On-disk environment probe cache (126-188)**
- File: `%APPDATA%\apkstart\cache\env.json` (129-131);
- key = `exe path + exe(size:mtime) + aehd.sys(size:mtime) + whether WinHvPlatform.dll exists` (154-162);
- TTL: a positive conclusion lasts 6h (126), while **a negative one is trusted for only 10 minutes** (127; the user may have just enabled virtualization);
- On boot failure the emulator calls `invalidateEnvCache()` (`emulator.js:848,886`).

**7) `emulatorAccel()` (845-902)**: parses the `-accel-check` text; three fallback rules: `emulator-check` missing but `aehd.sys` present → usable (879-883; the comment explains this avoids misreading "no acceleration" and forcing `-accel off`, since software emulation crashes outright on some machines); `hasAehdFile && /aehd/` → usable (884); `hv.dll && /whpx/` → usable (886); otherwise `viaTcg: true` (888-897).

**8) Disk guard `guardDisk()` (262-277)**

| component | need(MB) | + 1024MB buffer |
|---|---|---|
| adb | 64 | 1088 |
| emulator | 600 | 1624 |
| sysimg / playimg | 1800 | 2824 |
| qemu | 320 | 1344 |
| iso | 1100 | 2124 |
| aehd | 64 | 1088 |
| unlisted (e.g. `'runtime'`) | 512 | **1536** |

When space is insufficient it throws: "not enough space on the target disk: this component needs about N MB… change the 'runtime data directory' to a drive with more space (Settings → System integration → Runtime data directory → Browse)".

### Pitfalls and invariants

- **The image destination must match `paths().sysImgRoot`**: `installPlayImage` extracts to `p.sysImgRoot` (1023), `materializeImages` targets `paths().sysImgRoot` (726), and `playImageInfo` looks in `p.sysImgRoot` (974). Any new code that builds `<DATA_DIR>/system-images` itself will reproduce "I set the runtime directory but it still downloads to AppData".
- **`guardDisk('runtime')` underestimates**: 512+1024=1536MB, while the reality is "1.5GB package + the zip on disk + 3.3GB of extracted system.img + .xz expansion". A small drive fails during extraction and leaves a partial file (`installRuntimePack` has no cleanup logic for a partial zip; it relies on the next resume).
- **`this._cache.pack` / `emulatorUrl` / `sysimgUrl` / `playUrl` have no invalidation entry**: `main.js:819-825` only calls `sources.reset()`. If the user changes `sourcePreference` or a bundle URL in settings, the old address is still used within the same process (`runtimePackUrl` is the exception, because settings are read first every time, 477).
- **`materializeImages` failures are swallowed in two places**: its own `.catch(e => onLog(...))` (790) and the caller's `.catch(() => 0)` (576). A missing `@napi-rs/lzma` or an antivirus block → the image never expands → `checkEnv().sysimg.ok === false` → every start re-enters the "download runtime" path (the classic "stuck preparing runtime").
- **A failed `emulatorVersion()` is not cached** (687-714): it returns `ok:false` directly with no `envCacheSet` and no 30s memory cache; every `checkEnv()` runs `execFile(emulator.exe -version)` for up to 20s. Only the success path writes the cache (707-710).
- **The `emulatorVersion` cache lives only in memory/on disk and `_cache.emulatorVerAt` is set only on success**; the failure path makes status polling spawn the process over and over.
- **`extractZip` does not check for zip-slip**: `path.join(destDir, name)` is joined directly (606), while `updater._extract` has a `startsWith(path.resolve(dest))` guard (updater:237) — the two differ. The runtime bundle and update package both come from this project's releases so the risk is low, but do not feed untrusted input into `extractZip`.
- **The custom address in `resolveRuntimePack()` has `size: 0`**, so download progress can only come from probing or bytes received; `total` is therefore 0 in `installRuntimePack` and the MB text lacks "/ total size".
- **`installAdb` extracts into `p.root`** (446) and the zip's top level is `platform-tools/`; `installEmulator` does the same (926). So root doubles as `ANDROID_SDK_ROOT` (comment at 232-234).
- **`ensurePlatformTools()` (939-955)**: the emulator requires `platform-tools` under the SDK root, otherwise FATAL; it copies 3 files (`adb.exe` + two dlls) from `engine/platform-tools`, `tools/platform-tools`, or the directory of `settings.adbPath`.
- **`installAehd` only downloads** (1047-1062); installing needs admin: `main.js:1121-1200` goes through `silent_install.bat` + UAC.
- **QEMU install**: NSIS `/S /D=<dir>`, where `/D` must be last and unquoted (1112-1116); a `setTimeout` force-kills it after 600s (1119).
- **`systemImageInfo()` (797-839)**: first looks in `paths().sysImgDir`, then enumerates every `android-*/tag/abi` under `sysImgRoot`, `<root>/system-images` and `<appRoot>/engine/system-images` (by API descending); any set with `system.img > 300MB` and a `kernel-ranchu` counts as ok. This is the compatibility point for "the full edition may ship only a smaller AOSP image".
- **`playImageInfo()` and `sysimg.ok`**: `checkEnv().sysimg.ok` ORs the two (390-399), but `engine.ensure()` uses `env.sysimg.ok` (`engine.js:852`), so having only the play image is enough to boot.
- **Invariant**: every `install*` reports `onProgress` as `{stage:'download'|'extract'|'install'|'done', percent}`; `main.js:317` uniformly adds `component`, and the UI's `app.js:357 updateStepProgress` reads only `percent/message`.
- The fallback versions hardcoded in `SOURCES` will go stale (`emulator-windows_x64-16847572.zip`, `x86_64-34_r14.zip`, 27-41); they are used only when the index cannot be fetched.

### Call sites
- `src/core/engine.js:16,54` (`new Provisioner(appRoot)`), `:79,202,393,995` (`paths()`), `:109,235,368,635,849,996` (`checkEnv`), `:264,761` (`emulatorAccel`), `:639` (`createDisk`), `:848` (`materializeImages`), `:1017,1021` (`paths().root` → layers), `:873` (`needsSetup`).
- `src/core/emulator.js:17,29`, `:53,225` (`paths`/`ensureDirs`), `:56,63` (`systemImageInfo`), `:62,723` (`playImageInfo`), `:659` (`adbVersionPath`), `:761-762` (`emulatorAccel`+`emulatorVersion`), `:848,886` (`invalidateEnvCache`).
- `src/core/installer.js:95-99` (`playImageInfo` + `installPlayImage`, downloaded on demand the first time an ARM app appears); `:159,169,190,489` (`playImageInfo` checks).
- `src/main.js`: `:314-354` (the `autoDeploy` main flow), `:707` (`paths().root` for the UI), `:824` (`sources.reset`), `:898,932,939,946,953,964,977` (self-check/diagnostics), `:1076-1269` (the `provision:*` IPC handlers), `:1330,1542` (`avdHome`/`root`), `:1631` (`checkEnv` before prewarm).
- `test/engine-test.js:146-220,391-401`, `test/auto-test.js:1347-1350`, `test/boot-test.js:44`.

### Test coverage
`test/engine-test.js`
- yes `:149` the default runtime directory is inside the data directory
- yes `:156` empty-environment check: adb not ready, component structure complete
- yes `:166` built-in ZIP decompression works
- yes `:197` relative URLs from the SDK index are expanded into absolute ones (`absUrl`/`baseOf`)
- yes `:211` the resolved emulator / system-image URLs are absolute downloadable URLs
- yes `:244` image validation: distinguishes valid ISO9660 / corrupt / incomplete (`inspectIso`)
- yes `:391` `playImageInfo` validates the completeness of the API 34 compatible image

`test/auto-test.js`
- yes `:1339` **system-image destination: a fresh install must land in the runtime directory** (covers all three branches of `paths().sysImgRoot`)

`test/boot-test.js:44` runs a real `checkEnv` + a real boot (`npm run test:boot`, works offline but needs the ISO).

**Uncovered**: `installRuntimePack`, `resolveRuntimePack`, `materializeImages`, `installAdb/installEmulator/installPlayImage/installAehd/installQemu` and `guardDisk` have no unit tests at all (all need real network/large files).

---

## 4. `src/core/updater.js` — online update (check / prepare / apply)

### Responsibility
Gets the latest version from this repository's GitHub/Gitee Releases, picks an asset by install flavor, downloads and assembles the payload, and generates a PowerShell overwrite script that performs "replace + restart" after the process exits.

### Public interface (exports `{Updater, cmpVer, OWNER, REPO}`)

| Member | Signature | Notes |
|---|---|---|
| `constructor` | `({currentVersion, exePath, isPackaged, dataDir, settings?, onProgress?})` | 38-50; `this.installDir = dirname(exePath)`, `this.sources = new Sources(settings)` |
| `get flavor` | `'setup' \| 'portable'` | 53-59: `Uninstall *.exe` in `installDir` → `setup` |
| `get updateDir` | `<dataDir>/update` | 61-63 |
| `check` | `({force=false}) => Promise<Latest>` | 73-115, see below |
| `prepare` | `(info?) => Promise<{mode:'zip'\|'setup', payload, version}>` | 121-176 |
| `_downloadParts` | `(asset, target, conns, total)` | 182-227, per-part download + sequential stitching |
| `_extract` | `(zipPath, dest)` | 229-251, with zip-slip protection, streaming entry by entry |
| `apply` | `(job, {waitPid?, spawn?}) => true \| script` | 258-325; with `spawn:false` it only returns the script (for tests) |
| `static repoUrl()` | `() => 'https://github.com/RoutineMiku/apkstart/releases'` | 328-330 |
| `cmpVer` | re-exported from `version.js` | 333 |

`check()` returns (82-112):

```js
{ version, tag, name, notes, htmlUrl, publishedAt,
  asset: { name, size, url, urls[], sizes{}, source, parts?, partial? } | null,
  assets, sources, unreachable,
  flavor, hasUpdate, current, canAutoApply }
```
`asset` selection (77-80):
- `setup`: `/Setup\.exe$/i` → fallback `/win.*\.exe$/i`
- `portable`: `/portable.*\.zip$/i` → `/win64.*\.zip$/i` → **`/\.zip$/i`**
`hasUpdate = cmpVer(merged.tag, current) > 0` (109); `canAutoApply = !!asset && (asset.url || asset.parts?.length)` (111).

### Key internals

**1) `check()` (73-115)** only does "metadata + pick asset"; download URLs are speed-tested later in `prepare()`. `force` is passed through to `sources.latest`.

**2) `prepare()` (121-176)**
- Payload directory `<dataDir>/update/<version>/`;
- With `asset.parts` → `_downloadParts` (133-134);
- Otherwise `candidates(asset)` → `rank()` → `downloadMulti(ranked, file, {connections})` (136-163);
- **How the progress total is picked**: scan `sizes[url]` in `ranked` order and take the first known value (142-147); the comment notes that picking wrong makes it "show 92% forever, then suddenly jump to complete";
- `.zip` → extract to `payload/` → `{mode:'zip',payload:out}`; anything else → `{mode:'setup',payload:file}` (166-175).

**3) `_downloadParts()` (182-227)**: each part gets its own `candidates + rank` (so some can come from Gitee and some from a mirror), `downloadAnyParallel` into `<name>.<index>.tmp`, verifies `part.size` (when known, 211-216), writes sequentially with `fs.writeSync(fd, buf, 0, len, doneBytes)`, and finally verifies `doneBytes === total` (224-226). Each whole part is `readFileSync`ed into memory (213) — parts are ≤100MiB, which is acceptable.

**4) `apply()` (258-325) — the most critical piece of the update chain**
The generated script (`lines`, 265-307) does, in order:
1. `$ErrorActionPreference='SilentlyContinue'`, `Note()` writes `<updateDir>/update.log`;
2. `Wait-Process -Id <waitPid> -Timeout 90` + `Sleep 700ms` (270-272);
3. `mode==='zip'`: `Copy-Item -Recurse -Force` **up to 12 rounds**, each round probing "does the target exe exist", sleeping 600ms on failure (275-290); then `Remove-Item $src` (the extracted directory, 289);
4. `mode==='setup'`: `Start-Process -ArgumentList '/S' -Wait` and record the exit code (291-298);
5. Relaunch `exe` (300-301);
6. `Remove-Item <updateDir>/<version> -Recurse -Force`, then **`exit 0`** (304-306; the comment says a failed cleanup must not make the caller think the update failed).

How it is launched (309-324):
- The script is first written to `update/apply.log.ps1` for troubleshooting (310);
- The real execution uses `-EncodedCommand` (UTF-16LE base64, 313); the comment explains this **avoids PS 5.1 decoding a BOM-less script as ANSI/GBK**, which garbles non-ASCII paths;
- **It must not be `detached`** (315-318): some security software/sandboxes block "a detached console process", with the symptom that the script never runs at all (the UI sits at "replacing the program and restarting"); a normal child process + `child.unref()` is used instead;
- `spawn(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand',b64], {stdio:'ignore', windowsHide:true})`.

### Pitfalls and invariants

- **Setup vs portable is decided by "is there an `Uninstall *.exe` in the install directory"** (53-59); there is no other marker. NSIS silently overwrites for setup, and portable copies over.
- **Overwriting does not delete files that only the old version had** (comment at 287-288); it only clears this run's extraction directory. So "residue of a deleted dll" can affect the new version (currently judged harmless).
- **The caller must exit after `apply()`**: `main.js:594-596` calls `apply(job)` then `app.quit()` 900ms later; the script waits up to 90s.
- **Gitee 100MiB → `.part1/.part2`** (comment at 130-134); `sources.latest` already turns parts into a logical asset, and `check()` must carry `parts` all the way out (88-101) — auto-test:926 guards exactly this.
- **`sizes` is recorded per URL**; you cannot get away with `asset.size` alone (142-147, sources:339-347).
- **Potential misjudgment: the default fallback `/\.zip$/i` treats the runtime bundle as an update package** (80). The same release contains both `ApkStart-vX-win64-portable.zip` and `ApkStart-runtime-vX.zip` (`.github/workflows/release.yml:44,187`); today it works only because the `portable` regex matches first. If the portable package is ever renamed, `/\.zip$/i` will pick the 1.5GB runtime bundle and overwrite the program directory.
- **`prepare` does not verify the zip integrity of the download**; only `_extract` surfaces errors, and a size mismatch against `total` is thrown by `downloadMulti` (download:546).
- **Updates are only checked in a packaged build**: `main.js:1665 if (app.isPackaged)`; development builds never check.
- Invariant: `apply()` must be called after a successful `prepare()` (`prepare` throws when there is no payload; `main.js:592` catches and sends `sendProgress({stage:'error'})`).
- `flavor` does a `readdirSync(installDir)` every time with no cache (53-59) — frequent calls mean disk IO; today it is only used by check/UI.

### Call sites
- `src/main.js:38` (require), `:1503-1511` (construct, injecting `settings`/`onProgress`), `:579-604` (`runUpdate`: `check`→`prepare`→`apply`→`quit`), `:496,584,588` (tray/manual check + `repoUrl()`), `:1447` (`app:updateCheck`, `force` defaults to true), `:1456` (`app:updateOpen`), `:1461` (`app:updateApply`), `:1667` (silent check 8s after start).
- `src/preload.js:71-72` (`updateCheck` / `updateApply`); `src/ui/app.js` settings page, "Software update".

### Test coverage (`test/auto-test.js`)
- yes `:820` version comparison is numeric and segment-by-segment (`cmpVer`)
- yes `:828` the install flavor decides which asset is picked + `flavor` detection
- yes `:926` part assets must be carried all the way to `updater.asset` (otherwise `prepare` reports "no usable download address")
- yes `:1033` part update packages are stitched back in order and aborted immediately on a size mismatch (`_downloadParts`)
- Indirect coverage: `:843/:864/:878/:901/:949/:976` (`sources`), `:995/:1068/:1108/:1155/:1198/:1251` (`downloadMulti`)
- **Uncovered**: the contents of the script generated by `apply()` (nothing asserts against `apply.log.ps1`), the zip-slip behavior of `_extract`, and the `sizes` selection in `prepare`.

---

## 5. `src/core/store.js` — settings and app-list persistence

### Responsibility
A JSON store that "merges defaults on read + writes atomically": `%APPDATA%\apkstart\{settings.json,apps.json,icons/,apks/}`.

### Public interface (`module.exports = store`)

| Member | Signature | Notes |
|---|---|---|
| `DATA_DIR` / `ICON_DIR` / `APK_DIR` | `string` | 10-14; `DATA_DIR = %APPDATA%\apkstart` |
| `getSettings()` | `() => Settings` | 175-186: `deepMerge(DEFAULT_SETTINGS, disk contents)` + **forced migration** |
| `saveSettings(patch)` | `(patch) => Settings` | 188-196: `deepMerge(current, patch)`, translating `engine.resourceMode` into the three toggles when present |
| `getApps()` | `() => App[]` | 198-201, falls back to `[]` on a corrupt file |
| `saveApps(apps)` | `(apps) => void` | 203-205 |
| `upsertApp(app)` | `(app) => app` | 207-214, merges by `package` |
| `removeApp(pkg)` / `getApp(pkg)` | | 216-223 |
| `iconPath(pkg)` / `apkPath(pkg,version='cur')` | `=> string` | 225-231 |
| `ensureDirs()` | `() => void` | 119-123 |
| `DEFAULT_SETTINGS` | constant object | 16-117, referenced directly by tests and doctor |

### Key internals

- **Atomic write** (133-138): write `<file>.tmp` → `renameSync`, avoiding half-written JSON.
- **`deepMerge` (140-150)**: recurses only into plain objects; arrays and scalars are overridden; recursion happens only when `base[k]` is an object.
- **Read-time migration (175-186) — three forced overrides, with no version field**:
  - `s.engine.headless = false` (179): the old headless mode is not the same as "the window will not open";
  - `s.hideAfterLaunch = false` (181): in old builds quitting the shell killed the whole runtime;
  - `s.freeform = false` (184): the old freeform small window turned into "a small window inside a window".
  Because it overrides on every read, a `true` in an old settings.json is permanently ineffective (asserted at auto-test:455).
- **Resource-policy translation (160-170, 191-193)**: `save` → `liteMode:true/priorityMode:balanced/renderSize:540x960`; `smooth` → `false/performance/720x1280`; `balanced` → `true/balanced/auto`. It fires only when `patch.engine.resourceMode` is present, to avoid fighting with the individual toggles.
- **"Factual constraints" documented in the defaults** (written in comments; do not delete them when reading):
  - `engine.headless:false` (28-30): in headless mode SurfaceFlinger emits no VSYNC, so apps are alive but show nothing;
  - `engine.badGpu:''` (32-34): records the `<emulator version>|<gpu>` that "crashed right after launch", invalidated automatically when the runtime is upgraded;
  - `runtime.dir:''` (68) = `%APPDATA%\apkstart\runtime`;
  - `runtime.downloadConnections:8` (88);
  - `runtime.sourcePreference:'auto'` (91), `autoMirror:true` (94), `giteeToken:''` (97);
  - `runtime.compatImage:false` (78) — **essentially obsolete**: `provision.checkEnv:381-384` no longer depends on it and uses the play image as the primary image too;
  - `engine.logLimitKB:2048` (55), no `engine.prefetch`, `engine.prewarm:true` (65);
  - `display.portrait:'900x1600'` (112), but `main.js:276` uses `d.portrait || '540x960'` (inconsistent defaults; in practice the 900x1600 that exists in settings wins).
- **`DEFAULT_SETTINGS` lacks `runtime.avdDir`**: `provision.paths():207` reads `runtime.avdDir`, which is `undefined` for a fresh user; it only exists after the UI writes it (`ui/app.js:1203`). Likewise `runtime.installed` is read by `engine.js:870` but absent from the defaults.

### Pitfalls and invariants

- **`getSettings()` does `readFileSync + JSON.parse` on every call with no in-memory cache** (175-186). Meanwhile `provision.paths()` reads settings 2–4 times per call (193, 207, 209 etc.), and `checkEnv()` is called from several status polls → lots of small-file reads. This is the first place to optimize for performance.
- **`saveSettings` writes the "merged full object"** (189-194), so settings.json carries every default value as of that moment; defaults added by an upgrade are not written and only merged on read — which is exactly why the migration can live on the read path.
- The migration is a **one-way force** (179-184); if users should ever be allowed to re-enable headless, change this, not the UI.
- `writeJson`'s `renameSync` would fail across volumes (`os.tmpdir` and `DATA_DIR` are on the same volume here; tests that change `APPDATA` are still on the same volume).
- How tests isolate state: change `process.env.APPDATA` then **re-`require`** (`auto-test.js:11,1344-1347`); `DATA_DIR` is a constant evaluated at module load, so changing the env within the same process has no effect — keep that in mind when writing tests.

### Call sites
- `src/core/provision.js:12,145,192,197-237,452,1159,1187,1193,1217`.
- `src/core/engine.js:15,1017-1021` (`store.DATA_DIR`), `src/core/emulator.js:16`, `src/core/installer.js:10`, `src/core/sharer.js:10`, `src/core/layers.js:162` (lazy require inside `summary`).
- `src/main.js`: the whole flow (startup migration, `app:info`, `settings:get/set`, `bootstrabBundledRuntime:97-171` calling `saveSettings({runtime:{dir}})` directly).
- `test/engine-test.js:147`, `test/auto-test.js:456,700,1346,1374,1386`, `test/boot-test.js:21`.

### Test coverage
- yes `auto-test.js:455` forced migration of old config: headless and "quit after launch" no longer take effect
- yes `auto-test.js:1373` one resource-policy switch is translated automatically into vCPU/priority/resolution
- yes `auto-test.js:1385` the data-partition capacity is configurable and no longer a hardcoded number by default
- yes `engine-test.js:149` the default runtime directory is inside the data directory (depends on `DATA_DIR`)
- **Uncovered**: `upsertApp/removeApp/apkPath/iconPath`, and the atomicity of `writeJson`.

---

## 6. `src/core/layers.js` — container layer inventory / reclaim

### Responsibility
Treats the runtime directory as image layers for a **read-only inventory** and **reclaim against an explicit list** (default `dryRun`), and gives the settings page a summary of "how much disk it all takes".

### Public interface (exports `{analyze, prune, summary, walk, dirSize}`)

| Export | Signature | Notes |
|---|---|---|
| `walk` | `(dir, out=[], depth=0) => [{path,size}]` | Recursive file list, **depth capped at 6** (15-27) |
| `dirSize` | `(dir) => bytes` | 29 |
| `analyze` | `(root, {keepAvd='apkstart.avd', aggressive=false, keepSnapshots=false}) => {total,groups,candidates}` | 36-127 |
| `prune` | `(root, {apply=false, keepAvd, aggressive, keepSnapshots, onRemove}) => {…analyze, apply, removed, saved, after}` | 133-152 |
| `summary` | `(root) => {total,totalText,runtimeText,groups,reclaimable,reclaimableText,count}` | 155-184 |

Each `candidates[]` item is `{path, size, reason, kind:'file'|'dir'}`.

### Key internals

**1) The 8 reclaim categories in `analyze()` (in code order)**

| # | Lines | Target | reason |
|---|---|---|---|
| 0 | 48-51 | `emulator/`, `system-images/`, `avd/`, `platform-tools/` | Size groups only (`groups`), never deleted |
| 1 | 53-61 | `emulator/qemu/windows-x86_64/qemu-system-{aarch64,armel,i386}*` | Non-x86_64 QEMU targets |
| 2 | 63-68 | `system-images/**/{NOTICE.txt,source.properties}` larger than 1MB | Bulky readme files inside image packages |
| 3 | 70-77 | `system-images/android-30` (only when API34 play's `system.img` exists), `<root>/x86_64` | Old image / mis-placed extraction directory |
| 4 | 79-86 | `avd/*.avd` where `name !== keepAvd` | Inactive AVDs (8–16GB of user data included) |
| 5 | 87-90 | `avd/**/*.lock` | Lock files left by an abnormal exit |
| 6 | 91-100 | `avd/<keepAvd>/snapshots` or `snapshots.stale-N` (when `keepSnapshots=false`) | Old quickboot snapshots |
| 7 | 103-110 | `<root>/_tmp`, `<root>/images` | Download temp files / old QEMU·ISO leftovers |
| 8 | 112-123 | `emulator/crashreport.exe` when `aggressive` | Only used to build release packages |

**2) `prune()`'s safety constraint (139-141)**
```js
const p = path.resolve(c.path), rootAbs = path.resolve(root);
if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;   // never leave root, never delete root
```
With `apply=false` it **touches no file** (142-149) and only returns the list; a failed delete (file in use) is skipped silently and cleaned next time (148).

**3) `summary()` (155-184)**: runs `analyze` on the runtime plus 4 extra directories (`avd`, `APK_DIR`, `ICON_DIR`, `logs`), filters out zero-byte groups, and switches to GB above 1GB.

### Pitfalls and invariants

- **The `aggressive` blacklist is a hard constraint** (comment at 112-114): `Qt6WebEngineCoreAndroidEmu.dll` is a load-time dependency of `qemu-system-x86_64.exe` and **must never be deleted**; `qsn/netsim` are kept conservatively.
- **`keepAvd` defaults to the hardcoded `'apkstart.avd'`** and must match `AVD_NAME` in `emulator.js`; rename both together.
- **`keepSnapshots:true` is required while the runtime is running**: `engine.cleanup()` passes `keepSnapshots: this.vmRunning` (`engine.js:1019-1023`), otherwise deleting the current session's snapshots would corrupt the running machine.
- `walk`'s depth limit of 6 prevents symlink loops/deep recursion blowups; files deeper than 6 levels are not counted in size (an underestimate).
- `analyze`'s `candidates` **do not include** "the active AVD's userdata/snapshots (when `keepSnapshots=true`)" — that is the guarantee that installed apps are never removed (asserted at auto-test:174).
- `prune`'s `after` is just `total - saved` with no rescan, so it differs slightly from reality when a delete failed.

### Call sites
- `src/core/engine.js:1017` (`usage()` → `summary`), `:1019-1023` (`cleanup()` → `prune`).
- `src/main.js:1004` (`runtime:usage` → `runtime.usage()` → `summary`), `:1056-1071` (`runtime:cleanup`: first `apply:false` to get the list → `dialog.showMessageBox` confirmation → `apply:true`).
- `src/ui/app.js` (the settings page "usage/cleanup" panel, through `runtime:usage`/`runtime:cleanup`).
- `test/auto-test.js:25,157,167,171`.

### Test coverage
- yes `auto-test.js:139` inventory of reclaimable items: non-x86_64 QEMU, old images, old AVDs, lock files, old snapshots (including "dryRun deletes nothing" and "the active AVD and x86_64 QEMU survive `apply`")
- **Uncovered**: the 4 extra directories in `summary()`, the `aggressive` branch, and the depth limit.

---

## 7. The four small utilities

### 7.1 `src/core/logfile.js` — size-rotated logging

| Export | Signature | Notes |
|---|---|---|
| `rotate` | `(file, limitKB) => bool` | 15-26: returns false when `size < limit`; otherwise deletes the old `.1.log` → renames to `.1.log` |
| `append` | `(file, line, limitKB=2048) => bool` | 33-45: rotates on **the first call in each process + every 200 lines** (39), and `appendFileSync` adds the newline |
| `trimNow` | `(file, limitKB=2048) => bool` | 48-50: an unconditional check at startup |

- Responsibility: long-term appends to `app.log` / `emulator.log` would fill the disk (header at 2-9); only **one** `.1.log` is kept.
- Pitfalls: `limitKB` is clamped to ≥256KB by `Math.max(256, ...)` (39, 49); `counters` is a module-level `Map` that resets when the process restarts; `rotate` uses `renameSync`, which on Windows fails silently (returns false) when the file is in use.
- Call sites: `src/main.js:85` (`appLog`, `logs/app.log`), `src/core/emulator.js:577` (emulator log).
- Tests: yes `auto-test.js:1404` — the log rotates automatically once over the limit and only one backup is kept.

### 7.2 `src/core/notify.js` — Android notifications → Windows notifications

| Export | Signature | Notes |
|---|---|---|
| `parseRecords` | `(dumpsys text) => [{pkg,key,title,text}]` | 34-63 |
| `NotifyBridge` | `new NotifyBridge({getClient,getAppLabel,getAppIcon,onOpen})` | `start()/stop()`, internally `setInterval(_tick, POLL_MS=2500)` (11, 77-89) |

Key internals:
- Every 2.5s `client.shell('dumpsys notification --noredact', {timeout:12000})` (97), **after `isOnline()`** (96);
- Filtering: the `SYSTEM_PKGS` allowlist + `com.android.providers.*` + `launcher` (18-32); `FLAG_ONGOING_EVENT(0x2)` and `FLAG_FOREGROUND_SERVICE(0x40)` are skipped (43-45);
- The first `_tick` only establishes a `primed` baseline, so startup does not pop every historical notification at once (99-104); `seen` is trimmed from over 500 to 300 (113);
- Clicking `note.on('click')` → `onOpen(pkg)` (130);
- A top-level `require('electron')` (9) → **plain-Node tests cannot run it**, which is why `test/notify-test.js` runs under Electron.

Call sites: `src/main.js:36,682-697` (`startNotifier()`, started only by `onContainerActive(true)` when the container has an app window, and `stop()`ed at `:670-678` when it closes; stopped at `:1772` on exit).
Tests: `test/notify-test.js` (calls `parseRecords` with a real `test/notif.txt` dump; **not part of `npm test`**); `NotifyBridge` itself is uncovered.

### 7.3 `src/core/android.js` — Android settings toggles (no need to enter the launcher)

| Export | Notes |
|---|---|
| `ACTIONS` | 11 `android.settings.*` action constants (7-19) |
| `AndroidSettings` | `new AndroidSettings(runtime)`; methods `status()`, `setWifi`, `setAirplane`, `setVolume`, `setAnimations`, `setFontScale`, `setDensity`, `tune({pkg})`, `open(action)`, `permissions(pkg)`, `grantAll(pkg)` |

Key internals:
- `client()` does `await runtime.ensure()` every time (24-28) and throws "runtime not ready" on failure;
- `_sh(commands)` joins several commands with `; ` into **one** `adb shell` (30-34) with a 20s timeout;
- `status()` uses `echo "k=$(...)"` to grab 7 values at once and then parses them with regex (37-61);
- `tune()`: turns off the three animation scales + `max_cached_processes=32` + optionally `deviceidle whitelist +pkg` (111-121);
- `permissions()` parses the `runtime permissions:` section of `dumpsys package`, ending by indentation (131-145); `grantAll()` runs `pm grant` for each and ignores failures (147-156);
- Value ranges: `fontScale 0.85~1.3`, `density 120~640`, `volume 0~100` (79-108).

Call sites: `src/main.js:1501` (`androidSet = new AndroidSettings(runtime)`), `:1404-1434` (the `android:status/set/open/tune/permissions/grantAll` IPC); `src/preload.js` exposes it to the settings page.
Tests: **no coverage** (it needs a real adb).

### 7.4 `src/core/display.js` — pure display-fit math

| Export | Signature | Notes |
|---|---|---|
| `densityFor` | `(w,h,manual) => dpi` | Clamped to 120–640 when `manual>0`; otherwise `min(w,h)/2.57` clamped to 200–480 (7-10) |
| `portraitSize` | `(str) => {w,h}` | Parses `900x1600`; illegal/landscape falls back to `{900,1600}` (12-18) |
| `defaultBounds` | `(area) => {x,y,w,h}` | Height `area.h*0.84`, 9:16 width, centered (20-28) |
| `fullscreenBounds` | `(portrait, area) => {x,y,w,h}` | Full height, width from the portrait ratio, horizontally centered (36-46) |
| `sizeFor` | `(mode, portrait, area) => {w,h}` | **Both modes return the portrait preset** (55-57) |

Key invariant (documented in the comments): the emulator window's aspect ratio is **locked by the LCD at boot**, and a plain `SW_MAXIMIZE` only yields a window stuck to the left edge with an unchanged width; so "fullscreen" = maximize the window **without changing the Android resolution** (48-54), and switching modes needs no runtime restart.

Call sites: `src/main.js:32` (require), `:274-277` (`portraitSize()` reads `display.portrait`) — **only `portraitSize` is used in runtime code**; `densityFor/defaultBounds/fullscreenBounds/sizeFor` are currently called only by tests (`appwin.js:46` has its own `AppWindow.sizeFor`).
Tests: yes `auto-test.js:465` "display fit: window/fullscreen share the portrait resolution, the window keeps a stretchable 9:16 ratio" (covers all 4 functions).

---

## 8. The overall download / deploy / update chain

### 8.1 Text flowchart

```
[User clicks "one-click setup"]
src/ui/app.js:371  deployAll()
   ├─ setStepBusy('all',true)  → button says "preparing…" (app.js:334)
   ├─ api.autoDeploy()         → preload.js:45  invoke('runtime:autoDeploy')
   └─ IPC runtime:autoDeploy   → main.js:870
        └─ autoDeploy()        → main.js:314  (has a `deploying` mutex, main.js:313/315)

[autoDeploy main flow, main.js:314-354]
 1. env = provisioner.checkEnv()                           main.js:319
 2. needEngine = !env.emulator.ok || !env.sysimg.ok        main.js:320
 3. if needEngine && settings.runtime.preferGithubRuntime:
      installRuntimePack(progress)                          provision.js:522
        ├─ resolveRuntimePack()                             provision.js:476
        │    ├─ custom runtimePackUrl? use it directly      :477
        │    ├─ concurrent GET GitHub / Gitee releases?per_page=15  :487
        │    └─ find assets /^ApkStart-runtime-.*\.zip$/, highest by cmpVer  :497-515
        ├─ guardDisk('runtime', root)   [512+1024=1536MB]    :525 → :262
        ├─ sources.rank(sources.candidates(url))  serial speed test  :534-536 → sources.js:399
        ├─ downloadMulti(urls, _tmp/runtime-pack.zip)        :541 → download.js:338
        │    ├─ concurrent Range probe → only mix sources with the same total size  download.js:355-381
        │    ├─ 8-way chunk rotation + .chunks.json sidecar  download.js:391-416
        │    └─ idle watchdog 20s / slow 45s & <120KB/s → switch source  download.js:449-503
        ├─ size gate <200MB → throw "bundle download incomplete"  :556
        ├─ extractZip(zip, root)   >64MB uses streaming ZipFile  :559 → :591
        ├─ write <root>/.runtime-pack.json, delete the zip   :566-571
        └─ materializeImages()  .img.xz/.gz → .img           :573-576 → :722
      afterPack = checkEnv()                                 main.js:328
      if emulator.ok && sysimg.ok → return {ok:true,source:'github'}
      else → continue filling gaps from the official source (main.js:330)
 4. Official-source per-component fallback (only if the previous step failed/incomplete):
      installAdb()          provision.js:428  → downloadAny  platform-tools.zip
      installEmulator()     provision.js:905  → downloadAnyParallel + extractZip + ensurePlatformTools
      installSystemImage()  provision.js:966  → installPlayImage(:1004) → downloadAnyParallel + extractZip
 5. after = checkEnv(); ok = adb.ok && emulator.ok && sysimg.ok   main.js:347-348
 6. finally deploying=false                                 main.js:351-353

[The UI then boots, app.js:381-387]
 api.runtimeStart() → main.js:880 → runtime.ensure()        engine.js:787 onwards
   ├─ provisioner.materializeImages(onLog).catch(()=>{})     engine.js:848
   ├─ checkEnv()                                             engine.js:849
   ├─ killOrphanEmulators()                                  engine.js:856
   └─ boot()  on failure doctor diagnosis + variant retries (GPU/accel/memory stepped down)

[Two background chains after startup]
 A. Auto-deploy (20s delay) main.js:1657-1661 → autoDeploy()   ← the same function as the UI
 B. Update check (8s after start, packaged only) main.js:1665-1676
      updater.check()                     updater.js:73
        └─ sources.latest({force})        sources.js:277
             ├─ fetchReleases() concurrently GitHub/Gitee   :237
             ├─ 403/429 → breaker 15min                     :286-290
             ├─ all failed → previous result + stale        :292-298
             └─ merge same-version assets (urls[] + sizes{}), keep parts  :304-348
      info.hasUpdate → notify + send('update:state')

[User clicks "update now"]
 main.js:579 runUpdate()  (updateBusy mutex)
   ├─ updater.prepare(info)                              updater.js:121
   │    ├─ parts?  _downloadParts()  per-part speed test + download + sequential stitch  :182
   │    └─ otherwise  candidates→rank→downloadMulti      :140-163
   │    └─ .zip → _extract to update/<ver>/payload       :166-173
   ├─ updater.apply(job)                                 updater.js:258
   │    ├─ generate the PS script (Wait-Process 90s → copy/silent install → restart → cleanup → exit 0)
   │    ├─ write update/apply.log.ps1 (troubleshooting)  :310
   │    └─ spawn powershell -EncodedCommand (**not detached**) + unref  :319-323
   └─ setTimeout(900ms) → quitting=true; app.quit()       main.js:596
        └─ the script waits for the process to exit → overwrites the install dir → Start-Process exe → deletes update/<ver>
```

Key timing numbers (one-off constants; do not casually lower them when taking over):
- `autoDeploy` delay **20s** (`main.js:1661`; the comment notes disk/CPU are already saturated during a cold start);
- Update check delay **8s**, only when `app.isPackaged` (`main.js:1665-1675`);
- In `apply`: `Wait-Process -Timeout 90`, **12 copy rounds × 600ms**, cleanup 400ms after restart (`updater.js:271-306`);
- Exit the app **900ms** after `apply` returns (`main.js:596`);
- `downloadMulti`: chunk idle **20s**, slow threshold **45s + 120KB/s**, **6** retries per chunk, at most **2** source switches;
- `download` (single stream): idle **30s**, non-2xx retries **2** × 1.5s.

### 8.2 The most failure-prone links in this chain

| # | Symptom (user's view) | Code location | Mechanism / notes |
|---|---|---|---|
| 1 | **"Stuck preparing runtime"**, the progress bar sits at 1–3% for a long time | `provision.js:531` (pinned `percent:1`) + `sources.js:412-417` (**serial** speed tests, ≤9s per URL) + `sources.js:52` (256KB each) | 4 candidates (direct + 2 mirrors + Gitee) means 30s+ of "no byte progress". The worse the network, the more candidates, the more it looks hung |
| 2 | Progress **sits at 99% for a long time**, then jumps back to "filling gaps from the official source" | `provision.js:575-576` (`materializeImages(...).catch(()=>0)`) + `:790` (a single image failure only logs) | A `.xz` expansion failure swallowed by two catch layers → `checkEnv().sysimg.ok=false` → `autoDeploy` takes `main.js:330` and downloads another 1.4GB; the next start retries the expansion again |
| 3 | Weird errors around `@napi-rs/lzma` | `provision.js:771-781` (`require.resolve('@napi-rs/lzma')` then require `index.js` by file path) | If the lzma binary is not packaged / is trapped in the asar → `Cannot find module`; the comment explains why `require('@napi-rs/lzma')` cannot be used directly (ESM polyfill) |
| 4 | **"I set the runtime directory and it still downloads to AppData"** | `provision.js:217-224` (`sysImgRoot` three branches), `:726` (`materializeImages` target), `:237` (`avdHome`), `store.js:67-98` (`runtime.dir` defaults empty), `main.js:97-171` (`bootstrapBundledRuntime` **overwrites** `runtime.dir`) | (1) An old user already has `<DATA_DIR>/system-images` → branch 2 keeps using it and never moves; (2) when a portable exe has a sibling `runtime/`, `bootstrapBundledRuntime` calls `saveSettings({runtime:{dir: bundled}})` at `main.js:165-168` and overwrites the user's setting (only `sameTree && emulator.exe exists` respects the old setting, `:144-148`); (3) AVDs have a separate `avdDir` setting and may live on a different drive from the runtime |
| 5 | Plenty of disk yet it reports "not enough space", or extraction fails halfway | `provision.js:262-277` (the `need` table at 264-265 has no `'runtime'`), `main.js:940` (self-check threshold 8192MB) | `guardDisk('runtime')` only estimates 1536MB while the bundle + expansion really needs ~5GB; passing the guard can still overflow |
| 6 | Progress **stuck at 95%** (historical issue) | Countermeasures already present: `download.js:446-451,492-503` (switch source when slow), `:466-480` (must settle); the single-stream path still only has `idleMs=30s` (`:112`) | A slow source dragging its tail chunk; the sidecar (`.chunks.json`) ensures a retry fetches only the missing chunks instead of the whole package |
| 7 | "Connection interrupted / stalled" voids the whole download | `download.js:155` (`close` with `!complete` → reject), `:526-528` (chunk retries exhausted → throw + save sidecar) | Resume is by design; but `downloadParallel` degrades to a single stream when it sees a partial file (`:188-191`), turning multi-threaded into single-threaded |
| 8 | The update hangs at "replacing the program and restarting" | `updater.js:315-323` (the "must not be detached" compatibility comment), `:271` (Wait-Process 90s), `:280-285` (12 copy rounds) | Security software blocking "a detached process" → the script never runs; or uninstall/install is stopped by UAC; `update/update.log` is the only on-site evidence |
| 9 | After an update the program directory gains a strange 1.5GB file | `updater.js:80` (portable fallback `/\.zip$/i`) | If a release has only `ApkStart-runtime-vX.zip` and no `portable` asset, it is treated as the update package and extracted into the install directory |
| 10 | "One version on Gitee has no installer" | `.github/workflows/release.yml:36-44,78-100` (100MiB gate + a missing `GITEE_TOKEN` fails outright); consumers `sources.js:172-204`, `updater.js:182-227` | A build-time problem, but the symptom shows up here; parts must be `part1..N` contiguous or the whole group is dropped (`sources.js:196-203`) |
| 11 | Still using the old address after switching sources / changing the mirror prefix | `main.js:819-825` only calls `sources.reset()`; the `_cache.*` at `provision.js:479,514,642,664,984` have no invalidation entry | A process restart is required for it to take full effect |
| 12 | Status polling pegs the CPU / spawns processes endlessly | `provision.js:687-714` (a failed `emulatorVersion` is not cached), `:298-315` (adb 30s cache), `:845-902` (accel 30s + on-disk 6h/10min) | When the emulator is not installed, every `checkEnv` `execFile`-probes multiple paths |
| 13 | The AVD is judged "already in use" and will not boot | `layers.js:87-90` (lock-file inventory), `main.js:963-969` (self-check finds `.lock`), `engine.js:856` (`killOrphanEmulators`) | A `*.lock` left by an abnormal exit; the cleanup panel can reclaim it |
| 14 | The first launch loses "already installed apps/data" | `store.js:179-184` (three forced migrations), `engine.js:848` (`materializeImages`), `doctor.snapshotKey`/`imageIdentity` (snapshot fingerprint, `auto-test.js:88,98`) | The migration is one-way; the snapshot fingerprint **does not include the data-partition size** (`auto-test:1395`), so resizing does not wipe data |

### 8.3 Three "look here first" notes for the next maintainer

1. **One function explains 80% of deployment problems**: `Provisioner.checkEnv()` (`provision.js:367`). It simultaneously determines the UI's "what is missing", the `autoDeploy` branches, whether `engine.ensure()` uses emulator or qemu, and the contents of the diagnostic report.
2. **Path rules live in exactly one place**: `Provisioner.paths()` (`provision.js:197`). Any new code that writes runtime files must get its paths from there; never assemble `DATA_DIR` yourself.
3. **Download strategy is centralized in `Sources` + `downloadMulti`**: a new source only needs to enter `candidates()`; new "rate limit / prefer best" logic only needs changes to `rank()` and the multi-source conditions in `downloadMulti` — do not write a second copy inside `provision.js`.
