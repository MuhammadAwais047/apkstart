# Portable adb

Unpack Android platform-tools into this directory (so that `adb.exe` appears) and ApkStart will prefer it:

```
tools/platform-tools/
└─ adb.exe
```

Download: https://developer.android.com/tools/releases/platform-tools

If this directory is empty, ApkStart tries, in order:

1. The adb path set manually in Settings
2. This directory
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. The adb bundled with common emulators (LDPlayer / MuMu / BlueStacks)
5. The system PATH
