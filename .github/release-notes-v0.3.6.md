# ApkStart v0.3.6

> In one line: **fixed "a persistent black screen after tapping Agree and continue in Hongguo"**. The real cause was Android's Wi-Fi taking a long time to connect, so the app loaded its home page with no network and only a black background remained — nothing to do with the GPU or the render backend.

## 1. Black screen after tapping Agree in Hongguo — real cause and fix

### The previous release's misdiagnosis

v0.3.5 blamed the black screen on the GPU backend (swangle / software), which was **wrong**. Switching backends of course did not help.

### The real cause found by this round of testing

Layer by layer via adb:

- `cmd wifi status`: `Wifi is not connected`; `ip -o addr show wlan0`: **no IP at all**;
- In other words, **the virtual machine had no network at that moment**;
- Hongguo's privacy dialog is a local page, so it displayed normally; after tapping "Agree and continue" it has to fetch home-page data,
  and with no data it renders as one solid black block — that is the "black screen after tapping Agree" the user saw;
- `sys.boot_completed` only means the system is up; **Wi-Fi association + DHCP often take another few tens of seconds to two-plus minutes**.
  The app started before the network was ready, every home-page request failed, and the page stayed black.

Measurement evidence: on the same virtual machine, querying right after boot showed "no IP"; after waiting a minute or two it became
`wlan0 inet 10.0.2.16/24` + `Wifi is connected to "AndroidWifi"`, at which point the Hongguo home page was completely normal.

### Fixes in this release

1. **Wait for the network before launching an app**: `installer.launch` waits up to 150 seconds before `am start`,
   logging `waiting for the Android VM to get online… Ns`, and only then really starts the app — eliminating at the source
   the black screen caused by "the app running before the network".
2. **Network health check after boot**: a successful boot checks whether the VM obtained an IP, and when there is no network the log states the reason,
   instead of leaving the user staring at a black screen guessing.
3. **Settings → Fix network** (new button): one-click repair. It resets the Android user data and reboots,
   then waits until the network is ready (up to 4 minutes), and on success stores the "network normal" state as a quick-boot snapshot.
   - **The app list is kept**; opening an app reinstalls it automatically, so there is no need to reinstall APKs by hand;
   - Runtime data such as in-app logins and watch history is lost and needs to be signed in again;
   - Only the current AVD is affected; the system image and the local APK cache are untouched.

> If Hongguo shows a black screen now: first just open Hongguo (this release waits for the network automatically); if it is still black, tap "Settings → Fix network".

## 2. The previous release's "clear cache" fix continues to work

v0.3.5's `includeSnapshots` + "reset Android data" are unchanged and remain available.

## 3. Known limitations

- That Android 14 (`google_apis_playstore`) image has an upstream issue: on a **cold boot with existing user data**,
  Wi-Fi often stays `NO-CARRIER` and never gets an IP; the boot right after a data reset connects correctly.
  "Fix network" therefore resets data and immediately saves a snapshot to preserve the working state.
- The Play Store image does not allow `adb root`, so the broken Wi-Fi configuration cannot be deleted individually.

## 4. Measured record

- After the fix: tapping "Agree and continue" → enters `MainFragmentActivity`, and the home page shows the series list and recommendation feed normally
  (confirmed by screenshot, not a black screen).
- On the same virtual machine after waiting for the network: `wlan0 inet 10.0.2.16/24`, `Wifi is connected to "AndroidWifi"`.
- `npm test`: **113 items all passed** (8 + 25 + 80).

## 5. How to upgrade

- Portable: unzip over the old copy; the data directory (default `%APPDATA%\apkstart`) is untouched.
- Installed edition: install over the old copy.
