/**
 * Race Day Dashboard Web Service
 * --------------------------------
 * Grid of meetings x race number x scheduled time for any date, with:
 *   - Missing-jockey / missing-trainer flags (colored outline + count badge)
 *     per race, and missing/zero/duplicate tab number
 *   - Duplicate-jockey flag (orange "D") per race
 *   - Click a race time to see runner-level detail (tab no, horse, jockey,
 *     position (once resulted), issue) in a popup
 *   - Finished-race results: green result line (tab numbers, 1st-4th) under
 *     the time on the grid, full finishing-position table in the popup
 *   - Abandoned meetings get an "ABBN" tag; abandoned races show "Abandoned"
 *     directly inside the race cell (time struck through)
 *   - Schedule-time sanity check (solid red "bad-time"): flags a race
 *     scheduled less than 15 minutes after the previous race at that
 *     meeting, an exact-duplicate scheduled time, or the 00:00 placeholder.
 *     (A separate UTC/local-timezone cross-check used to live here too --
 *     removed 11 Aug 2026 per Dinesh, see raceView.js's removal note near
 *     the top of the file for why and what it used to catch.)
 *   - Client auto-refreshes every 3 minutes (paused while the popup is open)
 *   - Light/Dark theme toggle + a "Search meeting" text box, both remembered
 *     per-browser via localStorage alongside the other grid filters
 *   - Issues report downloadable as CSV, Excel (.xlsx), JSON, or PDF
 *
 * Config: reads the MongoDB connection string from db.json (same file/
 * format used by db-service and race-schedule) -- READ ONLY, never
 * modified or copied by this program.
 *
 * Endpoints:
 *   GET /                    -> the dashboard as an HTML page (default: today)
 *   GET /?date=YYYY-MM-DD     -> dashboard for a specific date
 *   GET /?includeTrials=true  -> include trial meetings (excluded by default)
 *   GET /api/race/:id         -> runner-level detail for one race, as JSON
 *   GET /report.csv|.xlsx|.json|.pdf?date=YYYY-MM-DD -> downloadable issues
 *                                      report (missing/duplicate jockey, tab
 *                                      number problems, missing trainer,
 *                                      bad time, duplicate meetings,
 *                                      missing/duplicate race numbers,
 *                                      abandoned races) across ALL
 *                                      disciplines, not just one tab -- same
 *                                      data, four downloadable formats
 *   GET /meeting-report.csv|.xlsx|.json|.pdf?date=YYYY-MM-DD&meeting=...
 *       &country=...&discipline=T|H|G[&includeTrials=true] -> full race +
 *                                      runner details for ONE meeting (every
 *                                      race, every runner, issue or not),
 *                                      four downloadable formats -- linked
 *                                      from the small download icon next to
 *                                      each meeting name on the grid
 *   GET /meetings-list.csv|.xlsx|.json|.pdf?date=YYYY-MM-DD
 *       [&discipline=T|H|G][&includeTrials=true] -> one row per MEETING for
 *                                      the date (meeting/country/TAB/race
 *                                      count/first race time/trial/
 *                                      abandoned/has issues) -- discipline
 *                                      omitted means all three, not just
 *                                      Thoroughbred; four downloadable formats
 *   GET /health                -> DB connectivity check
 *
 * Login (added 12 Aug 2026 per Dinesh -- see raceView.js's renderLoginPage
 * comment for the full request/scoping history): one username/password per
 * person (29 Sep 2026) protects every page, API and report download, with
 * logins and downloads recorded in the activity log. Only /login, /logout,
 * /health and the static files in public/ stay open (29 Sep 2026, per
 * Dinesh -- the APIs and downloads were previously open and returned data
 * to anyone with the URL). Credentials are never stored in this repo: run
 * `node setup-auth.js` on the hosting machine to add/remove users or change
 * a password -- it writes securely-hashed passwords to a
 * local config file outside the project folder (AUTH_CONFIG_PATH below,
 * same pattern as db.json). This app never sees or logs the plaintext
 * password after setup. The session is a plain browser-session cookie (no
 * "remember me") -- closing the browser logs you out.
 *   GET  /login   -> login form
 *   POST /login   -> checks credentials, starts a session cookie
 *   GET  /logout  -> ends the session
 */

const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { loadConfig, extractConnectionString } = require('./db-config');
const { MIN_PASSWORD_LENGTH, USERNAME_RE, loadAuthFile, saveAuthFile, findUserIndex, usersFilePath, activeAuthPath } = require('./auth-store');
const { KEEP_PREVIOUS_MONTHS, activityLogDir, monthKey, monthFilePath, migrateLegacyLog, deleteOldMonths, readEntries } = require('./activity-log');
const { DEFAULT_COUNTRIES: MISSING_DEFAULT_COUNTRIES, pickSourceMeetings, uncheckedFeedCountries, compareMeetings, sameCourse: sameCourseName } = require('./missing-meetings');
const { generateCommentsV2 } = require('./comments-v2');
const {
  RUNNERS_API_URL, NEDS_SITE_BASE, NEDS_SITE_HEADERS, parseNedsSiteMeetings, parseNedsSiteRunners,
  sameCountry, parseRunnerMeetings, compareRunners, countRunners, stillDiffers,
} = require('./runners-check');
const { KEEP_DAYS: CHANGE_KEEP_DAYS, meetingSnap, raceSnap, diffMeeting, diffRace, appendChanges, readChanges, deleteOldChangeFiles } = require('./change-tracker');
const {
  buildSchedule, buildRaceDetail, renderHtml, renderLoginPage, todayStr, escapeHtml, buildIssuesReport, issuesReportToCsv,
  slugify, countrySlug, raceUrl, DISCIPLINE_SLUGS,
  buildMeetingDetailsReport, meetingDetailsReportToCsv, buildMeetingsListReport, meetingsListReportToCsv, disciplineLabel,
  renderMeetingsListPage, groupDocsByDate, buildMeetingsListRowsForRange, parseClock, deriveRaceStatus,
  renderAdminPage, renderAdminDeniedPage, renderChangesPage, renderSystemHealthPage, renderMissingMeetingsPage,
} = require('./raceView');

// Default config-file location changed 9 Sep 2026, per Dinesh: production's
// WinSW service actually runs out of `C:\Thilina\Dinesh project\project - 1`
// (confirmed already holding real db.json/auth.json/ignore-file data there),
// NOT `C:\Users\Dinesh\projects-config` -- that mismatch is what caused the
// EPERM write failures on the ignore-file save routes (the old default
// pointed at a folder the production service can't write to). Still
// overridable per-file via env var for any other environment (e.g. this
// codebase's own local dev machine, whose files live elsewhere).
const DB_CONFIG_PATH = process.env.DB_CONFIG_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\db.json';
const AUTH_CONFIG_PATH = process.env.AUTH_CONFIG_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\auth.json';
const FORM_IGNORE_PATH = process.env.FORM_IGNORE_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\form-line-ignores.json';
const AGE_IGNORE_PATH = process.env.AGE_IGNORE_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\age-ignores.json';
const DUP_JOCKEY_IGNORE_PATH = process.env.DUP_JOCKEY_IGNORE_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\dup-jockey-ignores.json';
const MISSING_JOCKEY_IGNORE_PATH = process.env.MISSING_JOCKEY_IGNORE_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\missing-jockey-ignores.json';
const PORT = process.env.PORT || 3000;
const CONNECTION_NAME = process.env.DB_CONNECTION_NAME || 'mongodb-prod';

// "Missing form lines" runner-level manual overrides (28 Aug 2026, per
// Dinesh: a runner flagged as missing form lines might just be a genuine
// first-starter with no past runs -- someone checks the real source
// (punters.com.au) by hand, and if it's confirmed there's really nothing to
// find, ticks it here so the dashboard stops flagging that runner. Keyed by
// runnerId (the horse's stable identity across races, not per-race), stored
// in the same external-config-file style as auth.json/db.json so it's never
// lost on a redeploy and never committed to the repo.
let formLineIgnores = {};
try {
  if (fs.existsSync(FORM_IGNORE_PATH)) formLineIgnores = JSON.parse(fs.readFileSync(FORM_IGNORE_PATH, 'utf8'));
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${FORM_IGNORE_PATH}: ${err.message} -- starting with an empty list`);
}

function saveFormLineIgnores() {
  const dir = path.dirname(FORM_IGNORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FORM_IGNORE_PATH, JSON.stringify(formLineIgnores, null, 2), 'utf8');
}

// "Horse age issue" runner-level manual overrides -- same pattern as
// formLineIgnores above, added 7 Sep 2026 per Dinesh: "Age issue vanda ada
// highlight pannunga... Age checked no issue anda madhiri check mark poda
// podunga" (highlight it, but let someone confirm "checked, no issue" to
// clear it). Keyed by runnerId, same external-config-file style.
let ageIgnores = {};
try {
  if (fs.existsSync(AGE_IGNORE_PATH)) ageIgnores = JSON.parse(fs.readFileSync(AGE_IGNORE_PATH, 'utf8'));
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${AGE_IGNORE_PATH}: ${err.message} -- starting with an empty list`);
}

function saveAgeIgnores() {
  const dir = path.dirname(AGE_IGNORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AGE_IGNORE_PATH, JSON.stringify(ageIgnores, null, 2), 'utf8');
}

// Attaches `runner.ageIssueIgnored` (Thoroughbred only, same as the age
// check itself) so raceView.js's isAgeIssue() can skip a runner someone's
// already manually confirmed. Kept separate from attachFormLineStatus --
// this is a plain local lookup with no DB/racecards involvement, unlike
// that one.
//
// A confirmed race gets RE-SCRAPED sometimes (Dinesh, 11 Sep 2026: confirmed
// "Checked, no issue" on a missing jockey, a later re-scrape put the jockey
// back to missing, but the warning stayed hidden) -- the ignore is a
// judgement about the data AT THE TIME it was made, not a standing order to
// hide this runner forever, so it's treated as stale (and not applied, so
// the warning can reappear if the problem is still there after the
// refresh) once the race document itself has been re-scraped past the
// ignore's `ignoredAt`.
//
// Originally this compared against `updatedAt`, assumed to be AEST
// (UTC+10) based on one sample. Turned out wrong: confirmed 11 Sep 2026 by
// a real ignore-then-rescrape test (TAIF R3 / ISTA'ANAF) that `updatedAt`
// gets bumped by some other, unrelated AEST-clocked background process
// (its value keeps tracking "current AEST time" even when nothing about
// the race changed), so it doesn't reliably mean "this doc was
// re-scraped". `createdAt`, by contrast, gets reset to a fresh plain-UTC
// timestamp every time this specific race document is actually
// re-scraped (the ingest pipeline replaces the whole doc rather than
// patching fields in place -- confirmed by createdAt landing within
// seconds of `fileGeneratedAt`, which is consistently plain UTC, across
// every doc sampled), so that's the reliable "was this re-scraped" signal.
function parseIngestTimestamp(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function isIgnoreStale(entry, doc) {
  if (!entry || !entry.ignoredAt || !doc || !doc.createdAt) return false;
  const createdAt = parseIngestTimestamp(doc.createdAt);
  if (!createdAt) return false;
  return createdAt > new Date(entry.ignoredAt);
}

function applyAgeIgnores(docs) {
  for (const doc of docs) {
    if (doc.rDiscipline !== 'T') continue;
    for (const r of (doc.runners || [])) {
      const entry = r.runnerId && ageIgnores[r.runnerId];
      r.ageIssueIgnored = Boolean(entry) && !isIgnoreStale(entry, doc);
    }
  }
}

// "Duplicate jockey" manual overrides -- same pattern as ageIgnores above,
// added 7 Sep 2026 per Dinesh: "Duplicate jockey checked with site podunga
// adau click panna checked podunga". Keyed by raceId + jockey name (NOT
// runnerId) -- being a duplicate is a property of the jockey name shared
// across runners IN THIS RACE, not of any single runner, so confirming it
// once clears it for every runner sharing that name in that race together.
let dupJockeyIgnores = {};
try {
  if (fs.existsSync(DUP_JOCKEY_IGNORE_PATH)) dupJockeyIgnores = JSON.parse(fs.readFileSync(DUP_JOCKEY_IGNORE_PATH, 'utf8'));
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${DUP_JOCKEY_IGNORE_PATH}: ${err.message} -- starting with an empty list`);
}

function saveDupJockeyIgnores() {
  const dir = path.dirname(DUP_JOCKEY_IGNORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DUP_JOCKEY_IGNORE_PATH, JSON.stringify(dupJockeyIgnores, null, 2), 'utf8');
}

function dupJockeyIgnoreKey(raceId, jockey) {
  return `${raceId}|${String(jockey).trim().toLowerCase()}`;
}

// Attaches `runner.duplicateJockeyIgnored` (Thoroughbred + Harness --
// Greyhound has no jockeys) so raceView.js's jockeyCounts() can exclude a
// confirmed runner from the duplicate tally.
function applyDupJockeyIgnores(docs) {
  for (const doc of docs) {
    if (doc.rDiscipline === 'G') continue;
    for (const r of (doc.runners || [])) {
      const entry = r.jockey && dupJockeyIgnores[dupJockeyIgnoreKey(doc._id, r.jockey)];
      r.duplicateJockeyIgnored = Boolean(entry) && !isIgnoreStale(entry, doc);
    }
  }
}

// "Missing jockey" manual overrides -- same pattern as dupJockeyIgnores
// above, added 7 Sep 2026 per Dinesh: "Missing jockey / Duplicate jockey
// Idukku checked with Site button podunga, pottadu adu issue ignore
// aaganu". Keyed by raceId + runnerId (not runnerId alone) -- whether a
// jockey is assigned is a fact about THIS race's entry, not a durable
// horse attribute, so confirming it must not silently hide a genuinely
// different missing-jockey problem for the same horse in a later race.
let missingJockeyIgnores = {};
try {
  if (fs.existsSync(MISSING_JOCKEY_IGNORE_PATH)) missingJockeyIgnores = JSON.parse(fs.readFileSync(MISSING_JOCKEY_IGNORE_PATH, 'utf8'));
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${MISSING_JOCKEY_IGNORE_PATH}: ${err.message} -- starting with an empty list`);
}

function saveMissingJockeyIgnores() {
  const dir = path.dirname(MISSING_JOCKEY_IGNORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MISSING_JOCKEY_IGNORE_PATH, JSON.stringify(missingJockeyIgnores, null, 2), 'utf8');
}

function missingJockeyIgnoreKey(raceId, runnerId) {
  return `${raceId}|${runnerId}`;
}

// Attaches `runner.missingJockeyIgnored` (Thoroughbred + Harness -- same
// disciplines countMissingJockeys() itself applies to) so raceView.js can
// skip a confirmed runner.
function applyMissingJockeyIgnores(docs) {
  for (const doc of docs) {
    if (doc.rDiscipline === 'G') continue;
    for (const r of (doc.runners || [])) {
      const entry = r.runnerId && missingJockeyIgnores[missingJockeyIgnoreKey(doc._id, r.runnerId)];
      r.missingJockeyIgnored = Boolean(entry) && !isIgnoreStale(entry, doc);
    }
  }
}

function applyFormLineIgnores(docs) {
  for (const doc of docs) {
    for (const r of (doc.runners || [])) {
      const ignored = r.hasFormLinesRaw === false && Boolean(r.runnerId && formLineIgnores[r.runnerId]);
      r.hasFormLines = r.hasFormLinesRaw !== false || ignored;
      r.formLineIgnored = ignored;
    }
  }
}

// Every manual "Confirm / Checked" override, applied fresh on each read so
// cached race data reflects a confirm straight away.
function applyAllIgnores(docs) {
  applyFormLineIgnores(docs);
  applyAgeIgnores(docs);
  applyDupJockeyIgnores(docs);
  applyMissingJockeyIgnores(docs);
}

// --- Response cache (1 Oct 2026, per Dinesh: "site a konjo optimize panni
// speed aakunga") -----------------------------------------------------
// The DB and the external feeds are remote and slow (a full dashboard load
// measured 43 s cold). Values are fresh for ttlMs; after that, for up to
// staleMs more, the old value is returned at once while one refresh runs
// in the background, so nobody waits on a refresh that isn't needed yet.
// Concurrent callers share one in-flight load.
const memoCache = new Map();
let memoSets = 0;
function cached(key, ttlMs, staleMs, load) {
  const now = Date.now();
  const hit = memoCache.get(key);
  const hasValue = hit && hit.at !== undefined;
  if (hasValue && now - hit.at < ttlMs) return Promise.resolve(hit.value);
  const usable = hasValue && now - hit.at < ttlMs + staleMs;
  if (hit && hit.pending) return usable ? Promise.resolve(hit.value) : hit.pending;
  const entry = hit || {};
  entry.pending = Promise.resolve().then(load).then((value) => {
    entry.value = value;
    entry.at = Date.now();
    entry.pending = null;
    return value;
  }, (err) => {
    entry.pending = null;
    throw err;
  });
  memoCache.set(key, entry);
  if (++memoSets % 200 === 0) {
    for (const [k, e] of memoCache) if (!e.pending && e.at !== undefined && now - e.at > 60 * 60 * 1000) memoCache.delete(k);
  }
  if (usable) {
    entry.pending.catch((err) => console.warn(`[race-dashboard] WARNING: background refresh of ${key} failed: ${err.message}`));
    return Promise.resolve(hit.value);
  }
  return entry.pending;
}

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const config = loadConfig(DB_CONFIG_PATH);
    const { connectionString } = extractConnectionString(config, CONNECTION_NAME);
    const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 8000 });
    clientPromise = client.connect().then(() => client).catch((err) => {
      clientPromise = null; // allow retry on next request
      throw err;
    });
  }
  return clientPromise;
}

// --- Login config -------------------------------------------------------
//
// One login per person (29 Sep 2026, per Dinesh), managed from the admin
// page or `node setup-auth.js` (file format: auth-store.js). Returns null
// if not set up yet rather than throwing -- the server should still come
// up (so /health keeps working) with the login gate simply refusing
// everyone until a user exists.
function loadAuthConfig(configPath) {
  const config = loadAuthFile(configPath);
  if (config && !config.users.length) {
    throw new Error(`${configPath} has no users -- run "node setup-auth.js" to add one`);
  }
  return config;
}

const AUTH_USERS_PATH = usersFilePath(AUTH_CONFIG_PATH);

let authConfig = null;
let authConfigStamp = '';
function authFileStamp() {
  const p = activeAuthPath(AUTH_CONFIG_PATH);
  try {
    return `${p}|${fs.statSync(p).mtimeMs}`;
  } catch (e) {
    return '';
  }
}
function readAuthConfig() {
  const p = activeAuthPath(AUTH_CONFIG_PATH);
  try {
    authConfigStamp = authFileStamp();
    authConfig = loadAuthConfig(p);
    if (!authConfig) {
      console.warn(`[race-dashboard] WARNING: No dashboard login configured yet at ${p}. Run "node setup-auth.js" once on this machine to add a user -- until then, nobody can log in.`);
    }
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: Could not read login config at ${p}: ${err.message}`);
  }
}
readAuthConfig();

// User changes take effect without a restart: the file in use is re-read
// whenever it (or which file is in use) changes. On a bad edit the last
// good list stays in use.
function refreshAuthConfig() {
  applyAdminBootstrap();
  const stamp = authFileStamp();
  if (!stamp || stamp === authConfigStamp) return;
  const previous = authConfig;
  readAuthConfig();
  if (!authConfig) authConfig = previous;
}

// Every user change goes through here: saved to auth-users.json (see
// auth-store.js for why) and applied to the running server at once.
function saveUsers(config) {
  saveAuthFile(AUTH_USERS_PATH, config);
  authConfig = config;
  authConfigStamp = authFileStamp();
}

function findUser(username) {
  const idx = findUserIndex(authConfig, username);
  return idx === -1 ? null : authConfig.users[idx];
}

function isAdmin(req) {
  const user = findUser(req.session && req.session.username);
  return Boolean(user && user.role === 'admin');
}

// Admin-area sections (30 Sep 2026, per Dinesh): admins get all of them
// plus user management; anyone else only the ones an admin ticked for them.
const PERMISSIONS = ['activity', 'health', 'changes', 'missing'];
function accessOf(req) {
  const user = findUser(req.session && req.session.username);
  const admin = Boolean(user && user.role === 'admin');
  const granted = new Set(user && Array.isArray(user.permissions) ? user.permissions : []);
  const access = { admin };
  PERMISSIONS.forEach((p) => { access[p] = admin || granted.has(p); });
  access.any = PERMISSIONS.some((p) => access[p]);
  return access;
}
function cleanPermissions(list) {
  return Array.isArray(list) ? PERMISSIONS.filter((p) => list.includes(p)) : [];
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (accessOf(req)[permission]) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'You do not have access to this' });
    return res.status(403).send(renderAdminDeniedPage());
  };
}

// First-admin setup without server (RDP) access: `node setup-auth.js
// --bootstrap` on any PC writes admin-bootstrap.json (hashed password only)
// into the project folder; after it's uploaded by FTP, the next request
// adds/updates that user as an admin in auth.json and deletes the file.
// FTP access already means full control of the server code, so this opens
// no new door.
const ADMIN_BOOTSTRAP_PATH = path.join(__dirname, 'admin-bootstrap.json');
// The service account may not be allowed to delete a file uploaded by FTP
// (seen on production 29 Sep 2026), so a bootstrap file is applied once per
// distinct content rather than on every request, and any problem is written
// to the activity log -- the one server file that can be downloaded by FTP
// to diagnose it.
let lastBootstrapContent = null;
function logSystem(message) {
  console.warn(`[race-dashboard] WARNING: ${message}`);
  appendLog({ time: new Date().toISOString(), user: null, action: 'system-warning', detail: message, ip: null });
}
function applyAdminBootstrap() {
  if (!fs.existsSync(ADMIN_BOOTSTRAP_PATH)) return;
  let content;
  try {
    content = fs.readFileSync(ADMIN_BOOTSTRAP_PATH, 'utf8');
  } catch (err) {
    return;
  }
  if (content === lastBootstrapContent) return;
  lastBootstrapContent = content;
  let boot;
  try {
    boot = JSON.parse(content);
    if (!USERNAME_RE.test(boot.username || '') || !/^\$2[aby]\$/.test(boot.passwordHash || '')) {
      throw new Error('file must have a valid "username" and bcrypt "passwordHash"');
    }
    const config = loadAuthFile(activeAuthPath(AUTH_CONFIG_PATH)) || { sessionSecret: SESSION_SECRET, users: [] };
    const idx = findUserIndex(config, boot.username);
    if (idx === -1) {
      config.users.push({ username: boot.username, passwordHash: boot.passwordHash, role: 'admin', createdAt: new Date().toISOString() });
    } else {
      config.users[idx] = { ...config.users[idx], passwordHash: boot.passwordHash, role: 'admin' };
    }
    saveUsers(config);
  } catch (err) {
    logSystem(`Admin bootstrap failed (${err.code || 'error'}): ${err.message}`);
    return;
  }
  console.log(`[race-dashboard] Admin bootstrap: "${boot.username}" is now an admin.`);
  appendLog({ time: new Date().toISOString(), user: boot.username, action: 'admin-bootstrap', ip: null });
  try {
    fs.unlinkSync(ADMIN_BOOTSTRAP_PATH);
  } catch (err) {
    logSystem('Admin bootstrap applied, but admin-bootstrap.json could not be deleted -- delete it by FTP.');
  }
}

// --- Activity log -------------------------------------------------------
//
// Who logged in and who downloaded what: one file per month next to
// auth.json, files older than about 3 months deleted automatically (see
// activity-log.js). Writes never block or fail a request.
const ACTIVITY_LOG_DIR = activityLogDir(AUTH_CONFIG_PATH);

// Runs once per month (and at startup): folds in the old single log file
// and deletes months past the retention window.
let logsMaintainedMonth = null;
function maintainLogs(now) {
  const key = monthKey(now);
  if (key === logsMaintainedMonth) return;
  logsMaintainedMonth = key;
  const problems = [migrateLegacyLog(ACTIVITY_LOG_DIR), ...deleteOldMonths(ACTIVITY_LOG_DIR, now)].filter(Boolean);
  problems.forEach((p) => logSystem(p));
}

function appendLog(entry) {
  const now = new Date();
  maintainLogs(now);
  fs.appendFile(monthFilePath(ACTIVITY_LOG_DIR, monthKey(now)), JSON.stringify(entry) + '\n', (err) => {
    if (err) console.warn(`[race-dashboard] Could not write activity log: ${err.message}`);
  });
}

function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
}

// Views repeat a lot (the dashboard reloads itself every 3 minutes), so a
// view with the same dedupeKey by the same user is logged at most once per
// dedupeMs.
const lastLoggedAt = new Map();
function logActivity(req, action, detail, dedupe) {
  if (dedupe) {
    const key = `${req.session && req.session.username}|${action}|${dedupe.key}`;
    const now = Date.now();
    if (now - (lastLoggedAt.get(key) || 0) < dedupe.ms) return;
    lastLoggedAt.set(key, now);
  }
  const entry = {
    time: new Date().toISOString(),
    user: (req.session && req.session.username) || null,
    action,
    ...detail,
    ip: clientIp(req),
  };
  appendLog(entry);
}

// --- Data-change tracking (30 Sep 2026, per Dinesh) ---------------------
//
// Every 2 minutes: compare meetings/races for yesterday..today+2 with the
// last snapshot and log what was added/removed/changed (change-tracker.js).
// Only races whose updatedAt moved are re-read, plus a full re-read every
// 30 minutes in case a scrape changes data without touching updatedAt. A
// date entering the window for the first time is recorded silently, so
// data that already existed isn't reported as "added".
const CHANGE_CHECK_MS = 2 * 60 * 1000;
const CHANGE_FULL_SWEEP_MS = 30 * 60 * 1000;
const CHANGE_SNAPSHOT_PATH = path.join(ACTIVITY_LOG_DIR, 'data-changes-snapshot.json');
const TRACK_MEETING_PROJ = { mDate: 1, mCourse: 1, mCourseDisplayName: 1, mCountry: 1, mDiscipline: 1, mTrack: 1, isAbandoned: 1, numberOfRaces: 1, updatedAt: 1 };
const TRACK_RACE_PROJ = {
  rDate: 1, rCourse: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rScheduleTime: 1, rDistance: 1, rClass: 1,
  isAbandoned: 1, resultString: 1, updatedAt: 1,
  'runners.runnerId': 1, 'runners.tabNo': 1, 'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1,
  'runners.isScratched': 1, 'runners.bp': 1, 'runners.weight': 1,
};

// lastScrapeSeenAt: when this server last saw any meeting/race updatedAt
// move, in its own clock -- the DB's updatedAt strings carry no time zone,
// so they can't be compared with "now" directly.
let tracker = { dates: [], meetings: {}, races: {}, lastCheckAt: null, lastFullAt: 0, lastScrapeSeenAt: null, lastChangeCount: 0 };
try {
  if (fs.existsSync(CHANGE_SNAPSHOT_PATH)) tracker = { ...tracker, ...JSON.parse(fs.readFileSync(CHANGE_SNAPSHOT_PATH, 'utf8')), lastFullAt: 0 };
} catch (err) {
  console.warn(`[race-dashboard] WARNING: Could not read ${CHANGE_SNAPSHOT_PATH} (starting a fresh snapshot): ${err.message}`);
}

function trackedDates() {
  const today = Date.parse(`${todayStr()}T00:00:00Z`);
  return [-1, 0, 1, 2].map((n) => new Date(today + n * 86400000).toISOString().slice(0, 10));
}

let changeCheckRunning = false;
let changeCleanupDate = null;
async function checkDataChanges() {
  if (changeCheckRunning) return;
  changeCheckRunning = true;
  try {
    const db = (await getClient()).db();
    const dates = trackedDates();
    const silent = new Set(dates.filter((d) => !tracker.dates.includes(d)));
    const inWindow = (d) => dates.includes(d);
    const time = new Date().toISOString();
    const full = Date.now() - tracker.lastFullAt >= CHANGE_FULL_SWEEP_MS;
    const entries = [];
    let scrapeSeen = false;

    const meetingDocs = await db.collection('meetings').find({ mDate: { $in: dates }, isHidden: { $ne: true } }).project(TRACK_MEETING_PROJ).toArray();
    const meetings = {};
    meetingDocs.forEach((m) => { meetings[m._id] = meetingSnap(m); });
    for (const id of new Set([...Object.keys(tracker.meetings), ...Object.keys(meetings)])) {
      const prev = tracker.meetings[id];
      const cur = meetings[id];
      const date = (cur || prev).date;
      if (!inWindow(date) || silent.has(date)) continue;
      if (!prev || !cur || prev.updatedAt !== cur.updatedAt) scrapeSeen = true;
      entries.push(...diffMeeting(prev, cur, time));
    }

    const light = await db.collection('races').find({ rDate: { $in: dates }, isHidden: { $ne: true } }).project({ updatedAt: 1 }).toArray();
    const liveIds = new Set(light.map((r) => r._id));
    const toRead = full ? [...liveIds] : light.filter((r) => !tracker.races[r._id] || tracker.races[r._id].updatedAt !== (r.updatedAt || null)).map((r) => r._id);
    const races = { ...tracker.races };
    for (let i = 0; i < toRead.length; i += 500) {
      const docs = await db.collection('races').find({ _id: { $in: toRead.slice(i, i + 500) } }).project(TRACK_RACE_PROJ).toArray();
      for (const doc of docs) {
        const cur = raceSnap(doc);
        const prevSnap = tracker.races[doc._id];
        if (!silent.has(cur.date)) {
          if (!prevSnap || prevSnap.updatedAt !== cur.updatedAt) scrapeSeen = true;
          entries.push(...diffRace(prevSnap, cur, time, doc._id));
        }
        races[doc._id] = cur;
      }
    }
    for (const id of Object.keys(races)) {
      if (liveIds.has(id)) continue;
      const prev = races[id];
      if (inWindow(prev.date) && !silent.has(prev.date)) entries.push(...diffRace(prev, null, time, id));
      delete races[id];
    }

    tracker = {
      dates, meetings, races, lastCheckAt: time, lastFullAt: full ? Date.now() : tracker.lastFullAt,
      lastScrapeSeenAt: scrapeSeen ? time : tracker.lastScrapeSeenAt, lastChangeCount: entries.length,
    };
    if (entries.length) appendChanges(ACTIVITY_LOG_DIR, entries);
    if (entries.length || silent.size || full) fs.writeFileSync(CHANGE_SNAPSHOT_PATH, JSON.stringify(tracker));
    if (changeCleanupDate !== dates[1]) {
      changeCleanupDate = dates[1];
      deleteOldChangeFiles(ACTIVITY_LOG_DIR, dates[1]).forEach((p) => logSystem(p));
    }
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: data-change check failed: ${err.message}`);
  } finally {
    changeCheckRunning = false;
  }
}

// --- System health (30 Sep 2026, per Dinesh; admins only) ---------------
//
// Everything the dashboard depends on, checked live. Results are cached for
// HEALTH_CACHE_MS so several open pages don't re-hit the slow feeds.
const SERVER_STARTED_AT = new Date();
const HEALTH_CACHE_MS = 60 * 1000;
const FEED_SLOW_MS = 20 * 1000;
const SCRAPE_QUIET_WARN_MS = 60 * 60 * 1000;
const CHANGE_CHECK_LATE_MS = 6 * 60 * 1000;
// Files only read at startup: uploading a newer one needs a restart.
const RESTART_FILES = ['server.js', 'raceView.js', 'auth-store.js', 'activity-log.js', 'change-tracker.js', 'views/dashboard.html', 'views/admin.html', 'views/changes.html', 'views/system-health.html'];
let healthCache = null;

function ageText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60} min ago` : `${Math.floor(h / 24)} d ago`;
}

async function timed(fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - start, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

async function fetchFeedRows(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data.length : 0;
}

async function runHealthChecks() {
  const now = Date.now();
  const today = todayStr();
  const checks = [];
  const add = (key, name, status, main, sub) => checks.push({ key, name, status, main, sub });

  const uptimeMs = now - SERVER_STARTED_AT.getTime();
  add('server', 'Dashboard server', 'ok', `Up ${ageText(uptimeMs).replace(' ago', '')}`,
    `Started ${SERVER_STARTED_AT.toISOString()} · memory ${Math.round(process.memoryUsage().rss / 1048576)} MB`);

  const [db, speed, scratch, video] = await Promise.all([
    timed(async () => { await (await getClient()).db().admin().ping(); }),
    timed(() => fetchFeedRows(SPEED_MAP_GREYHOUND_STATS_URL + today)),
    timed(() => fetchFeedRows(SCRATCHINGS_STATS_URL + today)),
    timed(async () => {
      const url = new URL(VIDEO_LIST_URL);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', '1');
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      if (res.status === 403) return 'list-denied'; // files still checked one by one
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return 'listing';
    }),
  ]);
  add('db', 'Database (MongoDB)', db.ok ? (db.ms > 1500 ? 'warn' : 'ok') : 'bad', db.ok ? `${db.ms} ms` : 'Not reachable',
    db.ok ? (db.ms > 1500 ? 'Connected, but slow to answer' : 'Connected') : db.error);

  const seen = tracker.lastScrapeSeenAt ? Date.parse(tracker.lastScrapeSeenAt) : null;
  if (seen) {
    const quiet = now - seen > SCRAPE_QUIET_WARN_MS;
    add('scrape', 'Scraped data', quiet ? 'warn' : 'ok', ageText(now - seen),
      `Last meeting/race update seen ${tracker.lastScrapeSeenAt}${quiet ? ' · nothing updated for over 60 min' : ''}`);
  } else {
    add('scrape', 'Scraped data', uptimeMs > SCRAPE_QUIET_WARN_MS ? 'warn' : 'ok', 'Not seen yet',
      'No meeting/race update seen since the server started');
  }

  const feed = (key, name, r, unit) => add(key, name, r.ok ? (r.ms > FEED_SLOW_MS ? 'warn' : 'ok') : 'bad',
    r.ok ? `${(r.ms / 1000).toFixed(1)} s` : 'Not reachable',
    r.ok ? `${r.ms > FEED_SLOW_MS ? 'Slow (over 20 s) · ' : ''}${r.value} ${unit} today` : r.error);
  feed('speedmap', 'Speed Map feed', speed, 'rows');
  feed('scratchings', 'Scratchings feed', scratch, 'meetings');
  const runnersLast = runnersCheckState.lastRunAt ? Date.parse(runnersCheckState.lastRunAt) : null;
  const runnersLate = !runnersLast || now - runnersLast > RUNNERS_CHECK_EVERY_MS + 60 * 60 * 1000;
  const ns = runnersCheckState.stats;
  const usedSource = runnersSourceLabel(runnersCheckState.source);
  add('runners', 'Runner check (RAS / Neds)', runnersCheckRunning ? 'ok' : (runnersCheckState.error || (runnersLate && uptimeMs > 5 * 60 * 1000) ? 'warn' : 'ok'),
    runnersCheckRunning ? 'Running now' : (runnersLast ? ageText(now - runnersLast) : 'Not run yet'),
    runnersCheckState.error ? `Last try failed (both sources): ${runnersCheckState.error} · retrying hourly${runnersLast ? ` · last good check ${ageText(now - runnersLast)}` : ''}`
      : ns ? `Every 8 h, RAS + Neds together · last with ${usedSource || '?'}${runnersCheckState.fallbackReason ? ` (other source failed: ${runnersCheckState.fallbackReason})` : ''} · ${ns.racesChecked} races in ${ns.meetings} meetings checked${ns.bySource ? ` (RAS ${ns.bySource.ras == null ? '-' : ns.bySource.ras}, Neds ${ns.bySource.neds == null ? '-' : ns.bySource.neds})` : ''}, ${ns.racesWithDifferences} with differences`
        : 'First run starts a minute after the server starts');
  const jc = jockeyCheckState;
  const jockeyLast = jc.lastRunAt ? Date.parse(jc.lastRunAt) : null;
  const nedsPaused = (jc.nedsPausedUntil || 0) > now;
  add('jockeys', 'Jockey check (Neds)', jockeyCheckRunning ? 'ok' : (nedsPaused || jc.error ? 'warn' : 'ok'),
    jockeyCheckRunning ? 'Running now' : (jockeyLast ? ageText(now - jockeyLast) : 'Not run yet'),
    nedsPaused ? `Neds website paused until ${new Date(jc.nedsPausedUntil).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} -- it ${jc.nedsPauseReason || 'asked us to slow down'}`
      : jc.error ? `Last run failed: ${jc.error}`
        : jockeyLast ? `Every ${JOCKEY_CHECK_EVERY_MS / 3600000} h · ${jc.racesWanted} races in the next 24 h missing a jockey, ${jc.racesChecked} checked on Neds, ${jc.jockeysFound} jockeys found`
          : 'First run starts two minutes after the server starts');
  // The full "can't be checked" message lives here only (9 Oct 2026, per
  // Dinesh: System Health, admins only) -- the dashboard just marks today's
  // races Missing Video as before.
  const videoFail = videoCheckErrors.get(today);
  const cantCheck = (why) => `Race videos can't be checked right now -- ${why}. Today's Thoroughbred races in ${[...VIDEO_COUNTRIES].join('/')} show Missing Video until it works again, and video buttons won't show${videoFail ? ` (last failed check ${videoFail.at})` : ''}.`;
  if (!video.ok || videoFail) {
    add('video', 'Race video storage (S3)', 'bad', 'Not reachable', cantCheck(videoFail ? videoFail.error : `the video storage answered ${video.error}`));
  } else if (video.value === 'list-denied') {
    // Listing refused but files readable: checked race by race (9 Oct 2026).
    add('video', 'Race video storage (S3)', 'warn', `${(video.ms / 1000).toFixed(1)} s`,
      'Folder listing refused (HTTP 403 Access Denied) -- videos are checked race by race instead, so the check is slower; the KEMPTON / KEMPTON PARK style name matching only covers "... PARK"');
  } else {
    add('video', 'Race video storage (S3)', 'ok', `${(video.ms / 1000).toFixed(1)} s`, 'Video listing reachable');
  }

  const lastCheck = tracker.lastCheckAt ? Date.parse(tracker.lastCheckAt) : null;
  add('changes', 'Data Changes check', lastCheck && now - lastCheck <= CHANGE_CHECK_LATE_MS ? 'ok' : (uptimeMs < 60000 ? 'ok' : 'warn'),
    lastCheck ? ageText(now - lastCheck) : 'Not run yet',
    lastCheck ? `Runs every ${CHANGE_CHECK_MS / 60000} min · last found ${tracker.lastChangeCount} change${tracker.lastChangeCount === 1 ? '' : 's'}` : 'Starts a few seconds after the server starts');

  const probe = path.join(ACTIVITY_LOG_DIR, '.health-write-test');
  const writable = await timed(async () => { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); });
  const users = authConfig ? authConfig.users : [];
  add('logins', 'Logins & logs', writable.ok && users.length ? 'ok' : 'bad', `${users.length} user${users.length === 1 ? '' : 's'}`,
    `${users.filter((u) => u.role === 'admin').length} admin · using ${path.basename(activeAuthPath(AUTH_CONFIG_PATH))} · ` +
    (writable.ok ? 'server can save users and logs' : `server can't write its folder: ${writable.error}`));

  const stale = [];
  let newest = 0;
  for (const rel of RESTART_FILES) {
    try {
      const m = fs.statSync(path.join(__dirname, rel)).mtimeMs;
      newest = Math.max(newest, m);
      if (m > SERVER_STARTED_AT.getTime()) stale.push(rel);
    } catch (e) { /* a file this build doesn't have */ }
  }
  let cssTime = null;
  try { cssTime = fs.statSync(path.join(__dirname, 'public', 'styles.css')).mtime.toISOString(); } catch (e) { /* none */ }
  add('deploy', 'Deployed code', stale.length ? 'warn' : 'ok', newest ? new Date(newest).toISOString() : '-',
    stale.length ? `Uploaded after the server started, restart WinSW to load: ${stale.join(', ')}` : `Latest code file upload${cssTime ? ` · styles.css ${cssTime}` : ''}`);

  const bad = checks.filter((c) => c.status === 'bad');
  const warn = checks.filter((c) => c.status === 'warn');
  const overall = bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
  const summary = overall === 'ok' ? 'All systems OK'
    : [bad.length ? `${bad.length} down` : '', warn.length ? `${warn.length} warning${warn.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  return { checkedAt: new Date().toISOString(), overall, summary, problems: [...bad, ...warn].map((c) => c.name), checks };
}

async function getHealth(fresh) {
  if (!fresh && healthCache && Date.now() - Date.parse(healthCache.checkedAt) < HEALTH_CACHE_MS) return healthCache;
  healthCache = await runHealthChecks();
  return healthCache;
}

// Falls back to a random per-process secret if login isn't set up yet, so
// the session middleware always has something to sign cookies with -- those
// sessions just won't matter since login is blocked anyway until setup runs.
const SESSION_SECRET = (authConfig && authConfig.sessionSecret) || crypto.randomBytes(32).toString('hex');

// TAB/Non-TAB lives on the `meetings` collection (`isTAB`), not on the race
// document itself -- join it in here via `meetingId`. Returns a Map of
// meetingId -> { isTAB } (defaults to true for missing/unknown meetings so
// they still render normally rather than vanishing under the TAB filter).
async function fetchMeetingExtrasByMeetingId(meetingIds) {
  const map = new Map();
  if (!meetingIds.length) return map;
  const client = await getClient();
  const meetingDocs = await client.db().collection('meetings')
    .find({ _id: { $in: meetingIds } })
    // rsMeetingId (21 Sep 2026, per Dinesh) -- the external speed-map stats
    // service's own meeting id, needed by attachSpeedMapStatus below to
    // join its per-race EventID ("<rsMeetingId>:<raceNo>") back to one of
    // OUR races. tabMeetingId (21 Sep 2026, per Dinesh) -- a DIFFERENT
    // external id, needed by attachScratchingStatus below to join the
    // scratchings feed's "MeetingID" the same way.
    .project({ _id: 1, isTAB: 1, isHidden: 1, rsMeetingId: 1, tabMeetingId: 1 })
    .toArray();
  for (const m of meetingDocs) map.set(m._id, { isTAB: m.isTAB !== false, isHidden: m.isHidden === true, rsMeetingId: m.rsMeetingId || null, tabMeetingId: m.tabMeetingId || null });
  return map;
}

// Lightweight fetch for the "Meetings List" date-RANGE view (7 Sep 2026,
// per Dinesh -- see raceView.js's renderMeetingsListPage). Deliberately
// does NOT project runners at all -- that view shows no issue detection
// (just meeting/race-count/TAB/trial/abandoned), so skipping the runner
// fields (and the racecards/video joins fetchRaceDocs does for the single-
// date dashboard) keeps a wide date range fast. `doc.runners = []` is set
// so buildSchedule()/buildMeetingsListReport() -- built assuming runners
// exist -- still run cleanly (their issue counts just come back 0/null,
// which this view doesn't render anyway).
async function fetchRaceDocsForDateRange(fromDate, toDate, includeTrials) {
  const client = await getClient();
  // isHidden (16 Sep 2026, per Dinesh) -- the upstream provider's own flag
  // for races it doesn't want published (hiddenReason samples: "Non-TAB",
  // "Extra race", "Abandoned"/"Abended"), left unfiltered until now so
  // these were showing on the dashboard/meetings-list/exports right
  // alongside real races.
  const filter = { rDate: { $gte: fromDate, $lte: toDate }, isHidden: { $ne: true } };
  if (!includeTrials) filter.isTrail = false;

  const docs = await client.db().collection('races')
    .find(filter)
    .project({
      _id: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rScheduleTime: 1,
      meetingId: 1, rStatus: 1, isOpen: 1, isAbandoned: 1, isTrail: 1, resultString: 1, rDate: 1,
    })
    .toArray();

  const meetingIds = [...new Set(docs.map((d) => d.meetingId).filter(Boolean))];
  const meetingExtrasByMeetingId = await fetchMeetingExtrasByMeetingId(meetingIds);
  const visibleDocs = [];
  for (const doc of docs) {
    const extras = meetingExtrasByMeetingId.get(doc.meetingId);
    // A race not individually flagged isHidden can still belong to a
    // meeting the provider hid outright (confirmed 16 Sep 2026 -- several
    // meetings were isHidden:true with no race-level flag to match), so
    // the meeting's own isHidden is checked too, not just the race's.
    if (extras && extras.isHidden) continue;
    doc.isTAB = extras ? extras.isTAB : true;
    doc.runners = [];
    visibleDocs.push(doc);
  }
  return visibleDocs;
}

// Race-replay videos (1 Sep 2026, per Dinesh) -- uploaded to an S3-compatible
// bucket as `client1/{date}/{country}_{course with spaces->underscores}_race
// {rNo}_{date}.mp4` (verified against a real file: AUS_SCONE_race5_2026-09-
// 01.mp4). Only produced for Thoroughbred races in AUS/GB/SAF/IRE so far --
// confirmed the DB's own `rCountry` values match these exact codes. The
// bucket supports a normal S3 ListObjectsV2 listing, so this fetches the
// WHOLE date's folder in one request (paginating if needed) rather than
// probing every race individually with its own HTTP call.
const VIDEO_LIST_URL = 'https://s3.troyendata.com/rob-rp-videos/';
const VIDEO_COUNTRIES = new Set(['AUS', 'GB', 'SAF', 'IRE']);

// The three external feeds are fetched once per date and shared by the
// dashboard, every race popup and the health page (see cached()).
const FEED_FRESH_MS = 2 * 60 * 1000;
const FEED_STALE_MS = 10 * 60 * 1000;

function listVideoKeysForDate(dateStr) {
  return cached(`feed-video|${dateStr}`, FEED_FRESH_MS, FEED_STALE_MS, () => loadVideoKeysForDate(dateStr));
}

async function loadVideoKeysForDate(dateStr) {
  const keys = new Set();
  let continuationToken = null;
  do {
    const url = new URL(VIDEO_LIST_URL);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', `client1/${dateStr}/`);
    url.searchParams.set('max-keys', '1000');
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (res.status === 403) throw Object.assign(new Error('the video storage answered HTTP 403 (Access Denied) to the folder listing'), { listDenied: true });
    if (!res.ok) throw new Error(`the video storage answered HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.add(m[1]);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : null;
  } while (continuationToken);
  return keys;
}

// Checks every non-trial Thoroughbred race in the eligible countries against
// the day's video listing, regardless of whether it's resulted yet (1 Sep
// 2026, per Dinesh -- an upcoming race can already have its video uploaded,
// and this is one listing call for the whole date either way, so there's no
// cost to checking all of them rather than only finished ones). Attaches
// `doc.hasVideo`/`doc.videoUrl` to every checked race. Whether a *missing*
// video counts as a real problem (vs. just "hasn't run yet") is decided
// downstream in raceView.js's buildSchedule, which only flags it once the
// race also has a result -- this function itself doesn't gate on that.
// When videos can't be checked at all, the races are marked as having no
// video, so today's show Missing Video as before (9 Oct 2026, per Dinesh:
// "Previous kaattuna madhiri wenu"); the reason is on System Health only,
// kept here per date.
const videoCheckErrors = new Map(); // dateStr -> { error, at }

// Folder listing refused (9 Oct 2026): the bucket started answering 403 to
// the listing while every file stays publicly readable, so each race's own
// file is checked with a HEAD request instead. A file found is remembered
// for 12 hours; one not there yet is re-checked after 3 minutes for today
// and later (it may be uploaded any moment), 6 hours for past days. The
// listing is tried again every 10 minutes.
const VIDEO_LIST_RETRY_MS = 10 * 60 * 1000;
const VIDEO_FOUND_TTL_MS = 12 * 60 * 60 * 1000;
const VIDEO_MISSING_TTL_MS = 3 * 60 * 1000;
const VIDEO_MISSING_PAST_TTL_MS = 6 * 60 * 60 * 1000;
let videoListDeniedUntil = 0;
const videoFileCache = new Map(); // key -> { exists, at } | { pending }

async function videoFileExists(key, dateStr) {
  const hit = videoFileCache.get(key);
  if (hit && hit.pending) return hit.pending;
  const missingTtl = dateStr < todayStr() ? VIDEO_MISSING_PAST_TTL_MS : VIDEO_MISSING_TTL_MS;
  if (hit && Date.now() - hit.at < (hit.exists ? VIDEO_FOUND_TTL_MS : missingTtl)) return hit.exists;
  const pending = fetch(`${VIDEO_LIST_URL}${key}`, { method: 'HEAD', signal: AbortSignal.timeout(10000) }).then((res) => {
    if (res.ok) return true;
    // 404, or 403 for a file that isn't there when listing is refused.
    if (res.status === 404 || res.status === 403) return false;
    throw new Error(`the video storage answered HTTP ${res.status}`);
  });
  videoFileCache.set(key, { pending });
  try {
    const exists = await pending;
    videoFileCache.set(key, { exists, at: Date.now() });
    if (videoFileCache.size > 20000) {
      for (const [k, v] of videoFileCache) if (v.at && Date.now() - v.at > VIDEO_FOUND_TTL_MS) videoFileCache.delete(k);
    }
    return exists;
  } catch (err) {
    if (hit) videoFileCache.set(key, hit); else videoFileCache.delete(key);
    throw err;
  }
}

// File names to try for a race when there's no listing to match against:
// ours, then with " PARK" added for GB/IRE (ours KEMPTON, the file
// GB_KEMPTON_PARK_... -- see similarVideoKey).
function videoKeyCandidates(dateStr, doc) {
  const keys = [buildVideoKey(dateStr, doc.rCountry, doc.rCourseDisplayName, doc.rNo)];
  if ((doc.rCountry === 'GB' || doc.rCountry === 'IRE') && !/\bPARK$/i.test(String(doc.rCourseDisplayName || '').trim())) {
    keys.push(buildVideoKey(dateStr, doc.rCountry, `${doc.rCourseDisplayName} PARK`, doc.rNo));
  }
  return keys;
}

// The day's listing, or null when the storage refuses listings (then files
// are checked one by one).
async function videoKeysOrNull(dateStr) {
  if (Date.now() < videoListDeniedUntil) return null;
  try {
    return await listVideoKeysForDate(dateStr);
  } catch (err) {
    if (!err.listDenied) throw err;
    videoListDeniedUntil = Date.now() + VIDEO_LIST_RETRY_MS;
    console.warn(`[race-dashboard] WARNING: race video listing refused (${err.message}) -- checking each race's file instead`);
    return null;
  }
}

// One race's video key, or null.
async function findVideoKey(dateStr, doc, existingKeys) {
  if (existingKeys) {
    const exact = buildVideoKey(dateStr, doc.rCountry, doc.rCourseDisplayName, doc.rNo);
    return existingKeys.has(exact) ? exact : similarVideoKey(existingKeys, dateStr, doc);
  }
  for (const key of videoKeyCandidates(dateStr, doc)) {
    if (await videoFileExists(key, dateStr)) return key;
  }
  return null;
}

async function attachVideoStatus(docs, dateStr) {
  const eligible = docs.filter((d) => d.rDiscipline === 'T' && VIDEO_COUNTRIES.has(d.rCountry) && !d.isTrail);
  if (!eligible.length) return;

  try {
    const existingKeys = await videoKeysOrNull(dateStr);
    // Up to 8 file checks at a time when there's no listing.
    let next = 0;
    await Promise.all(Array.from({ length: existingKeys ? 1 : 8 }, async () => {
      while (next < eligible.length) {
        const doc = eligible[next++];
        const key = await findVideoKey(dateStr, doc, existingKeys);
        doc.hasVideo = Boolean(key);
        if (key) doc.videoUrl = `${VIDEO_LIST_URL}${key}`;
      }
    }));
    videoCheckErrors.delete(dateStr);
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: could not check race videos for ${dateStr}: ${err.message}`);
    videoCheckErrors.set(dateStr, { error: err.message, at: new Date().toISOString() });
    for (const doc of eligible) if (doc.hasVideo !== true) doc.hasVideo = false;
  }
}

// The video can be named a little differently from our course -- ours
// KEMPTON, the file GB_KEMPTON_PARK_race1_... (5 Oct 2026, per Dinesh:
// "ipdi vanda ada anda meeting nameku podunga"). Same date, country and race
// number, and a course name with every word of ours (sameCourse); used only
// when exactly one course like that has videos that day.
function similarVideoKey(existingKeys, dateStr, doc) {
  const prefix = `client1/${dateStr}/${doc.rCountry}_`;
  const suffix = `_race${doc.rNo}_${dateStr}.mp4`;
  const hits = [...existingKeys].filter((k) => k.startsWith(prefix) && k.endsWith(suffix)
    && sameCourseName(doc.rCourseDisplayName, k.slice(prefix.length, k.length - suffix.length).replace(/_/g, ' ')));
  return hits.length === 1 ? hits[0] : null;
}

function buildVideoKey(dateStr, country, course, raceNo) {
  const courseKey = String(course || '').trim().replace(/\s+/g, '_');
  return `client1/${dateStr}/${country}_${courseKey}_race${raceNo}_${dateStr}.mp4`;
}

// Greyhound speed-map ("pace") predictions come from an external stats
// service (21 Sep 2026, per Dinesh: "Idu da Speed map varra source"). Each
// row there carries an EventID shaped "<rsMeetingId>:<raceNo>" -- and
// meetings.rsMeetingId is that EXACT same id already stored against our
// own meeting docs (verified against a real DUBBO meeting: rsMeetingId
// "527050139" matched EventID "527050139:6" for race 6). So a race present
// in this feed but with no matching doc in our own `speedMaps` collection
// is a genuine sync gap -- not just "no prediction made yet" -- and gets
// flagged as "Missing Speed Map", the same way attachVideoStatus above
// flags a genuinely missing video rather than one that just hasn't been
// uploaded.
const SPEED_MAP_GREYHOUND_STATS_URL = 'http://57.181.204.168:8085/getStatsGrey/';

function fetchGreyhoundSpeedMapEventKeys(dateStr) {
  return cached(`feed-speedmap|${dateStr}`, FEED_FRESH_MS, FEED_STALE_MS, () => loadGreyhoundSpeedMapEventKeys(dateStr));
}

async function loadGreyhoundSpeedMapEventKeys(dateStr) {
  // A bigger timeout than the video listing's above -- this returns every
  // runner-row for every Greyhound race that date (thousands of rows) in
  // one response, confirmed to genuinely take 8+ seconds even on a plain
  // curl (21 Sep 2026), not just slow from this dev box.
  const res = await fetch(SPEED_MAP_GREYHOUND_STATS_URL + dateStr, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Speed map stats request failed (${res.status})`);
  const json = await res.json();
  const rows = Array.isArray(json.data) ? json.data : [];
  const keys = new Set();
  for (const row of rows) {
    if (row && row.EventID) keys.add(String(row.EventID));
  }
  return keys;
}

async function attachSpeedMapStatus(docs, dateStr) {
  // Only Greyhound races have this external source -- `doc.rsMeetingId` is
  // attached in fetchRaceDocs from fetchMeetingExtrasByMeetingId above;
  // no id, no way to build the EventID key, so nothing to check.
  const eligible = docs.filter((d) => d.rDiscipline === 'G' && !d.isTrail && d.rsMeetingId);
  if (!eligible.length) return;

  let upstreamKeys;
  try {
    upstreamKeys = await fetchGreyhoundSpeedMapEventKeys(dateStr);
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: could not fetch greyhound speed map stats for ${dateStr}: ${err.message} -- skipping speed map check`);
    return;
  }

  const client = await getClient();
  const raceIds = eligible.map((d) => d._id);
  const speedMapDocs = await client.db().collection('speedMaps').find({ rId: { $in: raceIds } }, { projection: { rId: 1 } }).toArray();
  const syncedRaceIds = new Set(speedMapDocs.map((s) => s.rId));

  for (const doc of eligible) {
    const eventKey = `${doc.rsMeetingId}:${doc.rNo}`;
    doc.missingSpeedMap = upstreamKeys.has(eventKey) && !syncedRaceIds.has(doc._id);
  }
}

// Scratchings feed (21 Sep 2026, per Dinesh: "Inda Page'la irundu da
// Scratchings varudu... vanda scratchings ella update aagi irukkanu check
// pannunga, idula irukka scratchings update aagi illan na, warning
// kaattunga"). A different external id space than the speed-map source
// above: each meeting here carries a numeric "MeetingID" that matches
// meetings.tabMeetingId (NOT rsMeetingId) -- verified against real
// meetings (21 Sep 2026: ANGERS FR's tabMeetingId "469588" matched
// MeetingID 469588; Angle Park AUS and FFOS LAS GB matched the same way).
// Also covers ALL disciplines (Thoroughbred/Harness/Greyhound), unlike the
// Greyhound-only speed map feed above. A runner listed there as scratched
// (matched to one of OUR race's runners by tab/box number) but not yet
// marked isScratched in our own race doc is a genuine sync gap, flagged
// "Scratching Not Updated" the same way as the other external-source
// checks. An external RunnerNo with no match in our own runners list
// (checked 21 Sep 2026: several Yonkers Raceway harness races list a
// scratched runner numbered 9, one past our field of 8) is a reserve/
// emergency runner never part of our own field, not a sync gap -- skipped
// rather than flagged.
const SCRATCHINGS_STATS_URL = 'http://57.181.204.168:8085/getScratchingsGrey/';

// The day's feed meetings, shared by the scratching check below and the
// Missing Meetings page. Fresher than the other feeds: a scratching is
// time-critical.
function fetchScratchingsFeed(dateStr) {
  return cached(`feed-scratchings|${dateStr}`, 60 * 1000, 5 * 60 * 1000, () => loadScratchingsFeed(dateStr));
}

// The feed often answers 504 "Upstream timed out after 15s" and then works
// on the next try (seen 1 Oct 2026), so one failed request is retried.
async function loadScratchingsFeed(dateStr) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(SCRATCHINGS_STATS_URL + dateStr, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`Scratchings request failed (${res.status})`);
      const json = await res.json();
      return Array.isArray(json.data) ? json.data : [];
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchScratchingsByMeetingRace(dateStr) {
  const meetings = await fetchScratchingsFeed(dateStr);
  const map = new Map(); // "<tabMeetingId>:<raceNo>" -> [{RunnerNo, Runner}, ...]
  for (const m of meetings) {
    if (!m || m.MeetingID == null || !m.races) continue;
    for (const raceNoStr of Object.keys(m.races)) {
      const entry = m.races[raceNoStr];
      if (entry && Array.isArray(entry.scratchings) && entry.scratchings.length) {
        map.set(`${m.MeetingID}:${raceNoStr}`, entry.scratchings);
      }
    }
  }
  return map;
}

async function attachScratchingStatus(docs, dateStr) {
  const eligible = docs.filter((d) => !d.isTrail && d.tabMeetingId);
  if (!eligible.length) return;

  let scratchingsByKey;
  try {
    scratchingsByKey = await fetchScratchingsByMeetingRace(dateStr);
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: could not fetch scratchings for ${dateStr}: ${err.message} -- skipping scratching check`);
    return;
  }

  for (const doc of eligible) {
    const scratchings = scratchingsByKey.get(`${doc.tabMeetingId}:${doc.rNo}`);
    if (!scratchings) { doc.missingScratching = false; continue; }
    const unsynced = [];
    for (const scr of scratchings) {
      const runner = (doc.runners || []).find((r) => r.tabNo === scr.RunnerNo);
      if (runner && !runner.isScratched) {
        unsynced.push(runner.horseName || scr.Runner);
        // Per-runner flag (22 Sep 2026, per Dinesh: "Scratching update aagi
        // illanna warning waranu... runner name pakkathula like Age, Formline
        // issues") -- buildRaceDetail (raceView.js) reads this to show
        // "Scratching Not Updated" in the same per-runner Issue column as
        // the other checks, not just the race-level grid flag above.
        runner.missingScratching = true;
      }
    }
    doc.missingScratching = unsynced.length > 0;
    doc.missingScratchingNames = unsynced;
  }
}

// --- Runners check (2 Oct 2026, per Dinesh) -------------------------------
// Runners from two sources compared with ours (see runners-check.js), for
// today to 2 days ahead, every 8 hours ("Per day 3 times check panna podu 8
// hours once"): AUS + NZ for every code, plus the Missing Meetings
// countries for thoroughbred. Both sources are read in every run, at the
// same time, and the differences from both are shown, tagged by source (see
// mergeRunnerChecks; 8 Oct 2026 -- before that they took turns). When one fails, the other's
// result is used alone. The RAS API is one request per day; the Neds
// website is one page per day plus one per race we have (two at a time).
// Races already resulted are skipped. The result is kept in memory and in
// runners-check-state.json (so a restart doesn't trigger an extra run), and
// attachRunnersCheck() reads it for the grid and the race popup -- nothing
// waits on a source during a page load. A "Check now" button runs it on
// demand, at most once every 10 minutes.
const RUNNERS_CHECK_EVERY_MS = 8 * 60 * 60 * 1000;
const RUNNERS_CHECK_RETRY_MS = 60 * 60 * 1000; // after a failed run
const RUNNERS_CHECK_MANUAL_GAP_MS = 10 * 60 * 1000;
const RUNNERS_CHECK_STATE_PATH = path.join(ACTIVITY_LOG_DIR, 'runners-check-state.json');
const RUNNERS_API_TIMEOUT_MS = 60 * 1000;
const RUNNERS_SOURCES = { ras: 'RAS API', neds: 'Neds website' };
let runnersCheckState = { lastRunAt: null, lastAttemptAt: null, durationMs: null, dates: [], stats: null, error: null, races: {}, source: null, fallbackReason: null, trigger: null };
let runnersCheckRunning = false;
try {
  if (fs.existsSync(RUNNERS_CHECK_STATE_PATH)) runnersCheckState = { ...runnersCheckState, ...JSON.parse(fs.readFileSync(RUNNERS_CHECK_STATE_PATH, 'utf8')) };
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${RUNNERS_CHECK_STATE_PATH}: ${err.message} -- next runners check starts fresh`);
}

// Node's fetch only says "fetch failed"; the reason is on err.cause.
function networkReason(err) {
  const code = err && err.cause && (err.cause.code || err.cause.name);
  if (code) return `${err.message} (${code})`;
  if (err && err.name === 'TimeoutError') return `no answer within ${RUNNERS_API_TIMEOUT_MS / 1000} s`;
  return String((err && err.message) || err);
}

async function fetchSource(label, url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(RUNNERS_API_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${label} not reachable: ${networkReason(err)}`);
  }
  if (!res.ok) throw new Error(`${label} answered ${res.status}`);
  return res;
}

// --- Neds website politeness (5 Oct 2026, per Dinesh: "Ipdi panna inda site
// enga IP block pannuma?") -------------------------------------------------
// Every Neds page goes through fetchNeds(): a gap between requests, and if
// the site ever answers 429 (too many) or 403 (blocked) every Neds request
// stops for 6 hours -- so we back off long before a real block. The pause is
// kept in jockey-check-state.json and shown on System Health.
const NEDS_PAUSE_MS = 6 * 60 * 60 * 1000;
const JOCKEY_CHECK_EVERY_MS = 3 * 60 * 60 * 1000; // 5 Oct 2026: 3 h for now; Dinesh will ask for 2 h later
const JOCKEY_CHECK_STATE_PATH = path.join(ACTIVITY_LOG_DIR, 'jockey-check-state.json');
let jockeyCheckState = { lastRunAt: null, durationMs: null, error: null, racesWanted: 0, racesChecked: 0, jockeysFound: 0, issues: 0, nedsPausedUntil: 0, nedsPauseReason: null };
let jockeyCheckRunning = false;
try {
  if (fs.existsSync(JOCKEY_CHECK_STATE_PATH)) jockeyCheckState = { ...jockeyCheckState, ...JSON.parse(fs.readFileSync(JOCKEY_CHECK_STATE_PATH, 'utf8')) };
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${JOCKEY_CHECK_STATE_PATH}: ${err.message} -- starting fresh`);
}
function saveJockeyCheckState() {
  try { fs.writeFileSync(JOCKEY_CHECK_STATE_PATH, JSON.stringify(jockeyCheckState), 'utf8'); } catch (err) { /* in-memory state still works */ }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchNeds(url) {
  if (Date.now() < (jockeyCheckState.nedsPausedUntil || 0)) {
    throw Object.assign(new Error(`${RUNNERS_SOURCES.neds} paused until ${new Date(jockeyCheckState.nedsPausedUntil).toISOString()} (it asked us to slow down)`), { paused: true });
  }
  let res;
  try {
    res = await fetch(url, { headers: NEDS_SITE_HEADERS, signal: AbortSignal.timeout(RUNNERS_API_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${RUNNERS_SOURCES.neds} not reachable: ${networkReason(err)}`);
  }
  if (res.status === 429 || res.status === 403) {
    jockeyCheckState.nedsPausedUntil = Date.now() + NEDS_PAUSE_MS;
    jockeyCheckState.nedsPauseReason = `answered ${res.status} at ${new Date().toISOString()}`;
    saveJockeyCheckState();
    console.warn(`[race-dashboard] WARNING: ${RUNNERS_SOURCES.neds} answered ${res.status} -- pausing all Neds requests for 6 hours`);
    throw Object.assign(new Error(`${RUNNERS_SOURCES.neds} answered ${res.status} -- paused for 6 hours`), { paused: true });
  }
  if (!res.ok) throw new Error(`${RUNNERS_SOURCES.neds} answered ${res.status}`);
  return res.text();
}

// Race pages, a few workers, a gap after each request. Stops at once when
// the site asks us to slow down.
async function fetchNedsRaceRunners(jobs, { workers, gapMs, stats }) {
  let next = 0;
  let stopped = null;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < jobs.length && !stopped) {
      const job = jobs[next++];
      try {
        job.nr.runners = parseNedsSiteRunners(await fetchNeds(`${NEDS_SITE_BASE}/form/${encodeURIComponent(job.nr.id)}`));
      } catch (err) {
        if (err.paused) stopped = err;
        else stats.pageErrors++;
      }
      if (!stopped) await sleep(gapMs);
    }
  }));
  if (stopped) throw stopped;
}

// Both sources every run, at the same time (8 Oct 2026, per Dinesh: "NEDS
// and RAS same time check pannunga"). Every difference from either source is
// shown, tagged with where it came from (item.src: ras / neds / both) -- "NEDS
// mismatches irundalu kaattunga, Ignore option irukku": a Neds-only one that
// turns out fine gets ignored. The same difference from both shows once.
// Neds' own rules still apply (a runner of ours it doesn't list is not an
// issue -- see compareRunners' fromNeds).
function unionRunnerItems(a, b) {
  const out = a.map((it) => ({ ...it }));
  for (const it of b) {
    const same = out.find((x) => x.field === it.field && x.tab === it.tab && x.text === it.text);
    if (same) same.src = same.src === it.src ? same.src : 'both';
    else out.push({ ...it });
  }
  return out;
}

function mergeRunnerChecks(ras, neds) {
  const races = {};
  const ids = new Set([...Object.keys(ras ? ras.races : {}), ...Object.keys(neds ? neds.races : {})]);
  for (const id of ids) {
    const r = ras && ras.races[id];
    const n = neds && neds.races[id];
    if (!r || !n) { races[id] = r || n; continue; }
    races[id] = { ...r, items: unionRunnerItems(r.items, n.items), source: 'ras+neds' };
  }
  const entries = Object.values(races);
  const pick = (k) => [ras, neds].filter(Boolean).map((x) => x.stats[k]);
  return {
    races,
    stats: {
      meetings: Math.max(...pick('meetings')),
      meetingsNotInDb: (ras || neds).stats.meetingsNotInDb,
      racesChecked: entries.length,
      racesWithDifferences: entries.filter((e) => e.items.length).length,
      differences: entries.reduce((s, e) => s + e.items.length, 0),
      pageErrors: neds ? neds.stats.pageErrors : 0,
      bySource: { ras: ras ? ras.stats.racesChecked : null, neds: neds ? neds.stats.racesChecked : null },
    },
  };
}

// "RAS API + Neds website", or the one that answered.
function runnersSourceLabel(source) {
  return source === 'both' ? `${RUNNERS_SOURCES.ras} + ${RUNNERS_SOURCES.neds}` : (RUNNERS_SOURCES[source] || null);
}

// AUS + NZ for every code, plus the Missing Data countries for thoroughbred.
function runnersCheckScope() {
  const extraCountries = new Set(missingMeetingCountries);
  return {
    countries: ['AUS', 'NZ', 'NZL', ...extraCountries],
    inScope: (country, discipline) => country === 'AUS' || country === 'NZ' || (discipline === 'T' && extraCountries.has(country)),
  };
}

// Our races, yesterday to 2 days ahead (yesterday only so overseas Neds
// meetings can be told apart -- see matchSourceRaces).
async function loadRunnersCheckRaces(countries) {
  return (await getClient()).db().collection('races')
    .find({ rDate: { $in: trackedDates() }, rCountry: { $in: countries }, isHidden: { $ne: true }, isTrail: { $ne: true } })
    .project({
      rDate: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rScheduleTimeUTC: 1, resultString: 1,
      'runners.tabNo': 1, 'runners.horseName': 1, 'runners.isScratched': 1, 'runners.jockey': 1, 'runners.weight': 1,
    })
    .toArray();
}

// One source's meeting lists for the given days, merged (a meeting can be
// listed under the day before its local date on the RAS API). The same
// track + day can also be listed twice on one page -- the Neds website had
// two "Globe Derby" meetings on 7 Oct 2026, one with R3 and a second R4 --
// so same-key meetings are merged race by race rather than the later one
// dropped (dropping it lost the real R1-R8 and paired our R4 with the
// wrong one).
async function fetchSourceMeetings(source, listDates, keepDates, inScope) {
  const byKey = new Map();
  for (const dateStr of listDates) {
    const list = source === 'ras'
      ? parseRunnerMeetings(await (await fetchSource(RUNNERS_SOURCES.ras, `${RUNNERS_API_URL}?date=${dateStr}`)).json())
      : parseNedsSiteMeetings(await fetchNeds(`${NEDS_SITE_BASE}/${dateStr}`));
    for (const m of list) {
      if (!keepDates.includes(m.date) || !inScope(m.country, m.discipline)) continue;
      const key = `${m.date}|${m.country}|${m.discipline}|${m.track}`;
      const kept = byKey.get(key);
      if (!kept) { byKey.set(key, { ...m, races: [...m.races] }); continue; }
      for (const nr of m.races) {
        const dup = kept.races.some((k) => (k.id && k.id === nr.id) || (k.rNo === nr.rNo && (k.start || null) === (nr.start || null)));
        if (!dup) kept.races.push(nr);
      }
    }
    if (source === 'neds') await sleep(1000);
  }
  return [...byKey.values()];
}

// Two source races can carry the same number (see fetchSourceMeetings);
// ours pairs with the one starting closest to it. One that starts over 3
// hours from ours is a different race, not ours, and is left out.
const MAX_RACE_START_GAP_MS = 3 * 60 * 60 * 1000;
function pickSourceRace(candidates, race) {
  const ourStart = Date.parse(race.rScheduleTimeUTC || '');
  if (isNaN(ourStart)) return candidates[0];
  const gap = (nr) => (nr.start ? Math.abs(nr.start - ourStart) : null);
  const timed = candidates.filter((nr) => gap(nr) != null).sort((a, b) => gap(a) - gap(b));
  if (timed.length && gap(timed[0]) <= MAX_RACE_START_GAP_MS) return timed[0];
  return candidates.find((nr) => gap(nr) == null) || null;
}

// Source meetings -> [{ race (ours), nr (theirs), date }] for races not yet
// resulted on the given dates.
function matchSourceRaces(sourceMeetings, dbRaces, dates, stats) {
  const jobs = [];
  const MAX_DATE_OFFSET_MS = 6 * 60 * 60 * 1000;
  for (const m of sourceMeetings) {
    // Overseas meetings on the Neds website: the site dates them by the AUS
    // day (Canada's 2 Oct evening shows as 3 Oct), so the meeting's date in
    // ours is the one whose races, number by number, start closest to the
    // source's (median gap, within 6 hours) -- our UTC times can be an hour
    // out (LAS AMERICAS, 2 Oct 2026), so races are then paired by number,
    // not by time. Everything else (the RAS API, AUS/NZ on Neds) goes by the
    // meeting's own date + race number.
    const byStart = m.country !== 'AUS' && m.country !== 'NZ' && m.races.some((nr) => nr.start);
    const ours = dbRaces.filter((r) => (byStart || r.rDate === m.date) && r.rDiscipline === m.discipline && sameCountry(r.rCountry, m.country));
    const course = [...new Set(ours.map((r) => r.rCourseDisplayName))].find((name) => sameCourseName(name, m.track));
    if (!course) { stats.meetingsNotInDb.push(`${m.track} (${m.country} ${m.discipline} ${m.date})`); continue; }
    let meetingDate = m.date;
    if (byStart) {
      meetingDate = null;
      let best = Infinity;
      for (const d of [...new Set(ours.filter((r) => r.rCourseDisplayName === course).map((r) => r.rDate))]) {
        const gaps = m.races.map((nr) => {
          const r = ours.find((x) => x.rDate === d && x.rCourseDisplayName === course && x.rNo === nr.rNo);
          return r && nr.start && r.rScheduleTimeUTC ? Math.abs(Date.parse(r.rScheduleTimeUTC) - nr.start) : null;
        }).filter((g) => g != null).sort((a, b) => a - b);
        const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
        if (median <= MAX_DATE_OFFSET_MS && median < best) { best = median; meetingDate = d; }
      }
      if (!meetingDate) { stats.meetingsNotInDb.push(`${m.track} (${m.country} ${m.discipline}, no matching day)`); continue; }
    }
    stats.meetings++;
    for (const rNo of [...new Set(m.races.map((nr) => nr.rNo))]) {
      const race = ours.find((r) => r.rDate === meetingDate && r.rCourseDisplayName === course && r.rNo === rNo);
      if (!race) continue;
      const nr = pickSourceRace(m.races.filter((x) => x.rNo === rNo), race);
      if (nr && !race.resultString && !nr.final && dates.includes(race.rDate)) jobs.push({ race, nr, date: race.rDate });
    }
  }
  return jobs;
}

function runnersCheckEntry(race, date, sourceRunners, source) {
  const src = /^neds/.test(source) ? 'neds' : 'ras';
  return {
    date, items: compareRunners(race, sourceRunners, { fromNeds: src === 'neds' }).map((it) => ({ ...it, src })), source,
    meeting: race.rCourseDisplayName, country: race.rCountry, discipline: race.rDiscipline, rNo: race.rNo,
    counts: countRunners(race, sourceRunners),
  };
}

// One source, all dates -> { races, stats }. Throws when the source can't
// be read at all, so runRunnersCheck() can fall back to the other one.
async function checkRunnersWith(source, dates, dbRaces, inScope) {
  const races = {};
  const stats = { meetings: 0, meetingsNotInDb: [], racesChecked: 0, racesWithDifferences: 0, differences: 0, pageErrors: 0 };
  const sourceMeetings = await fetchSourceMeetings(source, dates, dates, inScope);
  const jobs = matchSourceRaces(sourceMeetings, dbRaces, dates, stats);
  // The Neds website needs each race's own page -- two at a time, a short
  // gap after each.
  if (source === 'neds') {
    await fetchNedsRaceRunners(jobs, { workers: 2, gapMs: 250, stats });
    if (jobs.length && stats.pageErrors === jobs.length) throw new Error(`${RUNNERS_SOURCES.neds}: none of its ${jobs.length} race pages could be read`);
  }
  for (const { race, nr, date } of jobs) {
    if (!Array.isArray(nr.runners) || !nr.runners.length) continue; // no field there yet
    const entry = runnersCheckEntry(race, date, nr.runners, source);
    stats.racesChecked++;
    if (entry.items.length) { stats.racesWithDifferences++; stats.differences += entry.items.length; }
    races[race._id] = entry;
  }
  return { races, stats };
}

async function runRunnersCheck(trigger = 'schedule') {
  if (runnersCheckRunning) return false;
  runnersCheckRunning = true;
  const startedAt = Date.now();
  const dates = trackedDates().slice(1); // today, tomorrow, day after -- same days as Missing Meetings
  const { countries, inScope } = runnersCheckScope();
  let summary = '';
  try {
    const dbRaces = await loadRunnersCheckRaces(countries);
    // Both at once (see mergeRunnerChecks); one failing still gives a result.
    const [ras, neds] = await Promise.allSettled(['ras', 'neds'].map((source) => checkRunnersWith(source, dates, dbRaces, inScope)));
    const failures = [];
    [['ras', ras], ['neds', neds]].forEach(([source, r]) => {
      if (r.status === 'rejected') {
        console.warn(`[race-dashboard] WARNING: Runners check with ${RUNNERS_SOURCES[source]} failed: ${r.reason.message}`);
        failures.push(r.reason.message);
      }
    });
    if (failures.length === 2) throw new Error(failures.join(' · '));
    const used = failures.length ? (ras.status === 'fulfilled' ? 'ras' : 'neds') : 'both';
    const result = mergeRunnerChecks(ras.status === 'fulfilled' ? ras.value : null, neds.status === 'fulfilled' ? neds.value : null);
    const now = new Date().toISOString();
    runnersCheckState = {
      lastRunAt: now, lastAttemptAt: now, durationMs: Date.now() - startedAt, dates, stats: result.stats, error: null, races: result.races,
      source: used, fallbackReason: failures.length ? failures[0] : null, trigger,
    };
    summary = `${result.stats.racesChecked} races, ${result.stats.racesWithDifferences} with differences (${runnersSourceLabel(used)}${failures.length ? '; the other failed' : ''})`;
    // The grid's cached race docs carry the previous result; reload them.
    for (const key of memoCache.keys()) if (dates.some((d) => key.startsWith(`docs|${d}|`) || key.startsWith('race|'))) memoCache.delete(key);
  } catch (err) {
    // Keep the last good result on screen; try again in an hour.
    runnersCheckState = { ...runnersCheckState, lastAttemptAt: new Date().toISOString(), durationMs: Date.now() - startedAt, error: err.message, trigger };
    summary = `failed (${err.message})`;
  } finally {
    runnersCheckRunning = false;
    try { fs.writeFileSync(RUNNERS_CHECK_STATE_PATH, JSON.stringify(runnersCheckState), 'utf8'); } catch (err) { /* in-memory state still works */ }
    console.log(`[race-dashboard] Runners check (${trigger}): ${summary} in ${Math.round((Date.now() - startedAt) / 1000)} s`);
    scheduleRunnersCheck();
  }
  return true;
}

// --- Jockey check (5 Oct 2026, per Dinesh) ----------------------------------
// The RAS feed fills jockeys late; the Neds website often has them sooner
// (Palermo 5 Oct: our R4 #17 XA had none, Neds had Juan Pablo Paoloni). Every
// JOCKEY_CHECK_EVERY_MS this reads the Neds pages of only the races starting
// in the next 24 hours that still have a running horse with no jockey in
// ours -- one page at a time, a second apart -- and updates those races'
// runners check result (Jockey Missing / Mismatched, plus the runner
// checks). Nothing to read, no requests.
async function runJockeyCheck() {
  if (jockeyCheckRunning || runnersCheckRunning) { scheduleJockeyCheck(10 * 60 * 1000); return; }
  jockeyCheckRunning = true;
  const startedAt = Date.now();
  const stats = { meetings: 0, meetingsNotInDb: [], pageErrors: 0 };
  let summary = '';
  try {
    const { countries, inScope } = runnersCheckScope();
    const dbRaces = await loadRunnersCheckRaces(countries);
    const now = Date.now();
    const wanted = dbRaces.filter((r) => {
      const start = r.rScheduleTimeUTC ? Date.parse(r.rScheduleTimeUTC) : NaN;
      return r.rDiscipline !== 'G' && !r.resultString && inScope(r.rCountry === 'NZL' ? 'NZ' : r.rCountry, r.rDiscipline)
        && start > now - 30 * 60 * 1000 && start < now + 24 * 60 * 60 * 1000
        && (r.runners || []).some((x) => !x.isScratched && !String(x.jockey || '').trim());
    });
    const wantedIds = new Set(wanted.map((r) => r._id));
    let checked = 0;
    let found = 0;
    let issues = 0;
    if (wanted.length) {
      const raceDates = [...new Set(wanted.map((r) => r.rDate))];
      // Overseas meetings are listed on Neds under the next (AUS) day.
      const listDates = [...new Set(wanted.flatMap((r) => (r.rCountry === 'AUS' || r.rCountry === 'NZ' || r.rCountry === 'NZL'
        ? [r.rDate]
        : [r.rDate, new Date(Date.parse(`${r.rDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)])))].sort();
      const sourceMeetings = await fetchSourceMeetings('neds', listDates, listDates, inScope);
      const jobs = matchSourceRaces(sourceMeetings, dbRaces, raceDates, stats).filter((j) => wantedIds.has(j.race._id));
      await fetchNedsRaceRunners(jobs, { workers: 1, gapMs: 1000, stats });
      for (const { race, nr, date } of jobs) {
        if (!Array.isArray(nr.runners) || !nr.runners.length) continue;
        let entry = runnersCheckEntry(race, date, nr.runners, 'neds-jockey');
        // A race RAS checked keeps RAS' flags (see mergeRunnerChecks); the
        // Neds ones are replaced by this fresher read.
        const prev = runnersCheckState.races[race._id];
        if (prev && /^ras/.test(prev.source || '')) {
          // (Saved before items carried src: the jockey ones were Neds'.)
          const rasItems = prev.items.filter((it) => (it.src ? it.src !== 'neds' : it.field !== 'jockey')).map((it) => ({ ...it, src: 'ras' }));
          entry = { ...prev, items: unionRunnerItems(rasItems, entry.items), source: 'ras+neds' };
        }
        checked++;
        issues += entry.items.length;
        found += entry.items.filter((it) => it.field === 'jockey' && /^Jockey Missing/.test(it.text)).length;
        runnersCheckState.races[race._id] = entry;
      }
      if (checked) {
        try { fs.writeFileSync(RUNNERS_CHECK_STATE_PATH, JSON.stringify(runnersCheckState), 'utf8'); } catch (err) { /* in-memory state still works */ }
        for (const key of memoCache.keys()) if (raceDates.some((d) => key.startsWith(`docs|${d}|`)) || key.startsWith('race|')) memoCache.delete(key);
      }
    }
    Object.assign(jockeyCheckState, {
      lastRunAt: new Date().toISOString(), durationMs: Date.now() - startedAt, error: null,
      racesWanted: wanted.length, racesChecked: checked, jockeysFound: found, issues,
    });
    summary = `${wanted.length} races missing a jockey, ${checked} checked, ${found} jockeys found on Neds`;
  } catch (err) {
    Object.assign(jockeyCheckState, { lastRunAt: new Date().toISOString(), durationMs: Date.now() - startedAt, error: err.message });
    summary = `failed (${err.message})`;
  } finally {
    jockeyCheckRunning = false;
    saveJockeyCheckState();
    console.log(`[race-dashboard] Jockey check: ${summary} in ${Math.round((Date.now() - startedAt) / 1000)} s`);
    scheduleJockeyCheck();
  }
}

// Every JOCKEY_CHECK_EVERY_MS from the last run (two minutes after start-up
// when overdue, after the runners check's own first run).
let jockeyCheckTimer = null;
function scheduleJockeyCheck(waitMs) {
  clearTimeout(jockeyCheckTimer);
  const last = jockeyCheckState.lastRunAt ? Date.parse(jockeyCheckState.lastRunAt) : 0;
  const wait = waitMs != null ? waitMs : Math.max(2 * 60 * 1000, last + JOCKEY_CHECK_EVERY_MS - Date.now());
  jockeyCheckTimer = setTimeout(runJockeyCheck, wait);
}

// Next run 8 hours after the last good one (an hour after a failed one; a
// minute after start-up when that's already overdue), so restarts don't add
// extra checks.
let runnersCheckTimer = null;
function scheduleRunnersCheck() {
  clearTimeout(runnersCheckTimer);
  const last = runnersCheckState.lastRunAt ? Date.parse(runnersCheckState.lastRunAt) : 0;
  const attempt = runnersCheckState.lastAttemptAt ? Date.parse(runnersCheckState.lastAttemptAt) : 0;
  const due = runnersCheckState.error && attempt > last ? attempt + RUNNERS_CHECK_RETRY_MS : last + RUNNERS_CHECK_EVERY_MS;
  const wait = Math.max(60 * 1000, due - Date.now());
  runnersCheckTimer = setTimeout(runRunnersCheck, wait);
}

// Puts the latest runners check differences on the race docs: runner.runnerCheckDiffs for a
// runner's Issue column, doc.runnerCheckLines for race-level ones (a runner absent
// or scratched on one side), doc.runnerMismatch for the grid flag. A
// difference whose value has changed in our DB since the check is dropped.
// Ignore button on Missing Data > Missing / Mismatched Runners (2 Oct 2026,
// per Dinesh: "Runners Mismatched Ignore option venu"). One entry per issue
// (race + kind + runner + text, so a different count or name shows again);
// entries for dates over a week old are dropped on the next save. An
// ignored issue is left off the grid, the popup and the Runners column.
const RUNNER_CHECK_IGNORE_PATH = process.env.RUNNER_CHECK_IGNORE_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\runner-check-ignores.json';
let runnerCheckIgnores = {};
try {
  if (fs.existsSync(RUNNER_CHECK_IGNORE_PATH)) runnerCheckIgnores = JSON.parse(fs.readFileSync(RUNNER_CHECK_IGNORE_PATH, 'utf8'));
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${RUNNER_CHECK_IGNORE_PATH}: ${err.message} -- starting with an empty list`);
}
function runnerIssueKey(raceId, it) {
  return `${raceId}|${it.field}|${it.tab == null ? '' : it.tab}|${it.text}`;
}
function runnerIssueIgnored(raceId, it) {
  return runnerCheckIgnores[runnerIssueKey(raceId, it)] || null;
}
function saveRunnerCheckIgnores() {
  const cutoff = new Date(Date.parse(`${todayStr()}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  for (const [key, e] of Object.entries(runnerCheckIgnores)) if (!e.date || e.date < cutoff) delete runnerCheckIgnores[key];
  const dir = path.dirname(RUNNER_CHECK_IGNORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RUNNER_CHECK_IGNORE_PATH, JSON.stringify(runnerCheckIgnores, null, 2), 'utf8');
}

function attachRunnersCheck(docs) {
  for (const doc of docs) {
    const entry = runnersCheckState.races[doc._id];
    if (!entry || !entry.items.length) continue;
    const items = entry.items.filter((it) => stillDiffers(doc, it, entry.source) && !runnerIssueIgnored(doc._id, it));
    for (const r of doc.runners || []) {
      const mine = items.filter((it) => !it.raceLevel && it.tab === r.tabNo && !r.isScratched);
      if (mine.length) {
        r.runnerCheckDiffs = mine.map((it) => it.text);
        // With keys, for the popup's Ignore buttons.
        r.runnerCheckItems = mine.map((it) => ({ key: runnerIssueKey(doc._id, it), text: it.text }));
      }
    }
    doc.runnerCheckLines = items.filter((it) => it.raceLevel).map((it) => it.text);
    doc.runnerCheckLineItems = items.filter((it) => it.raceLevel).map((it) => ({ key: runnerIssueKey(doc._id, it), text: it.text }));
    doc.runnerMismatch = doc.runnerCheckLines.length > 0 || (doc.runners || []).some((r) => r.runnerCheckDiffs);
    doc.runnersCheckedAt = runnersCheckState.lastRunAt;
  }
}

// Picks the best of several racecards clients' FormLines arrays for the
// same runner. The old rule (whichever array has the most entries) picked
// on race COUNT alone -- but checked against prod data 4 Sep 2026, when
// the two feeds cover the exact same past race they always agree on
// whether they know the jockey (never one filled in where the other left
// it blank), so the real difference is which RACES each feed chose to
// include, and the "WSB" feed's races have a blank jockey 61% of the time
// vs. only 39% for Default's -- so "longest wins" could pick a longer but
// much thinner WSB array over a shorter, mostly-complete Default one
// (Dinesh: "Past runs'ls jockey names irukku, raceday dashboard'la past
// runs'la jockey names missing", 4 Sep 2026). Picking by fewest missing
// jockeys instead (length only as a tie-break) measured a drop from 39.4%
// to 26.6% missing jockeys across real Default/WSB pairs, at the cost of
// ~15% fewer past-race rows for some runners -- a fair trade given the
// complaint was specifically about jockey names, not row count.
function pickBestFormLines(variants) {
  if (!variants.length) return [];
  let best = variants[0];
  let bestMissing = best.filter((fl) => !fl.JockeyName).length;
  for (const v of variants) {
    const missing = v.filter((fl) => !fl.JockeyName).length;
    if (missing < bestMissing || (missing === bestMissing && v.length > best.length)) {
      best = v;
      bestMissing = missing;
    }
  }
  return best;
}

// Cross-references each race's runners against the `racecards` collection --
// the same store TD admin's racecard export reads `FormLines` from
// (races._id == racecards.RaceId, runners[].runnerId == Runners[].RunnerId --
// verified against a real Alice Springs R1 racecard, 28 Aug 2026). A prior
// version of this check used the `ingestorRunnerFormCache` collection
// (keyed by horse name) instead -- replaced because it only caught a runner
// with NO cache record at all, and missed the real case: a runner whose
// racecard came out with empty FormLines despite a (stale/unrelated) cache
// record existing for that horse.
//
// A single race can have SEVERAL racecard variant documents, one per
// `Client` (`null` = the generic/no-client feed; e.g. "WSB" = that client's
// own feed) -- and they don't always agree. The Alice Springs R1 case that
// prompted this: the generic (Default) feed had `FormLines: []` for every
// runner while the SAME runners' WSB-client feed had real form-line history.
// So rather than collapsing straight to one yes/no, this attaches
// `formLinesByClient` (client label -> whether THAT client's feed has any
// form lines for this runner) to every runner, and derives `hasFormLines`
// from the Default/generic feed specifically -- since that's the one with
// no client suffix, matching what TD admin's plain racecard export shows.
// options.light (the grid and reports): only whether each runner has form
// lines, plus the comments -- the full past-race history for a whole day
// measured 48.6 MB / 21 s, the light version 2.8 MB / 2 s (1 Oct 2026).
// The race popup (one race) still loads everything.
async function attachFormLineStatus(docs, options = {}) {
  // Thoroughbred only (28 Aug 2026, per Dinesh) -- Harness/Greyhound
  // racecards weren't verified against this check, so skip the join for
  // them entirely rather than querying `racecards` for races that will
  // never be flagged anyway.
  const tRaceIds = docs.filter((d) => d.rDiscipline === 'T').map((d) => d._id).filter(Boolean);
  const raceIds = [...new Set(tRaceIds)];
  if (!raceIds.length) return;

  const client = await getClient();
  const cards = options.light
    ? await client.db().collection('racecards').aggregate([
      { $match: { RaceId: { $in: raceIds } } },
      { $project: {
        RaceId: 1, Client: 1, Style: 1, RaceComment: 1, SexRestriction: 1,
        Runners: { $map: { input: { $ifNull: ['$Runners', []] }, as: 'r', in: {
          RunnerId: '$$r.RunnerId', Comment: '$$r.Comment', formLineCount: { $size: { $ifNull: ['$$r.FormLines', []] } },
        } } },
      } },
    ]).toArray()
    : await client.db().collection('racecards')
      .find({ RaceId: { $in: raceIds } })
      .project({
        RaceId: 1, Client: 1, Style: 1, RaceComment: 1, SexRestriction: 1, 'Runners.RunnerId': 1, 'Runners.FormLines': 1,
        'Runners.Region': 1, 'Runners.Sire': 1, 'Runners.Dam': 1, 'Runners.Colour': 1,
        'Runners.PerformanceStatistics': 1, 'Runners.CurrentOdds': 1, 'Runners.CarryingWeight': 1, 'Runners.Comment': 1, 'Runners.Form': 1,
      })
      .toArray();

  // Prefer the "AU" Style variant's race comment when there is one (9 Sep
  // 2026, per Dinesh -- this dashboard is Australian-racing-first, prize
  // money is always shown in AUD$ regardless of country), rather than
  // whichever Style (UK/US/AU) the DB happens to return first. Only
  // reorders for the comment-selection loop below ("first one wins") --
  // doesn't affect form-line/pedigree merging, which already combines every
  // variant rather than picking one.
  cards.sort((a, b) => (b.Style === 'AU' ? 1 : 0) - (a.Style === 'AU' ? 1 : 0));

  // raceId -> runnerId -> { [clientLabel]: hasFormLines }
  const formByRaceId = new Map();
  // raceId -> comment text -- a race-level field (same for every runner in
  // it), unlike everything else this function tracks. Different client
  // variants reword it slightly (verified against real Warrnambool/Eagle
  // Farm racecards, 7 Sep 2026) but say the same thing, so first one found
  // wins (AU preferred, see the sort above) -- shown as-is, whatever the
  // source text says (9 Sep 2026, per Dinesh: no quality filtering here).
  const raceCommentByRaceId = new Map();
  // raceId -> sex restriction text (e.g. "Fillies", "Colts & Geldings") --
  // race-level, same "first one found wins" pattern as the comment above
  // (9 Sep 2026, per Dinesh: shown in the race info line as "Horse Sex").
  const sexRestrictionByRaceId = new Map();
  // raceId -> runnerId -> { region, sire, dam, colour, formLinesVariants, performanceStatistics }
  // -- pedigree/region are the same horse regardless of which client's feed
  // it came from, so any variant that has them will do; formLines vary by
  // client the same way the missing-form check found, so every variant's
  // array is kept here and the best one picked below (pickBestFormLines) rather
  // than picking a single winner (4 Sep 2026, per Dinesh -- wants country
  // code, pedigree, and full past-race history on click).
  const enrichByRaceId = new Map();
  for (const card of cards) {
    const clientLabel = card.Client || 'Default';
    if (!raceCommentByRaceId.has(card.RaceId) && card.RaceComment) raceCommentByRaceId.set(card.RaceId, card.RaceComment);
    if (!sexRestrictionByRaceId.has(card.RaceId) && card.SexRestriction) sexRestrictionByRaceId.set(card.RaceId, card.SexRestriction);
    if (!formByRaceId.has(card.RaceId)) formByRaceId.set(card.RaceId, new Map());
    if (!enrichByRaceId.has(card.RaceId)) enrichByRaceId.set(card.RaceId, new Map());
    const byRunnerId = formByRaceId.get(card.RaceId);
    const enrichByRunnerId = enrichByRaceId.get(card.RaceId);
    for (const r of (card.Runners || [])) {
      if (!byRunnerId.has(r.RunnerId)) byRunnerId.set(r.RunnerId, {});
      const hasLines = options.light ? r.formLineCount > 0 : Array.isArray(r.FormLines) && r.FormLines.length > 0;
      // Different Style/Language docs under the same Client are presentation
      // variants of the same underlying data pull, not independent sources
      // -- OR them together rather than letting whichever comes back last win.
      const perRunner = byRunnerId.get(r.RunnerId);
      perRunner[clientLabel] = perRunner[clientLabel] || hasLines;

      if (!enrichByRunnerId.has(r.RunnerId)) {
        enrichByRunnerId.set(r.RunnerId, { region: null, sire: null, dam: null, colour: null, formLinesVariants: [], performanceStatistics: null, currentOdds: null, weightKg: null, comment: null, form: null });
      }
      const enrich = enrichByRunnerId.get(r.RunnerId);
      if (!enrich.region && r.Region) enrich.region = r.Region;
      if (!enrich.sire && r.Sire) enrich.sire = r.Sire;
      if (!enrich.dam && r.Dam) enrich.dam = r.Dam;
      if (!enrich.colour && r.Colour) enrich.colour = r.Colour;
      if (Array.isArray(r.FormLines) && r.FormLines.length) enrich.formLinesVariants.push(r.FormLines);
      if (!enrich.performanceStatistics && r.PerformanceStatistics) enrich.performanceStatistics = r.PerformanceStatistics;
      // "0.0" is the feed's placeholder for "not priced yet", not a real
      // price (14 Sep 2026, per Dinesh -- confirmed most racecards docs
      // carry this default rather than a genuine quote).
      if (!enrich.currentOdds && r.CurrentOdds && r.CurrentOdds !== '0.0' && r.CurrentOdds !== '0') enrich.currentOdds = r.CurrentOdds;
      // Carrying weight (14 Sep 2026, per Dinesh) -- races.runners[].weight
      // is almost always blank (checked: 0 of 124 T runners sampled today),
      // this racecards field is the reliable source.
      if (!enrich.weightKg && r.CarryingWeight && r.CarryingWeight.WeightKg) enrich.weightKg = r.CarryingWeight.WeightKg;
      // Per-runner narrative comment (18 Sep 2026, per Dinesh -- "Runner
      // comments ongalukku access irukka"), a last-run summary distinct from
      // the race-level RaceComment above. Same "first variant found wins"
      // pattern as sire/dam.
      if (!enrich.comment && r.Comment) enrich.comment = r.Comment;
      // Compact form-figures string (e.g. "8x61", "34350x153" -- 18 Sep
      // 2026, per Dinesh, a reference screenshot) -- distinct from FormLines
      // above (the structured past-race table); same "first variant found
      // wins" pattern as everything else here.
      if (!enrich.form && r.Form) enrich.form = r.Form;
    }
  }

  for (const enrichByRunnerId of enrichByRaceId.values()) {
    for (const enrich of enrichByRunnerId.values()) {
      enrich.formLines = pickBestFormLines(enrich.formLinesVariants);
    }
  }

  for (const doc of docs) {
    const byRunnerId = formByRaceId.get(doc._id);
    const enrichByRunnerId = enrichByRaceId.get(doc._id);
    // Race-level, set once per doc (not per-runner). `hasRaceComment` stays
    // null for non-Thoroughbred docs -- H/G racecards have this field on
    // only 13%/25% of races (checked 7 Sep 2026), too sparse for "missing"
    // to mean anything there, same reasoning as the T-only form-lines check.
    doc.raceComment = raceCommentByRaceId.get(doc._id) || null;
    doc.hasRaceComment = doc.rDiscipline === 'T' ? Boolean(doc.raceComment) : null;
    doc.sexRestriction = sexRestrictionByRaceId.get(doc._id) || null;
    for (const r of (doc.runners || [])) {
      const perClient = byRunnerId ? byRunnerId.get(r.runnerId) : null;
      r.formLinesByClient = perClient || null; // null -- no racecard found for this runner at all
      // no racecard data -> can't confirm a gap, don't flag. The manual
      // "confirm no form" override is applied on top by applyFormLineIgnores.
      r.hasFormLinesRaw = perClient ? Boolean(perClient.Default) : true;

      const enrich = enrichByRunnerId ? enrichByRunnerId.get(r.runnerId) : null;
      r.region = enrich ? enrich.region : null;
      r.sire = enrich ? enrich.sire : null;
      r.dam = enrich ? enrich.dam : null;
      r.colour = enrich ? enrich.colour : null;
      r.pastRaces = enrich ? enrich.formLines : [];
      r.performanceStatistics = enrich ? enrich.performanceStatistics : null;
      r.currentOdds = enrich ? enrich.currentOdds : null;
      r.weightKg = enrich ? enrich.weightKg : null;
      r.runnerComment = enrich ? enrich.comment : null;
      r.formFigures = enrich ? enrich.form : null;
    }
  }
}

// 28 Aug 2026, per Dinesh ("romba slow-a irukku, innum load aagudhu"): the
// remote DB connection has turned out to be highly volatile -- the SAME
// racecards query measured 56ms server-side execution but 134 SECONDS
// wall-clock in one real page load, purely from network flakiness to the
// remote host, not a query-plan/index problem (that was fixed separately,
// see the races.rDate index). No code change here can fix that network
// path, so a date+trials combo's fully-assembled race docs are cached (see
// cached()): fresh for 60 s, then served while a background refresh runs
// for up to 10 more minutes, so a page load never waits on the refresh.
// The manual confirms are applied on every read, not baked into the cache.
async function fetchRaceDocs(dateStr, includeTrials) {
  const docs = await cached(`docs|${dateStr}|${includeTrials}`, 60 * 1000, 10 * 60 * 1000, () => loadRaceDocs(dateStr, includeTrials));
  applyAllIgnores(docs);
  return docs;
}

// Finish positions from finalResults (1 Oct 2026, per Dinesh: "Inda
// meetings full results kaattudilla"): the scraper sometimes writes a
// race's resultString but never copies each runner's finish position into
// races.runners[].fp -- that day 110 of 244 resulted races (101 AUS, e.g.
// all of Gatton) had no fp, while finalResults had every one of them, and
// agreed with fp wherever both existed. So a resulted race with no fp at
// all gets its positions from finalResults, matched on runnerId (tab
// number only for a runner without one).
async function fillFinishPositions(docs) {
  const needs = docs.filter((d) => d.resultString && (d.runners || []).length && !d.runners.some((r) => r.fp != null));
  if (!needs.length) return;
  const finals = await (await getClient()).db().collection('finalResults')
    .find({ raceId: { $in: needs.map((d) => d._id) } })
    .project({ raceId: 1, 'results.runnerId': 1, 'results.runnerNumber': 1, 'results.finishPosition': 1 })
    .toArray();
  const resultsByRace = new Map(finals.map((f) => [f.raceId, f.results || []]));
  for (const doc of needs) {
    const results = resultsByRace.get(doc._id);
    if (!results) continue;
    const byRunnerId = new Map();
    const byTabNo = new Map();
    for (const x of results) {
      if (!(x.finishPosition > 0)) continue;
      if (x.runnerId) byRunnerId.set(x.runnerId, x.finishPosition);
      if (x.runnerNumber != null) byTabNo.set(x.runnerNumber, x.finishPosition);
    }
    for (const r of doc.runners) {
      if (r.isScratched) continue;
      const fp = r.runnerId ? byRunnerId.get(r.runnerId) : byTabNo.get(r.tabNo);
      if (fp != null) r.fp = fp;
    }
  }
}

async function loadRaceDocs(dateStr, includeTrials) {
  const client = await getClient();
  // NOTE: no longer filtering out isAbandoned here -- the dashboard now has
  // a "Race status" filter (Upcoming/Running/Completed/Abandoned/Resulted)
  // that needs abandoned races present in the payload to filter for them.
  // Default view ("All statuses") now includes abandoned races too.
  // isHidden (16 Sep 2026, per Dinesh) -- the upstream provider's own flag
  // for races it doesn't want published (hiddenReason samples: "Non-TAB",
  // "Extra race", "Abandoned"/"Abended"), left unfiltered until now so
  // these were showing on the dashboard right alongside real races.
  const filter = { rDate: dateStr, isHidden: { $ne: true } };
  if (!includeTrials) filter.isTrail = false;

  const rawDocs = await client.db().collection('races')
    .find(filter)
    .project({
      _id: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rDistance: 1, rPrizeMoney: 1, rScheduleTime: 1,
      meetingId: 1, rStatus: 1, isOpen: 1, isAbandoned: 1, isTrail: 1, resultString: 1, createdAt: 1,
      'runners.jockey': 1, 'runners.isScratched': 1, 'runners.tabNo': 1, 'runners.fp': 1,
      'runners.trainer': 1, 'runners.horseName': 1, 'runners.runnerId': 1, 'runners.age': 1, 'runners.sex': 1,
      'runners.weight': 1, // runners check weight issues (attachRunnersCheck)
    })
    .sort({ rCourseDisplayName: 1, rNo: 1 })
    .toArray();

  const meetingIds = [...new Set(rawDocs.map((d) => d.meetingId).filter(Boolean))];
  const meetingExtrasByMeetingId = await fetchMeetingExtrasByMeetingId(meetingIds);
  // A race not individually flagged isHidden can still belong to a meeting
  // the provider hid outright (confirmed 16 Sep 2026 -- several meetings
  // were isHidden:true with no race-level flag to match), so the meeting's
  // own isHidden is checked too, not just the race's.
  const docs = rawDocs.filter((doc) => {
    const extras = meetingExtrasByMeetingId.get(doc.meetingId);
    return !(extras && extras.isHidden);
  });
  for (const doc of docs) {
    const extras = meetingExtrasByMeetingId.get(doc.meetingId);
    doc.isTAB = extras ? extras.isTAB : true;
    doc.rsMeetingId = extras ? extras.rsMeetingId : null;
    doc.tabMeetingId = extras ? extras.tabMeetingId : null;
  }
  await Promise.all([attachFormLineStatus(docs, { light: true }), attachVideoStatus(docs, dateStr), attachSpeedMapStatus(docs, dateStr), attachScratchingStatus(docs, dateStr), fillFinishPositions(docs)]);
  attachRunnersCheck(docs);
  return docs;
}

// One race's full detail for the popup: fresh 30 s, then up to 60 s more
// served while a refresh runs.
async function fetchRaceById(id) {
  const doc = await cached(`race|${id}`, 30 * 1000, 60 * 1000, () => loadRaceById(id));
  if (doc) applyAllIgnores([doc]);
  return doc;
}

async function loadRaceById(id) {
  const client = await getClient();
  const doc = await client.db().collection('races').findOne(
    { _id: id },
    {
      projection: {
        rCourseDisplayName: 1, rCourse: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rDistance: 1, rPrizeMoney: 1, rScheduleTime: 1, resultString: 1,
        rName: 1, rDisplayName: 1, isTrail: 1,
        rDate: 1, createdAt: 1, meetingId: 1,
        'runners.tabNo': 1, 'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1, 'runners.isScratched': 1, 'runners.fp': 1,
        'runners.runnerId': 1, 'runners.age': 1, 'runners.sex': 1, 'runners.colors': 1, 'runners.bp': 1, 'runners.weight': 1,
      },
    }
  );
  if (doc) {
    // Speed map (8 Sep 2026, per Dinesh -- a separate `speedMaps` collection,
    // one doc per race keyed by `rId` (== races._id), with a `predictions[]`
    // array of per-runner barrier/settling/closing speed measures (0-1) and
    // ratings. Only fetched for the single race a popup is open on (not the
    // whole grid), same as the racecards/video joins above. Everything
    // below runs in parallel -- each is a separate round trip to the remote
    // DB or a (cached) feed.
    await Promise.all([
      client.db().collection('speedMaps').findOne({ rId: doc._id }, { projection: { predictions: 1 } }).then((speedMapDoc) => {
        doc.speedMapPredictions = speedMapDoc && Array.isArray(speedMapDoc.predictions) ? speedMapDoc.predictions : null;
      }),
      // tabMeetingId (22 Sep 2026) -- needed by attachScratchingStatus, same
      // join as the schedule grid's own Scratching Not Updated check, just
      // scoped to this one race's meeting.
      fetchMeetingExtrasByMeetingId([doc.meetingId]).then((extras) => {
        doc.tabMeetingId = (extras.get(doc.meetingId) || {}).tabMeetingId || null;
        return attachScratchingStatus([doc], doc.rDate);
      }),
      attachFormLineStatus([doc]),
      attachVideoStatus([doc], doc.rDate),
      fillFinishPositions([doc]),
      attachSpotlights(doc),
      attachCommentsV2(doc),
    ]);
    attachRunnersCheck([doc]);
  }
  return doc;
}

// Comments V2 (7 Oct 2026, per Dinesh: free, no AI) -- written by
// comments-v2.js from this race's racecard, Thoroughbred only, on each popup
// load (a few ms; nothing saved). Runners scratched in ours are left out
// even when the racecard hasn't caught up.
async function attachCommentsV2(doc) {
  doc.commentsV2 = null;
  if (doc.rDiscipline !== 'T') return;
  try {
    const cards = await (await getClient()).db().collection('racecards')
      .find({ RaceId: doc._id })
      .project({ Style: 1, Course: 1, Date: 1, OffTimeUtc: 1, RaceDistance: 1, Runners: 1 })
      .toArray();
    const card = cards.find((c) => c.Style === 'AU') || cards[0];
    if (!card) return;
    const scratched = new Set((doc.runners || []).filter((r) => r.isScratched).map((r) => r.tabNo));
    doc.commentsV2 = generateCommentsV2(card, scratched);
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: Comments V2 for race ${doc._id} failed: ${err.message}`);
  }
}

// Spotlights (6 Oct 2026, per Dinesh: "Spot light mattu vainga") -- the 3
// "horses to watch" the company pipeline writes alongside its race/runner
// comments in `llmContent` (contentType RACE_CARD_COMMENTS), one doc per
// style (AU/UK/US). A race can have several docs per style after re-runs --
// the newest wins. Kept per style here; buildRaceDetail picks the race
// country's. llmContent has no raceId index, so this is a collection scan
// (~0.4 s), only done for the one race a popup opens.
async function attachSpotlights(doc) {
  doc.llmSpotlights = null;
  try {
    const rows = await (await getClient()).db().collection('llmContent')
      .find({ raceId: doc._id, contentType: 'RACE_CARD_COMMENTS' })
      .project({ 'contentInfo.style': 1, content: 1, updatedAt: 1 })
      .toArray();
    rows.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    const byStyle = {};
    for (const row of rows) {
      let parsed = null;
      try {
        parsed = JSON.parse(String(row.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      } catch (e) {
        continue;
      }
      const spotlights = (parsed && Array.isArray(parsed.spotlights) ? parsed.spotlights : [])
        .filter((s) => s && (s.horse || s.name))
        .map((s) => ({ horse: String(s.horse || ''), name: String(s.name || ''), explanation: String(s.explanation || '') }));
      if (spotlights.length) byStyle[String((row.contentInfo || {}).style || 'AU').toUpperCase()] = spotlights;
    }
    if (Object.keys(byStyle).length) doc.llmSpotlights = byStyle;
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: llmContent lookup for race ${doc._id} failed: ${err.message}`);
  }
}

// Global search (22 Sep 2026, per Dinesh: "Search panel onnu podunga, Ella
// search aaganum -- Runners, Jockeys, Trainers, Meetings, Races") -- scoped
// to ONE date (same as the rest of this dashboard, which is fundamentally
// per-day), scanning that date's `races` docs in memory rather than a
// separate text index, since a single day's race count is small. A query
// shaped like "R5" or a bare number matches races by race number; anything
// else is a case-insensitive substring match against course name / horse
// name / jockey / trainer. Each result carries a raceId so the client can
// jump straight to that race via the existing `?date=...&race=...` link,
// same as every other race link on this dashboard.
async function fetchSearchResults(dateStr, query) {
  const q = String(query || '').trim();
  const empty = { meetings: [], races: [], runners: [], jockeys: [], trainers: [] };
  if (!q) return empty;
  const qLower = q.toLowerCase();
  const raceNoMatch = /^r?\s*(\d{1,2})$/i.exec(q);
  const raceNoWanted = raceNoMatch ? parseInt(raceNoMatch[1], 10) : null;

  // The day's names are cached, so typing a search doesn't re-read the
  // whole day from the DB on every keystroke.
  const docs = await cached(`search|${dateStr}`, 60 * 1000, 5 * 60 * 1000, async () => (await getClient()).db().collection('races')
    .find({ rDate: dateStr, isHidden: { $ne: true } })
    .project({
      _id: 1, rDate: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rScheduleTime: 1, meetingId: 1,
      'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1,
    })
    .sort({ rCourseDisplayName: 1, rNo: 1 })
    .toArray());

  const meetingsMap = new Map();
  const races = [];
  const runners = [];
  const jockeysMap = new Map();
  const trainersMap = new Map();

  for (const doc of docs) {
    const course = doc.rCourseDisplayName || '';
    const url = docRaceUrl(doc);
    const courseMatches = course.toLowerCase().includes(qLower);
    const raceNoMatches = raceNoWanted != null && doc.rNo === raceNoWanted;
    const clock = parseClock(doc.rScheduleTime);

    if (courseMatches && !meetingsMap.has(doc.meetingId)) {
      meetingsMap.set(doc.meetingId, { meetingId: doc.meetingId, raceId: doc._id, url, course, country: doc.rCountry, discipline: doc.rDiscipline });
    }
    if (courseMatches || raceNoMatches) {
      races.push({ raceId: doc._id, url, course, rNo: doc.rNo, time: clock ? clock.label : null, discipline: doc.rDiscipline });
    }
    for (const r of (doc.runners || [])) {
      if (r.horseName && r.horseName.toLowerCase().includes(qLower)) {
        runners.push({ raceId: doc._id, url, horseName: r.horseName, course, rNo: doc.rNo });
      }
      if (r.jockey && r.jockey.toLowerCase().includes(qLower) && !jockeysMap.has(r.jockey)) {
        jockeysMap.set(r.jockey, { raceId: doc._id, url, name: r.jockey, course, rNo: doc.rNo });
      }
      if (r.trainer && r.trainer.toLowerCase().includes(qLower) && !trainersMap.has(r.trainer)) {
        trainersMap.set(r.trainer, { raceId: doc._id, url, name: r.trainer, course, rNo: doc.rNo });
      }
    }
  }

  const LIMIT = 8;
  return {
    meetings: [...meetingsMap.values()].slice(0, LIMIT),
    races: races.slice(0, LIMIT),
    runners: runners.slice(0, LIMIT),
    jockeys: [...jockeysMap.values()].slice(0, LIMIT),
    trainers: [...trainersMap.values()].slice(0, LIMIT),
  };
}

// "Upcoming Races" ticker (26 Sep 2026, per Dinesh, an approved draft
// mockup) -- the soonest-starting races across EVERY meeting/discipline on
// one date, for a scrolling countdown strip above the filters. Sorting/
// counting down needs a genuine cross-timezone-comparable timestamp, which
// `rScheduleTime` alone is NOT (it's venue-LOCAL, deliberately never parsed
// as an absolute Date elsewhere in this file -- see the removed
// timezone-mismatch check's comment in raceView.js for why). `rScheduleTimeUTC`
// is the only field that serves that purpose here; it has one known
// historical bad-value case (a single course, confirmed 22 Sep 2026) but
// no substitute exists, so a race with no parseable UTC time is simply
// left out rather than risk a wrong countdown.
function docRaceUrl(doc) {
  return raceUrl({ discipline: doc.rDiscipline, country: doc.rCountry, meeting: doc.rCourseDisplayName, date: doc.rDate, rNo: doc.rNo });
}

async function fetchUpcomingRaces(dateStr) {
  // Every open dashboard polls this each minute; one cached read serves them all.
  const docs = await cached(`upcoming|${dateStr}`, 30 * 1000, 2 * 60 * 1000, async () => (await getClient()).db().collection('races')
    .find({ rDate: dateStr, isHidden: { $ne: true } })
    .project({
      _id: 1, rDate: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1,
      rScheduleTimeUTC: 1, rStatus: 1, isOpen: 1, isAbandoned: 1, isTrail: 1,
    })
    .toArray());

  const now = Date.now();
  const upcoming = [];
  for (const doc of docs) {
    if (doc.isTrail) continue;
    if (deriveRaceStatus(doc) !== 'upcoming') continue;
    const targetMs = doc.rScheduleTimeUTC ? Date.parse(doc.rScheduleTimeUTC) : NaN;
    if (!Number.isFinite(targetMs) || targetMs < now) continue;
    upcoming.push({
      raceId: doc._id, url: docRaceUrl(doc), course: doc.rCourseDisplayName, country: doc.rCountry,
      discipline: doc.rDiscipline, rNo: doc.rNo, targetTime: new Date(targetMs).toISOString(),
    });
  }
  upcoming.sort((a, b) => Date.parse(a.targetTime) - Date.parse(b.targetTime));
  return upcoming.slice(0, 20);
}

// Fetches every race (all runners, full detail) for ONE specific meeting on
// ONE date -- used by the per-meeting "download this meeting's full details"
// links (10 Aug 2026, per Dinesh: "Alice Springs meeting download pannumna
// anda meeting full race details download pannanu"). Identifies the meeting
// the same way buildSchedule() groups it: course + country + discipline,
// scoped to the one date. Deliberately a much wider projection than
// fetchRaceDocs() (the grid's projection) since this needs everything
// buildMeetingDetailsReport() reports on -- race name, prize money, result,
// full runner list -- not just the fields the grid cells need to render.
async function fetchMeetingRaceDocs(dateStr, meeting, country, discipline, includeTrials) {
  const client = await getClient();
  // isHidden (16 Sep 2026, per Dinesh) -- keeps this report in sync with
  // what the grid actually shows for the meeting (see fetchRaceDocs).
  const filter = { rDate: dateStr, rCourseDisplayName: meeting, rCountry: country, rDiscipline: discipline, isHidden: { $ne: true } };
  if (!includeTrials) filter.isTrail = false;

  const docs = await client.db().collection('races')
    .find(filter)
    .project({
      _id: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rPrizeMoney: 1, rScheduleTime: 1,
      rName: 1, rDisplayName: 1, resultString: 1, isAbandoned: 1, rStatus: 1, isOpen: 1,
      meetingId: 1, rDate: 1,
      'runners.tabNo': 1, 'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1, 'runners.isScratched': 1, 'runners.fp': 1,
      'runners.runnerId': 1,
    })
    .sort({ rNo: 1 })
    .toArray();
  await fillFinishPositions(docs);
  return docs;
}

// Builds the issues report as an .xlsx workbook buffer. Kept in server.js
// (not raceView.js) since raceView.js is deliberately kept free of anything
// but plain data/HTML-string logic so it stays trivially unit-testable --
// exceljs/pdfkit are format-rendering libraries, not part of that core logic.
async function buildIssuesReportXlsxBuffer(rows, dateStr) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`Issues ${dateStr}`.slice(0, 31)); // Excel sheet names cap at 31 chars
  sheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Country', key: 'country', width: 10 },
    { header: 'Discipline', key: 'discipline', width: 14 },
    { header: 'Meeting', key: 'meeting', width: 24 },
    { header: 'Race No', key: 'rNo', width: 9 },
    { header: 'Scheduled Time', key: 'time', width: 15 },
    { header: 'Issues', key: 'issues', width: 70 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rows.forEach((r) => sheet.addRow(r));
  if (rows.length) sheet.autoFilter = { from: 'A1', to: 'G1' };
  return workbook.xlsx.writeBuffer();
}

// Builds the issues report as a landscape A4 PDF buffer -- a simple manually
// laid-out table (pdfkit draws primitives, not HTML), with word-wrapped
// "Issues" cells and automatic page breaks for long reports.
function buildIssuesReportPdfBuffer(rows, dateStr) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).font('Helvetica-Bold').text(`Race Issues Report - ${dateStr}`);
      doc.moveDown(0.5);

      const startX = doc.page.margins.left;
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colWidths = [55, 50, 65, 130, 40, 55, usableWidth - (55 + 50 + 65 + 130 + 40 + 55)];
      const headers = ['Date', 'Country', 'Discipline', 'Meeting', 'R#', 'Time', 'Issues'];
      let y = doc.y;

      function drawRow(cells, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        let x = startX;
        let maxHeight = 12;
        cells.forEach((cell, i) => {
          const text = cell == null ? '' : String(cell);
          const h = doc.heightOfString(text, { width: colWidths[i] - 4 });
          if (h > maxHeight) maxHeight = h;
        });
        cells.forEach((cell, i) => {
          doc.text(cell == null ? '' : String(cell), x, y, { width: colWidths[i] - 4 });
          x += colWidths[i];
        });
        y += maxHeight + 4;
      }

      drawRow(headers, true);
      doc.moveTo(startX, y - 2).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 2).strokeColor('#999').stroke();

      if (!rows.length) {
        doc.font('Helvetica').fontSize(10).text('No issues found for this date.', startX, y + 4);
      }

      rows.forEach((r) => {
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        drawRow([r.date, r.country, r.discipline, r.meeting, r.rNo, r.time, r.issues], false);
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Full meeting-details buffers (10 Aug 2026) -- same 4-format pattern as the
// issues report above, but one row per RUNNER for a single meeting instead
// of one row per race-with-an-issue across the whole date.
async function buildMeetingDetailsXlsxBuffer(rows, meeting, dateStr) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`${meeting} ${dateStr}`.slice(0, 31)); // Excel sheet names cap at 31 chars
  sheet.columns = [
    { header: 'Race No', key: 'rNo', width: 9 },
    { header: 'Race Name', key: 'raceName', width: 30 },
    { header: 'Class', key: 'rClass', width: 16 },
    { header: 'Prize Money', key: 'prizeMoney', width: 14 },
    { header: 'Scheduled Time', key: 'scheduledTime', width: 14 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Result', key: 'resultString', width: 16 },
    { header: 'Tab No', key: 'tabNo', width: 9 },
    { header: 'Horse', key: 'horseName', width: 22 },
    { header: 'Jockey', key: 'jockey', width: 20 },
    { header: 'Trainer', key: 'trainer', width: 20 },
    { header: 'Scratched', key: 'scratched', width: 11 },
    { header: 'Position', key: 'position', width: 10 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rows.forEach((r) => sheet.addRow(r));
  if (rows.length) sheet.autoFilter = { from: 'A1', to: 'M1' };
  return workbook.xlsx.writeBuffer();
}

function buildMeetingDetailsPdfBuffer(rows, meeting, country, discipline, dateStr) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).font('Helvetica-Bold').text(`${meeting} (${country}) - Full Meeting Details - ${dateStr}`);
      doc.moveDown(0.5);

      const startX = doc.page.margins.left;
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      // Race No, Time, Class, Result, Tab, Horse, Jockey, Trainer, Scr, Pos
      const colWidths = [30, 45, 70, 55, 30, 110, 90, 90, 40, usableWidth];
      colWidths[colWidths.length - 1] = usableWidth - colWidths.slice(0, -1).reduce((a, b) => a + b, 0);
      const headers = ['R#', 'Time', 'Class', 'Result', 'Tab', 'Horse', 'Jockey', 'Trainer', 'Scr', 'Pos'];
      let y = doc.y;

      function drawRow(cells, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        let x = startX;
        let maxHeight = 12;
        cells.forEach((cell, i) => {
          const text = cell == null ? '' : String(cell);
          const h = doc.heightOfString(text, { width: colWidths[i] - 4 });
          if (h > maxHeight) maxHeight = h;
        });
        cells.forEach((cell, i) => {
          doc.text(cell == null ? '' : String(cell), x, y, { width: colWidths[i] - 4 });
          x += colWidths[i];
        });
        y += maxHeight + 4;
      }

      drawRow(headers, true);
      doc.moveTo(startX, y - 2).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 2).strokeColor('#999').stroke();

      if (!rows.length) {
        doc.font('Helvetica').fontSize(10).text('No races found for this meeting/date.', startX, y + 4);
      }

      let currentRaceNo = null;
      rows.forEach((r) => {
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        // A light separator line whenever the race number changes, so a
        // multi-runner race reads as one visual block in the flat table.
        if (currentRaceNo !== null && r.rNo !== currentRaceNo) {
          doc.moveTo(startX, y - 2).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 2).strokeColor('#ddd').stroke();
        }
        currentRaceNo = r.rNo;
        drawRow([r.rNo, r.scheduledTime, r.rClass, r.resultString, r.tabNo, r.horseName, r.jockey, r.trainer, r.scratched, r.position], false);
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Meetings-list buffers (7 Sep 2026) -- same 4-format pattern as the reports
// above, but one row per MEETING for the whole date (or one discipline of
// it), not per race or per runner -- see buildMeetingsListReport in
// raceView.js.
async function buildMeetingsListXlsxBuffer(rows, dateStr, disciplineName) {
  const workbook = new ExcelJS.Workbook();
  const sheetName = `Meetings ${disciplineName ? disciplineName + ' ' : ''}${dateStr}`.slice(0, 31);
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Country', key: 'country', width: 10 },
    { header: 'Discipline', key: 'discipline', width: 14 },
    { header: 'Meeting', key: 'meeting', width: 24 },
    { header: 'TAB/Non-TAB', key: 'tab', width: 12 },
    { header: 'Races', key: 'raceCount', width: 8 },
    { header: 'First Race Time', key: 'firstRaceTime', width: 15 },
    { header: 'Trial', key: 'trial', width: 8 },
    { header: 'Abandoned', key: 'abandoned', width: 11 },
    { header: 'Has Issues', key: 'hasIssues', width: 11 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rows.forEach((r) => sheet.addRow(r));
  if (rows.length) sheet.autoFilter = { from: 'A1', to: 'J1' };
  return workbook.xlsx.writeBuffer();
}

function buildMeetingsListPdfBuffer(rows, dateStr, disciplineName) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const title = disciplineName ? `${disciplineName} Meetings - ${dateStr}` : `All Meetings - ${dateStr}`;
      doc.fontSize(16).font('Helvetica-Bold').text(title);
      doc.moveDown(0.5);

      const startX = doc.page.margins.left;
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colWidths = [55, 50, 65, 130, 60, 40, 65, 40, 55, usableWidth];
      colWidths[colWidths.length - 1] = usableWidth - colWidths.slice(0, -1).reduce((a, b) => a + b, 0);
      const headers = ['Date', 'Country', 'Discipline', 'Meeting', 'TAB', 'Races', 'First Time', 'Trial', 'Abandoned', 'Has Issues'];
      let y = doc.y;

      function drawRow(cells, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        let x = startX;
        let maxHeight = 12;
        cells.forEach((cell, i) => {
          const text = cell == null ? '' : String(cell);
          const h = doc.heightOfString(text, { width: colWidths[i] - 4 });
          if (h > maxHeight) maxHeight = h;
        });
        cells.forEach((cell, i) => {
          doc.text(cell == null ? '' : String(cell), x, y, { width: colWidths[i] - 4 });
          x += colWidths[i];
        });
        y += maxHeight + 4;
      }

      drawRow(headers, true);
      doc.moveTo(startX, y - 2).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 2).strokeColor('#999').stroke();

      if (!rows.length) {
        doc.font('Helvetica').fontSize(10).text('No meetings found for this date.', startX, y + 4);
      }

      rows.forEach((r) => {
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        drawRow([r.date, r.country, r.discipline, r.meeting, r.tab, r.raceCount, r.firstRaceTime, r.trial, r.abandoned, r.hasIssues], false);
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Validates/normalizes the query params for the per-meeting download links
// (meeting/country/discipline identify the meeting the same way
// buildSchedule() groups it -- see fetchMeetingRaceDocs above). Returns
// null if meeting/country are missing so the route can 400 rather than
// silently querying for an empty-string meeting name.
function parseMeetingRequestOptions(req) {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
  const includeTrials = req.query.includeTrials === 'true';
  const discipline = ['T', 'H', 'G'].includes(req.query.discipline) ? req.query.discipline : 'T';
  const meeting = (req.query.meeting || '').trim();
  const country = (req.query.country || '').trim();
  if (!meeting || !country) return null;
  return { dateStr, includeTrials, discipline, meeting, country };
}

function parseRequestOptions(req) {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
  const includeTrials = req.query.includeTrials === 'true';
  const discipline = ['T', 'H', 'G'].includes(req.query.discipline) ? req.query.discipline : 'T';
  return { dateStr, includeTrials, discipline };
}

const app = express();

// Static assets (styles.css) -- served before the login gate below, since
// the login page itself needs the stylesheet too.
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'rdd.sid',
  cookie: { httpOnly: true, sameSite: 'lax' }, // no maxAge -> browser-session cookie, cleared on browser close
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Login gate for everything registered below. /health stays open for the
// uptime monitor. API calls get a 401 instead of a redirect so fetch()
// callers see a clear failure rather than the login page's HTML.
// A session whose user has since been removed with setup-auth.js is
// treated as logged out on its next request.
const PUBLIC_PATHS = new Set(['/login', '/logout', '/health']);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  refreshAuthConfig();
  if (req.session && req.session.loggedIn) {
    // A password reset bumps the user's sessionVersion, logging out every
    // session that logged in with the old password.
    const user = findUser(req.session.username);
    if (user && (user.sessionVersion || 0) === (req.session.sessionVersion || 0)) return next();
    req.session.loggedIn = false;
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  // Remember a shared race link so login lands back on it.
  if (req.method === 'GET' && req.session && req.path.startsWith('/race/')) req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
});

// Every server-built report file (CSV/Excel/JSON/PDF) goes in the
// activity log; client-built race/meeting PDFs report in via /api/activity.
app.use((req, res, next) => {
  if (req.method === 'GET' && /\.(csv|xlsx|json|pdf)$/.test(req.path)) logActivity(req, 'download', { file: req.originalUrl });
  next();
});

app.post('/api/activity', (req, res) => {
  const file = req.body && typeof req.body.file === 'string' ? req.body.file.slice(0, 200) : null;
  if (!file) return res.status(400).json({ error: 'file is required' });
  logActivity(req, 'download', { file });
  res.json({ ok: true });
});

// --- Data Changes page (every logged-in user) ---------------------------
app.get('/changes', requirePermission('changes'), (req, res) => {
  logActivity(req, 'view-changes', {}, { key: 'changes', ms: 30 * 60 * 1000 });
  res.send(renderChangesPage({ username: req.session.username, access: accessOf(req) }));
});

app.get('/api/changes', requirePermission('changes'), (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
  try {
    res.json({
      date,
      lastCheckAt: tracker.lastCheckAt,
      checkEveryMinutes: CHANGE_CHECK_MS / 60000,
      trackedDates: tracker.dates,
      keepDays: CHANGE_KEEP_DAYS,
      entries: readChanges(ACTIVITY_LOG_DIR, date),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Missing Meetings (1 Oct 2026, per Dinesh) ---------------------------
// Thoroughbred meetings the Scratchings feed lists for today, tomorrow and
// the day after that the dashboard doesn't show (see missing-meetings.js).
// Only for users with the 'missing' section.

// Ignore button (1 Oct 2026, per Dinesh: "Meetings edawadu thewa illa, or
// edukka mudiyallanna Ignore panna"): keyed by the feed's MeetingID, which
// is one meeting on one date. Entries for dates over a week old are dropped
// on the next save.
const MISSING_MEETING_IGNORE_PATH = process.env.MISSING_MEETING_IGNORE_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\missing-meeting-ignores.json';
let missingMeetingIgnores = {};
try {
  if (fs.existsSync(MISSING_MEETING_IGNORE_PATH)) missingMeetingIgnores = JSON.parse(fs.readFileSync(MISSING_MEETING_IGNORE_PATH, 'utf8'));
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${MISSING_MEETING_IGNORE_PATH}: ${err.message} -- starting with an empty list`);
}
function saveMissingMeetingIgnores() {
  const cutoff = new Date(Date.parse(`${todayStr()}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  for (const [id, e] of Object.entries(missingMeetingIgnores)) if (!e.date || e.date < cutoff) delete missingMeetingIgnores[id];
  const dir = path.dirname(MISSING_MEETING_IGNORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MISSING_MEETING_IGNORE_PATH, JSON.stringify(missingMeetingIgnores, null, 2), 'utf8');
}

// Which countries are checked (1 Oct 2026, per Dinesh: "Additional country
// add panna option wenu"): added/removed on the page, saved here. Until the
// first change, the default list in missing-meetings.js is used.
const MISSING_MEETING_COUNTRIES_PATH = process.env.MISSING_MEETING_COUNTRIES_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\missing-meeting-countries.json';
const MISSING_DEFAULT_COUNTRY_NAMES = new Map(MISSING_DEFAULT_COUNTRIES);
let missingMeetingCountries = MISSING_DEFAULT_COUNTRIES.map(([code]) => code);
try {
  if (fs.existsSync(MISSING_MEETING_COUNTRIES_PATH)) {
    const saved = JSON.parse(fs.readFileSync(MISSING_MEETING_COUNTRIES_PATH, 'utf8'));
    if (Array.isArray(saved.countries)) missingMeetingCountries = saved.countries.filter((c) => typeof c === 'string');
  }
} catch (err) {
  console.warn(`[race-dashboard] WARNING: could not read ${MISSING_MEETING_COUNTRIES_PATH}: ${err.message} -- using the default countries`);
}
function saveMissingMeetingCountries(username) {
  const dir = path.dirname(MISSING_MEETING_COUNTRIES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MISSING_MEETING_COUNTRIES_PATH, JSON.stringify({
    countries: missingMeetingCountries, updatedBy: username, updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

// "Runners" column (2 Oct 2026, per Dinesh): each matched meeting's latest
// runners check result -- row.runners = { checked, missing, mismatched,
// races, lines }. checked is false when none of its races was in the last
// check (already resulted, or no runners in the source yet).
async function attachMeetingRunnerChecks(db, rows, dates) {
  const meetingIds = [...new Set(rows.map((r) => r.dbMeetingId).filter(Boolean))];
  const races = meetingIds.length ? await db.collection('races')
    .find({ meetingId: { $in: meetingIds }, rDate: { $in: dates }, isHidden: { $ne: true } })
    .project({ meetingId: 1, rNo: 1, 'runners.tabNo': 1, 'runners.horseName': 1, 'runners.isScratched': 1, 'runners.jockey': 1, 'runners.weight': 1 })
    .toArray() : [];
  for (const row of rows) {
    // byRace: one entry per race with an issue, for the click-to-expand list
    // (2 Oct 2026, per Dinesh: just "3 Missing | 3 Mismatched", the races
    // underneath on click, each opening that race).
    const result = { checked: false, missing: 0, mismatched: 0, races: 0, byRace: [] };
    for (const race of races.filter((r) => r.meetingId === row.dbMeetingId).sort((a, b) => a.rNo - b.rNo)) {
      const entry = runnersCheckState.races[race._id];
      if (!entry) continue;
      result.checked = true;
      const items = entry.items.filter((it) => stillDiffers(race, it, entry.source) && !runnerIssueIgnored(race._id, it) && !(race.runners || []).some((x) => x.tabNo === it.tab && x.isScratched && !it.raceLevel));
      if (!items.length) continue;
      result.races++;
      const one = { rNo: race.rNo, missing: 0, mismatched: 0, lines: [], url: entry.meeting ? raceUrl({ discipline: entry.discipline, country: entry.country, meeting: entry.meeting, date: entry.date, rNo: entry.rNo }) : null };
      for (const it of items) {
        if (it.field === 'present' && it.raceLevel) { result.missing++; one.missing++; } else { result.mismatched++; one.mismatched++; }
        one.lines.push(`${it.tab != null && !it.raceLevel ? `#${it.tab} ` : ''}${it.text}`);
      }
      result.byRace.push(one);
    }
    row.runners = result;
  }
}

async function getMissingMeetings(fresh) {
  const dates = trackedDates().slice(1); // today, tomorrow, day after
  if (fresh) dates.forEach((d) => memoCache.delete(`feed-scratchings|${d}`));
  const feeds = await Promise.allSettled(dates.map((d) => fetchScratchingsFeed(d)));
  const countryCodes = new Set(missingMeetingCountries);
  const errors = [];
  const source = [];
  const allFeedMeetings = [];
  feeds.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      source.push(...pickSourceMeetings(r.value, countryCodes));
      allFeedMeetings.push(...r.value);
    } else {
      errors.push({ date: dates[i], error: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
    }
  });
  const db = (await getClient()).db();
  const [dbMeetings, raceCounts] = await Promise.all([
    db.collection('meetings')
      .find({ mDate: { $in: dates }, mDiscipline: 'T' })
      .project({ _id: 1, tabMeetingId: 1, mDate: 1, mCountry: 1, mCourseDisplayName: 1, isHidden: 1, hiddenReason: 1 })
      .toArray(),
    db.collection('races').aggregate([
      { $match: { rDate: { $in: dates }, rDiscipline: 'T', isHidden: { $ne: true } } },
      { $group: { _id: '$meetingId', n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const rows = compareMeetings(source, dbMeetings, new Map(raceCounts.map((r) => [r._id, r.n])));
  for (const row of rows) {
    // A merged surface split (see missing-meetings.js) counts as ignored
    // under any of its feed MeetingIDs.
    const ignore = row.status === 'missing' && row.sourceMeetingIds.map((id) => missingMeetingIgnores[String(id)]).find(Boolean);
    if (ignore) Object.assign(row, { status: 'ignored', ignoredBy: ignore.ignoredBy, ignoredAt: ignore.ignoredAt });
  }
  await attachMeetingRunnerChecks(db, rows, dates);
  return {
    dates,
    checkedAt: new Date().toISOString(),
    countries: missingMeetingCountries.map((code) => ({ code, name: MISSING_DEFAULT_COUNTRY_NAMES.get(code) || null })),
    uncheckedCountries: uncheckedFeedCountries(allFeedMeetings, countryCodes),
    errors,
    total: rows.length,
    missing: rows.filter((r) => r.status === 'missing').length,
    ignored: rows.filter((r) => r.status === 'ignored').length,
    meetings: rows,
  };
}

app.get('/missing-meetings', requirePermission('missing'), (req, res) => {
  logActivity(req, 'view-missing-meetings', {}, { key: 'missing', ms: 30 * 60 * 1000 });
  res.send(renderMissingMeetingsPage({ username: req.session.username, access: accessOf(req) }));
});

// Admins only (1 Oct 2026, per Dinesh: "adminku mattu da country add
// pandra option wenu").
// Missing Data > Missing / Mismatched Runners (2 Oct 2026, per Dinesh): every
// race where the last runners check found a difference that's still true
// in our DB (Runner Missing / Runner Mismatched / Runner Count Mismatched).
app.get('/api/missing-runners', requirePermission('missing'), async (req, res) => {
  try {
    const state = runnersCheckState;
    const ids = Object.keys(state.races || {}).filter((id) => state.races[id].items.length);
    const docs = ids.length ? await (await getClient()).db().collection('races')
      .find({ _id: { $in: ids } })
      .project({ 'runners.tabNo': 1, 'runners.horseName': 1, 'runners.isScratched': 1, 'runners.jockey': 1, 'runners.weight': 1 })
      .toArray() : [];
    const races = [];
    for (const doc of docs) {
      const entry = state.races[doc._id];
      const items = entry.items.filter((it) => stillDiffers(doc, it, entry.source) && !(!it.raceLevel && (doc.runners || []).some((x) => x.tabNo === it.tab && x.isScratched)));
      if (!items.length) continue;
      const horse = (tab) => ((doc.runners || []).find((x) => x.tabNo === tab) || {}).horseName || '';
      races.push({
        raceId: doc._id, date: entry.date, meeting: entry.meeting, country: entry.country, discipline: entry.discipline, rNo: entry.rNo,
        url: entry.meeting ? raceUrl({ discipline: entry.discipline, country: entry.country, meeting: entry.meeting, date: entry.date, rNo: entry.rNo }) : null,
        counts: entry.counts || null,
        issues: items.map((it) => {
          const ignore = runnerIssueIgnored(doc._id, it);
          return {
            kind: it.field === 'count' ? 'count' : it.field === 'jockey' || it.field === 'weight' ? 'jockey' : (it.field === 'present' && it.raceLevel) || it.field === 'field' ? 'missing' : 'mismatched',
            tab: it.raceLevel ? null : it.tab,
            horse: it.raceLevel ? '' : horse(it.tab),
            text: it.text,
            // Saved before items carried src: jockey flags were always Neds'.
            src: it.src || (it.field === 'jockey' || /^neds/.test(entry.source || '') ? 'neds' : /^ras/.test(entry.source || '') ? 'ras' : null),
            key: runnerIssueKey(doc._id, it),
            ignored: Boolean(ignore),
            ignoredBy: ignore ? ignore.ignoredBy : null,
            ignoredAt: ignore ? ignore.ignoredAt : null,
          };
        }),
      });
    }
    races.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.country).localeCompare(String(b.country)) || String(a.meeting).localeCompare(String(b.meeting)) || a.rNo - b.rNo);
    const attempt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0;
    res.json({
      lastRunAt: state.lastRunAt, lastAttemptAt: state.lastAttemptAt, error: state.error, running: runnersCheckRunning,
      source: state.source, sourceLabel: runnersSourceLabel(state.source), fallbackReason: state.fallbackReason || null, trigger: state.trigger || null,
      canCheckAt: attempt ? new Date(attempt + RUNNERS_CHECK_MANUAL_GAP_MS).toISOString() : null,
      everyHours: RUNNERS_CHECK_EVERY_MS / 3600000, dates: state.dates || [], stats: state.stats, races,
      jockeyCheck: {
        lastRunAt: jockeyCheckState.lastRunAt, everyHours: JOCKEY_CHECK_EVERY_MS / 3600000, error: jockeyCheckState.error,
        racesWanted: jockeyCheckState.racesWanted, racesChecked: jockeyCheckState.racesChecked, jockeysFound: jockeyCheckState.jockeysFound,
        nedsPausedUntil: jockeyCheckState.nedsPausedUntil > Date.now() ? new Date(jockeyCheckState.nedsPausedUntil).toISOString() : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ignore / Undo for one runner check issue (see runnerIssueKey).
app.post('/api/missing-runners/ignore', requirePermission('missing'), (req, res) => {
  const { key, ignored } = req.body || {};
  if (typeof key !== 'string' || key.length > 500) return res.status(400).json({ error: 'key is required' });
  const raceId = key.split('|')[0];
  const entry = runnersCheckState.races[raceId];
  const item = entry && entry.items.find((it) => runnerIssueKey(raceId, it) === key);
  const saved = runnerCheckIgnores[key];
  if (ignored && !item) return res.status(404).json({ error: 'That issue is no longer in the last check' });
  const label = `${(entry && entry.meeting) || (saved && saved.meeting) || ''} R${(entry && entry.rNo) || (saved && saved.rNo) || '?'}: ${(item && item.text) || (saved && saved.text) || ''}`;
  if (ignored) {
    runnerCheckIgnores[key] = {
      date: entry.date, meeting: entry.meeting, rNo: entry.rNo, text: item.text,
      ignoredAt: new Date().toISOString(), ignoredBy: req.session.username,
    };
  } else {
    delete runnerCheckIgnores[key];
  }
  try {
    saveRunnerCheckIgnores();
  } catch (err) {
    return res.status(500).json({ error: `Could not save: ${err.message}` });
  }
  // The grid's cached race docs carry the old flags.
  for (const k of memoCache.keys()) if (k.startsWith('docs|') || k === `race|${raceId}`) memoCache.delete(k);
  logActivity(req, ignored ? 'confirm' : 'undo-confirm', { detail: `Runner issue ${ignored ? 'ignored' : 'un-ignored'}: ${label}` });
  res.json({ ok: true, ignored: Boolean(ignored), ignoredBy: ignored ? req.session.username : null, ignoredAt: ignored ? runnerCheckIgnores[key].ignoredAt : null });
});

// "Check now" (2 Oct 2026, per Dinesh: "Aditiona la check button podunga"):
// runs the runners check straight away with whichever source is available,
// at most once every 10 minutes. The page polls /api/missing-runners until
// it's done.
app.post('/api/missing-runners/check', requirePermission('missing'), (req, res) => {
  if (runnersCheckRunning) return res.status(409).json({ error: 'A check is already running', running: true });
  const attempt = runnersCheckState.lastAttemptAt ? Date.parse(runnersCheckState.lastAttemptAt) : 0;
  const waitMs = attempt + RUNNERS_CHECK_MANUAL_GAP_MS - Date.now();
  if (waitMs > 0) return res.status(429).json({ error: `Checked less than 10 minutes ago -- try again in ${Math.ceil(waitMs / 60000)} min`, retryInMs: waitMs });
  const source = runnersSourceLabel('both');
  logActivity(req, 'runners-check', { detail: `Ran the runners check (${source})` });
  runRunnersCheck('manual');
  res.status(202).json({ started: true, source });
});

app.post('/api/missing-meetings/countries', requireAdmin, (req, res) => {
  const { action } = req.body || {};
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(code)) return res.status(400).json({ error: 'Country code must be 2-4 letters, e.g. JPN' });
  if (action === 'add') {
    if (!missingMeetingCountries.includes(code)) missingMeetingCountries = [...missingMeetingCountries, code];
  } else if (action === 'remove') {
    missingMeetingCountries = missingMeetingCountries.filter((c) => c !== code);
  } else {
    return res.status(400).json({ error: 'action must be add or remove' });
  }
  try {
    saveMissingMeetingCountries(req.session.username);
  } catch (err) {
    return res.status(500).json({ error: `Could not save: ${err.message}` });
  }
  logActivity(req, 'missing-countries', { detail: `${action === 'add' ? 'Added' : 'Removed'} country ${code} (Missing Meetings)` });
  res.json({ ok: true, countries: missingMeetingCountries });
});

app.post('/api/missing-meetings/:meetingId/ignore', requirePermission('missing'), (req, res) => {
  const { meetingId } = req.params;
  if (!/^\d{1,12}$/.test(meetingId)) return res.status(400).json({ error: 'Bad meeting id' });
  const saved = missingMeetingIgnores[meetingId] || {};
  const { ignored, date = saved.date, country = saved.country, course = saved.course } = req.body || {};
  const label = `${String(course || meetingId).slice(0, 80)}${country ? ` (${String(country).slice(0, 5)})` : ''}${date ? ` ${String(date).slice(0, 10)}` : ''}`;
  if (ignored) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date is required' });
    missingMeetingIgnores[meetingId] = {
      date, country: String(country || '').slice(0, 5), course: String(course || '').slice(0, 80),
      ignoredAt: new Date().toISOString(), ignoredBy: req.session.username,
    };
  } else {
    delete missingMeetingIgnores[meetingId];
  }
  try {
    saveMissingMeetingIgnores();
  } catch (err) {
    return res.status(500).json({ error: `Could not save: ${err.message}` });
  }
  logActivity(req, ignored ? 'confirm' : 'undo-confirm', { detail: `Missing meeting ${ignored ? 'ignored' : 'un-ignored'}: ${label}` });
  res.json({ ok: true, ignored: Boolean(ignored), ignoredBy: req.session.username, ignoredAt: ignored ? missingMeetingIgnores[meetingId].ignoredAt : null });
});

app.get('/api/missing-meetings', requirePermission('missing'), async (req, res) => {
  try {
    res.json({ ...(await getMissingMeetings(req.query.fresh === '1')), canManageCountries: accessOf(req).admin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin page (29 Sep 2026, per Dinesh) --------------------------------
// Admins manage users and see everyone's activity; normal users never see
// the page or its link.
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admins only' });
  return res.status(403).send(renderAdminDeniedPage());
}

// The admin page shows the last 8 days: the current and previous month's
// files cover that, reading at most the end of each.
const ADMIN_LOG_TAIL_BYTES = 6 * 1024 * 1024;
const ADMIN_LOG_DAYS = 8;
function readRecentActivity() {
  const now = new Date();
  const since = now.getTime() - ADMIN_LOG_DAYS * 24 * 60 * 60 * 1000;
  const keys = new Set([monthKey(new Date(since)), monthKey(now)]);
  const entries = [];
  for (const key of keys) {
    for (const e of readEntries(monthFilePath(ACTIVITY_LOG_DIR, key), ADMIN_LOG_TAIL_BYTES)) {
      if (Date.parse(e.time) >= since) entries.push(e);
    }
  }
  return entries.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

function adminUserList() {
  return authConfig.users.map((u) => ({
    username: u.username, role: u.role, createdAt: u.createdAt || null,
    permissions: u.role === 'admin' ? PERMISSIONS.slice() : cleanPermissions(u.permissions),
  }));
}

// The Admin link opens User Activity; someone given only System Health or
// Data Changes lands on that section instead.
app.get('/admin', (req, res) => {
  const access = accessOf(req);
  if (!access.activity) {
    if (access.health) return res.redirect('/system-health');
    if (access.changes) return res.redirect('/changes');
    if (access.missing) return res.redirect('/missing-meetings');
    return res.status(403).send(renderAdminDeniedPage());
  }
  logActivity(req, 'view-admin', {}, { key: 'admin', ms: 30 * 60 * 1000 });
  res.send(renderAdminPage({ username: req.session.username, access }));
});

app.get('/system-health', requirePermission('health'), (req, res) => {
  res.send(renderSystemHealthPage({ username: req.session.username, access: accessOf(req) }));
});

app.get('/api/admin/health', requirePermission('health'), async (req, res) => {
  try {
    res.json(await getHealth(req.query.fresh === '1'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/overview', requirePermission('activity'), (req, res) => {
  try {
    res.json({ me: findUser(req.session.username).username, canManage: isAdmin(req), users: adminUserList(), entries: readRecentActivity() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function validPassword(p) {
  return typeof p === 'string' && p.length >= MIN_PASSWORD_LENGTH && p.length <= 200;
}

// Every change starts from the list as it is right now and is saved before
// replying, so the admin page never shows a change that didn't stick.
function changeUsers(req, res, action, detail, mutate) {
  refreshAuthConfig();
  const config = { sessionSecret: authConfig.sessionSecret, users: authConfig.users.map((u) => ({ ...u })) };
  const problem = mutate(config);
  if (problem) return res.status(400).json({ error: problem });
  try {
    saveUsers(config);
  } catch (err) {
    logSystem(`Could not save users to ${AUTH_USERS_PATH} (${err.code || 'error'}): ${err.message}`);
    return res.status(500).json({ error: `The server could not save the change (${err.code || err.message}).` });
  }
  logActivity(req, action, { detail });
  res.json({ ok: true, users: adminUserList() });
}

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const { password, role } = req.body || {};
  const permissions = cleanPermissions(req.body && req.body.permissions);
  const accessText = role === 'admin' ? 'admin' : (permissions.join(', ') || 'dashboard only');
  changeUsers(req, res, 'admin-add-user', `${username} (${accessText})`, (config) => {
    if (!USERNAME_RE.test(username)) return 'Username must be 2-40 characters: letters, numbers, dot, dash or underscore.';
    if (findUserIndex(config, username) !== -1) return `"${username}" already exists.`;
    if (!validPassword(password)) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    config.users.push({
      username, passwordHash: bcrypt.hashSync(password, 10), role: role === 'admin' ? 'admin' : 'user', permissions, createdAt: new Date().toISOString(),
    });
    return null;
  });
});

app.post('/api/admin/users/:username/permissions', requireAdmin, (req, res) => {
  const permissions = cleanPermissions(req.body && req.body.permissions);
  changeUsers(req, res, 'admin-change-access', `${req.params.username}: ${permissions.join(', ') || 'dashboard only'}`, (config) => {
    const idx = findUserIndex(config, req.params.username);
    if (idx === -1) return 'No such user.';
    if (config.users[idx].role === 'admin') return 'Admins already have every section.';
    config.users[idx].permissions = permissions;
    return null;
  });
});

app.post('/api/admin/users/:username/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  changeUsers(req, res, 'admin-reset-password', req.params.username, (config) => {
    const idx = findUserIndex(config, req.params.username);
    if (idx === -1) return 'No such user.';
    if (!validPassword(password)) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    const user = config.users[idx];
    user.passwordHash = bcrypt.hashSync(password, 10);
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    // An admin resetting their own password stays logged in here.
    if (findUserIndex(config, req.session.username) === idx) req.session.sessionVersion = user.sessionVersion;
    return null;
  });
});

app.post('/api/admin/users/:username/role', requireAdmin, (req, res) => {
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'user';
  changeUsers(req, res, 'admin-change-role', `${req.params.username} -> ${role}`, (config) => {
    const idx = findUserIndex(config, req.params.username);
    if (idx === -1) return 'No such user.';
    if (findUserIndex(config, req.session.username) === idx) return 'You cannot change your own role.';
    config.users[idx].role = role;
    return null;
  });
});

app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  changeUsers(req, res, 'admin-delete-user', req.params.username, (config) => {
    const idx = findUserIndex(config, req.params.username);
    if (idx === -1) return 'No such user.';
    if (findUserIndex(config, req.session.username) === idx) return 'You cannot delete your own account.';
    config.users.splice(idx, 1);
    return null;
  });
});

app.get('/login', (req, res) => {
  if (req.session && req.session.loggedIn && findUser(req.session.username)) return res.redirect('/');
  let error = null;
  if (req.query.error === '1') error = 'Incorrect username or password.';
  else if (req.query.error === 'noconfig') error = 'Login is not set up on this server yet. Ask the admin to run "node setup-auth.js".';
  res.send(renderLoginPage({ error }));
});

// Compared against when the username doesn't exist, so a wrong username
// takes as long as a wrong password and doesn't reveal which users exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

app.post('/login', (req, res) => {
  refreshAuthConfig();
  if (!authConfig) return res.redirect('/login?error=noconfig');
  const { username, password } = req.body || {};
  const user = findUser(username);
  const passwordOk = typeof password === 'string'
    && bcrypt.compareSync(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    logActivity(req, 'login-failed', { attemptedUser: typeof username === 'string' ? username.slice(0, 100) : null });
    return res.redirect('/login?error=1');
  }
  // New session id on login, so a session id handed out before login can't
  // be reused to ride on this user's login.
  const returnTo = typeof req.session.returnTo === 'string' && /^\/race\/[A-Za-z0-9/_-]+$/.test(req.session.returnTo) ? req.session.returnTo : '/';
  req.session.regenerate((err) => {
    if (err) return res.redirect('/login?error=1');
    req.session.loggedIn = true;
    req.session.username = user.username;
    req.session.sessionVersion = user.sessionVersion || 0;
    logActivity(req, 'login', {});
    res.redirect(returnTo);
  });
});

app.get('/logout', (req, res) => {
  if (!req.session) return res.redirect('/login');
  if (req.session.loggedIn) logActivity(req, 'logout', {});
  req.session.destroy(() => res.redirect('/login'));
});

// Keeps today's dashboard data warm while anyone has used the dashboard in
// the last 30 minutes, so a visitor never waits on a cold load.
let lastDashboardUseAt = 0;
function keepTodayWarm() {
  if (Date.now() - lastDashboardUseAt > 30 * 60 * 1000) return;
  fetchRaceDocs(todayStr(), false).catch((err) => console.warn(`[race-dashboard] WARNING: warm-up failed: ${err.message}`));
}

async function sendDashboard(req, res, { dateStr, includeTrials, discipline, initialRaceId }) {
  lastDashboardUseAt = Date.now();
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const schedule = buildSchedule(docs, dateStr);
    logActivity(req, 'view-dashboard', { detail: dateStr }, { key: dateStr, ms: 30 * 60 * 1000 });
    res.send(renderHtml(dateStr, schedule, {
      includeTrials, discipline, initialRaceId, username: req.session.username, access: accessOf(req),
      lastScrapeSeenAt: tracker.lastScrapeSeenAt, lastChangeCheckAt: tracker.lastCheckAt, serverStartedAt: SERVER_STARTED_AT.toISOString(),
    }));
  } catch (err) {
    res.status(500).send(`<h1>Error loading dashboard</h1><pre>${escapeHtml(err.message)}</pre>`);
  }
}

app.get('/', (req, res) => sendDashboard(req, res, parseRequestOptions(req)));

// Readable race links: /race/thoroughbred/australia/kalgoorlie/2026-10-01/R1
// (1 Oct 2026, per Dinesh). Matched against that date's races by race
// number + discipline, then by the same slug rules raceView.js uses to
// build the link, and shown as the full-screen race view.
const DISCIPLINE_BY_SLUG = Object.fromEntries(Object.entries(DISCIPLINE_SLUGS).map(([code, slug]) => [slug, code]));
app.get('/race/:discipline/:country/:meeting/:date/:raceNo', async (req, res) => {
  const { country, meeting, date } = req.params;
  const discipline = DISCIPLINE_BY_SLUG[String(req.params.discipline).toLowerCase()];
  const raceNoMatch = /^r?(\d{1,2})$/i.exec(req.params.raceNo);
  if (!discipline || !raceNoMatch || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(404).send(renderRaceNotFound(req.originalUrl));
  try {
    const candidates = await (await getClient()).db().collection('races')
      .find({ rDate: date, rNo: Number(raceNoMatch[1]), rDiscipline: discipline, isHidden: { $ne: true } })
      .project({ _id: 1, rCourseDisplayName: 1, rCountry: 1, isTrail: 1 })
      .toArray();
    const race = candidates.find((r) => slugify(r.rCourseDisplayName) === String(meeting).toLowerCase() && countrySlug(r.rCountry) === String(country).toLowerCase());
    if (!race) return res.status(404).send(renderRaceNotFound(req.originalUrl));
    return sendDashboard(req, res, { dateStr: date, includeTrials: Boolean(race.isTrail), discipline, initialRaceId: race._id });
  } catch (err) {
    return res.status(500).send(`<h1>Error loading race</h1><pre>${escapeHtml(err.message)}</pre>`);
  }
});

function renderRaceNotFound(url) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Race not found</title>` +
    `<link rel="stylesheet" href="/styles.css"></head><body><main class="adm-denied"><h1>Race not found</h1>` +
    `<p>No race matches <code>${escapeHtml(url)}</code>. The meeting name, country, date or race number may be different.</p>` +
    `<p><a class="logout-link" href="/">Back to the dashboard</a></p></main></body></html>`;
}

app.get('/api/race/:id', async (req, res) => {
  try {
    const doc = await fetchRaceById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Race not found' });
    logActivity(req, 'view-race', { detail: `${doc.rCourseDisplayName || doc.rCourse} R${doc.rNo} (${doc.rCountry}) ${doc.rDate}` }, { key: req.params.id, ms: 10 * 60 * 1000 });
    // canIgnoreRunnerCheck: the popup's runner check Ignore buttons, for
    // users with the Missing Data section (same as its Ignore endpoint).
    res.json({ ...buildRaceDetail(doc), canIgnoreRunnerCheck: Boolean(accessOf(req).missing) });
    prefetchMeetingRaces(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// After one race is opened, the other races at the same meeting are loaded
// in the background, so moving R1 -> R2 -> R3 in the popup doesn't wait.
// Uses the day's race list already in memory; does nothing if it isn't.
function prefetchMeetingRaces(doc) {
  for (const trials of [false, true]) {
    const entry = memoCache.get(`docs|${doc.rDate}|${trials}`);
    if (!entry || entry.at === undefined) continue;
    entry.value
      .filter((d) => d.meetingId === doc.meetingId && d._id !== doc._id)
      .forEach((d) => { fetchRaceById(d._id).catch(() => {}); });
    return;
  }
}

// Global search across Meetings/Races/Runners/Jockeys/Trainers, scoped to
// one date -- see fetchSearchResults above for the matching rules.
app.get('/api/search', async (req, res) => {
  try {
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
    const results = await fetchSearchResults(dateStr, req.query.q);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Upcoming Races" ticker data -- see fetchUpcomingRaces above.
app.get('/api/upcoming', async (req, res) => {
  try {
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
    const races = await fetchUpcomingRaces(dateStr);
    res.json({ races });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raw source documents for a race -- "Race Card" (the `racecards` documents,
// one per Style/Client variant) and "Data Dump" (the `datadumps` collection,
// a separate, richer per-runner feed with narrative last-run comments) --
// added 10 Sep 2026, per Dinesh: a debug/verify view showing exactly what's
// upstream, unprocessed, for the race a popup is open on. Requires login,
// unlike the read-only /api/race/:id above, since this exposes the full raw
// documents (not just the fields the dashboard already surfaces).
app.get('/api/race/:id/raw/:kind', async (req, res) => {
  const { id, kind } = req.params;
  const collectionByKind = { racecards: 'racecards', datadump: 'datadumps' };
  const collectionName = collectionByKind[kind];
  if (!collectionName) return res.status(400).json({ error: 'Unknown kind -- expected "racecards" or "datadump"' });
  try {
    const client = await getClient();
    const docs = await client.db().collection(collectionName).find({ RaceId: id }).toArray();
    res.json({ docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual override for a runner flagged "Missing form lines" -- used after
// someone has actually checked the real source (punters.com.au) and
// confirmed the runner genuinely has no past form (e.g. a first starter),
// so the dashboard stops flagging it. Gated behind login (unlike the mostly-
// open reads above) since it's a write, not a read. Keyed by runnerId, not
// per-race, since a horse's "no form yet" status doesn't depend on which
// race it's currently entered in.
app.post('/api/runner/:runnerId/form-ignore', (req, res) => {
  const { runnerId } = req.params;
  const { ignored, horseName } = req.body || {};
  logActivity(req, ignored ? 'confirm' : 'undo-confirm', { detail: `No form lines: ${horseName || runnerId}` });
  if (ignored) {
    formLineIgnores[runnerId] = {
      horseName: horseName || null,
      ignoredAt: new Date().toISOString(),
      ignoredBy: req.session.username,
    };
  } else {
    delete formLineIgnores[runnerId];
  }
  try {
    saveFormLineIgnores();
  } catch (err) {
    return res.status(500).json({ error: `Could not save: ${err.message}` });
  }
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Manual override for "Horse age issue" -- same pattern as form-ignore
// above, added 7 Sep 2026 per Dinesh: "Age checked no issue anda madhiri
// check mark poda podunga". Keyed by runnerId (a horse's age doesn't
// depend on which race it's entered in).
app.post('/api/runner/:runnerId/age-ignore', (req, res) => {
  const { runnerId } = req.params;
  const { ignored, horseName } = req.body || {};
  logActivity(req, ignored ? 'confirm' : 'undo-confirm', { detail: `Age checked: ${horseName || runnerId}` });
  if (ignored) {
    ageIgnores[runnerId] = {
      horseName: horseName || null,
      ignoredAt: new Date().toISOString(),
      ignoredBy: req.session.username,
    };
  } else {
    delete ageIgnores[runnerId];
  }
  try {
    saveAgeIgnores();
  } catch (err) {
    return res.status(500).json({ error: `Could not save: ${err.message}` });
  }
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Manual override for "Duplicate jockey" -- same pattern as age-ignore
// above, added 7 Sep 2026 per Dinesh: "Duplicate jockey checked with site
// podunga adau click panna checked podunga". Keyed by raceId + jockey name
// (not runnerId -- see dupJockeyIgnoreKey/applyDupJockeyIgnores), so one
// confirm clears every runner sharing that jockey in that race.
app.post('/api/race/:raceId/jockey-ignore', (req, res) => {
  const { raceId } = req.params;
  const { ignored, jockey } = req.body || {};
  if (!jockey) return res.status(400).json({ error: 'Missing "jockey" in request body' });
  logActivity(req, ignored ? 'confirm' : 'undo-confirm', { detail: `Duplicate jockey checked: ${jockey}` });
  const key = dupJockeyIgnoreKey(raceId, jockey);
  if (ignored) {
    dupJockeyIgnores[key] = {
      jockey,
      ignoredAt: new Date().toISOString(),
      ignoredBy: req.session.username,
    };
  } else {
    delete dupJockeyIgnores[key];
  }
  try {
    saveDupJockeyIgnores();
  } catch (err) {
    return res.status(500).json({ error: `Could not save: ${err.message}` });
  }
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Manual override for "Missing jockey" -- same pattern as jockey-ignore
// above, added 7 Sep 2026 per Dinesh: "Missing jockey / Duplicate jockey
// Idukku checked with Site button podunga, pottadu adu issue ignore
// aaganu". Keyed by raceId + runnerId (see missingJockeyIgnoreKey/
// applyMissingJockeyIgnores) -- unlike duplicate jockey, this is per
// RUNNER since it's not a shared-name group.
app.post('/api/race/:raceId/runner/:runnerId/missing-jockey-ignore', (req, res) => {
  const { raceId, runnerId } = req.params;
  const { ignored, horseName } = req.body || {};
  logActivity(req, ignored ? 'confirm' : 'undo-confirm', { detail: `Missing jockey checked: ${horseName || runnerId}` });
  const key = missingJockeyIgnoreKey(raceId, runnerId);
  if (ignored) {
    missingJockeyIgnores[key] = {
      horseName: horseName || null,
      ignoredAt: new Date().toISOString(),
      ignoredBy: req.session.username,
    };
  } else {
    delete missingJockeyIgnores[key];
  }
  try {
    saveMissingJockeyIgnores();
  } catch (err) {
    return res.status(500).json({ error: `Could not save: ${err.message}` });
  }
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Best-effort video lookup for a horse's PAST races (shown in the pedigree/
// form-history popup). Unlike attachVideoStatus,
// these races come from racecards.Runners[].FormLines, which mostly lacks
// a real race number (~87% of entries, confirmed against prod data 4 Sep
// 2026) and has no country code at all -- the client sends the horse's own
// region as a best guess. A wrong/missing guess just means no icon shows
// (the S3 key simply won't match), never a wrong video, so this degrades
// safely.
app.post('/api/video-check', async (req, res) => {
  const candidates = Array.isArray(req.body && req.body.candidates) ? req.body.candidates : [];
  const keysByDate = new Map();
  const results = [];
  for (const c of candidates) {
    const id = c && c.id;
    const dateStr = c && c.date;
    const country = c && c.country;
    const course = c && c.course;
    const raceNo = Number(c && c.raceNo);
    if (!dateStr || !course || !VIDEO_COUNTRIES.has(country) || !Number.isFinite(raceNo) || raceNo <= 0) {
      results.push({ id, hasVideo: false });
      continue;
    }
    try {
      // The listing, or file-by-file checks when listing is refused.
      if (!keysByDate.has(dateStr)) keysByDate.set(dateStr, await videoKeysOrNull(dateStr));
      const existingKeys = keysByDate.get(dateStr);
      const exact = buildVideoKey(dateStr, country, course, raceNo);
      const hasVideo = existingKeys ? existingKeys.has(exact) : await videoFileExists(exact, dateStr);
      results.push({ id, hasVideo, videoUrl: hasVideo ? `${VIDEO_LIST_URL}${exact}` : undefined });
    } catch (err) {
      results.push({ id, hasVideo: false });
    }
  }
  res.json({ results });
});

app.get('/report.csv', async (req, res) => {
  const { dateStr, includeTrials } = parseRequestOptions(req);
  try {
    // All disciplines/countries for the date -- this is a whole-date issues
    // report, not scoped to whichever discipline tab happens to be selected.
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildIssuesReport(docs, dateStr);
    const csv = issuesReportToCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="race-issues-${dateStr}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send(`Error generating report: ${err.message}`);
  }
});

app.get('/report.json', async (req, res) => {
  const { dateStr, includeTrials } = parseRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildIssuesReport(docs, dateStr);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="race-issues-${dateStr}.json"`);
    res.send(JSON.stringify(rows, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/report.xlsx', async (req, res) => {
  const { dateStr, includeTrials } = parseRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildIssuesReport(docs, dateStr);
    const buffer = await buildIssuesReportXlsxBuffer(rows, dateStr);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="race-issues-${dateStr}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(`Error generating report: ${err.message}`);
  }
});

app.get('/report.pdf', async (req, res) => {
  const { dateStr, includeTrials } = parseRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildIssuesReport(docs, dateStr);
    const buffer = await buildIssuesReportPdfBuffer(rows, dateStr);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="race-issues-${dateStr}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Error generating report: ${err.message}`);
  }
});

// Per-meeting "download this meeting's full details" endpoints (10 Aug
// 2026) -- unlike /report.* above (whole-date ISSUES only), these return
// EVERY race + runner at ONE meeting on ONE date, issue or not. Meeting is
// identified by ?meeting=&country=&discipline=&date= (+ optional
// includeTrials=true), matching the grouping key buildSchedule() uses so
// the export lines up exactly with what's shown for that meeting on the
// grid. A filesystem-unsafe meeting name (e.g. containing a slash or quote)
// is sanitized for the Content-Disposition filename only -- the report
// content itself always uses the real meeting name.
function safeFilenamePart(str) {
  return String(str || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'meeting';
}

app.get('/meeting-report.csv', async (req, res) => {
  const opts = parseMeetingRequestOptions(req);
  if (!opts) return res.status(400).send('Missing required "meeting" and "country" query params.');
  const { dateStr, includeTrials, discipline, meeting, country } = opts;
  try {
    const docs = await fetchMeetingRaceDocs(dateStr, meeting, country, discipline, includeTrials);
    const rows = buildMeetingDetailsReport(docs, dateStr);
    const csv = meetingDetailsReportToCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(meeting)}-${dateStr}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send(`Error generating meeting report: ${err.message}`);
  }
});

app.get('/meeting-report.json', async (req, res) => {
  const opts = parseMeetingRequestOptions(req);
  if (!opts) return res.status(400).json({ error: 'Missing required "meeting" and "country" query params.' });
  const { dateStr, includeTrials, discipline, meeting, country } = opts;
  try {
    const docs = await fetchMeetingRaceDocs(dateStr, meeting, country, discipline, includeTrials);
    const rows = buildMeetingDetailsReport(docs, dateStr);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(meeting)}-${dateStr}.json"`);
    res.send(JSON.stringify(rows, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/meeting-report.xlsx', async (req, res) => {
  const opts = parseMeetingRequestOptions(req);
  if (!opts) return res.status(400).send('Missing required "meeting" and "country" query params.');
  const { dateStr, includeTrials, discipline, meeting, country } = opts;
  try {
    const docs = await fetchMeetingRaceDocs(dateStr, meeting, country, discipline, includeTrials);
    const rows = buildMeetingDetailsReport(docs, dateStr);
    const buffer = await buildMeetingDetailsXlsxBuffer(rows, meeting, dateStr);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(meeting)}-${dateStr}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(`Error generating meeting report: ${err.message}`);
  }
});

app.get('/meeting-report.pdf', async (req, res) => {
  const opts = parseMeetingRequestOptions(req);
  if (!opts) return res.status(400).send('Missing required "meeting" and "country" query params.');
  const { dateStr, includeTrials, discipline, meeting, country } = opts;
  try {
    const docs = await fetchMeetingRaceDocs(dateStr, meeting, country, discipline, includeTrials);
    const rows = buildMeetingDetailsReport(docs, dateStr);
    const buffer = await buildMeetingDetailsPdfBuffer(rows, meeting, country, discipline, dateStr);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(meeting)}-${dateStr}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Error generating meeting report: ${err.message}`);
  }
});

// Same shape as parseMeetingRequestOptions, plus the specific race's id --
// the standalone full-screen race view's Export Data menu should only
// offer THAT race, not the whole meeting/day (18 Sep 2026, per Dinesh:
// "Download option anda raceku mattu wainga"). Reuses
// fetchMeetingRaceDocs/buildMeetingDetailsReport as-is (same projection,
// same row shape) and just filters the meeting's races down to the one
// asked for, rather than duplicating that fetch/report logic for a
// single-race case.
function parseSingleRaceRequestOptions(req) {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
  const includeTrials = req.query.includeTrials === 'true';
  const discipline = ['T', 'H', 'G'].includes(req.query.discipline) ? req.query.discipline : 'T';
  const meeting = (req.query.meeting || '').trim();
  const country = (req.query.country || '').trim();
  const raceId = (req.query.race || '').trim();
  if (!meeting || !country || !raceId) return null;
  return { dateStr, includeTrials, discipline, meeting, country, raceId };
}

async function fetchSingleRaceDoc(opts) {
  const docs = await fetchMeetingRaceDocs(opts.dateStr, opts.meeting, opts.country, opts.discipline, opts.includeTrials);
  return docs.filter((d) => d._id === opts.raceId);
}

app.get('/race-report.csv', async (req, res) => {
  const opts = parseSingleRaceRequestOptions(req);
  if (!opts) return res.status(400).send('Missing required "meeting", "country" and "race" query params.');
  try {
    const docs = await fetchSingleRaceDoc(opts);
    const rows = buildMeetingDetailsReport(docs, opts.dateStr);
    const csv = meetingDetailsReportToCsv(rows);
    const rNoPart = docs[0] ? `-R${docs[0].rNo}` : '';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(opts.meeting)}${rNoPart}-${opts.dateStr}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send(`Error generating race report: ${err.message}`);
  }
});

app.get('/race-report.json', async (req, res) => {
  const opts = parseSingleRaceRequestOptions(req);
  if (!opts) return res.status(400).json({ error: 'Missing required "meeting", "country" and "race" query params.' });
  try {
    const docs = await fetchSingleRaceDoc(opts);
    const rows = buildMeetingDetailsReport(docs, opts.dateStr);
    const rNoPart = docs[0] ? `-R${docs[0].rNo}` : '';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(opts.meeting)}${rNoPart}-${opts.dateStr}.json"`);
    res.send(JSON.stringify(rows, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/race-report.xlsx', async (req, res) => {
  const opts = parseSingleRaceRequestOptions(req);
  if (!opts) return res.status(400).send('Missing required "meeting", "country" and "race" query params.');
  try {
    const docs = await fetchSingleRaceDoc(opts);
    const rows = buildMeetingDetailsReport(docs, opts.dateStr);
    const buffer = await buildMeetingDetailsXlsxBuffer(rows, opts.meeting, opts.dateStr);
    const rNoPart = docs[0] ? `-R${docs[0].rNo}` : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(opts.meeting)}${rNoPart}-${opts.dateStr}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(`Error generating race report: ${err.message}`);
  }
});

app.get('/race-report.pdf', async (req, res) => {
  const opts = parseSingleRaceRequestOptions(req);
  if (!opts) return res.status(400).send('Missing required "meeting", "country" and "race" query params.');
  try {
    const docs = await fetchSingleRaceDoc(opts);
    const rows = buildMeetingDetailsReport(docs, opts.dateStr);
    const buffer = await buildMeetingDetailsPdfBuffer(rows, opts.meeting, opts.country, opts.discipline, opts.dateStr);
    const rNoPart = docs[0] ? `-R${docs[0].rNo}` : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(opts.meeting)}${rNoPart}-${opts.dateStr}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Error generating race report: ${err.message}`);
  }
});

// Same date/includeTrials parsing as parseRequestOptions, but `discipline`
// is OPTIONAL here -- omitted or invalid means "all disciplines", not a
// default to Thoroughbred, since the meetings-list download is meant to
// cover "ella meetings" by default with T/H/G as a narrower option.
function parseMeetingsListRequestOptions(req) {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
  const includeTrials = req.query.includeTrials === 'true';
  const discipline = ['T', 'H', 'G'].includes(req.query.discipline) ? req.query.discipline : null;
  return { dateStr, includeTrials, discipline };
}

app.get('/meetings-list.csv', async (req, res) => {
  const { dateStr, includeTrials, discipline } = parseMeetingsListRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildMeetingsListReport(docs, dateStr, discipline);
    const csv = meetingsListReportToCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${discipline || 'all'}-${dateStr}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send(`Error generating meetings list: ${err.message}`);
  }
});

app.get('/meetings-list.json', async (req, res) => {
  const { dateStr, includeTrials, discipline } = parseMeetingsListRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildMeetingsListReport(docs, dateStr, discipline);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${discipline || 'all'}-${dateStr}.json"`);
    res.send(JSON.stringify(rows, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/meetings-list.xlsx', async (req, res) => {
  const { dateStr, includeTrials, discipline } = parseMeetingsListRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildMeetingsListReport(docs, dateStr, discipline);
    const buffer = await buildMeetingsListXlsxBuffer(rows, dateStr, discipline ? disciplineLabel(discipline) : '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${discipline || 'all'}-${dateStr}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(`Error generating meetings list: ${err.message}`);
  }
});

app.get('/meetings-list.pdf', async (req, res) => {
  const { dateStr, includeTrials, discipline } = parseMeetingsListRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const rows = buildMeetingsListReport(docs, dateStr, discipline);
    const buffer = await buildMeetingsListPdfBuffer(rows, dateStr, discipline ? disciplineLabel(discipline) : '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${discipline || 'all'}-${dateStr}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Error generating meetings list: ${err.message}`);
  }
});

// Meetings List page (date-RANGE view, 7 Sep 2026 per Dinesh -- see
// raceView.js's renderMeetingsListPage for the "why a separate page"
// rationale). `from`/`to` default to today when missing/invalid, and are
// swapped if given backwards so the query never has to fail on that.
function parseMeetingsListViewOptions(req) {
  const today = todayStr();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
  const [fromDate, toDate] = from <= to ? [from, to] : [to, from];
  const includeTrials = req.query.includeTrials === 'true';
  const discipline = ['T', 'H', 'G'].includes(req.query.discipline) ? req.query.discipline : null;
  const country = (req.query.country || '').trim() || null;
  const tab = ['TAB', 'Non-TAB'].includes(req.query.tab) ? req.query.tab : null;
  return { fromDate, toDate, includeTrials, discipline, country, tab };
}

app.get('/meetings-list-view', async (req, res) => {
  const { fromDate, toDate, includeTrials, discipline, country, tab } = parseMeetingsListViewOptions(req);
  try {
    const docs = await fetchRaceDocsForDateRange(fromDate, toDate, includeTrials);
    const rows = buildMeetingsListRowsForRange(groupDocsByDate(docs), discipline, country, tab);
    const countries = [...new Set(docs.map((d) => d.rCountry).filter(Boolean))].sort();
    logActivity(req, 'view-meetings-list', { detail: `${fromDate} to ${toDate}` }, { key: `${fromDate}|${toDate}`, ms: 30 * 60 * 1000 });
    res.send(renderMeetingsListPage(rows, {
      fromDate, toDate, discipline, country, tab, includeTrials, countries, username: req.session.username, access: accessOf(req),
    }));
  } catch (err) {
    res.status(500).send(`<h1>Error loading meetings list</h1><pre>${escapeHtml(err.message)}</pre>`);
  }
});

app.get('/meetings-list-range.csv', async (req, res) => {
  const { fromDate, toDate, includeTrials, discipline, country, tab } = parseMeetingsListViewOptions(req);
  try {
    const docs = await fetchRaceDocsForDateRange(fromDate, toDate, includeTrials);
    const rows = buildMeetingsListRowsForRange(groupDocsByDate(docs), discipline, country, tab);
    const csv = meetingsListReportToCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${fromDate}-to-${toDate}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send(`Error generating meetings list: ${err.message}`);
  }
});

app.get('/meetings-list-range.json', async (req, res) => {
  const { fromDate, toDate, includeTrials, discipline, country, tab } = parseMeetingsListViewOptions(req);
  try {
    const docs = await fetchRaceDocsForDateRange(fromDate, toDate, includeTrials);
    const rows = buildMeetingsListRowsForRange(groupDocsByDate(docs), discipline, country, tab);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${fromDate}-to-${toDate}.json"`);
    res.send(JSON.stringify(rows, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/meetings-list-range.xlsx', async (req, res) => {
  const { fromDate, toDate, includeTrials, discipline, country, tab } = parseMeetingsListViewOptions(req);
  try {
    const docs = await fetchRaceDocsForDateRange(fromDate, toDate, includeTrials);
    const rows = buildMeetingsListRowsForRange(groupDocsByDate(docs), discipline, country, tab);
    const buffer = await buildMeetingsListXlsxBuffer(rows, `${fromDate} to ${toDate}`, discipline ? disciplineLabel(discipline) : '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${fromDate}-to-${toDate}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(`Error generating meetings list: ${err.message}`);
  }
});

app.get('/meetings-list-range.pdf', async (req, res) => {
  const { fromDate, toDate, includeTrials, discipline, country, tab } = parseMeetingsListViewOptions(req);
  try {
    const docs = await fetchRaceDocsForDateRange(fromDate, toDate, includeTrials);
    const rows = buildMeetingsListRowsForRange(groupDocsByDate(docs), discipline, country, tab);
    const buffer = await buildMeetingsListPdfBuffer(rows, `${fromDate} to ${toDate}`, discipline ? disciplineLabel(discipline) : '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="meetings-${fromDate}-to-${toDate}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Error generating meetings list: ${err.message}`);
  }
});

app.get('/health', async (req, res) => {
  try {
    const client = await getClient();
    const start = Date.now();
    await client.db().admin().ping();
    res.json({ status: 'ok', connected: true, pingMs: Date.now() - start, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', connected: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[race-dashboard] Listening on http://localhost:${PORT}`);
  console.log(`[race-dashboard] View dashboard: http://localhost:${PORT}/`);
  console.log(`[race-dashboard] Config file: ${DB_CONFIG_PATH}`);
  console.log(`[race-dashboard] Login config: ${activeAuthPath(AUTH_CONFIG_PATH)}${authConfig ? ` (${authConfig.users.length} user${authConfig.users.length === 1 ? '' : 's'}: ${authConfig.users.map((u) => u.username).join(', ')})` : ' (NOT SET UP -- run "node setup-auth.js")'}`);
  console.log(`[race-dashboard] Activity logs: ${ACTIVITY_LOG_DIR} (activity-log-YYYY-MM.jsonl, older than ${KEEP_PREVIOUS_MONTHS} months deleted)`);
  maintainLogs(new Date());
  console.log(`[race-dashboard] Data changes: checked every ${CHANGE_CHECK_MS / 60000} min, kept ${CHANGE_KEEP_DAYS} days`);
  setTimeout(checkDataChanges, 5000);
  setInterval(checkDataChanges, CHANGE_CHECK_MS);
  lastDashboardUseAt = Date.now();
  keepTodayWarm();
  setInterval(keepTodayWarm, 60 * 1000);
  scheduleRunnersCheck();
  scheduleJockeyCheck();
  console.log(`[race-dashboard] Jockey check: every ${JOCKEY_CHECK_EVERY_MS / 3600000} h (Neds website, races missing a jockey)`);
  console.log(`[race-dashboard] Runners check: every ${RUNNERS_CHECK_EVERY_MS / 3600000} h${runnersCheckState.lastRunAt ? `, last run ${runnersCheckState.lastRunAt}` : ', first run in a minute'}`);
});
