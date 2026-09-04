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

const fs = require('fs');
const path = require('path');

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

// `hasFormLines` is attached server-side (server.js's attachFormLineStatus)
// by cross-referencing the `racecards` collection -- this function stays
// DB-free like the rest of the file and just counts whatever was already
// attached. Thoroughbred only (28 Aug 2026, per Dinesh) -- Harness/Greyhound
// racecards weren't verified against this check and shouldn't be flagged.
function countMissingFormLines(runners, discipline) {
  if (discipline !== 'T') return null;
  if (!Array.isArray(runners)) return 0;
  return runners.filter((r) => !r.isScratched && r.hasFormLines === false).length;
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
  if (discipline === 'T' && runner.hasFormLines === false) parts.push(formLinesIssueLabel(runner.formLinesByClient));
  return parts.join(' | ');
}

// The Default (no-client) racecard feed can be missing form lines for a
// runner while a specific client's own feed (e.g. "WSB") has real history for
// the exact same runner -- confirmed against a real Alice Springs R1 case,
// 28 Aug 2026. Rather than a flat "Missing form lines", this names which
// feed(s) are actually missing it so it's clear whether it's a total gap or
// just the generic feed.
function formLinesIssueLabel(formLinesByClient) {
  if (!formLinesByClient) return 'Missing form lines (no racecard data found)';
  const present = Object.keys(formLinesByClient).filter((c) => c !== 'Default' && formLinesByClient[c]);
  if (!present.length) return 'Missing form lines (all feeds, including Default)';
  return `Missing form lines (Default) -- present under: ${present.join(', ')}`;
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
      missingFormCount: countMissingFormLines(doc.runners, doc.rDiscipline),
      status: deriveRaceStatus(doc),
      resultString: doc.resultString || '',
      isTrial: Boolean(doc.isTrail), // `isTrail` is the DB's field name
      // `hasVideo` is attached server-side (server.js's attachVideoStatus) for
      // every Thoroughbred race in AUS/GB/SAF/IRE, checked or not yet run --
      // undefined means "not checked at all" (different discipline/country).
      // `videoUrl` (the icon/link) shows for ANY race with a video, upcoming
      // or not, but the "missing" WARNING only applies once the race has
      // actually resulted -- an upcoming race with no video yet is normal,
      // not a problem to flag.
      missingVideo: doc.hasVideo === false && Boolean(doc.resultString),
      videoUrl: doc.videoUrl || null,
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
        missingTrainerCount, missingFormCount, status, resultString, isTrial, missingVideo, videoUrl,
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
            missingFormCount,
            status,
            resultString,
            isTrial,
            missingVideo,
            videoUrl,
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
    let hasMissingForm = false;
    let hasMissingVideo = false;
    let hasScheduleIssue = false;
    let hasAbandoned = false;
    for (const rNo of raceNos) {
      const race = races[rNo];
      if (!race) continue;
      if (race.missingJockeyCount > 0) hasMissingJockey = true;
      if (race.duplicateJockeyCount > 0) hasDuplicateJockey = true;
      if (race.tabIssueCount > 0) hasMissingTab = true;
      if (race.missingTrainerCount > 0) hasMissingTrainer = true;
      if (race.missingFormCount > 0) hasMissingForm = true;
      if (race.missingVideo) hasMissingVideo = true;
      if (race.badTime) hasScheduleIssue = true;
      if (race.status === 'abandoned') hasAbandoned = true;
    }
    const hasAnyIssue = hasMissingJockey || hasDuplicateJockey || hasMissingTab || hasMissingTrainer || hasMissingForm || hasMissingVideo || hasScheduleIssue;

    meetings.push({
      meeting: g.meeting, country: g.country, discipline: g.discipline, isTAB: g.isTAB,
      hasMissingJockey, hasDuplicateJockey, hasMissingTab, hasMissingTrainer, hasMissingForm, hasMissingVideo, hasScheduleIssue, hasAnyIssue, hasAbandoned,
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
      runnerId: r.runnerId || null,
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
    isTrial: Boolean(doc.isTrail), // `isTrail` is the DB's field name
    missingVideo: doc.hasVideo === false,
    videoUrl: doc.videoUrl || null,
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
    const missingFormCount = countMissingFormLines(doc.runners, doc.rDiscipline) || 0;
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
    if (missingFormCount > 0) issues.push(`Missing form lines x${missingFormCount}`);
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

// HTML page skeletons live in views/*.html (styles in public/styles.css,
// served statically by server.js) -- read once at startup and filled in per
// request via renderTemplate() below. Only the meeting/race grid itself is
// still built as an HTML string here, since that part is genuinely dynamic
// (one row per DB result) and can't be a static file.
const DASHBOARD_TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'dashboard.html'), 'utf8');
const LOGIN_TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8');

function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));
}

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
          if (race.missingFormCount > 0) cls += ' missing-form';
          if (race.missingVideo) cls += ' missing-video';
          if (race.badTime) cls += ' bad-time';
          if (race.resultString) cls += ' has-result';
          if (race.status === 'abandoned') cls += ' abandoned-race';
          if (race.isTrial) cls += ' trial-race';

          const titleParts = [];
          if (race.isTrial) titleParts.push('Trial race');
          titleParts.push(`Status: ${STATUS_LABELS[race.status] || race.status}`);
          if (race.badTime) titleParts.push(race.badTimeReason);
          if (race.gapMinutes !== null) titleParts.push(`${race.gapMinutes} min after the previous race`);
          if (race.rClass) titleParts.push(`Class: ${race.rClass}`);
          if (race.rPrizeMoney) titleParts.push(`Prize: ${race.rPrizeMoney}`);
          if (race.missingJockeyCount > 0) titleParts.push(`${race.missingJockeyCount} runner(s) missing jockey`);
          if (race.duplicateJockeyCount > 0) titleParts.push(`${race.duplicateJockeyCount} jockey(s) duplicated across runners`);
          if (race.tabIssueCount > 0) titleParts.push(`${race.tabIssueCount} runner(s) with missing/zero/duplicate tab number`);
          if (race.missingTrainerCount > 0) titleParts.push(`${race.missingTrainerCount} runner(s) missing trainer`);
          if (race.missingFormCount > 0) titleParts.push(`${race.missingFormCount} runner(s) missing form lines`);
          if (race.missingVideo) titleParts.push('Videos not available');
          if (race.videoUrl) titleParts.push('Race video available -- click the camera icon to watch');
          if (race.resultString) titleParts.push(`Result (tab numbers, 1st-4th): ${race.resultString}`);
          titleParts.push('Click for runner details');

          const mjBadgeClass = `mj-badge${race.missingJockeysFlagged ? ' mj-badge-alert' : ''}`;
          const mjBadge = race.missingJockeyCount > 0 ? `<sup class="${mjBadgeClass}" title="${race.missingJockeyCount} runner(s) missing a jockey">M${race.missingJockeyCount}</sup>` : '';
          const dupBadge = race.duplicateJockeyCount > 0 ? `<sup class="dup-badge" title="${race.duplicateJockeyCount} jockey(s) duplicated across runners">D${race.duplicateJockeyCount}</sup>` : '';
          const tabBadge = race.tabIssueCount > 0 ? `<sup class="tab-badge" title="${race.tabIssueCount} runner(s) with missing/zero/duplicate tab number">T${race.tabIssueCount}</sup>` : '';
          const trainerBadge = race.missingTrainerCount > 0 ? `<sup class="trainer-badge" title="${race.missingTrainerCount} runner(s) missing trainer">TR${race.missingTrainerCount}</sup>` : '';
          const formBadge = race.missingFormCount > 0 ? `<sup class="form-badge" title="${race.missingFormCount} runner(s) missing form lines">FL${race.missingFormCount}</sup>` : '';
          const resultLine = race.resultString ? `<div class="result-line">&#127937; ${escapeHtml(race.resultString)}</div>` : '';
          const abandonedLine = race.status === 'abandoned' ? `<div class="abandoned-line">Abandoned</div>` : '';
          const trialLine = race.isTrial ? `<div class="trial-line">Trial</div>` : '';
          const novideoLine = race.missingVideo ? `<div class="novideo-line">Videos not available</div>` : '';
          const videoLink = race.videoUrl
            ? `<a class="video-link" href="${escapeHtml(race.videoUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Watch race video">&#127909;</a>`
            : '';

          return `<td class="${cls}" data-status="${race.status}" title="${escapeHtml(titleParts.join(' | '))}" onclick="showRaceDetail('${escapeHtml(race.id)}')">${race.label}${mjBadge}${dupBadge}${tabBadge}${trainerBadge}${formBadge}${videoLink}${trialLine}${resultLine}${abandonedLine}${novideoLine}</td>`;
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
        if (m.hasMissingForm) issueCodes.push('missingform');
        if (m.hasMissingVideo) issueCodes.push('missingvideo');
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
        if (m.hasMissingForm) issueReasons.push('Missing Form Lines');
        if (m.hasMissingVideo) issueReasons.push('Missing Video');
        if (m.hasScheduleIssue) issueReasons.push('Schedule Issue');
        const healthTag = m.hasAnyIssue
          ? `<span class="health-tag issue" title="${escapeHtml(issueReasons.join(', '))}">Issue</span>`
          : '<span class="health-tag healthy" title="No missing/duplicate jockey, missing TAB, missing trainer, missing form lines, missing video, or schedule issue at this meeting">Healthy</span>';
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

  const usernameBlock = username
    ? `<span class="session-info">Logged in as <strong>${username}</strong> &middot; <a class="logout-link" href="/logout">Logout</a></span>`
    : '';

  const todayLinkHtml = `<a class="today-link" href="/${includeTrials ? '?includeTrials=true' : ''}">Jump to today</a>`;

  const reportLinksHtml = `<span class="report-links">
      <span class="report-links-label">&#11015; Download report:</span>
      <a class="report-link" href="/report.csv?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">CSV</a>
      <a class="report-link" href="/report.xlsx?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">Excel</a>
      <a class="report-link" href="/report.json?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">JSON</a>
      <a class="report-link" href="/report.pdf?date=${escapeHtml(dateStr)}${includeTrials ? '&includeTrials=true' : ''}">PDF</a>
    </span>`;

  // `missingAusMeetings`: null = date outside Racing Australia's own
  // published window (or the fetch failed) -- nothing to show either way.
  // An empty array means it WAS checked and nothing's missing, also no
  // banner. Only render when there's an actual discrepancy to report.
  const missingAusMeetings = Array.isArray(options.missingAusMeetings) ? options.missingAusMeetings : [];
  const missingAusMeetingsBanner = missingAusMeetings.length
    ? `<div class="ra-missing-banner">&#9888; Racing Australia lists ${missingAusMeetings.length} meeting(s) for this date not found in TD DB: ${escapeHtml(missingAusMeetings.join(', '))}</div>`
    : '';

  return renderTemplate(DASHBOARD_TEMPLATE, {
    DATE_STR: escapeHtml(dateStr),
    HEADING: escapeHtml(heading),
    USERNAME_BLOCK: usernameBlock,
    INCLUDE_TRIALS_CHECKED: includeTrials ? 'checked' : '',
    TODAY_LINK_HTML: todayLinkHtml,
    REPORT_LINKS_HTML: reportLinksHtml,
    TABS: tabs,
    COUNTRY_OPTIONS: countryOptions,
    SECTIONS: sections,
    MISSING_AUS_MEETINGS_BANNER: missingAusMeetingsBanner,
  });
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
  const errorBlock = error ? `<div class="login-error">${error}</div>` : '';
  return renderTemplate(LOGIN_TEMPLATE, { ERROR_BLOCK: errorBlock });
}

module.exports = {
  buildSchedule, buildRaceDetail, renderHtml, renderLoginPage, todayStr, parseClock, disciplineLabel, escapeHtml,
  countMissingJockeys, hasDuplicateJockey, countDuplicateJockeyGroups, issueForRunner, jockeyCounts,
  tabNoCounts, hasDuplicateTabNo, countTabNoIssues, tabIssueForRunner,
  countMissingTrainers,
  buildIssuesReport, issuesReportToCsv, buildMeetingDetailsReport, meetingDetailsReportToCsv, deriveRaceStatus,
  MISSING_JOCKEY_BORDER_THRESHOLD, GAP_THRESHOLD_MIN, DISCIPLINE_ORDER, STATUS_ORDER, STATUS_LABELS,
};
