/**
 * Issue workflow + history for the Overview page (Oct 2026, per Dinesh).
 *
 * - Workflow: an issue (`${raceId}|${code}`, see raceView.js raceIssueList)
 *   is Open until someone marks it In progress (they become its owner) or
 *   Fixed, with an optional note. Saved in issue-workflow.json.
 * - History: recordIssues() runs every few minutes for today and keeps, per
 *   race date, when each issue was first and last seen and when it went away
 *   (the data got fixed) or was marked Fixed -- issue-history/<date>.json.
 *   That gives "fixed today", the average fix time and the 7-day trend.
 *
 * Everything lives in the dashboard's data folder (the Docker /data volume),
 * never in the production database.
 */
const fs = require('fs');
const path = require('path');

const KEEP_HISTORY_DAYS = 40;
// waiting_source (Oct 2026, per Dinesh): "Not available at source yet" -- the
// data isn't on the source either; still open, alerts only near the jump.
const STATUSES = ['open', 'in_progress', 'waiting_source', 'fixed'];

function createIssueTracker({ dir, now = () => new Date() }) {
  const workflowPath = path.join(dir, 'issue-workflow.json');
  const historyDir = path.join(dir, 'issue-history');
  let workflow = {};
  try {
    if (fs.existsSync(workflowPath)) workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: could not read ${workflowPath}: ${err.message} -- starting with no issue statuses`);
  }
  const historyCache = new Map();

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  }

  function historyPath(dateStr) {
    return path.join(historyDir, `${dateStr}.json`);
  }

  function loadHistory(dateStr) {
    if (historyCache.has(dateStr)) return historyCache.get(dateStr);
    let h = { date: dateStr, races: 0, issues: {} };
    try {
      if (fs.existsSync(historyPath(dateStr))) h = JSON.parse(fs.readFileSync(historyPath(dateStr), 'utf8'));
    } catch (err) { /* start the day fresh */ }
    historyCache.set(dateStr, h);
    if (historyCache.size > 12) historyCache.delete(historyCache.keys().next().value);
    return h;
  }

  // Today's issues as the dashboard sees them right now.
  function recordIssues(dateStr, issues, raceCount) {
    const h = loadHistory(dateStr);
    const at = now().toISOString();
    const seen = new Set();
    for (const i of issues) {
      seen.add(i.key);
      const e = h.issues[i.key] || (h.issues[i.key] = { code: i.code, raceId: i.raceId, meeting: i.meeting, country: i.country, discipline: i.discipline, rNo: i.rNo, firstSeen: at });
      e.lastSeen = at;
      e.detail = i.detail;
      // Back again: no longer fixed (unless the team marked it fixed).
      if (e.resolvedAt && e.resolvedBy === 'data') { delete e.resolvedAt; delete e.resolvedBy; }
    }
    for (const [key, e] of Object.entries(h.issues)) {
      if (!seen.has(key) && !e.resolvedAt) { e.resolvedAt = at; e.resolvedBy = 'data'; }
    }
    h.races = raceCount;
    h.updatedAt = at;
    writeJson(historyPath(dateStr), h);
    prune();
  }

  let lastPrune = 0;
  function prune() {
    if (Date.now() - lastPrune < 6 * 60 * 60 * 1000) return;
    lastPrune = Date.now();
    const cutoff = new Date(Date.now() - KEEP_HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
    try {
      for (const f of fs.readdirSync(historyDir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) fs.unlinkSync(path.join(historyDir, f));
    } catch (err) { /* nothing to prune */ }
    for (const [key, w] of Object.entries(workflow)) {
      if ((w.updatedAt || '').slice(0, 10) < cutoff) delete workflow[key];
    }
  }

  function statusOf(key) {
    return workflow[key] || { status: 'open' };
  }

  function setStatus(key, status, username, note) {
    if (!STATUSES.includes(status)) throw new Error('Unknown status');
    const at = now().toISOString();
    const prev = workflow[key] || {};
    if (status === 'open') {
      delete workflow[key];
    } else {
      workflow[key] = {
        status,
        owner: status === 'in_progress' || status === 'waiting_source' ? username : (prev.owner || username),
        note: note != null ? String(note).slice(0, 500) : (prev.note || ''),
        startedAt: status === 'in_progress' ? (prev.startedAt || at) : prev.startedAt || null,
        fixedAt: status === 'fixed' ? at : null,
        updatedAt: at,
        updatedBy: username,
      };
    }
    writeJson(workflowPath, workflow);
    // (A manual Fixed also counts as fixed in dayStats.)
    return workflow[key] || { status: 'open' };
  }

  // Per-day numbers for the trend: issues found, fixed (went away or marked
  // fixed), and the share of races with no issue left open.
  function dayStats(dateStr) {
    const h = loadHistory(dateStr);
    const entries = Object.entries(h.issues);
    const fixed = entries.filter(([key, e]) => e.resolvedAt || (workflow[key] && workflow[key].status === 'fixed'));
    const openRaces = new Set(entries.filter(([key, e]) => !e.resolvedAt && !(workflow[key] && workflow[key].status === 'fixed')).map(([, e]) => e.raceId));
    const fixMinutes = fixed
      .map(([key, e]) => (Date.parse((workflow[key] && workflow[key].fixedAt) || e.resolvedAt) - Date.parse(e.firstSeen)) / 60000)
      .filter((m) => Number.isFinite(m) && m >= 0);
    return {
      date: dateStr,
      recorded: Boolean(h.updatedAt),
      found: entries.length,
      fixed: fixed.length,
      races: h.races || 0,
      score: h.races ? Math.round(((h.races - openRaces.size) / h.races) * 100) : null,
      avgFixMinutes: fixMinutes.length ? Math.round(fixMinutes.reduce((a, b) => a + b, 0) / fixMinutes.length) : null,
    };
  }

  function firstSeen(dateStr, key) {
    const e = loadHistory(dateStr).issues[key];
    return e ? e.firstSeen : null;
  }

  // For a ticket: is the issue still in the data? 'still' / 'fixed' / null (unknown).
  function dataNow(dateStr, key) {
    if (!dateStr || !key) return null;
    const e = loadHistory(dateStr).issues[key];
    if (!e) return null;
    return e.resolvedAt && e.resolvedBy === 'data' ? 'fixed' : 'still';
  }

  return { recordIssues, statusOf, setStatus, dayStats, firstSeen, dataNow, STATUSES };
}

// Critical: starts within 30 minutes; High: within the hour; Normal: later.
function priorityFor(startUtc, nowMs) {
  const start = Date.parse(startUtc || '');
  if (!Number.isFinite(start)) return 'normal';
  const mins = (start - nowMs) / 60000;
  if (mins <= 30) return 'critical';
  if (mins <= 60) return 'high';
  return 'normal';
}

module.exports = { createIssueTracker, priorityFor };
