# ApkStart offline parsing stack code walkthrough (WIP)

> Audience: engineers who will take over this project and keep developing the "APK → icon → shortcut" chain.
> Method: code reading only + grep for call sites; no state-changing command was run.
> Version baseline: `package.json` version `0.3.5` (electron ^33.4.11, node >=20).
> Every `file:line` refers to the current workspace snapshot; update it when you change the code.

Files covered (`src/core/*.js` has 29 files in total; this document covers only the parsing / icons / association / version / logging group):

| File | Lines | One-line role |
|---|---|---|
| `src/core/zip.js` | 236 | ZIP reader built on `zlib` alone (in-memory version + fd streaming version) |
| `src/core/axml.js` | 167 | Binary XML parser for AndroidManifest.xml |
| `src/core/arsc.js` | 233 | Trimmed-down resources.arsc parser (resolves @0x7f references) |
| `src/core/png.js` | 132 | Zero-dependency PNG encoder + procedural brand icon |
| `src/core/apk.js` | 190 | APK metadata entry point `parseApk()` |
| `src/core/shortcut.js` | 183 | Multi-size ICO generation + .lnk writing |
| `src/core/assoc.js` | 68 | .apk file association under HKCU |
| `src/core/version.js` | 36 | Version comparison (kept separate to avoid a circular dependency) |
| `src/core/logfile.js` | 52 | Append + size-based rotation (logging / small utility module) |
| `src/core/display.js` | 59 | Pure display-fit math (another small "pure utility" module) |

---

## 1. `src/core/zip.js`

### Responsibility
A minimal ZIP reader implemented with Node's built-in `zlib`: it parses only the central directory and decompresses single entries on demand; there is also a file-descriptor-based streaming version aimed at GB-scale system images.

### Public interface
```js
const { ZipArchive, ZipFile } = require('./zip');

new ZipArchive(buffer /*: Buffer, the whole package */)
  .entries        // Map<string, {name, flags, method, compSize, uncompSize, localOffset}>  ← public field, read directly from outside
  .has(name)      // → boolean
  .names()        // → string[]
  .find(re)       // (RegExp) → string[] (matching entry names)
  .read(name)     // → Buffer | null (null when the entry is missing; throws if the local header is corrupt or the method is unsupported)
  .pipeTo(name, dest /*: Writable */)  // → Promise<number> (resolves the uncompressed size, handy for verifying bytes written)

new ZipFile(filePath /*: string */)
  .size           // file size in bytes
  .entries        // same as above
  .has / .names / .find          // same as above
  .close()        // idempotent; fd set to null
  .read(name)     // → Buffer (throws when missing, does not return null — inconsistent with ZipArchive!)
  .pipeTo(name, dest)  // → Promise<number>
```
> Note the asymmetric interface: `ZipArchive.read` returns `null` for a missing entry, `ZipFile.read` throws `entry not found`. The `if (data && ...)` null check around `zip.read(...)` in `apk.js` exists because of the former.

### Key internals

**ZipArchive — whole package in memory (not streaming)**
- The constructor takes the `Buffer` handed in by the caller (`zip.js:14`) and never touches the disk itself. So "is the whole package read into memory" depends on the caller: `apk.js:78` uses `fs.readFileSync` and so does `installer.js:27` → **the APK parsing path keeps the entire package resident in memory, 100% of the time**.
- `_parse()` (`zip.js:20`): scans backwards from `buf.length-22` for `EOCD_SIG`, lower bound `buf.length - 65557` (`zip.js:23`, = 22-byte EOCD + max 65535-byte comment). Once found, `total` is read at `+10` (u16) and the central-directory offset at `+16` (u32).
- Central-directory loop (`zip.js:32-47`): advances by 46 + nameLen + extraLen + commentLen; field offsets 8/10/20/24/28/30/32/42 match the PKZIP spec; names are always decoded as UTF-8 (`zip.js:42`), and **GP flags bit 11 is not handled**.
- `read()` (`zip.js:54`): first validates the local file header signature `LOC_SIG`, then computes the data start from the nameLen/extraLen in the **local header** (`zip.js:61-63`; the central-directory lengths must not be used, the two can differ); `method 0` returns `Buffer.from(raw)` (**a copy**, `zip.js:65`); `method 8` uses `zlib.inflateRawSync` (`zip.js:66`).
- `pipeTo()` (`zip.js:80`): feeds `raw` into `createInflateRaw` in 1MB slices, resuming with `once('drain')` whenever `write()` returns false (`zip.js:105-116`); `dest.on('finish')` and `dest.on('error')` share `done`, and success resolves `e.uncompSize` (the caller can use it to verify the byte count). **Note that the data is already in memory; slicing only stops zlib from swallowing GBs at once, it does not save memory.**

**ZipFile — fd + tail window**
- Construction: `fs.openSync(path,'r')` + `statSync` (`zip.js:134-135`); if `_parse()` fails it calls `close()` automatically before throwing (`zip.js:137`, preventing fd leaks).
- Reads only the tail `min(size, 22 + 65557 + 4096)` bytes (`zip.js:152`, at most 69675B) for the EOCD scan; if the central directory is not inside that window (very long comments etc.), it does a separate `readAt(cdOffset, min(eocdAbs-cdOffset, 64MB))` (`zip.js:166-172`).
- `_readAt` (`zip.js:145`): `Buffer.alloc(len)` + **a single** `fs.readSync`. POSIX allows short reads and there is no retry loop here → a 64MB central directory could in theory be silently truncated (local Windows files normally do not trigger it; be careful with network or virtual drives).
- `read()` (`zip.js:206`) reads the whole `compSize` into memory and then inflates — **large entries still hit the 2GB ceiling**; `pipeTo()` (`zip.js:214`) is the actual streaming path: `createReadStream(null,{fd, autoClose:false, start, end})`, where `end` is **inclusive** (`zip.js:203` already computes `start+compSize-1`).
- `_range()` (`zip.js:195`) reads the 30-byte local header each time to validate the signature and returns `{e,start,end}`.

**Where exactly the 2GB limit lives**
| Location | Meaning |
|---|---|
| `zip.js:75-79` (comment) | Explicitly records that "GB-scale entries cannot be inflated in one block and will hit Node's 2GB single-Buffer ceiling" — this is why `pipeTo` exists |
| `zip.js:37` / `zip.js:180` | `uncompSize` / `compSize` are read with `readUInt32LE` → **no Zip64**, entries >4GiB read truncated/aliased values |
| `zip.js:29-30` / `161-162` | `total` is u16 (breaks above 65535 entries), `cdOffset` is u32 (`0xffffffff` under Zip64 → hits the "offset anomaly" branch at `zip.js:166` and throws) |
| `zip.js:208` | `ZipFile.read()` allocates one Buffer of the full `compSize` → a single entry >2GB fails outright with `ERR_BUFFER_TOO_LARGE` |
| `apk.js:78` | `readFileSync` on the whole package → any APK >2GB (or >`buffer.constants.MAX_LENGTH`) fails at read time and never reaches the zip layer |

### Pitfalls and invariants
1. **The local header and the central directory each carry their own nameLen/extraLen, and each must be read from its own place** (`zip.js:61-63`, `198-202`). They can differ (especially with a data descriptor or alignment padding), and using the central-directory values to compute the local data start is the most common way to break this code.
2. **Data descriptors (GP bit 3) need no special handling**: the compressed size comes from the central directory (`zip.js:36/179`), so the three fields in the local header being 0 does not matter. This is more robust than many streaming ZIP parsers.
3. **The encryption bit is never checked**: `flags` is only stored (`zip.js:34`) and bit 0 is never tested; encrypted entries fail as "inflate failed", which does not point at the real cause.
4. **A truncated central directory silently loses entries**: the `break` at `zip.js:176` exits quietly when `off+46 > cd.length` or the signature is wrong, without throwing. The symptom is "the APK clearly has lib/, yet abis is empty".
5. `ZipArchive.entries` is a public `Map`; `apk.js:31`, `apk.js:44` and `provision.js:608` all read `uncompSize` via `entries.get(name)` directly, so changing the data structure touches three places.
6. `pipeTo`'s `dest` must be a writable stream created by the caller (`provision.js:611` and `updater.js:239` both use `fs.createWriteStream`); the function never closes `dest`, it only waits for `finish`.
7. `ZipFile` must be `close()`d (`provision.js:619` does it in a `finally`, `updater.js:249` too), otherwise the fd leaks.
8. Names are always decoded as `utf8`; old ZIPs with GBK filenames come out garbled, but APK paths are ASCII, so there is no practical impact.

### Call sites
`ZipArchive`:
- `src/core/apk.js:8` (require), `apk.js:79` (the `parseApk` main path)
- `src/core/installer.js:12`, `installer.js:27` (`parseBundle`, unpacking .apks/.xapk)
- `src/core/provision.js:15`, `provision.js:595` (small packages use the in-memory version)
- `test/run-tests.js:29`, `57`; `test/run-tests.js:119`, `124` (real fixtures)
- `test/engine-test.js:167`, `194`
- `test/auto-test.js:277`, `319`

`ZipFile`:
- `src/core/provision.js:15`, `595` (>64MB uses the file version)
- `src/core/updater.js:21`, `230` (`_extract`, unpacking the update package)
- `test/auto-test.js:277`, `320` (consistency comparison against `ZipArchive`)

`pipeTo`:
- `src/core/provision.js:611`, `src/core/updater.js:239`, `src/core/zip.js:80` (itself)

### Test coverage
- `test/run-tests.js:30` "can parse the package.json zip structure of its own project" — the name is impressive, but it actually hand-builds a minimal stored zip (`run-tests.js:32-57`) and only covers `has` + `read`.
- `test/engine-test.js:166` "built-in ZIP decompression works" — covers `ZipArchive` + `pipeTo` indirectly through `Provisioner.extractZip` (`provision.js:591`).
- `test/auto-test.js:275` "ZipFile and ZipArchive produce the same result for the same archive (including deflate and streaming pipeTo)" — the only case that exercises stored/deflate, `read`/`pipeTo` and both classes at once; `auto-test.js:278-315` assembles the bytes by hand.
- **Gaps**: no Zip64, no "truncated central directory", no encryption bit, no `find()` case; the large-entry path of `ZipFile.read()` is uncovered.

---

## 2. `src/core/axml.js`

### Responsibility
Parses the compiled `AndroidManifest.xml` inside an APK (binary XML / AXML) into an ordinary DOM tree, so upper layers can query it by tag/attribute.

### Public interface
```js
const { parseAxml, attr, attrValue, children, ANDROID_NS, TYPE_REFERENCE } = require('./axml');

parseAxml(buffer /*: Buffer */)   // → node (root is manifest; throws if not AXML or the manifest is empty)
// node = { name: string, attrs: Attr[], children: node[], parent: node|null }
// Attr = {
//   ns: string,        // '' means no namespace (nsIdx = 0xffffffff)
//   prefix: string,    // maintained by namespace start/end events; holds the "last declared" prefix
//   name: string,      // attribute name (string pool)
//   value: string|number|boolean|null,  // rawValue first, otherwise interpreted by dataType
//   refId: number|null,   // set only when dataType=TYPE_REFERENCE(0x01) (unsigned)
//   dataType: number,  // Res_value.dataType as-is
//   typed: string|number|boolean|null,  // null for references, otherwise the same as value
// }

attr(node, name, ns = ANDROID_NS)   // → Attr | null; ns = null means "any namespace"
attrValue(node, name, ns = ANDROID_NS)  // → Attr.typed | null
children(node, name)                // → node[] (filtered by tag name, not recursive)
ANDROID_NS = 'http://schemas.android.com/apk/res/android'
TYPE_REFERENCE = 0x01
```

### Key internals

**`readStringPool(buf, start)` (`axml.js:26-62`)**
- Header: `type@0`, `headerSize@2`, `chunkSize@4`, `count@8`, `flags@16`, `stringsStart@20`; `isUtf8 = flags & 0x100` (`axml.js:34`).
- The offset table follows the header: `start + headerSize + i*4` (`axml.js:38`); the string base is `start + stringsStart` (`axml.js:40`).
- A UTF-8 pool needs **two** variable-length reads: first the "UTF-16 length" (1–2 bytes, `axml.js:47-48`), then the "UTF-8 byte length" (`axml.js:50-51`); the slice uses **the latter**. A UTF-16 pool uses a 1–2 u16 length in code units (slice `len*2`, `axml.js:58`).
- Returns `{ strings, chunkSize }`; the caller uses only `strings` (`axml.js:88`).

**`parseAxml(buffer)` (`axml.js:67-150`)**
- Header check `RES_XML_TYPE(0x0003)` (`axml.js:69`), `pos = readUInt16LE(2)` (headerSize), `total = readUInt32LE(4)` (`axml.js:72-73`).
- Per-chunk loop `while (pos + 8 <= total && pos < buf.length)` (`axml.js:81`), reading `type/headerSize/chunkSize`; `chunkSize <= 0` breaks immediately to avoid an infinite loop (`axml.js:85`).
- Namespaces: `nsStack` holds uris, `prefixByUri` records uri→prefix (`axml.js:76-77`); START pushes and sets, END only pops (`axml.js:89-97`). **When the same uri is declared multiple times the prefix is "last wins"**, and `prefixByUri` is never cleaned up.
- START_ELEMENT (`axml.js:98`):
  ```js
  nameIdx   = readUInt32LE(pos + 20)
  attrStart = readUInt16LE(pos + 24)   // offset relative to ResXMLTree_attrExt
  attrSize  = readUInt16LE(pos + 26)   // size of one attribute, normally 20
  attrCount = readUInt16LE(pos + 28)
  const attrBase = pos + 16 + attrStart;   // ★ axml.js:106
  ```
- Each attribute is 20 bytes: `ns@0`, `name@4`, `rawValue@8`, `value.size@12`, `value.res0@14`, `value.dataType@15`, `value.data@16` (`axml.js:109-113`).
- Value precedence: **if rawValue exists use the pool string** (`axml.js:120-121`) → otherwise `TYPE_STRING` takes `data` as a pool index (`122-123`) → `TYPE_REFERENCE` records only `refId` (`124-126`) → boolean (`127-128`) → dec/hex (`129-130`, `| 0` converts to signed 32-bit).
- Tree building: a new node's `parent` points at the stack top, it is pushed into the parent and then onto the stack (`axml.js:104`, `139-140`); END_ELEMENT pops one level (`141-142`).
- Finishing: it looks for the child of `root.children` named `manifest` and takes the first child if none is found (`axml.js:147`); if there is nothing at all it throws "APK manifest is empty" (`148`).

### Pitfalls and invariants

1. **The base of `attributeStart` (`axml.js:105-106`) is the single most breakable line in the whole codebase.**
   The `ResXMLTree_node` header is 16 bytes (type 2 + headerSize 2 + chunkSize 4 + lineNumber 4 + comment 4); `ResXMLTree_attrExt` starts at chunk+16, and `attributeStart` is **an offset relative to attrExt** (normally 20 = sizeof(attrExt) itself). So the correct formula is `pos + 16 + attrStart`.
   Changing it to `pos + attrStart` or `pos + headerSize + attrStart` does not crash — it only **silently decodes misaligned attribute names/namespaces**; externally the app name falls back to the package name, the icon goes through heuristic fallback, and `package` becomes `undefined`. **No assertion or synthetic byte case guards it today.**

2. **The `package` attribute has no namespace**: only `attrValue(manifest,'package',null)` in `apk.js:88` can read it; the `ns===null` branch of `attr()` (`axml.js:154`) exists for exactly this.

3. **Both `rawValue` and `dataType` must be tried**: attributes like `android:label` and `android:name` often carry `rawValue = 0xffffffff` with `dataType = 0x03`, so reading only raw yields null. Conversely, some toolchains write raw without a type, so the order must not be reversed.

4. **The difference between `typed` and `value` is deliberate**: when `refId` is present `typed = null` (`axml.js:136`), which keeps `attrValue()` from returning a "resource id number" as a string. All upper-layer logic (`apk.js:111`, `apk.js:141`) checks `refId` first, then `typed`.

5. **`chunkSize < 8` is not guarded** (only `<= 0`, `axml.js:85`); a malformed AXML could in theory spin in place. It does not happen with APKs, but add the guard if you ever parse arbitrary user-supplied files.

6. **Unsupported chunks are skipped silently**: CDATA (0x0104) has no branch and is passed over via `pos += chunkSize` (`axml.js:144`). `RES_XML_RESOURCE_MAP(0x0180)` is only skipped as well — so attribute names come from the string pool, not from the resource-map attr id. That is enough for this project (lookups by name), but **when resources are localized/obfuscated the names may be mangled into `a`/`b`** (hardened or resource-obfuscated APKs do this; at that point only a reverse lookup through the resource-map id works).

7. Only the `manifest` subtree is parsed; sibling nodes after the namespace END are ignored.

### Call sites
- `parseAxml`: `src/core/apk.js:9` (require), `apk.js:86` (manifest), `apk.js:54` (adaptive-icon XML reuses the same parser)
- `attr`: `src/core/apk.js:62` (`attr(node,'drawable')`)
- `attrValue`: `apk.js:18`, `19` (intent-filter action/category), `88`, `91`, `92`, `96`, `97`, `124`, `125`
- `children`: `apk.js:16`, `19`, `95`, `99`, `121`
- `ANDROID_NS`: **imported only at `apk.js:9` and never used** (dead import); the real user is `attr()`'s default parameter (`axml.js:152`)
- Tests: `test/run-tests.js:80` (require), `run-tests.js:120`
- No other module consumes it directly (`arsc.js` has its own copy of the string-pool code)

### Test coverage
- `test/run-tests.js:118` "the AXML root node is manifest" — **depends on a real APK fixture** (`run-tests.js:86-100` looks for `APKSTART_TEST_APK` / `test/fixtures/sample.apk` / `Documents/*.apk`); if none is found the whole section is skipped (`run-tests.js:130-132`).
- No synthetic AXML byte-level case → on a machine without fixtures (CI) `axml.js` has zero coverage, and offset bugs such as `attributeStart` would go unnoticed.
- The exports `attr` / `attrValue` / `children` / `ANDROID_NS` / `TYPE_REFERENCE` have no direct unit tests.

---

## 3. `src/core/arsc.js`

### Responsibility
A trimmed-down `resources.arsc` parser: resolves the `@0x7f...` resource references in the Manifest into the app-name string and the icon file path.

### Public interface
```js
const { ResTable, TYPE_REFERENCE } = require('./arsc');

new ResTable(buffer /*: Buffer, the whole resources.arsc */)
  .globalStrings   // string[]: file-level string pool (value.data is an index into this)
  .packages        // Array<{ id:number, typeStrings:string[], keyStrings:string[],
                   //         types: Map<number /*typeId*/, Array<{id, config, entries: Map<number, {dataType,data} >}>> }>
  .resolve(ref /*: number, 0xPPTTEEEE*/, prefer /*: 'string'|'file'|'any' = 'any' */, depth = 0)
                   // → string | number | boolean | null
TYPE_REFERENCE = 0x01   // exported, but no external consumer in the project
```

### Key internals

**Three-layer structure (`arsc.js:9-15`)**
`ResTable`(0x0002) → `ResTable_package`(0x0200) → `ResTable_type`(0x0201). `RES_TABLE_TYPE_SPEC_TYPE`(0x0202) has a constant but is never handled.

**`readStringPool(buf,start)` (`arsc.js:23-46`)**
A **copy-paste of the same logic as `axml.js:26`** (UTF-8/UTF-16 branches, two varint lengths). The two copies must be maintained in sync.

**`_parse()` (`arsc.js:87-106`)**
- Validates `RES_TABLE_TYPE` (`89`), `total@+4`, `pkgCount@+8` (read, but only `pos<total` drives the loop; `pkgCount` is never used as a counter).
- Only the **first** string pool becomes `globalStrings` (the `this.globalStrings.length === 0` condition at `99-100`), so later per-package pools are not mistaken for the global pool.

**`_parsePackage(start,size)` (`arsc.js:108-139`)**
- Fields: `id@+8`, `typeStrings@+268`, `keyStrings@+276`, `headerSize@+2` (`111-113`) — this is the fixed `ResTable_package` layout (name[128] UTF-16 occupies 12..268).
- The two string-pool reads are wrapped in `try/catch` (`117-120`); a failure only loses the type/key names and **does not affect `resolve`** (deliberate tolerance, see the invariants below).
- Sub-chunk loop `while (pos + 8 <= end)`, handling only `RES_TABLE_TYPE_TYPE` (`125-137`), grouping into `Map<number, chunk[]>` by `typeId` (each config of the same typeId gets its own entry).

**`_parseType(start)` (`arsc.js:141-179`)**
- Header: `headerSize@+2`, `id@+8` (u8), `flags@+9` (u8), `entryCount@+12` (u32), `entriesStart@+16` (u32), `config@+20`.
- The offset table starts at `start + headerSize`, entry data at `start + entriesStart` (`151-152`).
- Three encodings:
  - `FLAG_SPARSE(0x01)`: each item is 4 bytes `{idx:u16, offset:u16}`, and **the offset unit is 4 bytes** (the `*4` at `157-158`)
  - `FLAG_OFFSET16(0x02)`: `offset:u16`, `0xffff` means empty, **also `*4`** (`165-167`)
  - normal: `offset:u32`, `0xffffffff` means empty (`172-173`)
- The three `*4` multipliers are Android's compact entry encoding; remove them and everything misaligns.

**`_readValue(at)` (`arsc.js:181-192`)**
- `ResTable_entry`: `size@0` (u16), `flags@2` (u16); `flags & 0x0001` = `FLAG_COMPLEX` (bags/maps: styles, arrays, attrs) → **returns null immediately** (`186`).
- `valueAt = at + entrySize` (`187`, entrySize can be 8 or 16); `Res_value`'s `dataType@+3`, `data@+4` (`189-190`).
- There is no check of `Res_value.size` (spec'd as 8) and no bounds check beyond `at+8` (only one at `183`).

**`parseConfig` / `score`**
- `ResTable_config` layout: `size@0`, `imsi@4`, `locale(language@8,country@10)`, `screenType(orientation@12,touchscreen@13,**density@14**)`, `input@16`, `screenSize@20`, `version(**sdkVersion@24**)`, `screenConfig(screenLayout@28,**uiMode@29**)` (`48-59`).
- `isDefault = !language && !country && density===0 && !sdkVersion` (`60`) — **`uiMode` is not part of the test**, so a config that only sets `uiMode` is treated as default.
- Scoring (`65-77`):
  - `prefer='file'`: `s += density` (higher density wins), `anydpi(0xfffe)` gets an extra `-500` (to avoid picking up xml adaptive icons, comment at `69`)
  - otherwise: no-density wins, `language` −40, `sdkVersion/1000`, `uiMode` −20 (i.e. it prefers the default config with no language, low sdk, no uiMode)

**`resolve(ref,prefer,depth)` (`arsc.js:200-230`)**
- `depth > 6` or `ref` being 0 returns null immediately (cycle protection, `201`).
- Splits the reference: `pkgId = ref>>>24`, `typeId = (ref>>>16)&0xff`, `entryIdx = ref&0xffff` (`202-204`).
- **Falls back to `packages[0]` when the package is not found** (`206`) — multi-package APKs (shared libraries 0x02/0x03) can look in the wrong package.
- Picks the highest-`score` config among all configs of the same typeId (`211-217`).
- `TYPE_STRING` → `globalStrings[data]` (`220-222`, null if undefined); `TYPE_REFERENCE` → recurse (`224-226`); boolean/dec/hex are returned directly (`227-228`); anything else is null (e.g. `TYPE_DIMENSION`, colors, which are not parsed here).

### Pitfalls and invariants

1. **`globalStrings` must be the file-level pool**: `value.data` is a global pool index; the per-package `typeStrings/keyStrings` are only for debugging output. That is why swallowing errors in `_parsePackage`'s `try/catch` is safe — `resolve` does not depend on it. **Do not change `resolve` to use `keyStrings`.**
2. **The constants in `score()` are empirical**: `anydpi` −500, `language` −40. The intent is "Chinese apps prefer default resources, icons prefer the highest density"; the cost is that **the app name may come out in English** (`values/` is the default while `values-zh/` is penalized). The current goal is only "it displays"; there is no system-locale matching.
3. **Resources with `FLAG_COMPLEX` never resolve**: if `android:icon` points at a bag resource such as `<bitmap>`/`<shape>`, `resolve` returns null and `apk.js`'s heuristic fallback kicks in.
4. **The `*4` on sparse/16-bit offsets cannot be dropped** (`158`, `167`).
5. **`pkgCount` is read and unused** (`92`): the top-level chunk walk relies on `pos<total`, so stray non-package chunks do not break it, but `pkgCount` is a dead variable.
6. There is no `ResTable_typeSpec`, no overlayable/staged alias, no locale matching, no `0x00` dynamic package.
7. `TYPE_REFERENCE` is exported but used nowhere (`arsc.js:233`) — API noise.

### Call sites
- `ResTable`: `src/core/apk.js:10` (require), `apk.js:104` (constructed inside `try/catch`; on failure it degrades to `res=null`)
- `resolve`: `apk.js:65` (adaptive-icon `drawable`), `apk.js:111` (`label`, `'string'`), `apk.js:141` (`icon`/`roundIcon`, `'file'`), `arsc.js:225` (its own recursion)
- Tests: `test/run-tests.js:81` (require), `run-tests.js:126`
- `TYPE_REFERENCE`: no consumer anywhere in the project

### Test coverage
- `test/run-tests.js:123` "resources.arsc can be parsed" — only asserts `res.packages.length > 0`; it also depends on a real APK fixture and is skipped without one.
- No `resolve()` case (not one assertion that "some ref resolves to the expected string/path"), and no FLAG_SPARSE / FLAG_OFFSET16 / FLAG_COMPLEX cases.
- Conclusion: **`arsc.js` has the thinnest tests in this chain while carrying the hardest logic** (three entry encodings + config scoring).

---

## 4. `src/core/png.js`

### Responsibility
A zero-dependency PNG **encoder** + procedural drawing of the ApkStart brand icon (avoids binary assets in the repo, and makes theme-color changes easy).

> Note the direction: encoding only (RGBA → PNG), **no decoding**. Decoding WebP/PNG relies entirely on Electron's `nativeImage` / Chromium (see section 6).

### Public interface
```js
const { encodePng, drawAppIcon } = require('./png');

encodePng(width, height, rgba /*: Uint8Array, length must be = w*h*4, RGBA order */)  // → Buffer(PNG)
drawAppIcon(size = 256)  // → Buffer(PNG), size×size
```

### Key internals
- **CRC32** (`png.js:8-22`): the standard reflected polynomial `0xedb88320`, 256-entry lookup table stored in an `Int32Array`; `crc32()` returns an unsigned value via `>>> 0`.
- **chunk()** (`png.js:24-31`): `[len BE][type ascii][data][crc BE]`, with the CRC covering type+data.
- **`encodePng`** (`png.js:34-55`):
  - 13-byte IHDR: `width/height` BE, bitDepth=8, colorType=6 (RGBA), compression/filter/interlace all 0 (`png.js:36-40`)
  - Raw data is `raw = (width*4+1)*height`; the first byte of each row is filter 0 (None) and the rest is copied with `Buffer.from(rgba.buffer, byteOffset + y*stride, stride)` (`png.js:43-48`) — **this requires `rgba.byteOffset` to be a valid offset**; a `Uint8ClampedArray` view also works
  - A single IDAT, `zlib.deflateSync(raw, {level:9})` (`png.js:52`); `level:9` takes a few tens of ms for 256×256
- **`drawAppIcon`** (`png.js:80-130`):
  - 4× supersampling: `SS=4`, `S=size*4`; `acc = Float32Array(size*size*4)` accumulates the color (`png.js:83`)
  - Shapes: rounded rectangle `pad = 6%`, radius `24%` (`85-86`), tested with `roundRectAlpha()` (`59-65`, "clamp the point to the inner rectangle, then measure the distance to the nearest corner center"); triangle via `pointInTriangle()` (`67-74`, inside when three cross products share a sign)
  - Colors: diagonal gradient `t = (x/S)*0.6 + (y/S)*0.4` → `r 20..34 / g 26..44 / b 33..57`; the triangle is solid `#3ddc84` = (61,220,132) (`105-111`)
  - Sampling accumulates only samples inside the box (the `if (!inBox) continue;` at `102`); alpha stays 0 outside the box; finally the sum is divided by `n = SS*SS = 16` (`122-127`) → edges get a 0..255 coverage value, i.e. anti-aliasing
- **Performance envelope**: `size=256` → `S=1024`, 1,048,576 iterations with 1–2 geometric tests each; roughly 5–15ms per call. `size=512` is 4M iterations (about 4×). `main.js:175` computes `ICON_PNG` once at startup and caches it, so it is not a hot path.

### Pitfalls and invariants
1. **`acc` must be a `Float32Array`**: 16 accumulated samples would overflow/truncate to 255 in a `Uint8Array`, producing color banding. Uint16 also works, but the division line must change with it.
2. `encodePng` assumes `rgba.length >= w*h*4` and **does not validate the length**; a shorter buffer throws RangeError in `copy`, a longer one is ignored.
3. Only RGBA8 / filter 0 / a single IDAT is supported — a "good enough" encoder; adding filter optimization (Paeth) means rewriting the `raw` fill loop.
4. All coordinates in `drawAppIcon` are relative to `S` (the supersampled space), so changing `SS` does not affect the composition; changing `size` only affects sharpness/cost.
5. This is the source of the "brand placeholder icon" and also the input to the third fallback level of `iconToIco` (`shortcut.js:128-129`), so **whenever icon extraction fails**, the user sees this green triangle on the desktop.

### Call sites
- `drawAppIcon`: `src/main.js:15` (require), `main.js:28` (fallback for `loadBrandIcon()` when `LOGO_FILE` does not exist)
- `src/core/shortcut.js:128` (require), `129` (placeholder ICO)
- `encodePng`: only `png.js:129` (inside `drawAppIcon`) + tests
- Tests: `test/run-tests.js:63` (require), `66`, `73`; `test/auto-test.js:496`, `497`; `test/electron-integration.js:22`, `27`

### Test coverage
- `test/run-tests.js:64` "the PNG encoder emits a valid signature and IHDR" — checks the `0x89 0x50` signature, `IHDR` and length > 50; **no CRC check, no pixel check**.
- `test/run-tests.js:71` "the app icon can be drawn at any size" — the output width for 16/32/64/256 equals the input size.
- `test/auto-test.js:494` uses `drawAppIcon(64)` indirectly as the source material for PNG-in-ICO.
- Gaps: there is **no pixel-correctness assertion** for `drawAppIcon` (only the size); abnormal size/length inputs to `encodePng` are untested.

---

## 5. `src/core/apk.js` (entry point)

### Responsibility
Offline extraction of APK metadata: package name / version / app name / launch Activity / icon / ABI. No dependency on aapt, adb or the network.

### Public interface
```js
const { parseApk, quickCheck } = require('./apk');

parseApk(filePath /*: string */) → {
  ok: true,
  filePath,          // returned as-is
  sizeBytes,         // fs.statSync size
  package: string,   // required, otherwise throw
  label: string,     // whitespace collapsed + trimmed + truncated to 60 chars
  versionName: string,   // default '1.0'
  versionCode: number,   // 0 when not a number
  minSdk: number,        // default 0
  targetSdk: number,     // default 0
  launchActivity: string|null,
  abis: string[],        // ['arm64-v8a', ...], [] when there is no lib/
  iconPng: Buffer|null,  // raw icon bytes (PNG or WebP! the field name is misleading)
  iconFile: string|null, // path inside the APK, e.g. 'res/mipmap-xxxhdpi-v4/ic_launcher.png'
}   // always throws on failure (never returns ok:false)

quickCheck(filePath /*: string */) → boolean   // reads the first 4 bytes looking for 'PK'; false on any exception
```

### Key internals (`parseApk`, `apk.js:75-175`)

1. `fs.statSync` → `size < 1024` throws "file too small" (`76-77`).
2. `const buf = fs.readFileSync(filePath)` (`78`) → **the whole package into memory**, the heaviest step in the chain.
3. `new ZipArchive(buf)` (`79`).
4. `AndroidManifest.xml` is required; otherwise it reports "this may be a .apks/.xapk split package" (`81-83`).
5. `zip.read` + `parseAxml` (`85-86`).
6. `package`: **looked up without a namespace first** (`88`, `attrValue(manifest,'package',null)`), then falling back to the default namespace.
7. `versionName` defaults to `'1.0'`; `versionCode` only accepts a number (`91-93`).
8. `uses-sdk`'s `minSdkVersion` / `targetSdkVersion` are normalized with `| 0` (`95-97`) — `null | 0 === 0`.
9. The first `application` node is taken, defaulting to an empty object (`99`).
10. Resource table: `ResTable` is constructed only when `resources.arsc` exists, **all inside try/catch** (`103-105`) → if arsc is broken `res=null`, and every later `refId` resolution fails and gracefully falls back to defaults.
11. App name (`108-117`): `attr(app,'label')` → `res.resolve(refId,'string')` → otherwise if `typed` is a string use it → otherwise **capitalize the last segment of the package name**.
12. Launch Activity (`120-134`):
    - candidates = `activity` + `activity-alias` (`121`)
    - `isLauncherActivity` (`15-25`): **within the same `intent-filter`** both `android.intent.action.MAIN` and `android.intent.category.LAUNCHER` must be present (not combined across filters)
    - name completion: starts with `.` → `package + n`; contains no `.` → `package.n`; otherwise as-is (`127-129`)
    - for `activity-alias` with a `targetActivity` it is **overwritten** with the target (`130-132`; the test uses the node name `launcher.name === 'activity-alias'`)
13. Icon (`137-152`): `icon` first, `roundIcon` as fallback (`138`) → `res.resolve(refId,'file')` or the `typed` string → validated with `zip.has(file)` → `.xml` goes to `iconFromAdaptiveXml`, otherwise `zip.read(file)` → finally, if `!icon`, `pickIconFromZip`.
14. ABI (`155-158`): take the entries prefixed `lib/`, extract the second segment and deduplicate.
15. Return object (`160-174`).

**`iconFromAdaptiveXml(zip, xmlBuffer, res)` (`apk.js:51-73`)**
- Parses the adaptive-icon XML, looking for **direct children** in the order `['foreground','background','monochrome']` (`58-60`); it also accepts the root node itself being one of them (the second half of `60`)
- Reads `android:drawable`: `refId` → `res.resolve(...,'file')`, otherwise the `typed` string (`62-66`)
- **Accepts only `.png`/`.webp`** (`67`) and requires `zip.has(file)` (`68`); returns only when `data.length > 100` (`70`)
- It does not recurse into `<inset>`, `<layer-list>` or `<bitmap>`; a parse failure of the XML itself returns null (`53-57`)

**`pickIconFromZip(zip)` (`apk.js:27-48`, heuristic fallback)**
- Candidates: `/^res\/.*\.(png|webp)$/i` (`29`)
- Score = `entries.get(n).uncompSize` **the uncompressed byte count** (not pixel dimensions), multiplied by a name weight:
  - `ic_launcher|app_icon|ic_app` ×6 (`33`)
  - `_round|_foreground|_background` ×0.4 (`34`)
  - `xxxhdpi` ×1.6 / `xxhdpi` ×1.4 / `xhdpi` ×1.2 (`35-37`)
- After sorting descending it tries only the first 30 (`41`) and accepts one only when `data.length > 100` (`44`), otherwise null.

### Pitfalls and invariants
1. **Whole-package `readFileSync` (`apk.js:78`)**: parsing a 500MB APK makes the process hold 500MB resident; `>2GB` fails outright with `ERR_FS_FILE_TOO_LARGE`. For `.apks`/`.xapk` via `installer.parseBundle` it is worse (the outer ZIP is also read whole, then each split is written to disk and `parseApk`'d separately).
2. **The `iconPng` field name lies**: `apk.js:172` returns **the raw icon bytes**, which may be WebP (`res/mipmap-*/ic_launcher.webp`). That is why `shortcut.iconToIco` needs the three-level fallback, and why `installer.js:208-209` saving it as a `.png` means "file named .png, contents possibly WebP" — Chromium/nativeImage detects by magic bytes and displays it, but external tools will disagree.
3. **`launchActivity` is only "what the APK declares"**: `installer.js:227-234` explicitly comments that "the main Activity parsed from the APK is often not the real LAUNCHER entry", and after installation it is overridden by `client.resolveLauncher(pkg)`. **Do not add launch logic here.**
4. **Target handling for `activity-alias`**: `130-132` uses `launcher.name` (the tag name); if the same activity is both aliased and declared for real, the first match wins — the order is `activity` first, `activity-alias` second (`121`).
5. **`apk.js:38` in `pickIconFromZip`** is leftover dead code: `if (/\//.test(n.split('/')[1] || '')) { /* noop */ }` does nothing and is safe to delete.
6. **Scoring uses `uncompSize`**: a "high compression ratio, very large pixel" image (a solid-color splash screen) can rank low because it compresses well; solid-color icons can also outrank photos. That is an inherent flaw of the heuristic.
7. **`label` fallback**: `a.b.c` → `C`, so the package `com.example.game` displays as `Game`. Chinese apps degrade to an English segment when arsc parsing fails — an acceptable fallback.
8. **`res` being null never throws**; `label`/`icon` both fall back to defaults — this tolerance path makes "the ARSC parser is broken" look like "the icon got ugly and the name is English" rather than an error. When debugging, first check whether `iconFile` came from the fallback.
9. `quickCheck` (`178-188`) **has no caller inside `src/`** (only tests use it) — dead code; the `apk:parse` IPC channel (`main.js:756`) is only exposed by `preload.js:10` and is not consumed by `src/ui/app.js` (the UI actually goes through `installApk`, `ui/app.js:484`).

### Call sites
- `parseApk`:
  - `src/main.js:14` (require), `main.js:756` (IPC `apk:parse`)
  - `src/preload.js:10` (`window.apkstart.parseApk`)
  - `src/core/installer.js:11` (require), `installer.js:40` (finding the base APK in a split package), `installer.js:149` (main install path)
  - `scripts/selftest.js:18`, `142`
  - Tests: `test/run-tests.js:82`, `106`; `test/electron-integration.js:24`, `55`
- `quickCheck`: **used only in `test/run-tests.js:103-104`**
- Indirect (`installer.install`): `src/main.js:758` (IPC `apk:install`) ← `src/ui/app.js:484`

### Test coverage
- `test/run-tests.js:103` "quickCheck recognizes the PK header"
- `test/run-tests.js:107` "parses package name / version / launch Activity" — asserts `package` matches `^[\w.]+$`, that `versionName` exists, and that `launchActivity` contains `.`
- `test/run-tests.js:113` "parses a usable icon" — `iconPng.length > 100` and a non-empty `label`
- All three **depend on a real APK fixture** and the whole section is skipped without one (`run-tests.js:130-132`) → effectively untested on CI
- `test/electron-integration.js:54-62` runs "APK icon → multi-size ICO" on a real APK; on failure the log says "the icon may be in a format other than webp/jpg"
- Gaps: no case at all for `.apks`/`.xapk` (`installer.parseBundle`); the negative cases (activity-alias, no arsc, no icon) are untested

---

## 6. `src/core/shortcut.js`

### Responsibility
Converts the APK icon into a multi-size ICO and writes the Windows desktop/Start-menu `.lnk`; the three-level fallback guarantees the shortcut **always** has an icon.

### Public interface
```js
const {
  pngToIco, pngBytesToIco, iconToIco,
  writeShortcut, removeShortcut, safeFileName, ICO_SIZES,
} = require('./shortcut');

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]   // 9 sizes, exported but no external consumer in the project

pngToIco(pngBuffer)                  // → Buffer(ICO, multi-size DIB) | null; ★ requires ('electron') internally, throws TypeError under plain Node
pngBytesToIco(png)                   // → Buffer(ICO, single-size PNG-in-ICO) | null; works under plain Node
iconToIco(raw, { decode } = {})      // async → Buffer(ICO) | null; three-level fallback
writeShortcut({                      // → string (the shortcutPath written)
  shortcutPath, target, args?, iconIcoPath?, description?, cwd?, appUserModelId?,
})                                   // throws on failure (three error messages below)
removeShortcut(p)                    // → boolean, swallows exceptions
safeFileName(name)                   // → string, replaces illegal chars + collapses whitespace + truncates to 60 chars, 'Android App' if empty
```

### Key internals

**`buildDib(bgra, size)` (`shortcut.js:13-33`)**
- Hand-written 40-byte `BITMAPINFOHEADER`: `biSize=40`, `biWidth=size`, `biHeight=size*2` (XOR + AND sections), `biPlanes=1`, `biBitCount=32`, `BI_RGB`, `biSizeImage=size*size*4` (`14-21`)
- The XOR bitmap has its **row order flipped bottom-up** (`25-28`; ICO/DIB y-axis points up)
- The AND mask is 1bpp, rows padded to 4 bytes, **all zero** (`30-31`, the comment says "leave it to the alpha channel")

**`pngToIco(pngBuffer)` (`shortcut.js:39-73`) — the multi-size DIB route**
- `require('electron')` inside the function (`40`), `nativeImage.createFromBuffer`; returns null when `isEmpty()` (`41-42`)
- For each of the 9 sizes: `resize({quality:'best'})` → `buildDib(img.toBitmap(), s)` (`45-51`)
- `img.toBitmap()` on Windows is **BGRA**, exactly the order DIB needs, so no channel swap
- ICONDIR: `reserved=0, type=1, count=n`, each entry 16 bytes: `width/height` u8, `colorCount=0`, `reserved=0`, `planes=1`, `bitCount=32`, `bytesInRes`, `imageOffset` (`53-72`)
- **Width/height bytes are written as 0 when `>=256`** (`61-62`) — a single-byte 0 in an ICO directory means 256

**`pngBytesToIco(png)` (`shortcut.js:83-101`) — the PNG-in-ICO route**
- Validation: a `Buffer`, `length >= 24`, and `[1,4)` is `'PNG'` (`84`); reads BE `w@16`, `h@20` from IHDR, requires `w/h` non-zero and `<= 1024` (`85-87`)
- The ICONDIR is a fixed 22 bytes (6 + 16), `bytesInRes = png.length`, `imageOffset = 22` (`88-99`); the data area **is the original PNG bytes** (no re-encoding, no alpha loss)
- Valid since Vista, hence the comment that "the old DIB route would fail outright here" (`80-82`)

**`iconToIco(raw, {decode})` (`shortcut.js:109-133`), three-level fallback**
1. `nativeImage.createFromBuffer(raw)` can decode it (real PNG/JPEG) → `img.toPNG()` → `pngToIco` (`111-118`). **`toPNG()` is required** because raw may be JPEG and the DIB needs pixels.
2. A `decode` callback exists → `await decode(raw)` yields a PNG → `pngBytesToIco` (`120-126`). WebP goes through here (Chromium does the decode).
3. Placeholder: `drawAppIcon(256)` → `pngBytesToIco` (`127-132`)
4. Returns null if everything fails

**`writeShortcut(opt)` (`shortcut.js:144-169`)**
- Creates the directory with `mkdirSync(recursive)` if missing; throws "shortcut directory is not writable" on failure (`146-151`)
- **An existing .lnk is `unlinkSync`ed first** (`152-154`)
- `shell.writeShortcutLink(path,'create',{target,args,icon,iconIndex:0,description,cwd,appUserModelId})` (`155-163`); `icon` defaults to `target`
- Returns false → throws "failed to create shortcut" (`164`)
- **Read-back check**: `fs.existsSync(shortcutPath)` false → throws "shortcut was not written to disk" (`165-167`) — the comment (`138-141`) records this pitfall: security software blocking it, or the desktop redirected to a network drive that is not signed in, produces "returns true but the file does not exist".

**`safeFileName` (`shortcut.js:75-77`)**
`[\\/:*?"<>|]` → `_`, `\s+` → space, trim, `slice(0,60)`, `'Android App'` if empty. Windows reserved names (CON/PRN/NUL…) are **not handled**.

### Pitfalls and invariants
1. **`pngToIco` cannot run under plain Node**: `require('electron')` in Node returns the **path string** of electron.exe, so the destructured `nativeImage` is `undefined` and `createFromBuffer` throws a TypeError (there is no try/catch inside the function). That is why every `pngToIco` case lives in `test/electron-integration.js` (run with `electron test/...`) while `npm test` only covers `pngBytesToIco`/`iconToIco`.
2. **Both branches of the ternary at `shortcut.js:46-48` are identical code** (only the comments differ), equivalent to an unconditional `resize`. It is "a comment explaining a branch that does not exist" and can be cleaned up. The real intent the comment expresses is: **upscaling a small image beats a missing size** (a 64px icon interpolated to 256px looks fuzzy but never leaves an empty icon slot).
3. **The size invariant of `pngBytesToIco`**: directory width/height are single bytes, `>=256` is written as 0 (=256). If you pass a 512×512 PNG the directory **claims 256 while the data is 512**, and some shells refuse to display it. Today the callers guarantee this: `decodeIcon` at `main.js:223` clamps with `Math.min(256, ...)` and `pngToIco` also tops out at 256. **The constraint is implicit and is the easiest thing to trip over when adding a caller.**
4. **The DIB AND mask is all zero**: it relies on the 32bpp alpha channel. Old XP-era shells handle 32bpp alpha inconsistently, but Win10/11 is fine.
5. **`writeShortcut` deletes then recreates**: this loses properties such as "Pin to taskbar" and "Run as administrator" on the old .lnk. `installer.createShortcut` rebuilds on every reinstall, so user-pinned entries may be lost (pins are by AUMID, so they usually recover).
6. **`icon: opt.iconIcoPath || opt.target`**: when ICO generation fails the exe icon is used, so there is never a "blank page" icon.
7. **`appUserModelId` is optional** (`162`); `installer.js:299` passes one AUMID per app to group taskbar buttons — the comment is at `installer.js:299`, `writeShortcut` only passes it through.
8. `removeShortcut` swallows all exceptions and returns false; `installer.uninstall` ignores the return value (`installer.js:373-374`).

### Call sites
- `pngToIco`: `src/main.js:1310` (require), `1311` (computed on demand when the brand ICO is missing); `shortcut.js:115` (inside `iconToIco`); `test/electron-integration.js:23`, `29`, `56`
- `pngBytesToIco`: `shortcut.js:123`, `129`; `test/auto-test.js:495`, `498`, `502`
- `iconToIco`: `src/core/installer.js:13` (require), `212` (at install time), `346` (when backfilling icons); `test/auto-test.js:495`, `505`, `507`
- `writeShortcut`: `installer.js:13`, `292` (`createShortcut`); `test/electron-integration.js:23`, `35`
- `removeShortcut`: `installer.js:13`, `373`, `374` (uninstall)
- `safeFileName`: `installer.js:13`, `75` (desktop path), `88` (Start-menu path), `319` (fallback path)
- `ICO_SIZES`: used only at `shortcut.js:45`; exported with no external consumer
- Call context: `ctx.decodeIcon` is defined at `main.js:213` and injected into `Installer` at `main.js:1498`

### Test coverage
- `test/auto-test.js:494` "PNG-in-ICO and the WebP icon fallback both produce a usable ICO" — asserts the ICO header `type=1/count=1`, that `bytesInRes` equals the PNG length, that `ico.slice(22)` is exactly the original PNG, that illegal input returns null, that WebP without decode falls back to the placeholder, and that WebP with decode uses the real image. **This is the best-covered case in the file.**
- `test/electron-integration.js` (`electron test/electron-integration.js`, **not part of `npm test`**): steps "generate ICO", "create .lnk", "delete .lnk", "APK icon → multi-size ICO", with results written to `test/out/result.json`.
- Gaps: no assertion on the DIB byte structure of `pngToIco` (the Electron integration only checks "it generates and is >1000 bytes"); `safeFileName` has no unit tests for reserved names/over-long/illegal characters; the "returns true but nothing on disk" branch of `writeShortcut` cannot be constructed in a test.

---

## 7. `src/core/assoc.js`

### Responsibility
Registers/unregisters the `.apk` file association under `HKCU\Software\Classes` (no admin rights needed): double-clicking an APK → `apkstart.exe "%1"`.

### Public interface
```js
const { registerAssociation, unregisterAssociation, PROGID } = require('./assoc');
PROGID = 'ApkStart.apk'

registerAssociation(exePath /*: string, required */, iconPath /*?: string */, extraArgs /*?: string */)
  // → { ok: true, progId: 'ApkStart.apk' }   ★ always ok:true, even if every reg call failed
unregisterAssociation() → { ok: true }        // same as above
```

### Key internals
- `reg(args)` (`assoc.js:11-18`): `execFileSync('reg', args, {windowsHide:true, stdio:'pipe'})`, **all exceptions swallowed and false returned**, never propagated. → Every registry write is "best effort" and the caller gets no failure information.
- `notifyShell()` (`assoc.js:20-33`): PowerShell `Add-Type` + P/Invoke calls `SHChangeNotify(0x08000000=SHCNE_ASSOCCHANGED, 0, NULL, NULL)` so Explorer refreshes icons/associations; `timeout: 8000`, failures ignored (comment at `32`).
- `registerAssociation` (`assoc.js:40-56`) writes 6 entries:
  1. `HKCU\Software\Classes\.apk` default value = `ApkStart.apk`
  2. `.apk\OpenWithProgids` gains `ApkStart.apk` (empty `REG_NONE` value, `46` — the correct way to appear in the "Open with" list)
  3. `ApkStart.apk` default value + `FriendlyTypeName` = "Android app package"
  4. `DefaultIcon` = `"<icon>",0`
  5. `shell\open` default value = "Install into ApkStart"
  6. `shell\open\command` = `"<exePath>" <extraArgs> "%1"` (`43`)
- `command` assembly (`assoc.js:43`): **the caller is responsible for quoting `extraArgs`** (dev mode passes the app directory). Actual call sites: `main.js:1315` passes `l.args` (`launcherInfo()` already quotes it) and `scripts/assoc.js:22` passes `"<appDir>"`.
- `unregisterAssociation` (`assoc.js:58-66`): delete the value under `OpenWithProgids` → delete the whole `ApkStart.apk` subtree → **unconditionally** set the `.apk` default to empty → notify the shell.

### Pitfalls and invariants
1. **★★ Comment and implementation disagree (a real defect)**: `assoc.js:62` says "only clear the default value when .apk still points at us", but `assoc.js:63` is `reg(['add', ...EXT, '/ve', '/d', '', '/f'])` **with no condition at all**. Consequence: a user who had `.apk` associated with another unpacking tool (or the system default "unknown type") loses that association after unregistering, with no backup or restore. Fix: `reg query` the current default first and clear it only when it equals `PROGID`.
2. **The return value carries no information**: `registerAssociation` always returns `ok:true`, so the IPC at `main.js:1315` cannot tell "success" from "everything blocked by policy". A success toast in the UI would be a lie.
3. **`notifyShell` depends on PowerShell + `Add-Type`**: on machines without PowerShell or with a restricted policy it fails silently and the association is not refreshed (the user must sign out/in or refresh manually). The `timeout: 8000` blocks the main process synchronously — up to 8 seconds of stall.
4. **Quoting `extraArgs` is the caller's job** (`assoc.js:43`); passing an unquoted path containing spaces builds a broken command line.
5. Only HKCU is written, never HKLM — that is the key to "no admin needed", and it also means **every user on a multi-user machine must register separately**.
6. `PROGID` is hardcoded to `'ApkStart.apk'` and forms a registry contract together with `EXT='.apk'`; renaming it leaves residues from older versions that `unregisterAssociation` cannot clean (it only deletes the `PROGID` subtree).

### Call sites
- `registerAssociation`: `src/main.js:30` (require), `main.js:1315` (IPC `assoc:register`); `scripts/assoc.js:10`, `21`
- `unregisterAssociation`: `main.js:1318` (IPC `assoc:unregister`), `main.js:1351` (inside the uninstall flow, in `try/catch`); `scripts/assoc.js:26`
- `PROGID`: `main.js:1297` (`assoc:status` checks whether the `reg query` output contains it)
- UI: `src/ui/app.js:754-755` consumes only the `registered` field of `assoc:status`

### Test coverage
**None.** `grep -r assoc test/` has zero hits; `auto-test.js` / `engine-test.js` / `run-tests.js` have no registry cases (they would change state). `scripts/assoc.js` is a manual toggle. This is the only module in the group with **no automated verification at all**.

---

## 8. `src/core/version.js`

### Responsibility
Version comparison. Split into a small module **to avoid the `updater` ↔ `sources` circular dependency** (comment at `version.js:3`).

### Public interface
```js
const { parseVer, cmpVer } = require('./version');

parseVer(v)     // → Array<number|string>: strips the 'v' prefix, splits on [.+-], numeric segments become Number, empty segments filtered
cmpVer(a, b)    // → 1 (a>b) | -1 (a<b) | 0 (equal)
```

### Key internals
- `parseVer` (`version.js:7-13`): `String(v||'')` → `replace(/^v/i,'')` → `split(/[.+-]/)` → numeric segments become `Number`, other segments stay strings → `.filter(x => x !== '')`.
  - `'v0.3.2'` → `[0,3,2]`; `'0.3.2-preview'` → `[0,3,2,'preview']`; `'1.0.0+build'` → `[1,0,0,'build']`.
- `cmpVer` (`version.js:16-34`): iterates up to the longer length; **whichever side runs out first is smaller** (`23-24`); two numbers compare numerically, otherwise `String()` lexicographic order (`25-31`).

### Pitfalls and invariants
1. **`cmpVer('1.0','1.0.0') === -1`, not 0** (the semantics of `23-24`). Used in `updater.hasUpdate` (`updater.js:109`), "current 1.0 / remote 1.0.0" is judged as an update — versions are always three segments today so it has never triggered, but **do not use this for an equality test**.
2. **It is not semver**: pre-release segments compare as strings → `'preview' > 'beta'` (lexicographic), `'rc1' > 'rc'`; `1.0.0+build` is **greater than** `1.0.0` because it has an extra segment (semver says build metadata should be ignored). That is good enough for "sorting GitHub/Gitee release tags".
3. Numeric segments use `Number()`, so `'01'` equals `'1'`; `'1.10' > '1.9'` is correct (numeric comparison).
4. An empty string / `null` → `[]`, which compares as `-1` against any non-empty version.
5. The module is deliberately dependency-free (only two pure functions); any dependency added on either side reintroduces the cycle.

### Call sites
- `cmpVer`:
  - `src/core/provision.js:17` (require), `513` (`cands.sort((a,b) => cmpVer(b.tag, a.tag))`, picking the image version)
  - `src/core/sources.js:20` (require), `299` (release list sorted by tag descending)
  - `src/core/updater.js:22` (require), `109` (`hasUpdate: cmpVer(merged.tag, this.current) > 0`), `333` (**re-export** of `cmpVer`, so consumers of `updater.js` can bypass version.js)
- `parseVer`: only `version.js:17-18` (inside `cmpVer`)
- Tests: `test/auto-test.js:821` imports it from `../src/core/updater` (through the re-export), not from `version.js` directly

### Test coverage
- `test/auto-test.js:820` "version comparison compares numerically segment by segment; the v prefix and extra segments work" — 4 assertions: `v0.3.2 > 0.3.1`, `v` prefix equality, `0.10.0 > 0.9.9` (guarding against string comparison), `1.0.0 < 1.0.1`.
- Gaps: `1.0` vs `1.0.0`, pre-release segments, `+build`, empty values are all untested.

---

## 9. `src/core/logfile.js`

### Responsibility
Lightweight log append + size-based rotation (keeping a single `.1.log` backup), preventing `app.log` / `emulator.log` from growing without limit and eating disk space.

### Public interface
```js
const { append, rotate, trimNow } = require('./logfile');

append(file, line, limitKB = 2048)   // → boolean (true = written; any exception false, logging never throws)
rotate(file, limitKB)                // → boolean (true = a rotation ran this time)
trimNow(file, limitKB = 2048)        // → boolean (= rotate, but bypasses the counter; ★ no caller in src)
```

### Key internals
- Motivation comment (`logfile.js:4-9`): the emulator writes tens of KB of kernel log per boot; a dozen restarts a day plus qemu verbose output → hundreds of MB in a few months.
- `counters = new Map()` (`13`): counts **per process** by file path, not shared across processes.
- `rotate(file, limitKB)` (`15-26`):
  - `statSync` failure (file missing) → catch returns false (`23-25`)
  - `size < limitKB*1024` → false (`18`), i.e. **it rotates only once the limit is exceeded**
  - Backup name: `file.replace(/\.log$/i, '.1.log')` (`19`); `rmSync(bak,{force:true})` then `renameSync(file,bak)` → there is only ever one backup
- `append(file, line, limitKB)` (`33-45`):
  - `mkdirSync(dirname, {recursive:true})` (`35`, guaranteeing the directory even when only logging)
  - Increments the counter; `rotate` runs **only when `n===1` (first time in the process) or `n%200===0`** (`39`; comment at `38`: `statSync` is cheap but pointless on every line)
  - `appendFileSync(file, line.endsWith('\n') ? line : line+'\n')` (`40`, adding the newline automatically)
  - Lower-bound clamp: `Math.max(256, Number(limitKB) || 2048)` (`39` / `49`) — the limit is at least 256KB
  - The whole function is in try/catch and returns false on failure (`41-44`)

### Pitfalls and invariants
1. **★ Logs are lost when the filename does not end in `.log`**: `bak === file`, so `rmSync(bak)` deletes the file, `renameSync` then fails with ENOENT and the function returns false, **with the original log already gone**. Both current callers pass `*.log` (`app.log`, `emulator.log`) so it has never blown up; any new caller must respect the implicit contract "the filename ends in .log".
2. **Rotation happens before append** (`39` is before `40`): the new file is written immediately after rotating, so logs stay continuous and "the line that triggered the rotation" is not lost.
3. **The counter is per process**: the main process restarts at 1 → one `statSync` on every start, which is correct behavior (and means **a long-running process can miss up to 199 lines** between checks).
4. **No lock for multiple writers**: if the main process and a (future) child process write the same file, `rotate` races (A deletes the backup, B deletes it too, A's rename succeeds, B's rename fails → B's log lands in the new file, which is acceptable in practice).
5. **`limitKB` means "rotation threshold", not "hard cap"**: a single `line` can be arbitrarily long (the emulator writes tens of KB of boot output at once), so the file can still far exceed the threshold until the next check.
6. **`trimNow` is dead code** (`48-50`, zero callers project-wide): it was meant for "clean up at startup", but the `n===1` branch of `append` already covers that.
7. Callers pass inconsistent `limitKB`: `main.js:84` uses `settings.engine.logLimitKB`, while `emulator.js:576` uses `logLimitKB * 4` (plus another `Math.max(2048, ...)`) — the same setting is amplified 4× in one place, worth remembering when reading the number on the settings page.

### Call sites
- `append`:
  - `src/main.js:85` (`appLog()`, `limit = store.getSettings().engine.logLimitKB || 2048`, see `main.js:84`)
  - `src/core/emulator.js:577` (`_logWrite()`, `limit = max(2048, logLimitKB*4)`, see `emulator.js:576`)
  - Note that both do a **function-scoped `require('./logfile')`** (lazy load), not a top-level import
- `rotate`: `logfile.js:39` (itself), `test/auto-test.js:1408`
- `trimNow`: none
- Tests: `test/auto-test.js:1405`

### Test coverage
- `test/auto-test.js:1404` "the log rotates automatically once over the limit, keeping one backup" — writes 300KB, calls `rotate(f,256)`, asserts the file became `rot.1.log`.
- Gaps: the counter/auto-rotation path of `append` (`n===1`, `n%200`) is untested; `trimNow` is untested; the data-loss path for non-`.log` filenames is untested.

---

## 10. Appendix: `src/core/display.js` (another small pure utility module)

Although it is not part of the parsing chain, it is the other "zero-dependency, pure-computation, unit-testable" small module in `src/core`, and worth knowing about when taking over.

- **Responsibility**: pure display-fit math (no Electron/adb dependency): the window rectangle and Android resolution for fullscreen/windowed modes (`display.js:2-6`).
- **Interface**: `densityFor(w,h,manual)` → number (clamped to 120..640 when manual>0, otherwise `min(w,h)/2.57` clamped to 200..480, `7-10`); `portraitSize(str)` → `{w,h}` (regex `^(\d{3,4})x(\d{3,4})$`, falling back to `900x1600` when not portrait or out of range, `12-18`); `defaultBounds(area)` → `{x,y,w,h}` (84% height, width = height·9/16, centered, `20-28`); `fullscreenBounds(portrait,area)` (full height, width from the portrait ratio, horizontally centered, `36-46`); `sizeFor(mode,portrait,area)` (`55-57`).
- **Key pitfall**: `sizeFor` **ignores the `mode` parameter entirely** (`55-57`, always returns the portrait preset). That is not a bug: the comment (`48-54`) explains that the emulator window's aspect ratio is locked by the LCD at boot, and changing the Android resolution would distort the picture; "fullscreen" only maximizes the window.
- **Call sites**: `src/main.js:32` (require), `main.js:276` (`display.portraitSize(d.portrait || '540x960')`); tests at `test/auto-test.js:465`.
- **Tests**: `auto-test.js:465` "display fit: window/fullscreen share the portrait resolution; the window keeps a stretchable 9:16 ratio", covering `sizeFor`/`defaultBounds`/`fullscreenBounds`/`densityFor`.

---

# 11. Offline parsing stack overview

## 11.1 Entry points and call chains

**Four entry points**
| Entry | Chain |
|---|---|
| UI parse preview | `ui/app.js` → `preload.js:10` `parseApk` → `main.js:756` `apk:parse` → `parseApk` |
| UI install (the real main path) | `ui/app.js:484` `api.installApk` → `main.js:758` `apk:install` → `installer.install` (`installer.js:141`) → `parseApk` (`149`) or `parseBundle` (`146`) |
| Double-click an .apk (file association) | the `command` written by `assoc.js` → `apkstart.exe "%1"` → `main.js:206` `parseArgs` recognizes `.apk` → install flow |
| Command-line self-check | `scripts/selftest.js:142` → `parseApk` |

**Text version of the call chain starting at `parseApk(filePath)`**

```
parseApk(filePath)                                   apk.js:75
├─ fs.statSync(filePath)                            apk.js:76   → sizeBytes
├─ fs.readFileSync(filePath)                        apk.js:78   ← [whole package into memory]
├─ new ZipArchive(buf)                              apk.js:79   → zip.js:13
│  ├─ _parse()                                      zip.js:20
│  │  ├─ backwards EOCD scan (65557B window)        zip.js:23-26
│  │  ├─ total@+10 / cdOffset@+16                   zip.js:29-30
│  │  └─ central-directory loop → entries (Map)     zip.js:32-47
│  ├─ has('AndroidManifest.xml')                    apk.js:81   (missing → throw "may be .apks/.xapk")
│  ├─ read('AndroidManifest.xml')                   apk.js:85   → zip.js:54 (inflateRawSync)
│  └─ (images are read only for the icon fallback)  apk.js:43
├─ parseAxml(manifestBuf)                           apk.js:86   → axml.js:67
│  ├─ readStringPool (UTF-8/UTF-16 branches)        axml.js:88  → 26
│  ├─ START_ELEMENT + attr×N (20B each, base +16)   axml.js:98-140
│  └─ returns the manifest node                     axml.js:147
├─ attrValue(manifest,'package', ns=null)           apk.js:88
├─ new ResTable(zip.read('resources.arsc'))         apk.js:104  → arsc.js:79 (try/catch, failure → null)
│  ├─ global string pool (first one only)           arsc.js:99-100
│  ├─ packages[].types: Map<typeId, config[]>       arsc.js:101-103 / 141
│  └─ resolve(ref, 'string'|'file')                 arsc.js:200 → score() picks the config
│     ├─ label:  resolve(labelRef,'string')         apk.js:111
│     ├─ icon:   resolve(iconRef,'file')            apk.js:141
│     └─ adaptive: iconFromAdaptiveXml → parseAxml → resolve → zip.read   apk.js:51-73
├─ isLauncherActivity(activity|activity-alias)      apk.js:122 → 15
├─ !icon → pickIconFromZip(zip)                     apk.js:152 → 27 (name + uncompSize scoring)
├─ abis = lib/<abi>/ in zip.names(), deduplicated   apk.js:155
└─ return { package,label,versionName,versionCode,minSdk,targetSdk,
            launchActivity,abis,iconPng,iconFile }  apk.js:160-174

──────────────────── installer side (metadata → icon → ICO → .lnk) ────────────────────

installer.finishInstall(rt, meta, ...)               installer.js:179
├─ store.iconPath(pkg) → write <ICON_DIR>/<pkg>.png  installer.js:208-209 (contents may be WebP!)
├─ iconToIco(meta.iconPng, {decode: ctx.decodeIcon}) installer.js:212 → shortcut.js:109
│  ├─ (1) nativeImage.createFromBuffer → pngToIco     shortcut.js:112-116 → 39
│  │     └─ resize ×9 (16..256) → buildDib → ICONDIR  shortcut.js:13 / 45-72
│  ├─ (2) decodeIcon(raw) (hidden BrowserWindow+canvas) main.js:213-229
│  │     └─ canvas.toDataURL('image/png') → pngBytesToIco  shortcut.js:83
│  └─ (3) drawAppIcon(256) → pngBytesToIco            shortcut.js:127-129 → png.js:80
├─ write <ICON_DIR>/<pkg>.ico                        installer.js:214-215
├─ store.upsertApp(app)                              installer.js:259
└─ createShortcut(app)                               installer.js:265 / 286
   ├─ safeFileName(label) → desktop / Start-menu paths installer.js:75 / 88
   └─ writeShortcut({target,args,iconIcoPath,...})   installer.js:292 → shortcut.js:144
      └─ shell.writeShortcutLink + fs.existsSync read-back shortcut.js:155-167
```

## 11.2 Memory and time profile

| Stage | Data shape | Peak cost |
|---|---|---|
| `readFileSync` (`apk.js:78`) | Buffer of the whole APK | ≈ file size (500MB APK → 500MB) |
| `ZipArchive._parse` | central-directory metadata `Map` | ~100B per entry; 10k entries ≈ 1MB |
| `zip.read(manifest)` | inflate result | manifests are usually tens of KB |
| `zip.read(resources.arsc)` | inflate result | a few MB (10MB+ for big-vendor apps) |
| `ResTable._parse` | the `packages[].types` Map tree | proportional to the resource count; a few MB to a dozen MB for 100MB-class apps |
| `zip.read(icon)` | raw icon bytes | usually < 1MB (a xxxhdpi webp is tens of KB) |
| Overall | the old Buffer is never collected (`zip.buf` holds it) | **the full APK stays resident until parsing ends** |

Time: a normal APK (50MB class) takes ≈ 100–300ms, mostly in `inflateRawSync(resources.arsc)` and the `ResTable` entry walk; `drawAppIcon(256)` is on the order of 10ms (and `main.js:175` computes it once at startup and caches it).

## 11.3 The most fragile, most refactor-worthy spots (ordered by benefit/risk)

1. **`parseApk` reads the whole package into memory (`apk.js:78`) — fix this first**
   The existing `ZipFile` can already read just the central directory plus entries on demand, and `provision.js:594-595` is the precedent for ">64MB uses ZipFile". Changing `parseApk` to `new ZipFile(filePath)` and reading only `AndroidManifest.xml` / `resources.arsc` / the icon drops peak memory from "file size" to "a few MB" and sidesteps the 2GB Buffer cap. The change is confined to `apk.js:75-175` plus one `finally close()`, and can be copied into `installer.parseBundle` (which also does a whole-package `readFileSync` at `installer.js:27`).
   Note that the null semantics of `zip.read` differ between the two classes (`ZipArchive` returns null / `ZipFile` throws), so add `has()` checks when swapping.

2. **No Zip64 (`zip.js:29-30`, `37`, `161-162`, `180`)**
   When entries exceed 65535, a single entry exceeds 4GiB, or the EOCD has `cdOffset === 0xffffffff`:
   - `ZipArchive`: `zip.js:30` gets `offset = 0xffffffff`, and `zip.js:33`'s `readUInt32LE(offset)` then throws a `RangeError` straight out of the constructor (the message has nothing to do with "not a valid ZIP", which makes it hard to diagnose);
   - `ZipFile`: `cdOffset > eocdAbs` hits `zip.js:166-169`, `len` goes negative → throws "ZIP central directory offset anomaly"; with `total === 0xffff` only the first 65535 entries are parsed and the rest are **silently dropped**.
   APKs themselves are rarely >4GB, but **system images and update packages** (`provision.js` / `updater.js` share this code) will hit it eventually. Fix: when the EOCD shows `0xffff/0xffffffff`, locate the Zip64 EOCD (`0x06064b50`) and Zip64 locator (`0x07064b50`) and replace `compSize/uncompSize/localOffset/cdOffset/total` with u64 values (`readBigUInt64LE` then convert to Number, keeping the 2^53 precision limit in mind).

3. **WebP decoding depends on a hidden Electron window (`main.js:213-229` + `shortcut.js:120-126`)**
   Many APK icons are WebP, which `nativeImage` cannot decode; the only option is to open a `BrowserWindow` + `canvas` + base64 (`raw.toString('base64')` spikes memory by ×1.33, then adds the data-URL string). Three problems:
   - Without a GUI / headless / outside Electron (the pure-Node `selftest`, tests) it **silently degrades to the brand placeholder**, so the user sees a green triangle instead of the real icon;
   - The `executeJavaScript` errors are not differentiated: a WebP decode failure and a window-creation failure both end up as "no icon";
   - Every call does an IPC-style round trip, an obvious serial bottleneck for batch installs.
   Suggestion: ship a minimal WebP decoder, or at least distinguish "placeholder" from "real decode failure" inside `iconToIco` and surface the reason in `installer`'s warnings so the UI can say "the icon could not be parsed".

4. **The icon format allowlist is too narrow (`apk.js:29`, `apk.js:67`)**
   Only `.png`/`.webp` are accepted. As a result, `.jpg`/`.jpeg` icons, `<inset>`/`<layer-list>`/`<bitmap>` combinations inside `<adaptive-icon>`, and shape resources under `drawable` all end up in the `pickIconFromZip` heuristic fallback and may pick a splash/background image (scoring only looks at `uncompSize` and the filename). Suggestion: add `jpe?g` to the candidates; recurse one level into XML to take the first `<bitmap android:src>`; score by the real pixel dimensions parsed from the PNG/WebP header (`png.js` has no decoder, but reading an IHDR/VP8 header is about a dozen lines).

5. **Config selection in `arsc.js` is heuristic (`arsc.js:65-77`)**
   `anydpi` −500, `language` −40, `sdkVersion/1000` are all arbitrary constants; there is no locale matching (Chinese apps may get English names) and no exact matching "by screen density". Moreover the three entry encodings (sparse / offset16 / u32) have **no tests at all** — if an Android toolchain version switches encodings, the symptom is "every icon and name suddenly reverts to defaults" without an error (the try/catch at `apk.js:103-105` swallows it into `res=null`).
   Suggestion: add synthetic byte cases for `ResTable` and move the `score()` constants into explicit configuration.

6. **The relative base of `attributeStart` has no guard at all (`axml.js:105-106`)**
   The line in the whole chain most likely to be broken by a "quick refactor", and breaking it **does not throw, it only misaligns**. Suggestion: add a hand-written 20-line minimal AXML byte case (string pool + one start element + two attributes) asserting that `attr()` can read `package` and `android:label`.

7. **`assoc.unregisterAssociation` unconditionally clears the `.apk` default (`assoc.js:62-63`)**
   The protection the comment promises does not exist and wipes the user's existing `.apk` association; the module has zero tests. Fix as described in section 7, pitfall 1.

8. **`logfile.rotate` deletes before rename for non-`*.log` filenames (`logfile.js:19-21`)**
   A single `bak === file` boundary is enough to lose logs; add an explicit `if (bak === file) return false;` guard.

9. **Two copies of the string-pool parser (`axml.js:26` / `arsc.js:23`)**
   The logic is identical (including the two-varint UTF-8 length, an easy place to make a mistake). Suggestion: extract it into `src/core/respool.js` so one fix applies in both places.

10. **Scattered dead code / unused exports** (cheap to clean, but they mislead newcomers)
    `quickCheck` (`apk.js:178`, tests only), `trimNow` (`logfile.js:48`, zero calls), the `TYPE_REFERENCE` export (`arsc.js:233`), the `ICO_SIZES` export (`shortcut.js:182`), the unused `ANDROID_NS` import (`apk.js:9`), the noop at `apk.js:38`, the identical ternary branches at `shortcut.js:46-48`, the unused `pkgCount` read at `arsc.js:92`, and the `apk:parse` IPC with no UI consumer (`main.js:756` + `preload.js:10`).

## 11.4 Test gap list (by risk)

`npm test` actually runs `node test/run-tests.js && node test/engine-test.js && node test/auto-test.js` (`package.json:37`); **`test/electron-integration.js` is not included** (run `electron test/electron-integration.js` manually).

| Gap | Impact |
|---|---|
| No synthetic byte cases for AXML / ARSC; the section is skipped when the real APK fixture is missing (`run-tests.js:130-132`) | On CI `axml.js`/`arsc.js`/`apk.js` have zero coverage |
| No assertion at all for `arsc.resolve()` | The three entry encodings + config scoring are completely unguarded |
| No case for `.apks` / `.xapk` (`installer.parseBundle`) | The split-package path relies entirely on manual verification |
| Zero coverage for `assoc.js` | Nobody would notice a wrong registry write or a wrong delete |
| `pngToIco` / `writeShortcut` only "run through" in the Electron integration, not in `npm test` | A green `npm test` does not mean ICO/.lnk work |
| The auto-rotation path of `logfile.append` is untested | Only a direct `rotate` call is tested |
| `safeFileName` / `cmpVer` boundaries are untested | Illegal filenames, `1.0` vs `1.0.0` |
| No negative cases for Zip64 / huge entries / truncated central directory | Large-file problems can only be reproduced in production |

---

*This document is a WIP: line numbers are based on the 0.3.4 snapshot; update it whenever you change the related files.*
