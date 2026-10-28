// Comment fact check (27 Oct 2026, per Dinesh, after Hereford R1 26 Oct:
// "GOD OF FIRE (6) has a recent win ... faces a step up in class" when his
// last win was 4 runs back and today is a class drop -- "inda madhiri
// comments vanda warning thara mudiuma enakku mattu"). What a comment says
// about a horse's form, checked against the horse's racecard form lines
// (FormLines: newest first) and PerformanceStatistics. Keyword rules, no AI:
// a claim is only flagged when the form clearly says otherwise, and claims
// the form can't show (no runs, no class on either side) are left alone.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
};
const daysBetween = (a, b) => Math.round((Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 86400000);
const WORD_POS = { first: 1, '1st': 1, second: 2, '2nd': 2, 'runner-up': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };

// The horse's runs before today, newest first (trials left out).
function runsBefore(runner, raceDate) {
  return (Array.isArray(runner.pastRaces) ? runner.pastRaces : [])
    .filter((x) => x && x.Date && (!x.Type || String(x.Type).toUpperCase() === 'RACE') && String(x.Date).slice(0, 10) < raceDate)
    .sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
}
const posOf = (x) => (Number(x.FinishPosition) > 0 ? Number(x.FinishPosition) : null);
const runText = (x) => `${posOf(x) ? ordinal(posOf(x)) : 'unplaced'} at ${x.Course || '?'} ${shortDate(x.Date)}`;
// "16:3-1-4" -> { starts, wins, places }
function record(text) {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/.exec(String(text || ''));
  return m ? { text: m[0].trim(), starts: Number(m[1]), wins: Number(m[2]), places: Number(m[3]) + Number(m[4]) } : null;
}

// A class as { scale, rank, label } (higher rank = better race), or null.
// GB / IRE: Class 1 is the top. AUS / NZ: Class 1 is the bottom, BM and the
// "0 - 58" bands go by the number, a maiden is below all of them. Group /
// Grade / Listed sit above everything. Other countries: Group / Listed only.
function classOf(text, country) {
  const t = String(text || '');
  let m = /\b(?:Group|Grade|G)\s*([123])\b/i.exec(t);
  if (m) return { scale: '*', rank: 1000 - Number(m[1]), label: `Group ${m[1]}` };
  if (/\bListed\b/i.test(t)) return { scale: '*', rank: 990, label: 'Listed' };
  const c = String(country || '').toUpperCase();
  if (['GB', 'IRE', 'UK'].includes(c)) {
    m = /\bClass\s*([1-7])\b/i.exec(t);
    return m ? { scale: 'GB', rank: 100 - Number(m[1]), label: `Class ${m[1]}` } : null;
  }
  if (['AUS', 'NZ'].includes(c)) {
    m = /\b(?:BM|Benchmark)\s*(\d{2,3})\b/i.exec(t) || /\b0\s*-\s*(\d{2,3})\b/.exec(t);
    if (m) return { scale: 'BM', rank: Number(m[1]), label: `BM${m[1]}` };
    m = /\bClass\s*([1-6])\b/i.exec(t);
    if (m) return { scale: 'C', rank: Number(m[1]), label: `Class ${m[1]}` };
    if (/\bMaiden\b/i.test(t)) return { scale: 'M', rank: 0, label: 'Maiden' };
  }
  return null;
}
// -1 / 0 / 1 for today vs that run, or null when the two can't be compared.
function compareClass(today, then) {
  if (!today || !then) return null;
  const same = today.scale === then.scale;
  const eitherTop = today.scale === '*' || then.scale === '*';
  const eitherMaiden = today.scale === 'M' || then.scale === 'M';
  if (!same && !eitherTop && !eitherMaiden) return null;
  return Math.sign(today.rank - then.rank);
}

// The rest of the clause after a match: "yet to win over hurdles" is about
// hurdles, not the horse's career.
function clauseAfter(text, end) {
  const rest = text.slice(end);
  const stop = rest.search(/[.;,!?]|\s(?:and|but|while|although)\s/);
  return stop === -1 ? rest : rest.slice(0, stop);
}
// Words just before a claim that turn it around: "lacks recent success",
// "needs to find a win", "despite a lack of".
const NEGATED = /\b(?:no|not|never|lacks?|lacking|without|yet to|needs?|needing|search(?:es|ing)? for|finds?|rediscover|regain|despite|hasn't|has not|absence of|missing|short of|far from)\b[^.;,]{0,25}$/i;
// The form figures ("252379x314", newest last) as positions, newest first:
// 0 = 10th or worse, letters (F, P, U...) = didn't finish; spells (x) dropped.
function figures(text) {
  return String(text || '').replace(/[^0-9A-Za-z]/g, '').replace(/x/gi, '').split('').reverse()
    .map((c) => (/\d/.test(c) ? (c === '0' ? 10 : Number(c)) : null));
}
const QUALIFIED = /\b(?:over|hurdles?|fences?|chases?|season|prep|preparation|campaign|track|course|venue|turf|dirt|synthetic|all-weather|beyond|since|stable|yard|trainer|level|grade|group|listed|class|distance|trip|this|here|abroad|country|overseas|surface)\b/i;

// Each rule: the phrases (one RegExp, case-insensitive) and a check that
// returns why the form says otherwise, or null when it agrees / can't tell.
const RULES = [
  {
    claim: 'last-start win',
    negatable: true,
    re: /\b(?:just won|won (?:last start|last time(?: out)?|(?:his|her|its) (?:last|latest) (?:start|outing|race|run))|last[- ]start (?:win|winner|victory|success)|(?:coming|fresh|comes?|straight) off (?:a|an|his|her|its) (?:[a-z-]+ ){0,2}(?:win|victory|success|triumph)|off the back of (?:a|an|his|her|its) (?:[a-z-]+ ){0,2}(?:win|victory|success)|(?:won|scored|saluted) (?:at|on|in) (?:his|her|its) (?:last|latest|most recent) (?:start|outing|run|race)|broke (?:his|her|its) maiden last (?:start|time))/gi,
    check(f, m) {
      const last = f.runs[0];
      if (!last || posOf(last) === 1) return null;
      // "Coming off / fresh off / off the back of a win" is fine with a win
      // in the last two runs within 60 days (28 Oct 2026, per Dinesh: Trinity
      // State "coming off a solid maiden win" -- won its maiden 21 Sep, 2nd
      // since). "Won last start" / "just won" still mean the last start.
      if (/\boff\b/i.test(m[0])) {
        const win = f.runs.slice(0, 2).find((x) => posOf(x) === 1);
        if (win && daysBetween(win.Date, f.raceDate) <= 60) return null;
      }
      return `last start ${runText(last)}`;
    },
  },
  {
    claim: 'recent win',
    negatable: true,
    re: /\b(?:recent (?:win|victory|success|winner)|recently (?:won|scored|saluted|broke (?:his|her|its) maiden))\b/gi,
    check(f) {
      if (!f.runs.length) return null;
      const i = f.runs.findIndex((x) => posOf(x) === 1);
      if (i === 0 || i === 1) return null;
      // The form lines can miss runs the figures have (Sujeed, "x314": a win the run before last).
      const fig = f.figures.indexOf(1);
      if (f.figures.length > f.runs.length && (fig === 0 || fig === 1)) return null;
      if (i > 1 && daysBetween(f.runs[i].Date, f.raceDate) <= 45) return null;
      return i === -1
        ? `no win in the ${f.runs.length} runs shown; last start ${runText(f.runs[0])}`
        : `last win ${shortDate(f.runs[i].Date)} at ${f.runs[i].Course} (${i} runs ago); last start ${runText(f.runs[0])}`;
    },
  },
  {
    claim: 'last-start placing',
    re: /\b(?:(close|narrow|tight|short-head|nose|neck|head)\s+)?(second|2nd|third|3rd|fourth|4th|fifth|5th|runner-up)(?:\s+place)?(?:\s+at\s+[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,2})?\s+(?:last (?:start|time(?: out)?|outing|run)|at (?:his|her|its) (?:last|latest) (?:start|outing|run)|(?:on|in) (?:his|her|its) (?:last|latest|most recent) (?:start|outing|run|race))\b|\blast[- ]start (second|2nd|third|3rd|runner-up)\b/gi,
    check(f, m) {
      const last = f.runs[0];
      if (!last) return null;
      const said = WORD_POS[String(m[2] || m[3] || '').toLowerCase()];
      if (said && posOf(last) !== said) return `last start ${runText(last)}`;
      const lengths = parseFloat(last.LengthsBehind);
      if (m[1] && Number.isFinite(lengths) && lengths > 2.5) return `last start ${runText(last)}, beaten ${lengths}L — not close`;
      return null;
    },
  },
  {
    claim: 'result at a course',
    // Course names are capitalised: "solid 3rd at Chepstow", "won at Huntingdon".
    re: /\b(win|won|winning|victory|success|second|2nd|third|3rd|fourth|4th|runner-up)\s+at\s+([A-Z][A-Za-z'’]+(?:[ -][A-Z][A-Za-z'’]+){0,2})/g,
    check(f, m) {
      const course = m[2].toLowerCase();
      if (/^(?:group|grade|listed|class|benchmark|odds|the|this|his|her|its|long|short|big|good|start|last|each|any)\b/.test(course)) return null;
      const said = /^(?:win|won|winning|victory|success)$/i.test(m[1]) ? 1 : WORD_POS[m[1].toLowerCase()];
      const there = f.runs.slice(0, 6).filter((x) => {
        const c = String(x.Course || '').toLowerCase();
        return c && (c.startsWith(course) || course.startsWith(c));
      });
      if (!there.length || there.some((x) => posOf(x) === said)) return null;
      return `at ${there[0].Course}: ${there.map((x) => `${posOf(x) ? ordinal(posOf(x)) : 'unplaced'} ${shortDate(x.Date)}`).join(', ')}`;
    },
  },
  {
    claim: 'step up in class',
    re: /\b(?:steps? up in (?:class|grade)|stepping up in (?:class|grade)|(?:rises?|rising|moves? up|up) in (?:class|grade)|class rise|rise in (?:class|grade)|(?:higher|tougher|harder|stronger) (?:class|grade)|class hike)\b/gi,
    check(f) { return classCheck(f, 'up'); },
  },
  {
    claim: 'drop in class',
    re: /\b(?:drops? (?:back )?(?:down )?in (?:class|grade)|dropping (?:back )?(?:down )?in (?:class|grade)|(?:comes?|coming|steps?|back) down in (?:class|grade)|class drop|drop in (?:class|grade)|class relief|(?:easier|lower|weaker) (?:class|grade|company))\b/gi,
    check(f) { return classCheck(f, 'down'); },
  },
  {
    claim: 'first-up / after a break',
    // "his second start after a significant break" is second-up; "showed
    // promise in her last race after a break" (Vaal R4 28 Oct 2026) is about
    // that earlier race, not today's.
    skipBefore: /\bsecond\b[^.;]{0,30}$|\b(?:last|previous|latest|prior|most recent)\s+(?:race|start|run|outing|time|effort|appearance)\b[^.;]{0,25}$|\b(?:showed|shown|ran|was|finished|won|placed|raced|performed|returned|came|resumed)\b[^.;]{0,40}$/i,
    re: /\b(?:first[- ]up|resum(?:es|ing)|returns? (?:from|after) (?:a |an )?(?:[a-z-]+ ){0,2}(?:break|spell|layoff|lay-off|absence|rest)|after (?:a |an )?(?:[a-z-]+ ){0,2}(?:break|spell|layoff|lay-off|absence)|first (?:run|start|outing) (?:back|since)|fresh(?:ened)? up)\b/gi,
    check(f) {
      const last = f.runs[0];
      if (!last) return null;
      const gap = daysBetween(last.Date, f.raceDate);
      return gap < 42 ? `last run ${gap} days ago (${runText(last)})` : null;
    },
  },
  {
    claim: 'maiden / yet to win',
    re: /\b(?:(?:is|remains|still|as) a maiden|maiden (?:galloper|horse|runner|colt|filly|gelding|mare)|yet to (?:win|break (?:his|her|its) maiden|salute|score|taste victory)|still searching for (?:a|his|her|its) (?:first|maiden) (?:win|victory))/gi,
    check(f, m, text) {
      if (QUALIFIED.test(clauseAfter(text, m.index + m[0].length))) return null;
      const career = f.career;
      if (career && career.wins > 0) return `career ${career.text} (${career.wins} win${career.wins === 1 ? '' : 's'})`;
      const won = f.runs.find((x) => posOf(x) === 1);
      return won ? `won at ${won.Course} ${shortDate(won.Date)}` : null;
    },
  },
  {
    claim: 'debut',
    re: /\b(?:makes? (?:his|her|its) (?:racecourse |career )?debut|debutant|first[- ]starter|on debut today)\b/gi,
    check(f, m, text) {
      if (/\b(?:for|with|over|in|at|under)\b/i.test(clauseAfter(text, m.index + m[0].length).slice(0, 12))) return null;
      if (f.career && f.career.starts > 0) return `career ${f.career.text}`;
      return f.runs.length ? `${f.runs.length} runs in the form, last ${runText(f.runs[0])}` : null;
    },
  },
  {
    claim: 'record at this track',
    negatable: true,
    re: /\b(?:(?:course|track)(?: and distance)? (?:winner|specialist)|c ?& ?d winner|(?:has |previously |already )?won (?:here|at this (?:track|course|venue)|at the (?:track|course|venue))|winner (?:here|at this (?:track|course|venue))|(?:strong|good|solid|excellent|impressive|great|fine|sound|proven|decent) (?:track |course )?(?:record|form) (?:(?:at|on|here at) (?:this|the) (?:track|course|venue)|here))\b/gi,
    check(f, m) {
      const winner = /winner|won|specialist/i.test(m[0]);
      const cd = /distance|c ?& ?d/i.test(m[0]);
      const rec = cd ? f.trackDistance : f.track;
      if (!rec) return null;
      const what = cd ? 'track + distance' : 'track';
      if (winner && rec.wins === 0) return `${what} record ${rec.text} — no win`;
      if (!winner && rec.wins + rec.places === 0) return `${what} record ${rec.text}`;
      return null;
    },
  },
  {
    claim: 'record at the distance',
    negatable: true,
    re: /\b(?:distance winner|won (?:over|at) (?:this|the|today's) (?:trip|distance)|(?:proven|strong|good|solid|excellent) (?:record )?(?:over|at) (?:this|the|today's) (?:trip|distance))\b/gi,
    check(f, m) {
      const rec = f.distance;
      if (!rec) return null;
      if (/winner|won|proven/i.test(m[0]) ? rec.wins === 0 : rec.wins + rec.places === 0) return `distance record ${rec.text}`;
      return null;
    },
  },
];

function classCheck(f, way) {
  const last = f.runs[0];
  if (!last) return null;
  const today = classOf(f.raceClass, f.country);
  const then = classOf(last.EventClass, f.country);
  const cmp = compareClass(today, then);
  if (cmp == null) return null;
  if (way === 'up' && cmp > 0) return null;
  if (way === 'down' && cmp < 0) return null;
  const what = cmp === 0 ? 'same class' : cmp > 0 ? 'a step up' : 'a class drop';
  return `last start ${then.label} (${runText(last)}), today ${today.label} — ${what}`;
}

// The claims in `text` about `runner` that its form says are wrong:
// [{ claim, quote, why }]. race = { rDate, rClass, rCountry }.
function checkClaims(text, runner, race) {
  const out = [];
  if (!text || !runner) return out;
  const stats = runner.performanceStatistics || {};
  const f = {
    runs: runsBefore(runner, String(race.rDate || '').slice(0, 10)),
    raceDate: String(race.rDate || '').slice(0, 10),
    raceClass: race.rClass || '',
    country: race.rCountry,
    career: record(stats.career),
    track: record(stats.track),
    distance: record(stats.distance),
    trackDistance: record(stats.trackDistanceCombo),
    figures: figures(runner.formFigures),
  };
  // One finding per phrase: "comes off a recent win at Rockhampton" is the
  // last-start rule's, not also "recent win" and "win at Rockhampton".
  const spans = [];
  for (const rule of RULES) {
    for (const m of String(text).matchAll(rule.re)) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (spans.some(([a, b]) => start < b && end > a)) continue;
      spans.push([start, end]);
      const before = String(text).slice(Math.max(0, start - 40), start);
      if ((rule.negatable && NEGATED.test(before)) || (rule.skipBefore && rule.skipBefore.test(before))) continue;
      const why = rule.check(f, m, String(text));
      // recent: the last three runs, for the ticket (28 Oct 2026).
      if (why && !out.some((x) => x.why === why)) out.push({ claim: rule.claim, quote: m[0].trim(), why, recent: f.runs.slice(0, 3).map(runText).join(' · ') });
    }
  }
  return out;
}

module.exports = { checkClaims, classOf, compareClass };
