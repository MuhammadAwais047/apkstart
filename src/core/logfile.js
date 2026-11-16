'use strict';
/**
 * Lightweight log writing + rotation.
 *
 * app.log / emulator.log used to be plain appends, so they grew forever with long-term use:
 * each boot writes tens of KB of emulator kernel log; a dozen launches a day plus qemu's
 * verbose output adds up to hundreds of MB in a few months - that is how the disk quietly fills up.
 * Rotation is by size here, keeping a single .1.log backup, capped by the "log limit" in settings.
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // When the file name does not end in .log, bak equals the original: delete-then-rename would wipe the log.
    // Skip that edge case explicitly: a slightly large log beats a lost one.
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} file target log
 * @param {string} line one line (newline added automatically)
 * @param {number} [limitKB] rotate once this size is exceeded
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // Check once at process start, then every 200 lines (statSync is cheap, but no need to do it per line)
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Cleanup at startup: rotate an oversized log first (ignoring the counter) */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
