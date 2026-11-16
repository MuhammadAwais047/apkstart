'use strict';
/**
 * Electron integration test: verifies ICO generation, shortcut creation, real icon output
 * Run: electron test/electron-integration.js
 * Output: test/out/result.json
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const result = { steps: [] };
  const step = (name, ok, detail = '') => {
    result.steps.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name} ${detail}`);
  };

  try {
    const { drawAppIcon } = require('../src/core/png');
    const { pngToIco, writeShortcut, removeShortcut, iconToIco } = require('../src/core/shortcut');
    const { parseApk } = require('../src/core/apk');

    // 1. App icon -> PNG -> ICO
    const png = drawAppIcon(256);
    fs.writeFileSync(path.join(OUT, 'icon.png'), png);
    const ico = pngToIco(png);
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
    step('generate ICO', !!ico && ico.length > 1000, `${ico ? ico.length : 0} bytes`);

    // 1b. WebP icon fallback: nativeImage cannot decode WebP; it must land in the decode callback,
    // and without a decoder use the brand placeholder and **report it honestly** (install turns it into a soft warning).
    {
      // minimal 1x1 WebP
      const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
      let noDecoder = '';
      const placeholderIco = await iconToIco(webp, { onFallback: (why) => { noDecoder = why; } });
      step('WebP without decoder -> valid ICO and placeholder downgrade reported',
        !!placeholderIco && placeholderIco.length > 100 && /placeholder|webp-decode-failed/.test(noDecoder),
        noDecoder || '(no callback)');

      let decoded = 0;
      const viaDecode = await iconToIco(webp, {
        decode: async () => { decoded++; return png; },
        onFallback: (why) => { throw new Error(`must not downgrade: ${why}`); },
      });
      // If nativeImage one day decodes WebP directly, decoded is 0 and that still passes; what matters is a valid ICO
      step('WebP icon ends up as an ICO', !!viaDecode && viaDecode.readUInt16LE(2) === 1,
        `decode calls: ${decoded}, ${viaDecode ? viaDecode.length : 0} bytes`);
    }

    // 2. Shortcut
    const lnk = path.join(OUT, 'test.lnk');
    writeShortcut({
      shortcutPath: lnk,
      target: process.execPath,
      args: '--version',
      iconIcoPath: path.join(OUT, 'icon.ico'),
      description: 'ApkStart integration test',
    });
    step('create .lnk', fs.existsSync(lnk));
    removeShortcut(lnk);
    step('delete .lnk', !fs.existsSync(lnk));

    // 3. Real APK icon -> ICO
    const fixture = process.env.APKSTART_TEST_APK
      || (() => {
        try {
          const dl = path.join(process.env.USERPROFILE || '', 'Documents');
          return fs.readdirSync(dl).map((f) => path.join(dl, f)).find((f) => /\.apk$/i.test(f));
        } catch (_) { return null; }
      })();
    if (fixture) {
      const meta = parseApk(fixture);
      const iconIco = pngToIco(meta.iconPng);
      if (iconIco) {
        fs.writeFileSync(path.join(OUT, 'app.ico'), iconIco);
        step('APK icon -> multi-size ICO', true, `${meta.label}: ${iconIco.length} bytes`);
      } else {
        step('APK icon -> multi-size ICO', false, 'pngToIco returned empty (the icon may be a format other than webp/jpg)');
      }
    }

    result.ok = result.steps.every((s) => s.ok);
  } catch (e) {
    result.error = e.message;
    result.ok = false;
    console.error(e);
  }

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
