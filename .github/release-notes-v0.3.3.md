## What this release fixes

### 1. Slow downloads: the real cause is "every thread piling onto one blocked address"

Measured on this machine: 8 threads all hitting GitHub gave only **0.23 MB/s**, so a 113 MB update needed **493 seconds**;
at the same time two direct connections returned **zero bytes** (TCP connects but no data flows), and only the mirror was moving.

- **Multi-source parallel chunking**: the file is split into chunks and different chunks are pulled simultaneously from "GitHub direct / ghfast / gh-proxy", so bandwidth adds up.
  Measured on the same machine: **113 MB went from 493 seconds to 77 seconds** (about 1.5 MB/s, including speed tests and extraction).
- **Low-speed source switching**: when a chunk drops to tens of KB/s it is aborted, the source is switched, and the transfer resumes from the breakpoint — previously it would "hang at 95% forever".
- **Per-chunk resumable downloads**: if the 1.4 GB runtime pack fails halfway, a retry only fetches the missing chunks instead of starting over.
- **Stall watchdog**: if a connection is established but delivers no bytes for 20 seconds, it is dropped immediately and the next source is tried,
  instead of passively waiting out the 30-second socket timeout and freezing the whole pack.
- **Measured and chosen every time**: each candidate address really downloads 256 KB for a speed test, and only throughput *after the first byte arrives* counts
  (including the few hundred milliseconds of handshake would misjudge a "high latency but high bandwidth" source as slow); sources are tested sequentially so they do not steal bandwidth from each other.

### 2. Dual sources: GitHub and Gitee with automatic selection

- Both repositories are now public: GitHub `RoutineMiku/apkstart`, Gitee `daily-miku/apkstart`.
- Version checks ask both sides and take the higher version number; one source timing out or being blocked does not affect the other.
- Gitee caps release attachments at 100 MB per file, so the portable package is published there as `.part1/.part2`,
  and the client automatically picks a source per part, downloads them, and reassembles the full package (each part's size is validated and a missing part aborts).
- Gitee rate-limits anonymous calls: a 10-minute version cache plus a 403/429 circuit breaker for 15 minutes were added,
  and when both sources are down it falls back to the previous result marked `stale`, so the UI does not just throw an error.

### 3. User data is no longer deleted by accident

- **No automatic data wiping when the disk is full**: previously the last retry tier used `-wipe-data`, so a full disk made every tier fail
  and repeated retries wiped apps and saves together. Any automatic retry now forbids clearing data, and an insufficient disk halts with an explanation of what to do.
- **Moving the image to another drive is not a different image**: after moving the runtime directory from C: to D: (which Settings itself recommends),
  it used to be judged "the image changed" → `-wipe-data` → every installed app lost. It now compares image identity, so moving drives leaves data untouched.
- **`qemu-img resize` argument order** fixed: previously you could get "file grown to 6 GB while the filesystem is still 64 MB",
  so Android filled up on the first write and every service crashed with `setxattr` ENOSPC. Startup now also self-heals by comparison.

### 4. Other

- Install failures no longer spam the screen: repeated clicks on the same APK run only once; failure messages give an actionable conclusion by type
  (partition too small / ARM package / signature conflict / version downgrade).
- Resources and disk are controllable: three resource policies (save resources / balanced / smooth), three quality levels,
  an Android data partition adjustable from 4–24 GB with in-place growth (without losing installed apps), and an Android data directory that can point at another drive.
- Size: portable version 230 MB (52 unused language packs stripped, saving 39 MB).
- Logs roll by size instead of growing forever; shared-directory sync no longer moves the same file back and forth repeatedly.

## Verified on real hardware for this release (same machine, Windows 11 + Android 14 Play image)

| Item | Result |
|---|---|
| Cold start to an openable app | **23–25 seconds** (about 32 seconds on the first run including probing) |
| Quickboot snapshot hit | **5 seconds** |
| Install an APK and open the app | App window appears in **1.5 seconds** (warm snapshot) |
| Emulator/console windows visible throughout a 45-second boot | **0** |
| Windows left on the desktop after quitting ApkStart | **0** |

## Install

- **Full edition** `ApkStart-*-Setup.exe`: bundles the runtime, usable right after install (about 1.4 GB).
- **Lightweight edition** `ApkStart-*-win64-portable.zip`: unzip and run; the runtime is downloaded automatically on first launch
  (it now picks the fastest source and resumes from breakpoints).

Both repositories hold identical content; inside mainland China, Gitee is recommended.
