# Contributing

Issues and pull requests are welcome. The project's principle is **zero dependencies in the shell and predictable behavior**, so please read the conventions below first.

## Development environment

- Windows 10/11 x64
- Node.js ≥ 20
- `npm install && npm start`

## Pre-submit checks

```powershell
npm test          # Pure Node unit tests + engine pipeline tests (no network, no VM needed)
```

For UI changes, also run the smoke screenshot to confirm nothing has collapsed:

```powershell
electron . --smoke test\shot.png
```

## Code conventions

- **The shell adds no third-party runtime dependencies.** The ZIP / AXML / ARSC / PNG / ICO parsers under `src/core/` are hand-written; when adding a feature, first ask "can this be done with Node built-in modules?" instead of pulling in a large package for a small feature.
- The renderer is plain HTML/CSS/JS with no frontend framework.
- All communication with the Android side goes through `src/core/adb.js`; do not assemble adb commands ad hoc elsewhere.
- The main and renderer processes communicate only through the allowlisted channels exposed by `preload.js`, and `contextIsolation` stays enabled.
- Comments and UI copy are in English; identifiers are in English.

## Testing conventions

- When no real APK is available, the APK-parsing part of the tests is skipped automatically. To cover it, point an environment variable at any APK:

```powershell
$env:APKSTART_TEST_APK="C:\path\to\any.apk"; npm test
```

- Tests must not access the internet. If a test needs network behavior, start a local `http` server (see `test/engine-test.js`).

## Commit messages

Use Conventional Commits, for example:

```
feat(engine): support importing qcow2 disks from a custom path
fix(axml): correct attribute table base offset
docs: add notes on enabling WHPX
```

## Legal and boundaries

- This project distributes no Android system images, QEMU binaries or Google components; the user's machine downloads everything on demand.
- Do not commit commercial APKs, cracking tools or anything that infringes third-party copyright to the repository.
