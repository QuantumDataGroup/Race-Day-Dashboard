/**
 * Race Day Dashboard - core logic
 * ---------------------------------
 *   - Separate grid per discipline: Thoroughbred, Harness, Greyhound
 *   - Race class + prize money shown per race
 *   - Missing-jockey / duplicate-jockey detection (Thoroughbred + Harness only
 *     -- Greyhound races have no jockey field at all)
 *   - Per-race click-through detail: tab number, horse name, jockey (T/H) or
 *     trainer (G), and a computed "issue" per runner
 *
 * Kept free of the MongoDB driver / express so it can be unit tested with
 * plain sample data.
 */

const MISSING_JOCKEY_BORDER_THRESHOLD = 0; // strictly more than this -> red border (any missing jockey at all triggers it)
const GAP_THRESHOLD_MIN = 15; // race scheduled less than this many minutes after the previous race at the same meeting -> highlighted

const DISCIPLINE_ORDER = ['T', 'H', 'G'];
const DISCIPLINE_LABELS = { T: 'Thoroughbred', H: 'Harness', G: 'Greyhound' };

// Known legitimate placeholder value -- multiple runners can share this
// without it being a real duplicate-jockey bug (confirmed during the
// 5 Aug 2026 production investigation).
const PLACEHOLDER_JOCKEYS = new Set(['rider tba']);

const STATUS_ORDER = ['upcoming', 'running', 'completed', 'resulted', 'abandoned'];
const STATUS_LABELS = {
  upcoming: 'Upcoming', running: 'Running', completed: 'Completed', resulted: 'Resulted', abandoned: 'Abandoned',
};

// Race lifecycle status, derived from the real fields the DB actually has --
// there's no single "status" field with clean Upcoming/Running/Completed/
// Resulted/Abandoned values, so this maps from `isAbandoned`, `rStatus`
// (seen in production as "RESULT" / "INTERIM" / "ABANDONED" / "OPEN" / "open"
// / blank / null), and `isOpen` (betting still open):
//   - isAbandoned true (or rStatus "ABANDONED")      -> abandoned
//   - rStatus "RESULT"                                -> resulted (final)
//   - rStatus "INTERIM"                                -> completed (provisional, pending confirmation)
//   - isOpen === false (none of the above matched)     -> running (betting closed, no result yet -- in/near its live window)
//   - anything else (isOpen true or missing)           -> upcoming
function deriveRaceStatus(doc) {
  if (doc.isAbandoned) return 'abandoned';
  const rStatus = String(doc.rStatus || '').trim().toUpperCase();
  if (rStatus === 'ABANDONED') return 'abandoned';
  if (rStatus === 'RESULT') return 'resulted';
  if (rStatus === 'INTERIM') return 'completed';
  if (doc.isOpen === false) return 'running';
  return 'upcoming';
}

function todayStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// rScheduleTime looks like "2026-08-06T13:33:00" or "...+05:30" / "...+00:00".
// We only need the clock time as displayed (venue-local), so pull HH:mm
// straight out of the string rather than parsing it as an absolute Date --
// that sidesteps the inconsistent timezone-suffix formats seen in this field.
function parseClock(rScheduleTime) {
  if (!rScheduleTime) return null;
  const match = /T(\d{2}):(\d{2})/.exec(rScheduleTime);
  if (!match) return null;
  const hh = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  return { label: `${match[1]}:${match[2]}`, minutes: hh * 60 + mm };
}

function disciplineLabel(code) {
  return DISCIPLINE_LABELS[code] || code || '?';
}

function isPlaceholderJockey(name) {
  return PLACEHOLDER_JOCKEYS.has(String(name || '').trim().toLowerCase());
}

function isBlank(value) {
  return !value || !String(value).trim();
}

// Non-scratched runners with no jockey recorded. Not meaningful for
// Greyhound (G) -- dogs don't have jockeys, so the field is always blank
// there and flagging it would just mark every greyhound race. Returns null
// (not applicable) for G.
function countMissingJockeys(runners, discipline) {
  if (discipline === 'G') return null;
  if (!Array.isArray(runners)) return 0;
  return runners.filter((r) => !r.isScratched && isBlank(r.jockey)).length;
}

// Map of jockey (lowercased, trimmed) -> count of non-scratched runners
// carrying that jockey in this race, excluding blanks and known placeholders.
function jockeyCounts(runners) {
  const counts = new Map();
  if (!Array.isArray(runners)) return counts;
  for (const r of runners) {
    if (r.isScratched) continue;
    if (isBlank(r.jockey)) continue;
    if (isPlaceholderJockey(r.jockey)) continue;
    const key = String(r.jockey).trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function hasDuplicateJockey(runners, discipline) {
  if (discipline === 'G') return false; // no jockeys in greyhound racing
  const counts = jockeyCounts(runners);
  for (const c of counts.values()) {
    if (c > 1) return true;
  }
  return false;
}

// Count of DISTINCT jockey names that are assigned to more than one runner
// in this race (e.g. 2 if both "A Smith" and "B Jones" each cover 2+ runners).
function countDuplicateJockeyGroups(runners, discipline) {
  if (discipline === 'G') return 0; // no jockeys in greyhound racing
  const counts = jockeyCounts(runners);
  let n = 0;
  for (const c of counts.values()) {
    if (c > 1) n++;
  }
  return n;
}

// Tab/saddlecloth number is a physical race-day identifier that must be
// present, non-zero, and unique per race -- applies to ALL disciplines
// (Greyhound box numbers included), regardless of scratched status, since a
// bad tab number is a data problem independent of jockey/scratch state.
function isMissingTabNo(tabNo) {
  return tabNo == null || tabNo === '';
}

function isZeroTabNo(tabNo) {
  return !isMissingTabNo(tabNo) && Number(tabNo) === 0;
}

// Map of valid (non-missing, non-zero) tab number -> count of runners
// carrying that number in this race.
function tabNoCounts(runners) {
  const counts = new Map();
  if (!Array.isArray(runners)) return counts;
  for (const r of runners) {
    if (isMissingTabNo(r.tabNo) || isZeroTabNo(r.tabNo)) continue;
    const n = Number(r.tabNo);
    if (!Number.isFinite(n)) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return counts;
}

function hasDuplicateTabNo(runners) {
  const counts = tabNoCounts(runners);
  for (const c of counts.values()) {
    if (c > 1) return true;
  }
  return false;
}

// Count of runners with a missing, zero, or duplicate tab number -- used for
// the grid-level red flag/badge.
function countTabNoIssues(runners) {
  if (!Array.isArray(runners)) return 0;
  const counts = tabNoCounts(runners);
  return runners.filter((r) => {
    if (isMissingTabNo(r.tabNo)) return true;
    if (isZeroTabNo(r.tabNo)) return true;
    const n = Number(r.tabNo);
    return Number.isFinite(n) && (counts.get(n) || 0) > 1;
  }).length;
}

// Per-runner tab-number issue label (applies to every discipline).
function tabIssueForRunner(runner, counts) {
  if (isMissingTabNo(runner.tabNo)) return 'Missing tab number';
  if (isZeroTabNo(runner.tabNo)) return 'Invalid tab number (0)';
  const n = Number(runner.tabNo);
  if (Number.isFinite(n) && (counts.get(n) || 0) > 1) return 'Duplicate tab number';
  return '';
}

// Trainer must be present for every non-scratched runner -- applies to ALL
// disciplines (Greyhound runners have a trainer/handler too, unlike jockey).
// Verified against real production data (7 Aug 2026): trainer is reliably
// populated (0% blank in a ~18,700-runner sample), so this is a meaningful
// check, unlike weight/draw which are almost always blank in this collection.
function countMissingTrainers(runners) {
  if (!Array.isArray(runners)) return 0;
  return runners.filter((r) => !r.isScratched && isBlank(r.trainer)).length;
}

// --- Timezone/UTC cross-check: REMOVED 11 Aug 2026 -------------------------
//
// A whole timezone/UTC-offset validation feature (within-meeting peer
// comparison, then cross-meeting-same-day, then course-history baseline --
// see git history around 10-11 Aug 2026 for the full three-layer design,
// `computeTimezoneIssuesForMeeting`/`computeCrossMeetingTimezoneIssues`/
// `computeCourseHistoryTimezoneIssues`/`computeTimezoneIssues`,
// `computeUtcOffsetMinutes`/`formatUtcOffset`/`computeMajorityOffset`) was
// built 10-11 Aug 2026 to catch a real NZ - RICCARTON PARK bug where
// `rScheduleTimeUTC` was uniformly wrong for a whole meeting.
//
// Removed per Dinesh, 11 Aug 2026: "Time zone check pandrada remove
// pannunga, Time zone wena summa times mattu check pannunga podu" (remove
// the timezone check, just check the times instead), followed by "Times
// modal'la sonna madhiri <15 minutes gap irukka kudathu, same time wara
// kudathu, duplicate aagi irukka kudathu, na first'ku sonna vishayanga da"
// (like what I originally asked for -- no <15 min gap, no same/duplicate
// time -- those are the things I said first). That original ask is exactly
// the PRE-EXISTING "Schedule Issue" check just below (`GAP_THRESHOLD_MIN`,
// `highlighted`, `badTime`/`badTimeReason` in `buildSchedule()`) -- it
// already flags a race scheduled <15 minutes after the previous one, an
// exact-duplicate scheduled time within a meeting, and the 00:00 placeholder
// time. That check is untouched by this removal and remains the only
// schedule-time validation in this file.
//
// IMPORTANT if a UTC/local-mismatch-style check is ever requested again:
// this removal means the ONLY thing validated now is the LOCAL
// `rScheduleTime` value's shape/spacing -- `rScheduleTimeUTC` is no longer
// read or compared anywhere. That trades away the ability to catch the
// exact Riccarton Park class of bug (local time was correct, only the UTC
// field was wrong -- a purely local-time check cannot see that), which was
// a known, explicitly-accepted tradeoff at removal time, not an oversight.

// Per-runner issue label used in the click-through detail view. Combines the
// tab-number check (all disciplines), the trainer check (all disciplines),
// and the jockey check (Thoroughbred/Harness only -- Greyhound runners show
// a trainer column instead and have no jockey-based issue to flag beyond the
// trainer check already covering them).
function issueForRunner(runner, discipline, jockeyCountsMap, tabCountsMap) {
  if (runner.isScratched) return '';
  const parts = [];
  const tabIssue = tabIssueForRunner(runner, tabCountsMap || new Map());
  if (tabIssue) parts.push(tabIssue);
  if (discipline !== 'G') {
    if (isBlank(runner.jockey)) parts.push('Missing jockey');
    else if (!isPlaceholderJockey(runner.jockey)) {
      const key = String(runner.jockey).trim().toLowerCase();
      if ((jockeyCountsMap.get(key) || 0) > 1) parts.push('Duplicate jockey (assigned to more than one runner in this race)');
    }
  }
  if (isBlank(runner.trainer)) parts.push('Missing trainer');
  return parts.join(' | ');
}

/**
 * @param {Array<{_id, rCourseDisplayName, rCountry, rDiscipline, rNo, rClass, rPrizeMoney, rScheduleTime, runners}>} docs
 * @returns {{ byDiscipline: { T: {meetings, maxRaceNo}, H: {...}, G: {...} } }}
 */
function buildSchedule(docs) {
  const groups = new Map();

  for (const doc of docs) {
    const key = `${doc.rCourseDisplayName}|${doc.rCountry}|${doc.rDiscipline}`;
    if (!groups.has(key)) {
      groups.set(key, {
        meeting: doc.rCourseDisplayName,
        country: doc.rCountry,
        discipline: doc.rDiscipline,
        // TAB / Non-TAB is a meeting-level designation (from the `meetings`
        // collection's `isTAB` field, joined in by server.js via meetingId).
        // Defaults to true (TAB) when unknown so older callers/tests that
        // don't pass it still render normally.
        isTAB: doc.isTAB !== false,
        races: new Map(),
      });
    }
    groups.get(key).races.set(doc.rNo, {
      id: doc._id,
      clock: parseClock(doc.rScheduleTime),
      rScheduleTime: doc.rScheduleTime || null,
      rClass: doc.rClass || '',
      rPrizeMoney: doc.rPrizeMoney || '',
      missingJockeyCount: countMissingJockeys(doc.runners, doc.rDiscipline),
      duplicateJockeyCount: countDuplicateJockeyGroups(doc.runners, doc.rDiscipline),
      tabIssueCount: countTabNoIssues(doc.runners),
      missingTrainerCount: countMissingTrainers(doc.runners),
      status: deriveRaceStatus(doc),
      resultString: doc.resultString || '',
    });
  }

  const meetings = [];
  for (const g of groups.values()) {
    const raceNos = [...g.races.keys()].sort((a, b) => a - b);

    // Detect races that share the exact same clock time within this meeting
    // -- a strong signal of a bad/placeholder scheduled time, not a real gap.
    const labelCounts = new Map();
    for (const rNo of raceNos) {
      const clock = g.races.get(rNo).clock;
      if (clock) labelCounts.set(clock.label, (labelCounts.get(clock.label) || 0) + 1);
    }

    const races = {};
    let prevMinutes = null;

    for (const rNo of raceNos) {
      const {
        id, clock, rClass, rPrizeMoney, missingJockeyCount, duplicateJockeyCount, tabIssueCount,
        missingTrainerCount, status, resultString,
      } = g.races.get(rNo);

      let gapMinutes = null;
      let highlighted = false;
      if (clock && prevMinutes !== null) {
        gapMinutes = clock.minutes - prevMinutes;
        if (gapMinutes < 0) gapMinutes += 24 * 60; // guard against a rare midnight rollover
        highlighted = gapMinutes < GAP_THRESHOLD_MIN;
      }

      let badTimeReason = null;
      if (clock) {
        const isDuplicateTime = labelCounts.get(clock.label) > 1;
        const isPlaceholderTime = clock.label === '00:00';
        if (isPlaceholderTime) badTimeReason = 'Placeholder/unset time (00:00)';
        else if (isDuplicateTime) badTimeReason = `Same time as another race at this meeting (${clock.label})`;
      }

      races[rNo] = clock
        ? {
            id,
            label: clock.label,
            rClass,
            rPrizeMoney,
            gapMinutes,
            highlighted,
            missingJockeyCount,
            missingJockeysFlagged: missingJockeyCount > MISSING_JOCKEY_BORDER_THRESHOLD,
            duplicateJockeyCount,
            badTime: Boolean(badTimeReason),
            badTimeReason,
            tabIssueCount,
            missingTrainerCount,
            status,
            resultString,
          }
        : null;
      if (clock) prevMinutes = clock.minutes;
    }

    // Meeting-level issue summary -- true if ANY race at this meeting has
    // that kind of issue. Drives the "Issue" filter dropdown (Missing Jockey
    // / Duplicate Jockey / Missing TAB / Missing Trainer / Schedule Issue /
    // Meetings with Issues / Healthy Meetings), which filters whole
    // meeting-rows since the grid can't hide individual cells without
    // breaking the table shape. hasAbandoned is tracked separately (drives
    // the "ABBN" tag, not the Issue filter/hasAnyIssue -- an abandoned race
    // isn't a DATA problem to fix, just a status to show).
    let hasMissingJockey = false;
    let hasDuplicateJockey = false;
    let hasMissingTab = false;
    let hasMissingTrainer = false;
    let hasScheduleIssue = false;
    let hasAbandoned = false;
    for (const rNo of raceNos) {
      const race = races[rNo];
      if (!race) continue;
      if (race.missingJockeyCount > 0) hasMissingJockey = true;
      if (race.duplicateJockeyCount > 0) hasDuplicateJockey = true;
      if (race.tabIssueCount > 0) hasMissingTab = true;
      if (race.missingTrainerCount > 0) hasMissingTrainer = true;
      if (race.badTime) hasScheduleIssue = true;
      if (race.status === 'abandoned') hasAbandoned = true;
    }
    const hasAnyIssue = hasMissingJockey || hasDuplicateJockey || hasMissingTab || hasMissingTrainer || hasScheduleIssue;

    meetings.push({
      meeting: g.meeting, country: g.country, discipline: g.discipline, isTAB: g.isTAB,
      hasMissingJockey, hasDuplicateJockey, hasMissingTab, hasMissingTrainer, hasScheduleIssue, hasAnyIssue, hasAbandoned,
      races,
    });
  }

  const byDiscipline = {};
  for (const disc of DISCIPLINE_ORDER) {
    const discMeetings = meetings
      .filter((m) => m.discipline === disc)
      // country-wise grouping first, then meeting name within each country
      .sort((a, b) => a.country.localeCompare(b.country) || a.meeting.localeCompare(b.meeting));
    const maxRaceNo = discMeetings.reduce((max, m) => {
      const nums = Object.keys(m.races).map(Number);
      return Math.max(max, nums.length ? Math.max(...nums) : 0);
    }, 0);
    byDiscipline[disc] = { meetings: discMeetings, maxRaceNo };
  }

  const countries = [...new Set(meetings.map((m) => m.country))].sort();

  return { byDiscipline, countries };
}

// Builds the click-through detail payload for one race document (full runners).
// When the race has finished (resultString and/or per-runner finish position
// "fp" present), runners are sorted by finishing position instead of tab
// number, and each runner carries its finishing position for display.
function buildRaceDetail(doc) {
  const counts = jockeyCounts(doc.runners);
  const tabCounts = tabNoCounts(doc.runners);
  const clock = parseClock(doc.rScheduleTime);
  const hasResult = Boolean(doc.resultString) || (doc.runners || []).some((r) => r.fp != null);
  const runners = (doc.runners || [])
    .slice()
    .sort((a, b) => {
      if (hasResult) {
        const fa = a.fp != null ? a.fp : Infinity;
        const fb = b.fp != null ? b.fp : Infinity;
        if (fa !== fb) return fa - fb;
      }
      return (a.tabNo || 0) - (b.tabNo || 0);
    })
    .map((r) => ({
      tabNo: r.tabNo != null ? r.tabNo : null,
      position: r.fp != null ? r.fp : null,
      horseName: r.horseName || '',
      jockey: r.jockey || '',
      trainer: r.trainer || '',
      isScratched: Boolean(r.isScratched),
      issue: issueForRunner(r, doc.rDiscipline, counts, tabCounts),
    }));

  return {
    id: doc._id,
    meeting: doc.rCourseDisplayName,
    rName: doc.rName || doc.rDisplayName || '',
    country: doc.rCountry,
    discipline: doc.rDiscipline,
    disciplineLabel: disciplineLabel(doc.rDiscipline),
    rNo: doc.rNo,
    rClass: doc.rClass || '',
    rPrizeMoney: doc.rPrizeMoney || '',
    timeLabel: clock ? clock.label : null,
    resultString: doc.resultString || null,
    hasResult,
    runners,
  };
}

/**
 * Flat, downloadable issues report across every meeting/race for one date --
 * everything the grid highlights (missing/duplicate jockey, tab number
 * problems, bad/placeholder times) PLUS meeting/race-level integrity checks
 * that only make sense across the whole date (duplicate meetings, duplicate
 * race numbers within a meeting, missing/gapped race numbers).
 *
 * @param {Array} docs - same race docs buildSchedule() takes (ALL disciplines
 *   for the date, not just the currently selected tab -- Dinesh asked for
 *   "ella meetings and races", i.e. every meeting/race with any issue).
 * @param {string} dateStr
 * @returns {Array<{date, country, discipline, meeting, rNo, time, issues}>}
 */
function buildIssuesReport(docs, dateStr) {
  // meetingKey (course|country|discipline) -> Set of distinct meetingIds seen.
  // More than one distinct meetingId for the same course/country/discipline
  // on this date is itself a data problem (the same meeting ingested twice).
  const meetingIdsByMeetingKey = new Map();
  // meetingId (or a fallback key if meetingId is missing) -> aggregate info
  // used for missing/duplicate race-number and duplicate-time detection.
  const meetingAgg = new Map();

  for (const doc of docs) {
    const meetingKey = `${doc.rCourseDisplayName}|${doc.rCountry}|${doc.rDiscipline}`;
    if (!meetingIdsByMeetingKey.has(meetingKey)) meetingIdsByMeetingKey.set(meetingKey, new Set());
    if (doc.meetingId) meetingIdsByMeetingKey.get(meetingKey).add(doc.meetingId);

    const midKey = doc.meetingId || meetingKey;
    if (!meetingAgg.has(midKey)) {
      meetingAgg.set(midKey, {
        meeting: doc.rCourseDisplayName, country: doc.rCountry, discipline: doc.rDiscipline,
        raceNoCounts: new Map(), labelCounts: new Map(),
      });
    }
    const agg = meetingAgg.get(midKey);
    agg.raceNoCounts.set(doc.rNo, (agg.raceNoCounts.get(doc.rNo) || 0) + 1);
    const clock = parseClock(doc.rScheduleTime);
    if (clock) agg.labelCounts.set(clock.label, (agg.labelCounts.get(clock.label) || 0) + 1);
  }

  const duplicateMeetingKeys = new Set();
  for (const [key, ids] of meetingIdsByMeetingKey.entries()) {
    if (ids.size > 1) duplicateMeetingKeys.add(key);
  }

  const rows = [];

  for (const doc of docs) {
    const meetingKey = `${doc.rCourseDisplayName}|${doc.rCountry}|${doc.rDiscipline}`;
    const midKey = doc.meetingId || meetingKey;
    const agg = meetingAgg.get(midKey);
    const clock = parseClock(doc.rScheduleTime);

    const missingJockeyCount = countMissingJockeys(doc.runners, doc.rDiscipline) || 0;
    const duplicateJockeyGroups = countDuplicateJockeyGroups(doc.runners, doc.rDiscipline);
    const tabIssueCount = countTabNoIssues(doc.runners);
    const missingTrainerCount = countMissingTrainers(doc.runners);
    const isDuplicateRaceNo = (agg.raceNoCounts.get(doc.rNo) || 0) > 1;
    const isPlaceholderTime = Boolean(clock) && clock.label === '00:00';
    const isDuplicateTime = Boolean(clock) && !isPlaceholderTime && (agg.labelCounts.get(clock.label) || 0) > 1;
    const isDuplicateMeeting = duplicateMeetingKeys.has(meetingKey);

    const issues = [];
    if (isDuplicateMeeting) issues.push('Duplicate meeting (same course/country/discipline under more than one meeting ID)');
    if (isDuplicateRaceNo) issues.push('Duplicate race number within this meeting');
    if (missingJockeyCount > 0) issues.push(`Missing jockey x${missingJockeyCount}`);
    if (duplicateJockeyGroups > 0) issues.push(`Duplicate jockey x${duplicateJockeyGroups}`);
    if (tabIssueCount > 0) issues.push(`Tab number issue x${tabIssueCount} (missing/zero/duplicate)`);
    if (missingTrainerCount > 0) issues.push(`Missing trainer x${missingTrainerCount}`);
    if (isPlaceholderTime) issues.push('Placeholder scheduled time (00:00)');
    if (isDuplicateTime) issues.push(`Duplicate scheduled time (${clock.label}) with another race at this meeting`);
    if (deriveRaceStatus(doc) === 'abandoned') issues.push('Race abandoned');

    if (issues.length) {
      rows.push({
        date: dateStr,
        country: doc.rCountry,
        discipline: disciplineLabel(doc.rDiscipline),
        meeting: doc.rCourseDisplayName,
        rNo: doc.rNo,
        time: clock ? clock.label : '',
        issues: issues.join('; '),
      });
    }
  }

  // Missing race numbers (gaps in the sequence, e.g. R1, R2, R4 -> R3 missing)
  // have no race document at all, so they're added as their own rows here.
  for (const [, agg] of meetingAgg.entries()) {
    const raceNos = [...agg.raceNoCounts.keys()].sort((a, b) => a - b);
    for (let i = 1; i < raceNos.length; i++) {
      const gap = raceNos[i] - raceNos[i - 1];
      if (gap > 1) {
        for (let n = raceNos[i - 1] + 1; n < raceNos[i]; n++) {
          rows.push({
            date: dateStr,
            country: agg.country,
            discipline: disciplineLabel(agg.discipline),
            meeting: agg.meeting,
            rNo: n,
            time: '',
            issues: 'Missing race number (gap in sequence -- no race document found)',
          });
        }
      }
    }
  }

  rows.sort((a, b) => a.country.localeCompare(b.country) || a.meeting.localeCompare(b.meeting) || a.rNo - b.rNo);
  return rows;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function issuesReportToCsv(rows) {
  const headers = ['Date', 'Country', 'Discipline', 'Meeting', 'Race No', 'Scheduled Time', 'Issues'];
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push([r.date, r.country, r.discipline, r.meeting, r.rNo, r.time, r.issues].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

// Full meeting details download -- added 10 Aug 2026 per Dinesh: "Edwadu oru
// meeting full details download panna option wenu... Alice Springs meeting
// download pannumna anda meeting full race details download pannanu", same
// 4 formats as the issues report. Unlike buildIssuesReport (one row per
// RACE, only when something's wrong), this is one row per RUNNER across
// EVERY race at ONE specific meeting, wrong-or-not -- it's a full export of
// what's on the grid + modal for that meeting, not a validation report.
// `docs` must already be scoped to a single meeting (course+country+
// discipline+date) by the caller (server.js queries by those four fields).
function buildMeetingDetailsReport(docs, dateStr) {
  const rows = [];
  const sorted = docs.slice().sort((a, b) => a.rNo - b.rNo);

  for (const doc of sorted) {
    const clock = parseClock(doc.rScheduleTime);
    const hasResult = Boolean(doc.resultString) || (doc.runners || []).some((r) => r.fp != null);
    const runners = (doc.runners || []).slice().sort((a, b) => {
      if (hasResult) {
        const fa = a.fp != null ? a.fp : Infinity;
        const fb = b.fp != null ? b.fp : Infinity;
        if (fa !== fb) return fa - fb;
      }
      return (a.tabNo || 0) - (b.tabNo || 0);
    });

    const base = {
      date: dateStr,
      country: doc.rCountry,
      discipline: disciplineLabel(doc.rDiscipline),
      meeting: doc.rCourseDisplayName,
      rNo: doc.rNo,
      raceName: doc.rName || doc.rDisplayName || '',
      rClass: doc.rClass || '',
      prizeMoney: doc.rPrizeMoney || '',
      scheduledTime: clock ? clock.label : '',
      status: STATUS_LABELS[deriveRaceStatus(doc)] || deriveRaceStatus(doc),
      resultString: doc.resultString || '',
    };

    if (!runners.length) {
      // Still emit one row so a race with zero runner records isn't
      // silently dropped from the export.
      rows.push(Object.assign({}, base, { tabNo: '', horseName: '', jockey: '', trainer: '', scratched: '', position: '' }));
      continue;
    }

    for (const r of runners) {
      rows.push(Object.assign({}, base, {
        tabNo: r.tabNo != null ? r.tabNo : '',
        horseName: r.horseName || '',
        jockey: r.jockey || '',
        trainer: r.trainer || '',
        scratched: r.isScratched ? 'Yes' : 'No',
        position: r.fp != null ? r.fp : '',
      }));
    }
  }

  return rows;
}

function meetingDetailsReportToCsv(rows) {
  const headers = [
    'Date', 'Country', 'Discipline', 'Meeting', 'Race No', 'Race Name', 'Class', 'Prize Money',
    'Scheduled Time', 'Status', 'Result', 'Tab No', 'Horse', 'Jockey', 'Trainer', 'Scratched', 'Position',
  ];
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push([
      r.date, r.country, r.discipline, r.meeting, r.rNo, r.raceName, r.rClass, r.prizeMoney,
      r.scheduledTime, r.status, r.resultString, r.tabNo, r.horseName, r.jockey, r.trainer, r.scratched, r.position,
    ].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDateHeading(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const BASE_STYLE_BLOCK = `
  :root {
    color-scheme: light dark;
    --bg: #fafafa; --fg: #1a1a1a; --muted: #666; --card-bg: #fff; --border: #e0e0e0;
    --header-bg: #1F4E79; --header-fg: #fff; --header-bg-hover: #163a5c;
    --sub-bg: #f5f7fa; --hover-bg: #eef4fb; --shadow: rgba(0,0,0,0.1);
    --country-header-bg: #eef2f6; --country-header-fg: #444; --country-header-border: #d5dbe2;
    --input-border: #ccc; --tab-btn-bg: #fff; --tab-btn-fg: #333; --tab-btn-border: #d5dbe2;
    --modal-bg: #fff; --modal-shadow: rgba(0,0,0,0.25); --modal-overlay: rgba(0,0,0,0.4);
    --legend-fg: #555; --scratched-fg: #aaa; --empty-fg: #ccc; --meta-fg: #888;
    --result-fg: #1a7431;
  }
  [data-theme="dark"] {
    --bg: #14181c; --fg: #e8e8e8; --muted: #a9b2ba; --card-bg: #1b2126; --border: #333c44;
    --header-bg: #13324d; --header-fg: #fff; --header-bg-hover: #0d243a;
    --sub-bg: #20272d; --hover-bg: #263540; --shadow: rgba(0,0,0,0.6);
    --country-header-bg: #1e252b; --country-header-fg: #c3ccd3; --country-header-border: #333c44;
    --input-border: #4a545c; --tab-btn-bg: #1e252b; --tab-btn-fg: #dfe4e8; --tab-btn-border: #3a444d;
    --modal-bg: #1e252b; --modal-shadow: rgba(0,0,0,0.7); --modal-overlay: rgba(0,0,0,0.65);
    --legend-fg: #b7c0c7; --scratched-fg: #6d767d; --empty-fg: #555; --meta-fg: #8b949c;
    --result-fg: #4ad07f;
  }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; background: var(--bg); color: var(--fg); }
  h1 { margin: 0 0 4px; font-size: 26px; display: inline-block; }
  .top-row { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .top-row-right { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .session-info { font-size: 13px; color: var(--muted); }
  .logout-link { color: var(--header-bg); font-weight: 600; text-decoration: none; }
  .logout-link:hover { text-decoration: underline; }
  .login-page-body { display: flex; align-items: center; justify-content: center; min-height: 80vh; margin: 0; }
  .login-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 2px 10px var(--shadow); padding: 32px 36px; width: 320px; }
  .login-card h1 { font-size: 20px; margin: 0 0 4px; display: block; }
  .login-card p.sub { margin: 0 0 20px; }
  .login-card label { display: block; font-size: 13px; margin-bottom: 14px; }
  .login-card input[type="text"], .login-card input[type="password"] { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px 10px; font-size: 14px; border: 1px solid var(--input-border); border-radius: 4px; background: var(--card-bg); color: var(--fg); }
  .login-card button[type="submit"] { width: 100%; padding: 9px; font-size: 14px; font-weight: 600; border: none; border-radius: 4px; background: var(--header-bg); color: var(--header-fg); cursor: pointer; }
  .login-card button[type="submit"]:hover { background: var(--header-bg-hover); }
  .login-error { background: #fdecea; color: #a12622; border: 1px solid #f4c7c3; border-radius: 4px; padding: 8px 10px; font-size: 13px; margin-bottom: 16px; }
  [data-theme="dark"] .login-error { background: #3a1f1f; color: #ff9d95; border-color: #5c2e2c; }
  .sub { color: var(--muted); margin: 0 0 20px; font-size: 14px; }
  .disc-section { margin-bottom: 28px; }
  .disc-section[hidden] { display: none; }
  .section-count { font-size: 11px; font-weight: 400; opacity: 0.8; }
  .disc-tabs { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; align-items: center; }
  .grid-filters { margin-left: auto; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .country-filter, .tabmeeting-filter, .issue-filter, .status-filter, .meeting-search-filter { font-size: 13px; color: var(--fg); display: flex; align-items: center; gap: 6px; }
  .country-filter select, .tabmeeting-filter select, .issue-filter select, .status-filter select, .meeting-search-filter input {
    font-size: 13px; padding: 5px 8px; border: 1px solid var(--input-border); border-radius: 4px; background: var(--card-bg); color: var(--fg);
  }
  .meeting-search-filter input { width: 170px; }
  .meeting-search-wrap { position: relative; display: inline-block; }
  .meeting-suggestions { display: none; position: absolute; top: 100%; left: 0; right: 0; margin-top: 2px; background: var(--card-bg); border: 1px solid var(--input-border); border-radius: 4px; max-height: 190px; overflow-y: auto; z-index: 60; box-shadow: 0 4px 12px var(--shadow); }
  .meeting-suggestions.open { display: block; }
  .meeting-suggestions div { padding: 5px 9px; font-size: 12px; cursor: pointer; color: var(--fg); white-space: nowrap; }
  .meeting-suggestions div:hover, .meeting-suggestions div.active { background: var(--hover-bg); }
  .tabmeeting-tag { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
  .tabmeeting-tag.tab { background: #e3f2e6; color: #1a7431; }
  .tabmeeting-tag.nontab { background: #f2f2f2; color: #777; }
  .health-tag { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
  .health-tag.issue { background: #fde3e3; color: #a11b1b; }
  .health-tag.healthy { background: #e3f2e6; color: #1a7431; }
  .abandoned-tag { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-left: 4px; vertical-align: middle; background: #6b6b6b; color: #fff; }
  tr.country-header-row td { background: var(--country-header-bg); font-weight: 700; font-size: 11px; color: var(--country-header-fg); text-align: left; padding: 4px 10px; text-transform: uppercase; letter-spacing: 0.5px; border-top: 1px solid var(--country-header-border); }
  tr.row-hidden { display: none; }
  .tab-btn { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; padding: 8px 14px; border: 1px solid var(--tab-btn-border); border-radius: 6px; background: var(--tab-btn-bg); color: var(--tab-btn-fg); cursor: pointer; }
  .tab-btn:hover { background: var(--hover-bg); }
  .tab-btn.active { background: var(--header-bg); color: #fff; border-color: var(--header-bg); }
  .tab-btn.active .section-count { color: #dbe6f0; }
  table { border-collapse: collapse; width: 100%; background: var(--card-bg); box-shadow: 0 1px 3px var(--shadow); }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: center; font-size: 13px; white-space: nowrap; }
  th { background: var(--header-bg); color: var(--header-fg); position: sticky; top: 0; }
  td.meeting { text-align: left; font-weight: 600; background: var(--sub-bg); white-space: nowrap; }
  td.empty { color: var(--empty-fg); }
  td.cell.clickable { cursor: pointer; }
  td.cell.clickable:hover { background: var(--hover-bg); }
  td.time.highlight { background: #ffdcdc; color: #8a1f1f; font-weight: 700; }
  td.time.highlight:hover { background: #ffc9c9; }
  td.time.missing-jockeys { outline: 2px solid #cc0000; outline-offset: -2px; }
  td.time.tab-issue { outline: 2px solid #cc0000; outline-offset: -2px; background: #fff0f0; }
  td.time.bad-time { background: #e60000; color: #fff; font-weight: 700; }
  td.time.bad-time:hover { background: #cc0000; }
  td.time.status-filtered { opacity: 0.15; pointer-events: none; }
  td.time.has-result { white-space: normal; }
  td.time.missing-trainer { outline: 2px solid #6b46c1; outline-offset: -2px; }
  td.time.abandoned-race { white-space: normal; text-decoration: line-through; opacity: 0.85; }
  .result-line { font-size: 10px; font-weight: 700; color: var(--result-fg); margin-top: 2px; }
  .abandoned-line { font-size: 10px; font-weight: 700; color: #a11b1b; margin-top: 2px; text-decoration: none; }
  td.empty-state { padding: 24px; color: var(--muted); font-style: italic; text-align: center; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-right: 4px; color: #fff; }
  .badge.disc-T { background: #2b6cb0; }
  .badge.disc-H { background: #6b46c1; }
  .badge.disc-G { background: #38761d; }
  .country { font-weight: 400; color: var(--muted); font-size: 11px; }
  .mj-badge { color: var(--muted); font-size: 10px; font-weight: 700; margin-left: 2px; }
  .mj-badge.mj-badge-alert { color: #e14b4b; }
  .dup-badge { display: inline-block; background: #e07b00; color: #fff; font-size: 9px; font-weight: 700; border-radius: 3px; padding: 0 3px; margin-left: 3px; }
  .tab-badge { display: inline-block; background: #cc0000; color: #fff; font-size: 9px; font-weight: 700; border-radius: 3px; padding: 0 3px; margin-left: 3px; }
  .trainer-badge { display: inline-block; background: #6b46c1; color: #fff; font-size: 9px; font-weight: 700; border-radius: 3px; padding: 0 3px; margin-left: 3px; }
  /* Per-meeting "download this meeting's full details" widget (10 Aug 2026)
     -- a native <details>/<summary> disclosure, no JS needed to open/close.
     Only downside: it doesn't auto-close on an outside click like the
     meeting-search dropdown does -- acceptable tradeoff for a rarely-used,
     one-off action button. */
  .meeting-download { display: inline-block; position: relative; margin-left: 4px; vertical-align: middle; }
  .meeting-download > summary { list-style: none; cursor: pointer; display: inline-block; font-size: 11px; font-weight: 700; color: var(--header-bg); background: var(--card-bg); border: 1px solid var(--input-border); border-radius: 3px; padding: 1px 6px; }
  .meeting-download > summary::-webkit-details-marker { display: none; }
  .meeting-download > summary:hover { background: var(--hover-bg); }
  .meeting-download[open] > summary { background: var(--hover-bg); }
  .meeting-download-menu { position: absolute; top: 100%; left: 0; margin-top: 2px; background: var(--card-bg); border: 1px solid var(--input-border); border-radius: 4px; box-shadow: 0 4px 12px var(--shadow); z-index: 55; padding: 4px; display: flex; flex-direction: column; gap: 2px; white-space: nowrap; }
  .meeting-download-menu a { display: block; font-size: 12px; font-weight: 400; color: var(--fg); text-decoration: none; padding: 4px 10px; border-radius: 3px; text-align: left; }
  .meeting-download-menu a:hover { background: var(--hover-bg); }
  .controls { margin-bottom: 22px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .controls label { font-size: 13px; color: var(--fg); display: flex; align-items: center; gap: 6px; margin-right: 16px; }
  .controls input[type="date"] { font-size: 13px; padding: 4px 6px; border: 1px solid var(--input-border); border-radius: 4px; margin-left: 4px; background: var(--card-bg); color: var(--fg); }
  .controls a.today-link { font-size: 12px; color: var(--header-bg); text-decoration: none; margin-left: 4px; }
  .report-links { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; }
  .report-links-label { font-size: 12px; color: var(--muted); margin-right: 2px; }
  .controls a.report-link { font-size: 12px; color: #fff; background: var(--header-bg); text-decoration: none; padding: 5px 10px; border-radius: 4px; }
  .controls a.report-link:hover { background: var(--header-bg-hover); }
  .controls button.day-nav { font-size: 13px; padding: 5px 10px; border: 1px solid var(--input-border); border-radius: 4px; background: var(--card-bg); color: var(--header-bg); cursor: pointer; }
  .controls button.day-nav:hover { background: var(--hover-bg); }
  .theme-toggle { font-size: 13px; padding: 6px 12px; border: 1px solid var(--tab-btn-border); border-radius: 6px; background: var(--tab-btn-bg); color: var(--tab-btn-fg); cursor: pointer; }
  .theme-toggle:hover { background: var(--hover-bg); }
  .refresh-indicator { font-size: 11px; color: var(--muted); margin-left: 4px; }
  .legend { margin-top: 14px; font-size: 12px; color: var(--legend-fg); }
  .legend div { margin: 2px 0; }
  .legend .swatch { display: inline-block; width: 12px; height: 12px; border: 1px solid #e0b0b0; vertical-align: middle; margin-right: 6px; background: #ffdcdc; }
  .legend .swatch.border-swatch { background: #fff; border: 2px solid #cc0000; }
  .legend .swatch.dup-swatch { background: #e07b00; border: none; }
  .legend .swatch.bad-time-swatch { background: #e60000; border: none; }
  .legend .swatch.tab-swatch { background: #fff0f0; border: 2px solid #cc0000; }
  .meta { font-size: 12px; color: var(--meta-fg); margin-top: 6px; }

  .modal-overlay { display: none; position: fixed; inset: 0; background: var(--modal-overlay); align-items: center; justify-content: center; z-index: 50; }
  .modal-overlay.open { display: flex; }
  .modal-box { background: var(--modal-bg); color: var(--fg); border-radius: 6px; max-width: 640px; width: 92%; max-height: 80vh; overflow-y: auto; padding: 20px 24px; box-shadow: 0 8px 30px var(--modal-shadow); }
  .modal-box h2 { margin: 0 0 4px; font-size: 18px; display: block; }
  .modal-box .modal-race-name { font-weight: 600; font-size: 14px; margin: 0 0 4px; }
  .modal-box .modal-sub { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  .modal-box .modal-result { color: var(--result-fg); font-weight: 700; font-size: 13px; margin: 0 0 10px; }
  .modal-box table { width: 100%; box-shadow: none; }
  .modal-box th, .modal-box td { font-size: 13px; padding: 5px 8px; text-align: left; white-space: normal; }
  .modal-box th { background: var(--header-bg); }
  .modal-close { float: right; cursor: pointer; font-size: 20px; color: var(--muted); border: none; background: none; line-height: 1; }
  .modal-close:hover { color: var(--fg); }
  tr.scratched td { color: var(--scratched-fg); text-decoration: line-through; }
  td.issue-cell.missing { color: #e14b4b; font-weight: 600; }
  td.issue-cell.duplicate { color: #e07b00; font-weight: 600; }
  td.issue-cell.tab-issue { color: #e14b4b; font-weight: 600; }
  td.issue-cell.trainer-issue { color: #6b46c1; font-weight: 600; }
  td.position-cell { font-weight: 700; }
  .modal-loading, .modal-error { color: var(--muted); font-style: italic; }

  .table-scroll { width: 100%; }

  /* ---- Phone view (added 9 Aug 2026, per "phone'la open panna sariya
     kaatudilla") ---- the grid was unusable on phones mainly because there
     was no <meta name="viewport"> tag at all, so mobile browsers rendered
     it at desktop width and shrank everything down to fit, making text and
     tap targets tiny. Adding the viewport tag (see renderHtml's <head>)
     fixes that; these rules on top make the layout actually comfortable to
     use at phone widths rather than just "technically readable". */
  @media (max-width: 760px) {
    body { margin: 12px; }
    h1 { font-size: 20px; }
    .top-row { gap: 6px; }
    .sub { font-size: 12px; margin-bottom: 14px; }
    .disc-tabs { gap: 6px; margin-bottom: 14px; }
    .tab-btn { padding: 8px 10px; font-size: 13px; flex: 1 1 auto; justify-content: center; }
    .grid-filters { margin-left: 0; width: 100%; gap: 10px; }
    .country-filter, .tabmeeting-filter, .issue-filter, .status-filter, .meeting-search-filter { width: 100%; }
    .country-filter select, .tabmeeting-filter select, .issue-filter select, .status-filter select { flex: 1; width: 100%; }
    .meeting-search-filter input { width: 100%; flex: 1; }
    .controls { gap: 10px; }
    .controls label { margin-right: 0; }
    .report-links { width: 100%; flex-wrap: wrap; }
    /* The meeting-grid itself stays a real table (one column per race) --
       that structure doesn't reflow into a single phone column without a
       much bigger rework, so instead it scrolls horizontally inside its own
       box (finger-swipe) while the meeting name stays pinned on the left,
       so you always know which row you're looking at. */
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--border); }
    /* The meeting name + its country/TAB/issue tags all sitting on one
       nowrap line made that first column render ~345px wide -- on a
       ~370px-wide phone scroll box that left only a ~25px sliver not
       covered by the pinned column, so a race-time cell could never be
       scrolled into a position where it was both fully visible AND not
       physically underneath the sticky "meeting" cell (confirmed via
       getBoundingClientRect: meeting column right edge sat past x=340
       while the scroll box itself was only 368px wide) -- that's what
       looked like the sticky cell "stealing" the click. Under the table's
       normal automatic layout, max-width on a td is only a hint -- a
       nowrap child still forces the column wider to fit its content, so
       just capping td.meeting's max-width did NOT actually shrink it
       (confirmed: still measured ~272px). table-layout: fixed makes column
       widths obey the declared widths for real, so the sticky column stays
       genuinely narrow and ellipsis-truncates instead of stretching. */
    .table-scroll table { min-width: 640px; box-shadow: none; table-layout: fixed; }
    .table-scroll th, .table-scroll td { white-space: nowrap; }
    .table-scroll th:first-child, .table-scroll td.meeting {
      width: 110px; overflow: hidden; text-overflow: ellipsis;
    }
    /* Let the download menu escape the narrow, overflow:hidden sticky
       column while it's actually open, so it isn't clipped on phone widths. */
    .table-scroll td.meeting:has(details.meeting-download[open]) { overflow: visible; }
    .table-scroll thead th:first-child, .table-scroll td.meeting {
      position: sticky; left: 0; z-index: 3; box-shadow: 2px 0 4px var(--shadow);
    }
    .table-scroll thead th:first-child { z-index: 6; }
    .modal-box { width: 94%; padding: 16px 16px; max-height: 88vh; }
    .modal-box h2 { font-size: 16px; }
    .modal-box table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .modal-box th, .modal-box td { white-space: nowrap; }
    .legend { font-size: 11px; }
  }
`;

const MODAL_MARKUP = `
  <div class="modal-overlay" id="detailModal" onclick="if(event.target===this) closeRaceDetail()">
    <div class="modal-box">
      <button class="modal-close" onclick="closeRaceDetail()" aria-label="Close">&times;</button>
      <div id="detailContent"><p class="modal-loading">Loading...</p></div>
    </div>
  </div>
`;

const MODAL_SCRIPT_BLOCK = `
    function escapeHtmlClient(str) {
      return String(str).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
      });
    }

    function closeRaceDetail() {
      document.getElementById('detailModal').classList.remove('open');
    }

    function showRaceDetail(id) {
      var modal = document.getElementById('detailModal');
      var content = document.getElementById('detailContent');
      content.innerHTML = '<p class="modal-loading">Loading...</p>';
      modal.classList.add('open');

      fetch('/api/race/' + encodeURIComponent(id))
        .then(function (res) {
          if (!res.ok) throw new Error('Request failed (' + res.status + ')');
          return res.json();
        })
        .then(function (race) {
          var rows = race.runners.map(function (r) {
            var issueClass = '';
            if (r.issue.indexOf('tab number') !== -1) issueClass = 'issue-cell tab-issue';
            else if (r.issue.indexOf('trainer') !== -1) issueClass = 'issue-cell trainer-issue';
            else if (r.issue.indexOf('Missing') === 0) issueClass = 'issue-cell missing';
            else if (r.issue.indexOf('Duplicate') === 0) issueClass = 'issue-cell duplicate';
            var positionCell = race.hasResult ? '<td class="position-cell">' + (r.position != null ? r.position : '-') + '</td>' : '';
            return '<tr class="' + (r.isScratched ? 'scratched' : '') + '">' +
              positionCell +
              '<td>' + (r.tabNo != null ? r.tabNo : '-') + '</td>' +
              '<td>' + escapeHtmlClient(r.horseName) + '</td>' +
              '<td>' + (r.jockey ? escapeHtmlClient(r.jockey) : '<em>none</em>') + '</td>' +
              '<td>' + (r.trainer ? escapeHtmlClient(r.trainer) : '<em>none</em>') + '</td>' +
              '<td class="' + issueClass + '">' + (r.isScratched ? 'Scratched' : (escapeHtmlClient(r.issue) || '-')) + '</td>' +
              '</tr>';
          }).join('');

          var positionHeader = race.hasResult ? '<th>Pos</th>' : '';
          var resultLine = race.hasResult
            ? '<p class="modal-result">&#127937; Result' + (race.resultString ? ' (tab numbers, 1st-4th): ' + escapeHtmlClient(race.resultString) : '') + '</p>'
            : '';
          content.innerHTML =
            '<h2>' + escapeHtmlClient(race.meeting) + ' (' + escapeHtmlClient(race.country) + ') - Race ' + race.rNo + '</h2>' +
            (race.rName ? '<p class="modal-race-name">' + escapeHtmlClient(race.rName) + '</p>' : '') +
            '<p class="modal-sub">' + escapeHtmlClient(race.disciplineLabel) +
              (race.timeLabel ? ' &middot; ' + escapeHtmlClient(race.timeLabel) : '') +
              (race.rClass ? ' &middot; Class: ' + escapeHtmlClient(race.rClass) : '') +
              (race.rPrizeMoney ? ' &middot; Prize: ' + escapeHtmlClient(race.rPrizeMoney) : '') + '</p>' +
            resultLine +
            '<table><thead><tr>' + positionHeader + '<th>Tab</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>Issue</th></tr></thead><tbody>' + rows + '</tbody></table>';
        })
        .catch(function (err) {
          content.innerHTML = '<p class="modal-error">Could not load race detail: ' + escapeHtmlClient(err.message) + '</p>';
        });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeRaceDetail();
    });

    // Close any open "meeting download" dropdown when clicking ANYWHERE else
    // on the page (10 Aug 2026, per Dinesh: clicking elsewhere left the menu
    // stuck open -- he had to click the download button again just to close
    // it before it would open cleanly the next time). Native <details> has
    // no built-in outside-click-to-close behaviour, so this does it by hand:
    // any click whose target is NOT inside an open .meeting-download element
    // closes that element. A click on the summary/links INSIDE the open
    // dropdown is left alone (native toggle / the link's own onclick handle
    // those cases).
    document.addEventListener('click', function (e) {
      var openMenus = document.querySelectorAll('details.meeting-download[open]');
      for (var i = 0; i < openMenus.length; i++) {
        if (!openMenus[i].contains(e.target)) openMenus[i].removeAttribute('open');
      }
    });
`;

function renderMeetingsTable(meetings, maxRaceNo, dateStr, includeTrials) {
  const cols = Array.from({ length: maxRaceNo }, (_, i) => i + 1);
  const headerCells = cols.map((n) => `<th>R${n}</th>`).join('');

  let lastCountry = null;
  const rows = meetings.length
    ? meetings.map((m) => {
        const cells = cols.map((n) => {
          const race = m.races[n];
          if (!race) return '<td class="cell empty">&mdash;</td>';

          let cls = 'cell time clickable';
          if (race.highlighted) cls += ' highlight';
          if (race.missingJockeysFlagged) cls += ' missing-jockeys';
          if (race.tabIssueCount > 0) cls += ' tab-issue';
          if (race.missingTrainerCount > 0) cls += ' missing-trainer';
          if (race.badTime) cls += ' bad-time';
          if (race.resultString) cls += ' has-result';
          if (race.status === 'abandoned') cls += ' abandoned-race';

          const titleParts = [];
          titleParts.push(`Status: ${STATUS_LABELS[race.status] || race.status}`);
          if (race.badTime) titleParts.push(race.badTimeReason);
          if (race.gapMinutes !== null) titleParts.push(`${race.gapMinutes} min after the previous race`);
          if (race.rClass) titleParts.push(`Class: ${race.rClass}`);
          if (race.rPrizeMoney) titleParts.push(`Prize: ${race.rPrizeMoney}`);
          if (race.missingJockeyCount > 0) titleParts.push(`${race.missingJockeyCount} runner(s) missing jockey`);
          if (race.duplicateJockeyCount > 0) titleParts.push(`${race.duplicateJockeyCount} jockey(s) duplicated across runners`);
          if (race.tabIssueCount > 0) titleParts.push(`${race.tabIssueCount} runner(s) with missing/zero/duplicate tab number`);
          if (race.missingTrainerCount > 0) titleParts.push(`${race.missingTrainerCount} runner(s) missing trainer`);
          if (race.resultString) titleParts.push(`Result (tab numbers, 1st-4th): ${race.resultString}`);
          titleParts.push('Click for runner details');

          const mjBadgeClass = `mj-badge${race.missingJockeysFlagged ? ' mj-badge-alert' : ''}`;
          const mjBadge = race.missingJockeyCount > 0 ? `<sup class="${mjBadgeClass}" title="${race.missingJockeyCount} runner(s) missing a jockey">M${race.missingJockeyCount}</sup>` : '';
          const dupBadge = race.duplicateJockeyCount > 0 ? `<sup class="dup-badge" title="${race.duplicateJockeyCount} jockey(s) duplicated across runners">D${race.duplicateJockeyCount}</sup>` : '';
          const tabBadge = race.tabIssueCount > 0 ? `<sup class="tab-badge" title="${race.tabIssueCount} runner(s) with missing/zero/duplicate tab number">T${race.tabIssueCount}</sup>` : '';
          const trainerBadge = race.missingTrainerCount > 0 ? `<sup class="trainer-badge" title="${race.missingTrainerCount} runner(s) missing trainer">TR${race.missingTrainerCount}</sup>` : '';
          const resultLine = race.resultString ? `<div class="result-line">&#127937; ${escapeHtml(race.resultString)}</div>` : '';
          const abandonedLine = race.status === 'abandoned' ? `<div class="abandoned-line">Abandoned</div>` : '';

          return `<td class="${cls}" data-status="${race.status}" title="${escapeHtml(titleParts.join(' | '))}" onclick="showRaceDetail('${escapeHtml(race.id)}')">${race.label}${mjBadge}${dupBadge}${tabBadge}${trainerBadge}${resultLine}${abandonedLine}</td>`;
        }).join('');

        let countryHeaderRow = '';
        if (m.country !== lastCountry) {
          lastCountry = m.country;
          countryHeaderRow = `<tr class="country-header-row" data-country="${escapeHtml(m.country)}"><td colspan="${cols.length + 1}">${escapeHtml(m.country)}</td></tr>\n`;
        }

        const tabMeetingValue = m.isTAB ? 'tab' : 'nontab';
        const tabMeetingTag = `<span class="tabmeeting-tag ${tabMeetingValue}">${m.isTAB ? 'TAB' : 'Non-TAB'}</span>`;

        const issueCodes = [];
        if (m.hasMissingJockey) issueCodes.push('missingjockey');
        if (m.hasDuplicateJockey) issueCodes.push('duplicatejockey');
        if (m.hasMissingTab) issueCodes.push('missingtab');
        if (m.hasMissingTrainer) issueCodes.push('missingtrainer');
        if (m.hasScheduleIssue) issueCodes.push('scheduleissue');
        // Tooltip lists exactly which category(ies) triggered the "Issue"
        // pill -- added 10 Aug 2026 after a real support ticket where the
        // pill was assumed to mean a timezone problem when it was actually
        // an unrelated Duplicate Jockey flag (the timezone feature itself
        // was removed entirely 11 Aug 2026, see the removal note near the
        // top of this file).
        const issueReasons = [];
        if (m.hasMissingJockey) issueReasons.push('Missing Jockey');
        if (m.hasDuplicateJockey) issueReasons.push('Duplicate Jockey');
        if (m.hasMissingTab) issueReasons.push('Missing TAB number');
        if (m.hasMissingTrainer) issueReasons.push('Missing Trainer');
        if (m.hasScheduleIssue) issueReasons.push('Schedule Issue');
        const healthTag = m.hasAnyIssue
          ? `<span class="health-tag issue" title="${escapeHtml(issueReasons.join(', '))}">Issue</span>`
          : '<span class="health-tag healthy" title="No missing/duplicate jockey, missing TAB, missing trainer, or schedule issue at this meeting">Healthy</span>';
        const abandonedTag = m.hasAbandoned ? '<span class="abandoned-tag" title="At least one race at this meeting is abandoned">ABBN</span>' : '';

        // Per-meeting "download this meeting's full details" widget -- added
        // 10 Aug 2026 per Dinesh ("Edwadu oru meeting full details download
        // panna option wenu... Alice Springs meeting download pannumna anda
        // meeting full race details download pannanu"), same 4 formats
        // (CSV/Excel/JSON/PDF) as the top "Download report" button, but
        // scoped to just this one meeting's races+runners rather than the
        // whole date's issues. Query params identify the meeting the same
        // way buildSchedule groups it (course+country+discipline+date).
        const dlQuery = `?date=${encodeURIComponent(dateStr || '')}&meeting=${encodeURIComponent(m.meeting || '')}&country=${encodeURIComponent(m.country || '')}&discipline=${encodeURIComponent(m.discipline || '')}${includeTrials ? '&includeTrials=true' : ''}`;
        // onclick on each link closes this dropdown right after the download
        // starts (10 Aug 2026) -- without it the menu stayed open after a
        // download since the download itself doesn't navigate the page away.
        const closeOnClick = `onclick="this.closest('details').removeAttribute('open')"`;
        const downloadWidget = `<details class="meeting-download"><summary title="Download this meeting's full race &amp; runner details (CSV / Excel / JSON / PDF)">&#11015;</summary><div class="meeting-download-menu"><a href="/meeting-report.csv${dlQuery}" ${closeOnClick}>CSV</a><a href="/meeting-report.xlsx${dlQuery}" ${closeOnClick}>Excel</a><a href="/meeting-report.json${dlQuery}" ${closeOnClick}>JSON</a><a href="/meeting-report.pdf${dlQuery}" ${closeOnClick}>PDF</a></div></details>`;

        return `${countryHeaderRow}<tr class="meeting-row" data-country="${escapeHtml(m.country)}" data-tabmeeting="${tabMeetingValue}" data-issues="${issueCodes.join(' ')}" data-hasissue="${m.hasAnyIssue}" data-meeting="${escapeHtml(String(m.meeting || '').toLowerCase())}" data-meeting-name="${escapeHtml(m.meeting || '')}"><td class="meeting">${escapeHtml(m.meeting)} <span class="country">${escapeHtml(m.country)}</span> ${tabMeetingTag} ${healthTag} ${abandonedTag} ${downloadWidget}</td>${cells}</tr>`;
      }).join('\n')
    : `<tr><td class="empty-state" colspan="${cols.length + 1}">No meetings.</td></tr>`;

  const noMatchRow = `<tr class="no-match-row" hidden><td class="empty-state" colspan="${cols.length + 1}">No meetings match the selected filters.</td></tr>`;

  return `<div class="table-scroll"><table>
    <thead><tr><th style="text-align:left;">Meeting</th>${headerCells}</tr></thead>
    <tbody>
${rows}
${noMatchRow}
    </tbody>
  </table></div>`;
}

function renderHtml(dateStr, schedule, options = {}) {
  const { byDiscipline, countries } = schedule;
  const heading = formatDateHeading(dateStr);
  const includeTrials = Boolean(options.includeTrials);
  const selectedDiscipline = DISCIPLINE_ORDER.includes(options.discipline) ? options.discipline : DISCIPLINE_ORDER[0];
  const username = options.username ? escapeHtml(options.username) : null;

  const countryOptions = ['<option value="">All countries</option>']
    .concat(countries.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`))
    .join('\n');

  const tabs = DISCIPLINE_ORDER.map((disc) => {
    const { meetings } = byDiscipline[disc];
    const active = disc === selectedDiscipline ? ' active' : '';
    return `<button type="button" class="tab-btn${active}" data-disc="${disc}" onclick="switchDiscipline('${disc}')">` +
      `<span class="badge disc-${disc}">${disc}</span> ${escapeHtml(disciplineLabel(disc))} <span class="section-count">(${meetings.length})</span></button>`;
  }).join('\n');

  const sections = DISCIPLINE_ORDER.map((disc) => {
    const { meetings, maxRaceNo } = byDiscipline[disc];
    const hidden = disc === selectedDiscipline ? '' : ' hidden';
    return `
  <section class="disc-section" id="section-${disc}"${hidden}>
    ${renderMeetingsTable(meetings, maxRaceNo, dateStr, includeTrials)}
  </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Race Day Dashboard - ${escapeHtml(dateStr)}</title>
<style>
${BASE_STYLE_BLOCK}
</style>
</head>
<body>
  <div class="top-row">
    <div>
      <h1>Race Day Dashboard</h1>
      <p class="sub">${escapeHtml(heading)} <span class="refresh-indicator" id="refreshIndicator">&middot; Auto-refresh every 3 min</span></p>
    </div>
    <div class="top-row-right">
      ${username ? `<span class="session-info">Logged in as <strong>${username}</strong> &middot; <a class="logout-link" href="/logout">Logout</a></span>` : ''}
      <button type="button" class="theme-toggle" id="themeToggle" onclick="toggleTheme()">&#127769; Dark</button>
    </div>
  </div>
  <form class="controls" method="GET" action="/">
    <button type="button" class="day-nav" onclick="shiftDate(-1)" title="Previous day">&larr; Prev day</button>
    <label>Date:
      <input type="date" name="date" id="dateInput" value="${escapeHtml(dateStr)}" onchange="this.form.submit()">
    </label>
    <button type="button" class="day-nav" onclick="shiftDate(1)" title="Next day">Next day &rarr;</button>
    <label>
      <input type="checkbox" name="includeTrials" value="true" ${includeTrials ? 'checked' : ''} onchange="this.form.submit()">
      Include trials
    </label>
    <noscript><button type="submit">Go</button></noscript>
    <a class="today-link" href="/${includeTrials ? '?includeTrials=true' : ''}">Jump to today</a>
    <span class="report-links">
      <span class="report-links-label">&#11015; Download report:</span>
      <a class="report-link" href="/report.csv?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">CSV</a>
      <a class="report-link" href="/report.xlsx?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">Excel</a>
      <a class="report-link" href="/report.json?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">JSON</a>
      <a class="report-link" href="/report.pdf?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">PDF</a>
    </span>
  </form>
  <div class="disc-tabs">
${tabs}
    <div class="grid-filters">
      <label class="meeting-search-filter">Search meeting:
        <span class="meeting-search-wrap">
          <input type="text" id="meetingSearch" placeholder="Type a meeting name..." autocomplete="off" oninput="applyFilters()" onfocus="renderSuggestionDropdown()">
          <div class="meeting-suggestions" id="meetingSuggestions"></div>
        </span>
      </label>
      <label class="country-filter">Country:
        <select id="countryFilter" onchange="applyFilters()">
${countryOptions}
        </select>
      </label>
      <label class="tabmeeting-filter">Meetings:
        <select id="tabMeetingFilter" onchange="applyFilters()">
          <option value="">All meetings</option>
          <option value="tab">TAB meetings</option>
          <option value="nontab">Non-TAB meetings</option>
        </select>
      </label>
      <label class="issue-filter">Issue:
        <select id="issueFilter" onchange="applyFilters()">
          <option value="">All</option>
          <option value="missingjockey">Missing Jockey</option>
          <option value="duplicatejockey">Duplicate Jockey</option>
          <option value="missingtab">Missing TAB</option>
          <option value="missingtrainer">Missing Trainer</option>
          <option value="scheduleissue">Schedule Issue</option>
          <option value="hasissues">Meetings with Issues</option>
          <option value="healthy">Healthy Meetings</option>
        </select>
      </label>
      <label class="status-filter">Race status:
        <select id="statusFilter" onchange="applyFilters()">
          <option value="">All statuses</option>
          <option value="upcoming">Upcoming</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="abandoned">Abandoned</option>
          <option value="resulted">Resulted</option>
        </select>
      </label>
    </div>
  </div>
${sections}
  <p class="legend">
    <div><span class="swatch"></span> Highlighted time = scheduled less than ${GAP_THRESHOLD_MIN} minutes after the previous race at that meeting.</div>
    <div><span class="swatch border-swatch"></span> Red border + "M" and number = at least one runner is missing a jockey in that race (Thoroughbred/Harness only).</div>
    <div><span class="swatch dup-swatch"></span> Orange "D" + number = count of distinct jockeys assigned to more than one runner in that race.</div>
    <div><span class="swatch bad-time-swatch"></span> Solid red = bad scheduled time -- either a 00:00 placeholder or the exact same time as another race at that meeting.</div>
    <div><span class="swatch tab-swatch"></span> Red outline + "T" number = runner(s) with a missing, zero, or duplicate tab number in that race.</div>
    <div>Purple outline + "TR" number = runner(s) missing a trainer in that race.</div>
    <div><span class="tabmeeting-tag tab">TAB</span> / <span class="tabmeeting-tag nontab">Non-TAB</span> next to a meeting name = its TAB/wagering status. Use the "Meetings" filter above to show only one or the other.</div>
    <div><span class="health-tag issue">Issue</span> / <span class="health-tag healthy">Healthy</span> next to a meeting name = whether ANY race at that meeting has a missing/duplicate jockey, missing TAB number, missing trainer, or schedule issue. Hover the tag to see exactly which one(s). Use the "Issue" filter above to isolate one problem type, or show only "Meetings with Issues" / "Healthy Meetings".</div>
    <div><span class="abandoned-tag">ABBN</span> next to a meeting name = at least one race at that meeting is abandoned. Abandoned races also show "Abandoned" directly inside the race cell (time struck through).</div>
    <div>"Download report" = the same issues report as CSV, Excel, JSON, or PDF.</div>
    <div>&#11015; next to a meeting name = download that ONE meeting's full race + runner details (every race, every runner, not just issues) as CSV, Excel, JSON, or PDF -- click to open the format menu.</div>
    <div>"Race status" filter = Upcoming / Running / Completed / Abandoned / Resulted, per RACE (not per meeting -- one meeting can have races at different statuses through the day). Dims out non-matching race cells rather than hiding the whole meeting, since a meeting can have both matching and non-matching races at once.</div>
    <div>&#127937; Green result line under a race time (e.g. "1-4-6-7") = final result, tab numbers in finishing order (1st-4th). Click the race for full runner-by-runner finishing positions.</div>
    <div>"Search meeting" box = type the START of a meeting/course name to filter to it (matches from the beginning of the name only, not the middle; suggestions drop down as you type -- click one or keep typing). Combines with the other filters above.</div>
    <div>Dashboard auto-refreshes every 3 minutes to pull the latest data -- a live countdown next to the date shows time remaining, and pauses (holding steady) while a race detail popup is open. Use the &#127769;/&#9728;&#65039; button top-right to switch Dark/Light mode -- both your filter choices and theme are remembered on this device.</div>
    <div>Hover a race time for class + prize money. Click it for full runner detail (tab number, horse, jockey/trainer, position, issue).</div>
  </p>
  <p class="meta">date param: <code>?date=YYYY-MM-DD</code> &middot; trials param: <code>?includeTrials=true</code></p>

${MODAL_MARKUP}

  <script>
${MODAL_SCRIPT_BLOCK}

    function shiftDate(deltaDays) {
      var input = document.getElementById('dateInput');
      var parts = input.value.split('-').map(Number);
      var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      d.setUTCDate(d.getUTCDate() + deltaDays);
      var y = d.getUTCFullYear();
      var m = String(d.getUTCMonth() + 1).padStart(2, '0');
      var day = String(d.getUTCDate()).padStart(2, '0');
      input.value = y + '-' + m + '-' + day;
      input.form.submit();
    }

    function switchDiscipline(disc) {
      document.querySelectorAll('.tab-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-disc') === disc);
      });
      document.querySelectorAll('.disc-section').forEach(function (sec) {
        var isMatch = sec.id === 'section-' + disc;
        if (isMatch) sec.removeAttribute('hidden');
        else sec.setAttribute('hidden', '');
      });
    }

    function applyFilters() {
      var country = document.getElementById('countryFilter').value;
      var tabMeeting = document.getElementById('tabMeetingFilter').value;
      var issue = document.getElementById('issueFilter').value;
      var status = document.getElementById('statusFilter').value;
      var search = (document.getElementById('meetingSearch').value || '').trim().toLowerCase();

      saveFilterState();

      // Race status is a PER-RACE (per-cell) thing, not a per-meeting thing --
      // one meeting can have R1 Resulted, R2 Running, R3 Upcoming all at
      // once. So the status filter dims individual race cells rather than
      // hiding the whole meeting-row, and a row only disappears entirely if
      // NONE of its races match (handled below via data-has-status-match).
      document.querySelectorAll('td.time').forEach(function (cell) {
        var cellStatusMatch = !status || cell.getAttribute('data-status') === status;
        cell.classList.toggle('status-filtered', !cellStatusMatch);
      });

      document.querySelectorAll('tr.meeting-row').forEach(function (row) {
        var countryMatch = !country || row.getAttribute('data-country') === country;
        var tabMatch = !tabMeeting || row.getAttribute('data-tabmeeting') === tabMeeting;
        var issueMatch = true;
        if (issue === 'hasissues') issueMatch = row.getAttribute('data-hasissue') === 'true';
        else if (issue === 'healthy') issueMatch = row.getAttribute('data-hasissue') === 'false';
        else if (issue) issueMatch = (row.getAttribute('data-issues') || '').split(' ').indexOf(issue) !== -1;
        var statusMatch = !status || row.querySelectorAll('td.time[data-status="' + status + '"]').length > 0;
        // Prefix match only (starts with what's typed), not "contains" --
        // Dinesh specifically asked for this after "middle'la search aagudu".
        var searchMatch = !search || (row.getAttribute('data-meeting') || '').indexOf(search) === 0;
        row.classList.toggle('row-hidden', !(countryMatch && tabMatch && issueMatch && statusMatch && searchMatch));
      });

      // A country-header-row is visible only if at least one meeting-row
      // under it (before the next header) is still visible -- otherwise a
      // TAB/country combo with zero matches would leave an orphaned header.
      document.querySelectorAll('table').forEach(function (table) {
        var rows = Array.prototype.slice.call(table.querySelectorAll('tr.country-header-row, tr.meeting-row'));
        var currentHeader = null;
        var anyVisibleUnderHeader = false;
        rows.forEach(function (row) {
          if (row.classList.contains('country-header-row')) {
            if (currentHeader) currentHeader.classList.toggle('row-hidden', !anyVisibleUnderHeader);
            currentHeader = row;
            anyVisibleUnderHeader = false;
          } else if (!row.classList.contains('row-hidden')) {
            anyVisibleUnderHeader = true;
          }
        });
        if (currentHeader) currentHeader.classList.toggle('row-hidden', !anyVisibleUnderHeader);

        var anyVisible = table.querySelectorAll('tr.meeting-row:not(.row-hidden)').length > 0;
        var hasAnyMeetingRow = table.querySelectorAll('tr.meeting-row').length > 0;
        var noMatchRow = table.querySelector('tr.no-match-row');
        if (noMatchRow) {
          if (hasAnyMeetingRow && !anyVisible) noMatchRow.removeAttribute('hidden');
          else noMatchRow.setAttribute('hidden', '');
        }
      });

      updateMeetingSuggestions(country, tabMeeting, issue, status);
    }

    // "Search meeting" suggestions must only ever list meetings that are
    // ACTUALLY on the page right now for this date: this date's schedule
    // only (never other dates -- the whole page is per-date), the currently
    // selected discipline tab only (not all 3 mixed together), and further
    // narrowed by whichever Country/Meetings(TAB)/Issue/Race-status filters
    // are active -- so a suggestion never points at a meeting that isn't
    // actually visible if picked. This candidate list is independent of the
    // search text itself; renderSuggestionDropdown() below narrows it by
    // what's actually typed (PREFIX match only -- see that function).
    //
    // Built with a custom dropdown (not the native <datalist>) because
    // native datalist matching is browser-controlled and matches ANYWHERE
    // in the value, not just the start -- Dinesh specifically asked for
    // start-of-name-only matching ("middle'la search aagudhu, first'la
    // irundhu mattum thevai"), which datalist can't guarantee.
    var _availableMeetingNames = [];
    function updateMeetingSuggestions(country, tabMeeting, issue, status) {
      var activeSection = document.querySelector('.disc-section:not([hidden])');
      var names = [];
      var seen = {};
      if (activeSection) {
        activeSection.querySelectorAll('tr.meeting-row').forEach(function (row) {
          var countryMatch = !country || row.getAttribute('data-country') === country;
          var tabMatch = !tabMeeting || row.getAttribute('data-tabmeeting') === tabMeeting;
          var issueMatch = true;
          if (issue === 'hasissues') issueMatch = row.getAttribute('data-hasissue') === 'true';
          else if (issue === 'healthy') issueMatch = row.getAttribute('data-hasissue') === 'false';
          else if (issue) issueMatch = (row.getAttribute('data-issues') || '').split(' ').indexOf(issue) !== -1;
          var statusMatch = !status || row.querySelectorAll('td.time[data-status="' + status + '"]').length > 0;
          if (!(countryMatch && tabMatch && issueMatch && statusMatch)) return;
          var name = row.getAttribute('data-meeting-name');
          if (name && !seen[name]) { seen[name] = true; names.push(name); }
        });
      }
      names.sort();
      _availableMeetingNames = names;
      renderSuggestionDropdown();
    }

    // Renders the custom suggestion dropdown, filtered to names that START
    // WITH whatever is currently typed in the search box (case-insensitive
    // prefix match) -- not a "contains anywhere" match.
    function renderSuggestionDropdown() {
      var input = document.getElementById('meetingSearch');
      var dropdown = document.getElementById('meetingSuggestions');
      if (!input || !dropdown) return;
      var text = (input.value || '').trim().toLowerCase();
      dropdown.innerHTML = '';
      if (!text) { dropdown.classList.remove('open'); return; }
      var matches = _availableMeetingNames.filter(function (name) {
        return name.toLowerCase().indexOf(text) === 0;
      }).slice(0, 15);
      if (!matches.length) { dropdown.classList.remove('open'); return; }
      matches.forEach(function (name) {
        var item = document.createElement('div');
        item.textContent = name;
        // mousedown (not click) so this fires BEFORE the input's blur event
        // closes the dropdown out from under the click.
        item.onmousedown = function (e) {
          e.preventDefault();
          input.value = name;
          dropdown.classList.remove('open');
          applyFilters();
        };
        dropdown.appendChild(item);
      });
      dropdown.classList.add('open');
    }

    (function wireSearchDropdownDismiss() {
      var input = document.getElementById('meetingSearch');
      if (!input) return;
      // Close the dropdown when focus leaves the search box -- delayed so a
      // click on a suggestion (mousedown, handled above) still lands first.
      input.addEventListener('blur', function () {
        setTimeout(function () {
          var dropdown = document.getElementById('meetingSuggestions');
          if (dropdown) dropdown.classList.remove('open');
        }, 150);
      });
    })();

    // ---- Filter persistence (survives auto-refresh / manual reload) ----
    var FILTER_STORAGE_KEYS = {
      countryFilter: 'rdd_countryFilter', tabMeetingFilter: 'rdd_tabMeetingFilter',
      issueFilter: 'rdd_issueFilter', statusFilter: 'rdd_statusFilter', meetingSearch: 'rdd_meetingSearch',
    };
    function saveFilterState() {
      try {
        Object.keys(FILTER_STORAGE_KEYS).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) localStorage.setItem(FILTER_STORAGE_KEYS[id], el.value || '');
        });
      } catch (e) { /* localStorage unavailable -- ignore, filters just won't persist */ }
    }
    function restoreFilterState() {
      try {
        Object.keys(FILTER_STORAGE_KEYS).forEach(function (id) {
          var el = document.getElementById(id);
          var saved = localStorage.getItem(FILTER_STORAGE_KEYS[id]);
          if (el && saved) el.value = saved;
        });
        var savedDisc = localStorage.getItem('rdd_discipline');
        if (savedDisc && document.getElementById('section-' + savedDisc)) switchDiscipline(savedDisc);
      } catch (e) { /* ignore */ }
    }

    var _origSwitchDiscipline = switchDiscipline;
    switchDiscipline = function (disc) {
      _origSwitchDiscipline(disc);
      try { localStorage.setItem('rdd_discipline', disc); } catch (e) { /* ignore */ }
      // Rebuild "Search meeting" suggestions for the tab just switched to --
      // otherwise they'd keep listing the previous tab's meetings.
      applyFilters();
    };

    // ---- Light / Dark theme ----
    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      var btn = document.getElementById('themeToggle');
      if (btn) btn.innerHTML = theme === 'dark' ? '&#9728;&#65039; Light' : '&#127769; Dark';
    }
    function toggleTheme() {
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      var next = current === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('rdd_theme', next); } catch (e) { /* ignore */ }
      applyTheme(next);
    }

    // ---- Auto-refresh every 3 minutes, with a live countdown ----
    var AUTO_REFRESH_SECONDS = 3 * 60;
    var refreshSecondsLeft = AUTO_REFRESH_SECONDS;
    function formatCountdown(totalSeconds) {
      var m = Math.floor(totalSeconds / 60);
      var s = totalSeconds % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function updateRefreshIndicator(paused) {
      var el = document.getElementById('refreshIndicator');
      if (!el) return;
      el.textContent = paused
        ? '· Auto-refresh paused (runner detail open)'
        : '· Auto-refresh in ' + formatCountdown(refreshSecondsLeft);
    }
    function scheduleAutoRefresh() {
      updateRefreshIndicator(false);
      setInterval(function () {
        var modal = document.getElementById('detailModal');
        var isPaused = Boolean(modal && modal.classList.contains('open'));
        if (isPaused) {
          // Don't yank the page while a runner-detail popup is open -- hold
          // the countdown steady (don't tick it down) until it's closed.
          updateRefreshIndicator(true);
          return;
        }
        refreshSecondsLeft -= 1;
        if (refreshSecondsLeft <= 0) {
          saveFilterState();
          location.reload();
          return;
        }
        updateRefreshIndicator(false);
      }, 1000);
    }

    (function init() {
      var savedTheme = 'light';
      try { savedTheme = localStorage.getItem('rdd_theme') || 'light'; } catch (e) { /* ignore */ }
      applyTheme(savedTheme);
      restoreFilterState();
      applyFilters();
      scheduleAutoRefresh();
    })();
  </script>
</body>
</html>`;
}

// --- Login page -------------------------------------------------------------
//
// Added 12 Aug 2026 per Dinesh: "Enakku inda dash boardku user logins seiyanu,
// Ippodakku, User name Password kuduthu ullukku pora madhiri" (add a
// username/password login to the dashboard). Scoped via follow-up questions
// to: a single shared username/password, guarding ONLY the main dashboard
// page ("/") -- report downloads and the JSON API stay open -- with the
// password stored as a securely-hashed value in a local config file outside
// the project folder (see setup-auth.js, AUTH_CONFIG_PATH in server.js),
// never in plaintext and never committed to git. The session is a plain
// browser-session cookie -- closing the browser logs you out.
//
// This function is pure HTML (no DB/session code, consistent with the rest
// of this file) -- server.js supplies `error` based on session/query-string
// state and handles the actual credential check and session cookie.
function renderLoginPage(options = {}) {
  const error = options.error ? escapeHtml(options.error) : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Race Day Dashboard - Login</title>
<style>
${BASE_STYLE_BLOCK}
</style>
</head>
<body class="login-page-body">
  <div class="login-card">
    <h1>Race Day Dashboard</h1>
    <p class="sub">Sign in to continue</p>
    ${error ? `<div class="login-error">${error}</div>` : ''}
    <form method="POST" action="/login" autocomplete="off">
      <label>Username
        <input type="text" name="username" autocomplete="username" autofocus required>
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit">Log in</button>
    </form>
  </div>
  <script>
    (function () {
      var savedTheme = 'light';
      try { savedTheme = localStorage.getItem('rdd_theme') || 'light'; } catch (e) { /* ignore */ }
      document.documentElement.setAttribute('data-theme', savedTheme);
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  buildSchedule, buildRaceDetail, renderHtml, renderLoginPage, todayStr, parseClock, disciplineLabel, escapeHtml,
  countMissingJockeys, hasDuplicateJockey, countDuplicateJockeyGroups, issueForRunner, jockeyCounts,
  tabNoCounts, hasDuplicateTabNo, countTabNoIssues, tabIssueForRunner,
  countMissingTrainers,
  buildIssuesReport, issuesReportToCsv, buildMeetingDetailsReport, meetingDetailsReportToCsv, deriveRaceStatus,
  MISSING_JOCKEY_BORDER_THRESHOLD, GAP_THRESHOLD_MIN, DISCIPLINE_ORDER, STATUS_ORDER, STATUS_LABELS,
};
