/**
 * Comment picks report (15 Oct 2026, asked for by Dinesh's boss): how good
 * are the race comments' picks?
 *
 * - The race comment is the one the race popup shows (racecards
 *   RaceComment, AU style first). Its tab numbers -- "EAKLY (6) ... COUNTRY
 *   CAPER (4)" -- in the order they first appear are the picks.
 * - Runners scratched in our race doc (and numbers not in the field) are
 *   removed; what's left is the 1st pick, 2nd pick, ...
 * - The result string ("6-4-3/7-1", "/" = dead heat) gives each tab's
 *   finishing position. Win = 1st, place = top 3 (Dinesh: always top 3).
 * - Per pick position: races, wins, win strike rate, places, place rate,
 *   plus which pick the winner was (or "not picked"); overall, by discipline
 *   and by country.
 */
const TAB_RE = /\((\d{1,2})\)/g;
const MAX_PICKS = 6; // 1st..5th shown on their own, 6th+ together
const PLACE_POSITIONS = 3;
const DISCIPLINES = { T: 'Thoroughbred', H: 'Harness', G: 'Greyhound' };

// Tab numbers in the order the comment first mentions them.
function commentTabs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TAB_RE)) {
    const n = Number(m[1]);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

// "1-3-4/9-5" -> 1:1, 3:2, 4:3, 9:3, 5:4.
function resultPositions(resultString) {
  const pos = new Map();
  String(resultString || '').split('-').forEach((group, i) => {
    for (const t of group.split(/[/=]/)) {
      const n = Number(String(t).trim());
      if (n > 0 && !pos.has(n)) pos.set(n, i + 1);
    }
  });
  return pos;
}

// One race -> its picks and how they ran, or null when the comment has no
// usable picks or there's no result.
function analyseRace(race, comment) {
  if (!comment || !race.resultString) return null;
  const runners = race.runners || [];
  const field = new Set(runners.filter((r) => !r.isScratched && r.tabNo != null).map((r) => Number(r.tabNo)));
  const scratched = new Set(runners.filter((r) => r.isScratched && r.tabNo != null).map((r) => Number(r.tabNo)));
  const mentioned = commentTabs(comment);
  const picks = mentioned.filter((t) => field.has(t));
  if (!picks.length) return null;
  const pos = resultPositions(race.resultString);
  const names = new Map(runners.map((r) => [Number(r.tabNo), r.horseName || '']));
  const outcome = picks.map((t) => pos.get(t) || null);
  const winnerIdx = outcome.findIndex((p) => p === 1);
  return {
    raceId: race._id,
    date: race.rDate,
    meeting: race.rCourseDisplayName,
    rNo: race.rNo,
    country: race.rCountry || '?',
    discipline: race.rDiscipline || '?',
    picks,
    pickNames: picks.map((t) => names.get(t) || ''),
    removed: mentioned.filter((t) => scratched.has(t)),
    result: race.resultString,
    outcome,
    winnerPick: winnerIdx === -1 ? null : winnerIdx + 1,
  };
}

function emptySummary() {
  return { races: 0, byPick: Array.from({ length: MAX_PICKS }, (_, i) => ({ pick: i + 1, races: 0, wins: 0, places: 0 })), winnerFrom: { picked: Array(MAX_PICKS).fill(0), none: 0 } };
}

function addRace(s, a) {
  s.races++;
  for (let i = 0; i < Math.min(a.picks.length, MAX_PICKS); i++) {
    const b = s.byPick[i];
    // The last row ("6th+") counts each race once, by its best-placed pick from 6th on.
    const tail = i === MAX_PICKS - 1 ? a.outcome.slice(i).filter((p) => p != null) : null;
    const p = tail ? (tail.length ? Math.min(...tail) : null) : a.outcome[i];
    b.races++;
    if (p === 1) b.wins++;
    if (p != null && p <= PLACE_POSITIONS) b.places++;
  }
  if (a.winnerPick == null) s.winnerFrom.none++;
  else s.winnerFrom.picked[Math.min(a.winnerPick, MAX_PICKS) - 1]++;
}

function finish(s) {
  const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return {
    races: s.races,
    byPick: s.byPick.filter((b) => b.races).map((b) => ({ ...b, winRate: rate(b.wins, b.races), placeRate: rate(b.places, b.races) })),
    winnerFrom: {
      picked: s.winnerFrom.picked.map((n, i) => ({ pick: i + 1, races: n, share: rate(n, s.races) })),
      none: { races: s.winnerFrom.none, share: rate(s.winnerFrom.none, s.races) },
    },
  };
}

// rows: analyseRace results -> overall + by discipline + by country.
function summarise(rows) {
  const all = emptySummary();
  const byD = new Map();
  const byC = new Map();
  for (const a of rows) {
    addRace(all, a);
    if (!byD.has(a.discipline)) byD.set(a.discipline, emptySummary());
    addRace(byD.get(a.discipline), a);
    if (!byC.has(a.country)) byC.set(a.country, emptySummary());
    addRace(byC.get(a.country), a);
  }
  const list = (m, label) => [...m.entries()].map(([key, s]) => ({ key, label: label(key), ...finish(s) })).sort((x, y) => y.races - x.races);
  return {
    overall: finish(all),
    byDiscipline: list(byD, (k) => DISCIPLINES[k] || k),
    byCountry: list(byC, (k) => k),
  };
}

// Loads one race date's analysed races from the database.
async function loadDate(db, dateStr) {
  const races = await db.collection('races').find(
    { rDate: dateStr, resultString: { $nin: [null, ''] }, isTrail: { $ne: true } },
    { projection: { rDate: 1, rDiscipline: 1, rCountry: 1, rCourseDisplayName: 1, rNo: 1, resultString: 1, 'runners.tabNo': 1, 'runners.isScratched': 1, 'runners.horseName': 1 } },
  ).toArray();
  if (!races.length) return [];
  const cards = await db.collection('racecards').find(
    { RaceId: { $in: races.map((r) => r._id) }, RaceComment: { $nin: [null, ''] } },
    { projection: { RaceId: 1, Style: 1, RaceComment: 1 } },
  ).toArray();
  // Same choice as the race popup: the AU style's comment first.
  cards.sort((a, b) => (b.Style === 'AU' ? 1 : 0) - (a.Style === 'AU' ? 1 : 0));
  const comment = new Map();
  for (const c of cards) if (!comment.has(c.RaceId)) comment.set(c.RaceId, c.RaceComment);
  return races.map((r) => analyseRace(r, comment.get(r._id))).filter(Boolean);
}

module.exports = { commentTabs, resultPositions, analyseRace, summarise, loadDate, MAX_PICKS, PLACE_POSITIONS, DISCIPLINES };
