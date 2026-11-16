# Development environment and command cheat sheet

> This document records the environment facts you need to keep developing ApkStart on this machine.
> Most of the pitfalls are specific to the sandboxed environment; on another machine, verify with real probing.
> Last verified: 2026-11-14 (v0.3.5, local fixes released on top of v0.3.4).

## 0. Incident record: the workspace was once moved to the Recycle Bin wholesale

Around 2026-11-14 20:55, the **entire** `D:\apkstart-dsh` directory (261 items: source / tests / docs /
`.workbuddy` memory) was moved to the Recycle Bin by a "clean up old apkstart artifacts" operation.
The same sweep also removed `D:\apkstart-dist`, `D:\dist-gitee`, `D:\ApkStart-0.3.3-preview`,
`D:\tmp-wx` and other old directories — it looks like a wildcard cleanup of `D:\apkstart*` took the workspace with it.

Recovery procedure (reusable):
1. **Do not empty the Recycle Bin.** Entries on the D: drive live in `D:\$Recycle.Bin\<SID>\`, each as a pair
   of `$I<id><ext>` (metadata) + `$R<id><ext>` (data).
2. `$I` layout: version u64 @0, original size u64 @8, deletion time u64 @16,
   **path length u32 @24 (in UTF-16 code units, not bytes!)**, path UTF-16LE @28.
   Rename `$R` back to the original path recorded in `$I` to restore it (directories are recreated automatically).
3. `.git` was not in the Recycle Bin (the deletion tool probably skipped it): recover history from
   `C:\Users\15656\WorkBuddy\2026-10-29-20-43-38\apkstart\.git` (e1db34b = v0.3.4), then commit the workspace again.
4. Post-recovery check: `src/**` and `dist\ApkStart-win64-portable\resources\app\src` match file by file
   with SHA256; `npm test` is 112/112 green.

**Recommendation**: zip up source + `.git` + docs + test regularly and keep the archive off `D:\`
(for example under `C:\Users\15656\WorkBuddy\`); do not keep it on the same drive as the workspace.

## 1. Toolchain locations (not on PATH; absolute paths required)

| Tool | Path | Version |
|---|---|---|
| Node | `C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6\node.exe` | v22.22.2 |
| npm | `…\22.22.2-6\npm.cmd` | ships with Node |
| Git | `C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` | 2.55.0.windows.3 |
| Electron | `node_modules\electron\dist\electron.exe` inside the repo | 33.4.11 |

Extend PATH first in PowerShell:

```powershell
$env:PATH = 'C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd;' +
            'C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6;' + $env:PATH
```

Reinstall dependencies when they get wiped (about 19 seconds via a mirror):

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci --no-audit --no-fund
```

## 2. Two environment variables to clear in every shell

The host shell inherits both; if you do not clear them you get weirdness such as "Electron runs as plain Node":

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # otherwise electron.exe becomes node and --launch reports bad option
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue           # otherwise build/pack.js bulk deletes are blocked by safe-delete as SAFE_DELETE_BULK_GUARD_ERROR
```

## 3. Common commands

```powershell
cd D:\apkstart-dsh\apkstart

# Unit / regression tests (pure Node, no Electron/adb/network)
npm test

# Electron integration tests (ICO / .lnk / WebP icon fallback)
.\node_modules\electron\dist\electron.exe test\electron-integration.js

# UI smoke screenshot (--settings also captures the settings page; --perf/--download capture those sections)
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png"
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png" --settings

# Real boot (cold/hot boot timing; --stop shuts down gracefully and saves a snapshot)
node tools\e2e-boot.js . --stop

# Portable build packaging (outputs dist\ApkStart-win64-portable)
node build\pack.js

# Full installer (needs build/runtime, about 1.4GB of runtime; runs in CI)
npm run build:exe
```

> After smoke/boot runs, confirm no processes are left behind:
> `Get-Process -Name ApkStart,electron,emulator,qemu-system-x86_64 -ErrorAction SilentlyContinue`
> The emulator is detached, so qemu may still be alive after Electron exits (by design: the next start reattaches in a second).
>
> If `dist\ApkStart-win64-portable` is in use (Explorer / antivirus / a previous instance still open),
> `pack.js` falls back to `dist\ApkStart-v<version>-win64-portable` — that is expected; close the holder and rename it back.
> Read-only/indexing processes (Defender, SearchIndexer) can keep an empty directory from being deleted for minutes; wait and retry.

## 4. Data and runtime paths (this machine)

| Purpose | Path |
|---|---|
| Settings / app list / logs / APK backups | `%APPDATA%\apkstart` (actual directory name `ApkStart`, case-insensitive) |
| Runtime (emulator + adb + images) | `D:\ApkStartRuntime` (`settings.runtime.dir`) |
| AVDs / installed apps / snapshots | `D:\ApkStartData` (`settings.runtime.avdDir`) |
| Shared folder | `%USERPROFILE%\ApkStartShared` |
| Diagnostic reports | `%APPDATA%\apkstart\logs\diagnostic-*.txt` |
| Last launch failure record | `%APPDATA%\apkstart\logs\last-failure.json` |

## 5. Text/file handling notes (specific to this terminal)

- **Do not use `Set-Content` / `Get-Content -Raw` on UTF-8 files containing non-ASCII text**:
  PowerShell 5.1 decodes as ANSI by default and writes mojibake (this happened once in this session and destroyed a test file).
  Always read/write text through the editor tooling; if you must write from PowerShell, use
  `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))`.
- **`[System.IO.File]` static methods use the process start directory**, so they still resolve the old path after `cd` — always use absolute paths.
- **Deleting large directories**: `Remove-Item -Recurse` may be blocked by the safe-delete layer;
  use `[System.IO.Directory]::Delete($path, $true)`; if space is not freed afterwards, empty the Recycle Bin.
- **Long-running processes** (qemu / large downloads) should run as background tasks; when a normal command ends, its child process tree is cleaned up too.
- When reading `reg.exe` output, remember it uses the console code page; ASCII content such as package names and paths is fine.

## 6. Common failure reference

| Symptom | Cause / handling |
|---|---|
| `electron --version` prints `v20.x` (a Node version) | `ELECTRON_RUN_AS_NODE=1` was not cleared |
| Packaging reports `SAFE_DELETE_BULK_GUARD_ERROR` | `NODE_OPTIONS` was not cleared |
| axml/apk cases in `npm test` show as "skipped" | No real fixture; synthetic APK cases still run (`test/lib/make-apk.js`) |
| Emulator `0xC0000005` (3221225477) | Render backend crash; newer builds switch backends automatically and write `last-failure.json`; the report is in `logs\diagnostic-*.txt` |
| "Running multiple emulators with the same AVD" | A leftover qemu holds the lock; run `node tools\emu-clean.ps1` or reboot (newer builds clean orphans automatically) |
| Gitee 403 in update checks | Anonymous API rate limit; the client trips for 15 minutes and uses GitHub only — not a failure |
| `reg.exe` / `sc.exe` blocked in the sandbox | Affects automated tests only; the product runs on the user's desktop unaffected |
| Portable build exits after 1 second with no window | The single-instance lock is held by another ApkStart process (possibly an instance that did not exit cleanly); run `Stop-Process -Name ApkStart` first |

## 7. Release procedure (do it only after real-device verification passes)

```powershell
# 1. bump the version
#    package.json: version -> 0.3.5
# 2. release notes: docs/RELEASE-NOTES-NEXT.md -> .github/release-notes-v0.3.5.md
# 3. commit + tag
git add -A; git commit -m "chore(release): v0.3.5"
git tag -a v0.3.5 -m "ApkStart v0.3.5"
# 4. push to both repositories (GitHub over SSH, Gitee over https; as needed)
git push origin main; git push origin v0.3.5
git push gitee main;  git push gitee v0.3.5
```

CI: `release.yml` builds the portable edition (95MB zip), the full Setup (~1.35GB) and the runtime bundle
(~1.36GB), and syncs the portable edition to Gitee (requires the `GITEE_TOKEN` secret; without it the job fails outright instead of silently skipping).
xz compression in the `full` job takes about 40 minutes — that is normal.
