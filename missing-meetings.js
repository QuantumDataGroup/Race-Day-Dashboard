// Missing Meetings check (1 Oct 2026, per Dinesh): thoroughbred meetings the
// Scratchings feed (getScratchingsGrey, see server.js) lists for these
// countries, compared with the meetings in our DB, so a meeting the feed has
// but the dashboard doesn't is flagged. The feed lists every meeting of the
// day, not only ones with scratchings.
//
// Matched on the feed's MeetingID (= meetings.tabMeetingId in our DB); when
// that doesn't match, on date + country + course name. The feed can split
// one of our meetings by surface -- on 1 Oct 2026 it had WOODBINE (R1, R4,
// R6) and WOODBINE AW (R2, R3, R5, R7, R8) where our DB has one WOODBINE
// meeting with R1-R8 -- so surface words are ignored in the name match.

// The starting country list. Users can add/remove countries on the page
// (saved by server.js); this is used until they do.
const DEFAULT_COUNTRIES = [
  ['UAE', 'UAE'], ['KOR', 'Korea'], ['MAL', 'Malaysia'], ['MUS', 'Mauritius'], ['ARG', 'Argentina'],
  ['BRZ', 'Brazil'], ['CHI', 'Chile'], ['GER', 'Germany'], ['DEN', 'Denmark'], ['ITY', 'Italy'],
  ['SAU', 'Saudi Arabia'], ['SWE', 'Sweden'], ['CAN', 'Canada'],
];

// Courses left out of the check altogether -- not listed, not counted --
// whatever the date (1 Oct 2026, per Dinesh: "KOR - JEJU meeting ignore
// pannunga... anda list lairundu eduthurunga, anda meetings count panna
// wena"). [country, course as the feed names it].
const EXCLUDED_COURSES = [
  ['KOR', 'JEJU'],
];
function isExcluded(country, course) {
  return EXCLUDED_COURSES.some(([c, name]) => c === country && sameCourse(name, course));
}

function isThoroughbred(m) {
  return Boolean(m && m.MeetingID != null && String(m.Discipline || '').toUpperCase() === 'T');
}

// Feed meetings worth checking: thoroughbred, one of the checked
// countries (a Set of codes), minus the excluded courses.
function pickSourceMeetings(feedMeetings, countryCodes) {
  return (feedMeetings || []).filter((m) => {
    if (!isThoroughbred(m)) return false;
    const country = String(m.Country || '').toUpperCase();
    return countryCodes.has(country) && !isExcluded(country, m.Course);
  });
}

// Countries with thoroughbred meetings in the feed that aren't checked yet,
// most meetings first -- offered as quick "add" choices on the page.
function uncheckedFeedCountries(feedMeetings, countryCodes) {
  const counts = new Map();
  for (const m of feedMeetings || []) {
    if (!isThoroughbred(m)) continue;
    const code = String(m.Country || '').toUpperCase();
    if (code && !countryCodes.has(code)) counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts].map(([code, meetings]) => ({ code, meetings })).sort((a, b) => b.meetings - a.meetings || a.code.localeCompare(b.code));
}

const NAME_IGNORE = new Set(['de', 'del', 'la', 'el', 'the', 'and', 'aw', 'turf', 'all', 'weather', 'dirt', 'synthetic', 'tapeta', 'polytrack']);
function nameTokens(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t && !NAME_IGNORE.has(t));
}
// Same course when every word of the shorter name is in the longer one.
function sameCourse(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return small.every((t) => big.has(t));
}

// dbMeetings: { _id, tabMeetingId, mDate, mCountry, mCourseDisplayName, isHidden, hiddenReason }
// visibleRaceCounts: Map meetingId -> races the dashboard shows for it.
function compareMeetings(sourceMeetings, dbMeetings, visibleRaceCounts) {
  const byTabId = new Map();
  for (const m of dbMeetings) if (m.tabMeetingId) byTabId.set(String(m.tabMeetingId), m);
  const rows = sourceMeetings.map((s) => {
    const country = String(s.Country || '').toUpperCase();
    const m = byTabId.get(String(s.MeetingID))
      || dbMeetings.find((d) => d.mDate === s.Date && d.mCountry === country && sameCourse(d.mCourseDisplayName, s.Course));
    let status = 'ok';
    let note = '';
    if (!m) {
      status = 'missing';
    } else if (m.isHidden) {
      status = 'missing';
      note = `Hidden on the dashboard${m.hiddenReason ? ` (${m.hiddenReason})` : ''}`;
    } else if (!(visibleRaceCounts.get(m._id) > 0)) {
      status = 'missing';
      note = 'No races on the dashboard';
    }
    return {
      date: s.Date,
      country,
      course: s.Course,
      sourceMeetingId: s.MeetingID,
      races: Object.keys(s.races || {}).length,
      status,
      note,
      dashboardMeeting: m ? m.mCourseDisplayName : null,
    };
  });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.country.localeCompare(b.country) || a.course.localeCompare(b.course));
  return rows;
}

module.exports = { DEFAULT_COUNTRIES, pickSourceMeetings, uncheckedFeedCountries, compareMeetings, sameCourse };
