#!/usr/bin/env node
'use strict';
/**
 * .apk association CLI switches (no UI)
 *   node scripts/assoc.js on   -> register double-click APK install
 *   node scripts/assoc.js off  -> remove the association
 */
const path = require('path');
const fs = require('fs');
const { registerAssociation, unregisterAssociation } = require('../src/core/assoc');

const action = process.argv[2] || 'on';
const isDev = !process.env.APKSTART_PACKAGED;
const exe = isDev
  ? path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.execPath;
const appDir = path.join(__dirname, '..');

if (action === 'on') {
  const iconPath = path.join(__dirname, '..', 'build', 'apkstart.ico');
  const r = registerAssociation(exe, fs.existsSync(iconPath) ? iconPath : undefined,
    isDev ? `"${appDir}"` : undefined);
  console.log('registered the .apk association:', r.progId);
  console.log('Double-clicking an .apk in Explorer now installs it into ApkStart.');
} else if (action === 'off') {
  unregisterAssociation();
  console.log('removed the .apk association.');
} else {
  console.log('Usage: node scripts/assoc.js [on|off]');
  process.exit(1);
}
