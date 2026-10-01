/**
 * Data-change tracking (30 Sep 2026, per Dinesh): what was added, removed
 * or changed in meetings/races after each scrape -- e.g. a missing jockey
 * that a re-scrape filled in, or a runner being scratched.
 *
 * The database has no change feed (not a replica set), so server.js keeps a
 * snapshot of the tracked fields and compares each new read against it.
 * This file holds the snapshot/diff logic and the storage: one file per
 * race date (data-changes-2026-09-30.jsonl), kept KEEP_DAYS days.
 */

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;
const FILE_RE = /^data-changes-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function str(v) {
  return v == null ? '' : String(v).trim();
}
function yesNo(v) {
  return v ? 'Yes' : 'No';
}
// Barrier and tab number 0 mean "not set" in this data.
function numOrBlank(v) {
  const s = str(v);
  return s === '0' ? '' : s;
}
// rScheduleTime is venue-local ("2026-09-30T13:35:00"); only the clock
// time is shown.
function clock(v) {
  const m = /(\d{2}:\d{2})/.exec(str(v));
  return m ? m[1] : str(v);
}

function meetingSnap(m) {
  return {
    date: m.mDate,
    name: str(m.mCourseDisplayName || m.mCourse),
    country: str(m.mCountry),
    discipline: str(m.mDiscipline),
    races: m.numberOfRaces || null,
    updatedAt: m.updatedAt || null,
    fields: { 'Track condition': str(m.mTrack), Abandoned: yesNo(m.isAbandoned) },
  };
}

function runnerKey(x) {
  return x.runnerId ? String(x.runnerId) : `tab${x.tabNo}|${str(x.horseName).toLowerCase()}`;
}

function raceSnap(r) {
  const runners = {};
  (r.runners || []).forEach((x) => {
    runners[runnerKey(x)] = {
      label: `#${numOrBlank(x.tabNo) || '?'} ${str(x.horseName)}`,
      fields: {
        Jockey: str(x.jockey),
        Trainer: str(x.trainer),
        Scratched: yesNo(x.isScratched),
        Barrier: numOrBlank(x.bp),
        Weight: str(x.weight),
        'Horse name': str(x.horseName),
        'Tab number': numOrBlank(x.tabNo),
      },
    };
  });
  return {
    date: r.rDate,
    meeting: str(r.rCourseDisplayName || r.rCourse),
    country: str(r.rCountry),
    discipline: str(r.rDiscipline),
    raceNo: r.rNo,
    updatedAt: r.updatedAt || null,
    fields: {
      'Race time': clock(r.rScheduleTime),
      Distance: str(r.rDistance),
      Class: str(r.rClass),
      Abandoned: yesNo(r.isAbandoned),
      Result: str(r.resultString),
    },
    runners,
  };
}

function kindOf(field, oldV, newV) {
  if (field === 'Scratched') return newV === 'Yes' ? 'scratched' : 'changed';
  if (field === 'Abandoned') return newV === 'Yes' ? 'abandoned' : 'changed';
  if (oldV === '' && newV !== '') return 'fixed';
  if (oldV !== '' && newV === '') return 'missing';
  return 'changed';
}

function diffFields(prevFields, curFields, base, skip) {
  const out = [];
  for (const field of Object.keys(curFields)) {
    if (skip && skip(field)) continue;
    const oldV = prevFields[field] == null ? '' : prevFields[field];
    const newV = curFields[field];
    if (oldV === newV) continue;
    out.push({ ...base, field, old: oldV, new: newV, kind: kindOf(field, oldV, newV) });
  }
  return out;
}

function diffMeeting(prev, cur, time) {
  const m = cur || prev;
  const base = { time, date: m.date, country: m.country, discipline: m.discipline, meeting: m.name, raceNo: null, runner: '' };
  if (!prev) return [{ ...base, field: 'Meeting added', old: '', new: cur.races ? `${cur.races} races` : 'added', kind: 'added' }];
  if (!cur) return [{ ...base, field: 'Meeting removed', old: prev.name, new: '', kind: 'removed' }];
  return diffFields(prev.fields, cur.fields, base);
}

function diffRace(prev, cur, time, raceId) {
  const r = cur || prev;
  const base = { time, date: r.date, country: r.country, discipline: r.discipline, meeting: r.meeting, raceNo: r.raceNo, raceId, runner: '' };
  if (!prev) return [{ ...base, field: 'Race added', old: '', new: `R${cur.raceNo} ${cur.fields['Race time']}`.trim(), kind: 'added' }];
  if (!cur) return [{ ...base, field: 'Race removed', old: `R${prev.raceNo}`, new: '', kind: 'removed' }];
  const out = diffFields(prev.fields, cur.fields, base);
  for (const key of Object.keys(cur.runners)) {
    const now = cur.runners[key];
    const was = prev.runners[key];
    const rBase = { ...base, runner: now.label };
    if (!was) {
      out.push({ ...rBase, field: 'Runner added', old: '', new: now.label, kind: 'added' });
      continue;
    }
    // A scratched runner's jockey/barrier etc. are often blanked -- only
    // the scratching itself is worth reporting.
    const scratched = now.fields.Scratched === 'Yes';
    out.push(...diffFields(was.fields, now.fields, rBase, (f) => scratched && f !== 'Scratched'));
  }
  for (const key of Object.keys(prev.runners)) {
    if (!cur.runners[key]) out.push({ ...base, runner: prev.runners[key].label, field: 'Runner removed', old: prev.runners[key].label, new: '', kind: 'removed' });
  }
  return out;
}

function changesFilePath(dir, date) {
  return path.join(dir, `data-changes-${date}.jsonl`);
}

function appendChanges(dir, entries) {
  const byDate = new Map();
  entries.forEach((e) => {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(JSON.stringify(e));
  });
  for (const [date, lines] of byDate) fs.appendFileSync(changesFilePath(dir, date), lines.join('\n') + '\n');
}

// Newest first.
function readChanges(dir, date) {
  const file = changesFilePath(dir, date);
  if (!fs.existsSync(file)) return [];
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) { /* skip a partial line */ }
  }
  return entries.reverse();
}

// Deletes files for race dates more than KEEP_DAYS days before today.
// Returns error messages for files that couldn't be deleted.
function deleteOldChangeFiles(dir, todayDate) {
  const cutoff = new Date(Date.parse(`${todayDate}T00:00:00Z`) - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const errors = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return errors;
  }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m || m[1] >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (err) {
      errors.push(`Could not delete old data-change log ${name} (${err.code || 'error'}): ${err.message}`);
    }
  }
  return errors;
}

module.exports = { KEEP_DAYS, meetingSnap, raceSnap, diffMeeting, diffRace, appendChanges, readChanges, deleteOldChangeFiles };
