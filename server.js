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
 * comment for the full request/scoping history): a single shared
 * username/password protects ONLY the main dashboard page ("/"). Report
 * downloads, the meeting reports, /api/race/:id, and /health stay open --
 * that split was an explicit choice, not an oversight (see the Handover
 * document if it's ever revisited). Credentials are never stored in this
 * repo: run `node setup-auth.js` once on the hosting machine to set/change
 * the username and password -- it writes a securely-hashed password to a
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
const {
  buildSchedule, buildRaceDetail, renderHtml, renderLoginPage, todayStr, escapeHtml, buildIssuesReport, issuesReportToCsv,
  buildMeetingDetailsReport, meetingDetailsReportToCsv, buildMeetingsListReport, meetingsListReportToCsv, disciplineLabel,
  renderMeetingsListPage, groupDocsByDate, buildMeetingsListRowsForRange,
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
// Loaded once at startup (cheap local file read, unlike the lazy MongoDB
// connection above). Returns null if not set up yet rather than throwing --
// the server should still come up (so /health keeps working) with the
// login gate simply refusing everyone until an admin runs
// `node setup-auth.js`.
function loadAuthConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.username || !parsed.passwordHash) {
    throw new Error(`${configPath} is missing "username" or "passwordHash" -- re-run "node setup-auth.js"`);
  }
  return parsed;
}

let authConfig = null;
let authConfigWarning = null;
try {
  authConfig = loadAuthConfig(AUTH_CONFIG_PATH);
  if (!authConfig) {
    authConfigWarning = `No dashboard login configured yet at ${AUTH_CONFIG_PATH}. Run "node setup-auth.js" once on this machine to set a username/password -- until then, nobody can log in.`;
  }
} catch (err) {
  authConfigWarning = `Could not read login config at ${AUTH_CONFIG_PATH}: ${err.message}`;
}
if (authConfigWarning) console.warn(`[race-dashboard] WARNING: ${authConfigWarning}`);

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
    .project({ _id: 1, isTAB: 1 })
    .toArray();
  for (const m of meetingDocs) map.set(m._id, { isTAB: m.isTAB !== false });
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
  const filter = { rDate: { $gte: fromDate, $lte: toDate } };
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
  for (const doc of docs) {
    const extras = meetingExtrasByMeetingId.get(doc.meetingId);
    doc.isTAB = extras ? extras.isTAB : true;
    doc.runners = [];
  }
  return docs;
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

async function listVideoKeysForDate(dateStr) {
  const keys = new Set();
  let continuationToken = null;
  do {
    const url = new URL(VIDEO_LIST_URL);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', `client1/${dateStr}/`);
    url.searchParams.set('max-keys', '1000');
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Video listing request failed (${res.status})`);
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
async function attachVideoStatus(docs, dateStr) {
  const eligible = docs.filter((d) => d.rDiscipline === 'T' && VIDEO_COUNTRIES.has(d.rCountry) && !d.isTrail);
  if (!eligible.length) return;

  let existingKeys;
  try {
    existingKeys = await listVideoKeysForDate(dateStr);
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: could not list race videos for ${dateStr}: ${err.message} -- skipping video check`);
    return;
  }

  for (const doc of eligible) {
    const key = buildVideoKey(dateStr, doc.rCountry, doc.rCourseDisplayName, doc.rNo);
    doc.hasVideo = existingKeys.has(key);
    if (doc.hasVideo) doc.videoUrl = `${VIDEO_LIST_URL}${key}`;
  }
}

function buildVideoKey(dateStr, country, course, raceNo) {
  const courseKey = String(course || '').trim().replace(/\s+/g, '_');
  return `client1/${dateStr}/${country}_${courseKey}_race${raceNo}_${dateStr}.mp4`;
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
async function attachFormLineStatus(docs) {
  // Thoroughbred only (28 Aug 2026, per Dinesh) -- Harness/Greyhound
  // racecards weren't verified against this check, so skip the join for
  // them entirely rather than querying `racecards` for races that will
  // never be flagged anyway.
  const tRaceIds = docs.filter((d) => d.rDiscipline === 'T').map((d) => d._id).filter(Boolean);
  const raceIds = [...new Set(tRaceIds)];
  if (!raceIds.length) return;

  const client = await getClient();
  const cards = await client.db().collection('racecards')
    .find({ RaceId: { $in: raceIds } })
    .project({
      RaceId: 1, Client: 1, Style: 1, RaceComment: 1, SexRestriction: 1, 'Runners.RunnerId': 1, 'Runners.FormLines': 1,
      'Runners.Region': 1, 'Runners.Sire': 1, 'Runners.Dam': 1, 'Runners.Colour': 1,
      'Runners.PerformanceStatistics': 1,
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
      const hasLines = Array.isArray(r.FormLines) && r.FormLines.length > 0;
      // Different Style/Language docs under the same Client are presentation
      // variants of the same underlying data pull, not independent sources
      // -- OR them together rather than letting whichever comes back last win.
      const perRunner = byRunnerId.get(r.RunnerId);
      perRunner[clientLabel] = perRunner[clientLabel] || hasLines;

      if (!enrichByRunnerId.has(r.RunnerId)) {
        enrichByRunnerId.set(r.RunnerId, { region: null, sire: null, dam: null, colour: null, formLinesVariants: [], performanceStatistics: null });
      }
      const enrich = enrichByRunnerId.get(r.RunnerId);
      if (!enrich.region && r.Region) enrich.region = r.Region;
      if (!enrich.sire && r.Sire) enrich.sire = r.Sire;
      if (!enrich.dam && r.Dam) enrich.dam = r.Dam;
      if (!enrich.colour && r.Colour) enrich.colour = r.Colour;
      if (Array.isArray(r.FormLines) && r.FormLines.length) enrich.formLinesVariants.push(r.FormLines);
      if (!enrich.performanceStatistics && r.PerformanceStatistics) enrich.performanceStatistics = r.PerformanceStatistics;
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
      r.hasFormLines = perClient ? Boolean(perClient.Default) : true; // no racecard data -> can't confirm a gap, don't flag
      if (r.hasFormLines === false && r.runnerId && formLineIgnores[r.runnerId]) {
        r.hasFormLines = true;
        r.formLineIgnored = true;
      }

      const enrich = enrichByRunnerId ? enrichByRunnerId.get(r.runnerId) : null;
      r.region = enrich ? enrich.region : null;
      r.sire = enrich ? enrich.sire : null;
      r.dam = enrich ? enrich.dam : null;
      r.colour = enrich ? enrich.colour : null;
      r.pastRaces = enrich ? enrich.formLines : [];
      r.performanceStatistics = enrich ? enrich.performanceStatistics : null;
    }
  }
}

// 28 Aug 2026, per Dinesh ("romba slow-a irukku, innum load aagudhu"): the
// remote DB connection has turned out to be highly volatile -- the SAME
// racecards query measured 56ms server-side execution but 134 SECONDS
// wall-clock in one real page load, purely from network flakiness to the
// remote host, not a query-plan/index problem (that was fixed separately,
// see the races.rDate index). No code change here can fix that network
// path, so this caches a date+trials combo's fully-assembled race docs in
// memory for a short window -- short enough that it's still fresher than
// the dashboard's own 3-minute auto-refresh, but long enough that a manual
// reload or the next auto-refresh tick within that window skips the slow
// round trip entirely instead of repeating it.
const RACE_DOCS_CACHE_TTL_MS = 60 * 1000;
const raceDocsCache = new Map(); // "dateStr|includeTrials" -> { docs, expiresAt }

async function fetchRaceDocs(dateStr, includeTrials) {
  const cacheKey = `${dateStr}|${includeTrials}`;
  const cached = raceDocsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.docs;

  const client = await getClient();
  // NOTE: no longer filtering out isAbandoned here -- the dashboard now has
  // a "Race status" filter (Upcoming/Running/Completed/Abandoned/Resulted)
  // that needs abandoned races present in the payload to filter for them.
  // Default view ("All statuses") now includes abandoned races too.
  const filter = { rDate: dateStr };
  if (!includeTrials) filter.isTrail = false;

  const docs = await client.db().collection('races')
    .find(filter)
    .project({
      _id: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rDistance: 1, rPrizeMoney: 1, rScheduleTime: 1,
      meetingId: 1, rStatus: 1, isOpen: 1, isAbandoned: 1, isTrail: 1, resultString: 1, createdAt: 1,
      'runners.jockey': 1, 'runners.isScratched': 1, 'runners.tabNo': 1, 'runners.fp': 1,
      'runners.trainer': 1, 'runners.horseName': 1, 'runners.runnerId': 1, 'runners.age': 1, 'runners.sex': 1,
    })
    .sort({ rCourseDisplayName: 1, rNo: 1 })
    .toArray();

  const meetingIds = [...new Set(docs.map((d) => d.meetingId).filter(Boolean))];
  const meetingExtrasByMeetingId = await fetchMeetingExtrasByMeetingId(meetingIds);
  for (const doc of docs) {
    doc.isTAB = meetingExtrasByMeetingId.has(doc.meetingId) ? meetingExtrasByMeetingId.get(doc.meetingId).isTAB : true;
  }
  await Promise.all([attachFormLineStatus(docs), attachVideoStatus(docs, dateStr)]);
  applyAgeIgnores(docs);
  applyDupJockeyIgnores(docs);
  applyMissingJockeyIgnores(docs);
  raceDocsCache.set(cacheKey, { docs, expiresAt: Date.now() + RACE_DOCS_CACHE_TTL_MS });
  return docs;
}

async function fetchRaceById(id) {
  const client = await getClient();
  const doc = await client.db().collection('races').findOne(
    { _id: id },
    {
      projection: {
        rCourseDisplayName: 1, rCourse: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rDistance: 1, rPrizeMoney: 1, rScheduleTime: 1, resultString: 1,
        rName: 1, rDisplayName: 1, isTrail: 1,
        rDate: 1, createdAt: 1,
        'runners.tabNo': 1, 'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1, 'runners.isScratched': 1, 'runners.fp': 1,
        'runners.runnerId': 1, 'runners.age': 1, 'runners.sex': 1, 'runners.colors': 1,
      },
    }
  );
  if (doc) {
    // Speed map (8 Sep 2026, per Dinesh -- a separate `speedMaps` collection,
    // one doc per race keyed by `rId` (== races._id), with a `predictions[]`
    // array of per-runner barrier/settling/closing speed measures (0-1) and
    // ratings. Only fetched for the single race a popup is open on (not the
    // whole grid), same as the racecards/video joins above.
    const speedMapDoc = await client.db().collection('speedMaps').findOne({ rId: doc._id }, { projection: { predictions: 1 } });
    doc.speedMapPredictions = speedMapDoc && Array.isArray(speedMapDoc.predictions) ? speedMapDoc.predictions : null;
    await Promise.all([attachFormLineStatus([doc]), attachVideoStatus([doc], doc.rDate)]);
    applyAgeIgnores([doc]);
    applyDupJockeyIgnores([doc]);
    applyMissingJockeyIgnores([doc]);
  }
  return doc;
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
  const filter = { rDate: dateStr, rCourseDisplayName: meeting, rCountry: country, rDiscipline: discipline };
  if (!includeTrials) filter.isTrail = false;

  return client.db().collection('races')
    .find(filter)
    .project({
      _id: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rPrizeMoney: 1, rScheduleTime: 1,
      rName: 1, rDisplayName: 1, resultString: 1, isAbandoned: 1, rStatus: 1, isOpen: 1,
      meetingId: 1, rDate: 1,
      'runners.tabNo': 1, 'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1, 'runners.isScratched': 1, 'runners.fp': 1,
    })
    .sort({ rNo: 1 })
    .toArray();
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

// Guards ONLY the "/" route below -- report downloads, /api/race/:id, and
// /health are intentionally left open (Dinesh's explicit choice, 12 Aug 2026).
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/');
  let error = null;
  if (req.query.error === '1') error = 'Incorrect username or password.';
  else if (req.query.error === 'noconfig') error = 'Login is not set up on this server yet. Ask the admin to run "node setup-auth.js".';
  res.send(renderLoginPage({ error }));
});

app.post('/login', (req, res) => {
  if (!authConfig) return res.redirect('/login?error=noconfig');
  const { username, password } = req.body || {};
  const ok = typeof username === 'string' && typeof password === 'string'
    && username === authConfig.username
    && bcrypt.compareSync(password, authConfig.passwordHash);
  if (!ok) return res.redirect('/login?error=1');
  req.session.loggedIn = true;
  req.session.username = username;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  if (req.session) return req.session.destroy(() => res.redirect('/login'));
  res.redirect('/login');
});

app.get('/', requireLogin, async (req, res) => {
  const { dateStr, includeTrials, discipline } = parseRequestOptions(req);
  try {
    const docs = await fetchRaceDocs(dateStr, includeTrials);
    const schedule = buildSchedule(docs, dateStr);
    res.send(renderHtml(dateStr, schedule, { includeTrials, discipline, username: req.session.username }));
  } catch (err) {
    res.status(500).send(`<h1>Error loading dashboard</h1><pre>${escapeHtml(err.message)}</pre>`);
  }
});

app.get('/api/race/:id', async (req, res) => {
  try {
    const doc = await fetchRaceById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Race not found' });
    res.json(buildRaceDetail(doc));
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
app.get('/api/race/:id/raw/:kind', requireLogin, async (req, res) => {
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
app.post('/api/runner/:runnerId/form-ignore', requireLogin, (req, res) => {
  const { runnerId } = req.params;
  const { ignored, horseName } = req.body || {};
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
  raceDocsCache.clear(); // so the grid reflects this without waiting out the cache TTL
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Manual override for "Horse age issue" -- same pattern as form-ignore
// above, added 7 Sep 2026 per Dinesh: "Age checked no issue anda madhiri
// check mark poda podunga". Keyed by runnerId (a horse's age doesn't
// depend on which race it's entered in).
app.post('/api/runner/:runnerId/age-ignore', requireLogin, (req, res) => {
  const { runnerId } = req.params;
  const { ignored, horseName } = req.body || {};
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
  raceDocsCache.clear();
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Manual override for "Duplicate jockey" -- same pattern as age-ignore
// above, added 7 Sep 2026 per Dinesh: "Duplicate jockey checked with site
// podunga adau click panna checked podunga". Keyed by raceId + jockey name
// (not runnerId -- see dupJockeyIgnoreKey/applyDupJockeyIgnores), so one
// confirm clears every runner sharing that jockey in that race.
app.post('/api/race/:raceId/jockey-ignore', requireLogin, (req, res) => {
  const { raceId } = req.params;
  const { ignored, jockey } = req.body || {};
  if (!jockey) return res.status(400).json({ error: 'Missing "jockey" in request body' });
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
  raceDocsCache.clear();
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Manual override for "Missing jockey" -- same pattern as jockey-ignore
// above, added 7 Sep 2026 per Dinesh: "Missing jockey / Duplicate jockey
// Idukku checked with Site button podunga, pottadu adu issue ignore
// aaganu". Keyed by raceId + runnerId (see missingJockeyIgnoreKey/
// applyMissingJockeyIgnores) -- unlike duplicate jockey, this is per
// RUNNER since it's not a shared-name group.
app.post('/api/race/:raceId/runner/:runnerId/missing-jockey-ignore', requireLogin, (req, res) => {
  const { raceId, runnerId } = req.params;
  const { ignored, horseName } = req.body || {};
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
  raceDocsCache.clear();
  res.json({ ok: true, ignored: Boolean(ignored) });
});

// Best-effort video lookup for a horse's PAST races (shown in the pedigree/
// form-history popup). A read, like /api/race/:id above, so left open (same
// "guards only /" choice noted on requireLogin). Unlike attachVideoStatus,
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
      if (!keysByDate.has(dateStr)) keysByDate.set(dateStr, await listVideoKeysForDate(dateStr));
      const existingKeys = keysByDate.get(dateStr);
      const key = buildVideoKey(dateStr, country, course, raceNo);
      const hasVideo = existingKeys.has(key);
      results.push({ id, hasVideo, videoUrl: hasVideo ? `${VIDEO_LIST_URL}${key}` : undefined });
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

app.get('/meetings-list-view', requireLogin, async (req, res) => {
  const { fromDate, toDate, includeTrials, discipline, country, tab } = parseMeetingsListViewOptions(req);
  try {
    const docs = await fetchRaceDocsForDateRange(fromDate, toDate, includeTrials);
    const rows = buildMeetingsListRowsForRange(groupDocsByDate(docs), discipline, country, tab);
    const countries = [...new Set(docs.map((d) => d.rCountry).filter(Boolean))].sort();
    res.send(renderMeetingsListPage(rows, {
      fromDate, toDate, discipline, country, tab, includeTrials, countries, username: req.session.username,
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
  console.log(`[race-dashboard] Login config: ${AUTH_CONFIG_PATH}${authConfig ? ` (username: ${authConfig.username})` : ' (NOT SET UP -- run "node setup-auth.js")'}`);
});
