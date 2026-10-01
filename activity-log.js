/**
 * Activity log files: one JSON object per line, one file per month
 * (activity-log-2026-09.jsonl), kept next to auth.json. Files more than
 * KEEP_PREVIOUS_MONTHS months old are deleted automatically (per Dinesh,
 * 29 Sep 2026: about 3 months of history). Shared by server.js (writes,
 * cleanup, admin page) and setup-auth.js (shows recent entries).
 */

const fs = require('fs');
const path = require('path');

const KEEP_PREVIOUS_MONTHS = 3;
const FILE_RE = /^activity-log-(\d{4}-\d{2})\.jsonl$/;
const LEGACY_NAME = 'activity-log.jsonl';

function activityLogDir(authConfigPath) {
  return process.env.ACTIVITY_LOG_DIR || path.dirname(authConfigPath);
}

// Months are UTC, matching the ISO "time" stamped on every entry.
function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function monthFilePath(dir, key) {
  return path.join(dir, `activity-log-${key}.jsonl`);
}

function monthIndex(key) {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
}

// Oldest first.
function listMonthFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return names
    .map((name) => FILE_RE.exec(name))
    .filter(Boolean)
    .map((m) => ({ key: m[1], path: path.join(dir, m[0]) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

// The single activity-log.jsonl used before monthly files becomes the file
// for the month it was last written in. Returns an error message or null.
function migrateLegacyLog(dir) {
  const legacy = path.join(dir, LEGACY_NAME);
  if (!fs.existsSync(legacy)) return null;
  try {
    const target = monthFilePath(dir, monthKey(fs.statSync(legacy).mtime));
    if (fs.existsSync(target)) {
      fs.appendFileSync(target, fs.readFileSync(legacy, 'utf8'));
      fs.unlinkSync(legacy);
    } else {
      fs.renameSync(legacy, target);
    }
    return null;
  } catch (err) {
    return `Could not move ${LEGACY_NAME} into a monthly file (${err.code || 'error'}): ${err.message}`;
  }
}

// Keeps the current month plus the KEEP_PREVIOUS_MONTHS before it. Returns
// error messages for files that couldn't be deleted.
function deleteOldMonths(dir, now) {
  const cutoff = monthIndex(monthKey(now)) - KEEP_PREVIOUS_MONTHS;
  const errors = [];
  for (const f of listMonthFiles(dir)) {
    if (monthIndex(f.key) >= cutoff) continue;
    try {
      fs.unlinkSync(f.path);
    } catch (err) {
      errors.push(`Could not delete old activity log ${path.basename(f.path)} (${err.code || 'error'}): ${err.message}`);
    }
  }
  return errors;
}

// The last maxBytes of a file as parsed entries, oldest first. A partial
// first line (cut by the byte limit) and any corrupt line are skipped.
function readEntries(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return [];
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  let text;
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift();
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) { /* skip */ }
  }
  return entries;
}

module.exports = {
  KEEP_PREVIOUS_MONTHS, activityLogDir, monthKey, monthFilePath, listMonthFiles, migrateLegacyLog, deleteOldMonths, readEntries,
};
