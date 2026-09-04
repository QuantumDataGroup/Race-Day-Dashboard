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
  buildMeetingDetailsReport, meetingDetailsReportToCsv,
} = require('./raceView');

const DB_CONFIG_PATH = process.env.DB_CONFIG_PATH || 'C:\\Users\\Dinesh\\projects-config\\db.json';
const AUTH_CONFIG_PATH = process.env.AUTH_CONFIG_PATH || 'C:\\Users\\Dinesh\\projects-config\\auth.json';
const FORM_IGNORE_PATH = process.env.FORM_IGNORE_PATH || 'C:\\Users\\Dinesh\\projects-config\\form-line-ignores.json';
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

// TAB / Non-TAB is a meeting-level designation that lives on the `meetings`
// collection (`isTAB`), not on the race document itself -- join it in here
// via `meetingId` so the grid can filter/tag by it. Returns a Map of
// meetingId -> isTAB (defaults missing/unknown meetings to true so they
// still render normally rather than vanishing under the TAB filter).
async function fetchTabStatusByMeetingId(meetingIds) {
  const map = new Map();
  if (!meetingIds.length) return map;
  const client = await getClient();
  const meetingDocs = await client.db().collection('meetings')
    .find({ _id: { $in: meetingIds } })
    .project({ _id: 1, isTAB: 1 })
    .toArray();
  for (const m of meetingDocs) map.set(m._id, m.isTAB !== false);
  return map;
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
    const course = String(doc.rCourseDisplayName || '').trim().replace(/\s+/g, '_');
    const key = `client1/${dateStr}/${doc.rCountry}_${course}_race${doc.rNo}_${dateStr}.mp4`;
    doc.hasVideo = existingKeys.has(key);
    if (doc.hasVideo) doc.videoUrl = `${VIDEO_LIST_URL}${key}`;
  }
}

// Cross-references Troyen DB's AUS Thoroughbred meetings for one date against
// Racing Australia's own published meeting calendar (1 Sep 2026, per Dinesh:
// manually compared racingaustralia.horse against TD DB and found Saturday's
// entire card -- 18 meetings -- missing from the DB; wanted that check
// running on the dashboard itself). Racing Australia's homepage lists the
// "next 7 days" as a table of `<a href="...Key=YYYYMonDD,STATE,Meeting
// Name">` links -- that Key param is the most reliable thing to parse (far
// more stable than scraping visible table layout/CSS), so this just regex-
// matches every Key occurrence rather than doing real HTML/DOM parsing.
// Scoped to AUS/Thoroughbred only because that's literally what this site
// covers -- it has no Harness/Greyhound or overseas content at all.
const RACING_AUSTRALIA_URL = 'https://www.racingaustralia.horse/';
const RACING_AUSTRALIA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const RA_MONTH_TO_NUM = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const RA_MEETINGS_CACHE_TTL_MS = 15 * 60 * 1000; // external site, meeting lists don't churn minute-to-minute
// 3 Sep 2026, per Dinesh -- on the actual hosting machine this request kept
// failing (403, then repeated timeouts) and, since a FAILED fetch never
// populated the success cache above, every single dashboard page load paid
// the full retry + timeout cost again. This failure cache backs off for a
// few minutes after a failure so a flaky/blocked external site degrades to
// "banner just doesn't show for a while", not "every page load gets slower".
const RA_MEETINGS_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
let raMeetingsCache = null; // { fetchedAt, byDate: Map(dateStr -> [{state, name}]) }
let raMeetingsFailedAt = null;

async function fetchRacingAustraliaMeetings() {
  if (raMeetingsCache && Date.now() - raMeetingsCache.fetchedAt < RA_MEETINGS_CACHE_TTL_MS) return raMeetingsCache.byDate;
  if (raMeetingsFailedAt && Date.now() - raMeetingsFailedAt < RA_MEETINGS_FAILURE_BACKOFF_MS) {
    throw new Error('skipping retry -- recent fetch failure still within backoff window');
  }

  let res;
  try {
    res = await fetch(RACING_AUSTRALIA_URL, {
      headers: { 'User-Agent': RACING_AUSTRALIA_UA },
      signal: AbortSignal.timeout(4000),
    });
  } catch (err) {
    raMeetingsFailedAt = Date.now();
    throw err;
  }
  if (!res.ok) {
    raMeetingsFailedAt = Date.now();
    throw new Error(`Racing Australia homepage request failed (${res.status})`);
  }
  const html = await res.text();

  const byDate = new Map();
  for (const m of html.matchAll(/Key=(\d{4})([A-Za-z]{3})(\d{2})%2C([A-Z]+)%2C([^"&]+)"/g)) {
    const [, year, monAbbr, day, state, encodedName] = m;
    const month = RA_MONTH_TO_NUM[monAbbr];
    if (!month) continue;
    const dateStr = `${year}-${month}-${day}`;
    const name = decodeURIComponent(encodedName).trim();
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    // The same meeting can appear more than once in the table markup (e.g.
    // separate Programs/Form/Results links) -- dedupe by state+name.
    const list = byDate.get(dateStr);
    if (!list.some((x) => x.state === state && x.name === name)) list.push({ state, name });
  }

  raMeetingsCache = { fetchedAt: Date.now(), byDate };
  return byDate;
}

// Troyen DB course names never carry sponsor branding (e.g. DB has
// "MILDURA", Racing Australia shows "bet365 Mildura" for the exact same
// meeting) -- treat the Racing Australia name ending with the DB name
// (case-insensitive) as a match, alongside an exact match.
function courseNamesMatch(dbName, raName) {
  const a = String(dbName || '').trim().toUpperCase();
  const b = String(raName || '').trim().toUpperCase();
  if (!a || !b) return false;
  return a === b || b.endsWith(a) || a.endsWith(b);
}

// Returns the list of Racing Australia meetings (as "Name (STATE)" strings)
// for `dateStr` that have no matching entry in `dbMeetingNames` -- or `null`
// (not an empty array) when `dateStr` falls outside Racing Australia's own
// published window (currently the next ~7 days) or the fetch itself failed,
// so the dashboard can tell "nothing to compare here" apart from "checked,
// none missing".
async function findMissingAusMeetings(dateStr, dbMeetingNames) {
  let byDate;
  try {
    byDate = await fetchRacingAustraliaMeetings();
  } catch (err) {
    // Don't re-log the same failure on every request during the backoff
    // window -- only the actual attempt that failed is worth a log line.
    if (!err.message.includes('skipping retry')) {
      console.warn(`[race-dashboard] WARNING: could not fetch Racing Australia meeting list: ${err.message} -- skipping missing-meeting check`);
    }
    return null;
  }
  if (!byDate.has(dateStr)) return null;

  return byDate.get(dateStr)
    .filter((ra) => !dbMeetingNames.some((db) => courseNamesMatch(db, ra.name)))
    .map((ra) => `${ra.name} (${ra.state})`);
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
    .project({ RaceId: 1, Client: 1, 'Runners.RunnerId': 1, 'Runners.FormLines': 1 })
    .toArray();

  // raceId -> runnerId -> { [clientLabel]: hasFormLines }
  const formByRaceId = new Map();
  for (const card of cards) {
    const clientLabel = card.Client || 'Default';
    if (!formByRaceId.has(card.RaceId)) formByRaceId.set(card.RaceId, new Map());
    const byRunnerId = formByRaceId.get(card.RaceId);
    for (const r of (card.Runners || [])) {
      if (!byRunnerId.has(r.RunnerId)) byRunnerId.set(r.RunnerId, {});
      const hasLines = Array.isArray(r.FormLines) && r.FormLines.length > 0;
      // Different Style/Language docs under the same Client are presentation
      // variants of the same underlying data pull, not independent sources
      // -- OR them together rather than letting whichever comes back last win.
      const perRunner = byRunnerId.get(r.RunnerId);
      perRunner[clientLabel] = perRunner[clientLabel] || hasLines;
    }
  }

  for (const doc of docs) {
    const byRunnerId = formByRaceId.get(doc._id);
    for (const r of (doc.runners || [])) {
      const perClient = byRunnerId ? byRunnerId.get(r.runnerId) : null;
      r.formLinesByClient = perClient || null; // null -- no racecard found for this runner at all
      r.hasFormLines = perClient ? Boolean(perClient.Default) : true; // no racecard data -> can't confirm a gap, don't flag
      if (r.hasFormLines === false && r.runnerId && formLineIgnores[r.runnerId]) {
        r.hasFormLines = true;
        r.formLineIgnored = true;
      }
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
      _id: 1, rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rPrizeMoney: 1, rScheduleTime: 1,
      meetingId: 1, rStatus: 1, isOpen: 1, isAbandoned: 1, isTrail: 1, resultString: 1,
      'runners.jockey': 1, 'runners.isScratched': 1, 'runners.tabNo': 1, 'runners.fp': 1,
      'runners.trainer': 1, 'runners.horseName': 1, 'runners.runnerId': 1,
    })
    .sort({ rCourseDisplayName: 1, rNo: 1 })
    .toArray();

  const meetingIds = [...new Set(docs.map((d) => d.meetingId).filter(Boolean))];
  const tabStatusByMeetingId = await fetchTabStatusByMeetingId(meetingIds);
  for (const doc of docs) {
    doc.isTAB = tabStatusByMeetingId.has(doc.meetingId) ? tabStatusByMeetingId.get(doc.meetingId) : true;
  }
  await Promise.all([attachFormLineStatus(docs), attachVideoStatus(docs, dateStr)]);
  raceDocsCache.set(cacheKey, { docs, expiresAt: Date.now() + RACE_DOCS_CACHE_TTL_MS });
  return docs;
}

async function fetchRaceById(id) {
  const client = await getClient();
  const doc = await client.db().collection('races').findOne(
    { _id: id },
    {
      projection: {
        rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rPrizeMoney: 1, rScheduleTime: 1, resultString: 1,
        rName: 1, rDisplayName: 1, isTrail: 1,
        meetingId: 1, rDate: 1,
        'runners.tabNo': 1, 'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1, 'runners.isScratched': 1, 'runners.fp': 1,
        'runners.runnerId': 1,
      },
    }
  );
  if (doc) await Promise.all([attachFormLineStatus([doc]), attachVideoStatus([doc], doc.rDate)]);
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
    const schedule = buildSchedule(docs);
    const dbAusThoroughbredMeetings = [...new Set(
      docs.filter((d) => d.rCountry === 'AUS' && d.rDiscipline === 'T').map((d) => d.rCourseDisplayName)
    )];
    const missingAusMeetings = await findMissingAusMeetings(dateStr, dbAusThoroughbredMeetings);
    res.send(renderHtml(dateStr, schedule, { includeTrials, discipline, username: req.session.username, missingAusMeetings }));
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
