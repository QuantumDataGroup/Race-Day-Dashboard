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
const PORT = process.env.PORT || 3000;
const CONNECTION_NAME = process.env.DB_CONNECTION_NAME || 'mongodb-prod';

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

async function fetchRaceDocs(dateStr, includeTrials) {
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
      meetingId: 1, rStatus: 1, isOpen: 1, isAbandoned: 1, resultString: 1,
      'runners.jockey': 1, 'runners.isScratched': 1, 'runners.tabNo': 1, 'runners.fp': 1,
      'runners.trainer': 1,
    })
    .sort({ rCourseDisplayName: 1, rNo: 1 })
    .toArray();

  const meetingIds = [...new Set(docs.map((d) => d.meetingId).filter(Boolean))];
  const tabStatusByMeetingId = await fetchTabStatusByMeetingId(meetingIds);
  for (const doc of docs) {
    doc.isTAB = tabStatusByMeetingId.has(doc.meetingId) ? tabStatusByMeetingId.get(doc.meetingId) : true;
  }
  return docs;
}

async function fetchRaceById(id) {
  const client = await getClient();
  return client.db().collection('races').findOne(
    { _id: id },
    {
      projection: {
        rCourseDisplayName: 1, rCountry: 1, rDiscipline: 1, rNo: 1, rClass: 1, rPrizeMoney: 1, rScheduleTime: 1, resultString: 1,
        rName: 1, rDisplayName: 1,
        meetingId: 1, rDate: 1,
        'runners.tabNo': 1, 'runners.horseName': 1, 'runners.jockey': 1, 'runners.trainer': 1, 'runners.isScratched': 1, 'runners.fp': 1,
      },
    }
  );
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

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'rdd.sid',
  cookie: { httpOnly: true, sameSite: 'lax' }, // no maxAge -> browser-session cookie, cleared on browser close
}));
app.use(express.urlencoded({ extended: false }));

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
