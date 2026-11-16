# Runtime engine directory (manual placement, optional)

**Since 0.2, ApkStart is fully self-contained by default**: adb, QEMU and the system image are downloaded and deployed by the app into
`%APPDATA%\apkstart\runtime\`, so there is nothing to prepare by hand.

This directory only serves the following two situations:

## 1. Place QEMU manually (download source blocked / you want a specific version)

```
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ … (remaining QEMU files)
```

Official QEMU Windows builds: https://qemu.weilnetz.de/w64/
(`qemu-w64-setup-*.exe` is an NSIS installer; ApkStart installs it silently into the runtime directory with `/S /D=`;
you can also unpack the installer with 7-Zip and place the files at the location above)

## 2. Place adb manually

```
tools/platform-tools/
└─ adb.exe
```

Download: https://developer.android.com/tools/releases/platform-tools

## System image

- Recommended: Android-x86 9.0-r2 (x86_64), downloadable inside the app (multiple mirrors, resumable downloads)
- Or import: any disk image with Android already installed (qcow2 / raw / vmdk), via "Runtime → Import"
- After import, ApkStart boots directly from the disk, with no install step

## Hardware acceleration

QEMU uses WHPX acceleration: Control Panel → "Turn Windows features on or off" → tick "Virtual Machine Platform" → reboot.
When it is not enabled, ApkStart automatically falls back to pure software emulation (TCG), and the first boot is slower.
