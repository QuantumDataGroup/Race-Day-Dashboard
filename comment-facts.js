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
// withTrials: barrier trials too (see TRIALS_COUNT).
function runsBefore(runner, raceDate, withTrials) {
  return (Array.isArray(runner.pastRaces) ? runner.pastRaces : [])
    .filter((x) => x && x.Date && (withTrials || !isTrial(x)) && String(x.Date).slice(0, 10) < raceDate)
    .sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
}
const isTrial = (x) => Boolean(x.Type) && String(x.Type).toUpperCase() !== 'RACE';
const posOf = (x) => (Number(x.FinishPosition) > 0 ? Number(x.FinishPosition) : null);
const runText = (x) => `${posOf(x) ? ordinal(posOf(x)) : 'unplaced'}${isTrial(x) ? ' (trial)' : ''} at ${x.Course || '?'} ${shortDate(x.Date)}`;
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
const NEGATED = /\b(?:no|not|never|lacks?|lacking|without|yet to|needs?|needing|search(?:es|ing)? for|finds?|rediscover|regain|despite|hasn't|has not|absence of|missing|short of|far from|little|lack of|limited|scant|scarce)\b[^.;,]{0,25}$/i;
// Someone else's: "the trainer's recent success" isn't the horse's (13 Nov 2026).
const OTHERS = /\b(?:trainer|jockey|rider|stable|yard|connections|sire|dam|owner|family|half-(?:sister|brother)|sibling)(?:'s|’s|s'|s’)?\s+(?:[a-z-]+\s+){0,2}$/i;
// Just before a win: it did not win ("narrowly missed victory at Milan",
// "yet to record a win at Moe").
// A word that starts another clause; a claim doesn't run across one.
const CLAUSE_BREAK = /;|\b(?:but|however|although|though|while|whereas|then)\b/i;
// The words before a phrase without horse names: a name is in capitals, and
// "NO JOKE JOE (15) won at Turfway Park" isn't "no ... won" (13 Nov 2026).
const wordsOnly = (s) => s.replace(/\b[A-Z][A-Z'’-]+\b/g, ' ');
// Just before a win: it's wanted or possible, not done ("needs a win at
// Kalgoorlie", "could add a win at Moe").
const WANTS = /\b(?:needs?|needing|search(?:es|ing)? for|seek(?:s|ing)?|chasing|looking for|aiming for|hoping for|hunting for|bid for|chance (?:of|for)|capable of|good enough for|in line for|regain|rediscover|could|can|should|would|may|might|will)\b[^.;,]{0,25}$/i;
const DIDNT = /\b(?:no|not|never|without|yet to|hasn't|has not|didn't|did not|is still chasing|still chasing)\b[^.;,]{0,25}$/i;
const MISSED = /\b(?:missed(?: out on)?|denied|failed to (?:land|record|secure|register|claim|score|notch|take|grab)|unable to (?:land|record|secure|claim|take)|could(?:n't| not) (?:land|record|secure|claim|take))\b[^.;,]{0,20}$/i;
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
    check(f, m, text) {
      const last = f.runs[0];
      // No finishing position (not known) -- nothing to go on.
      if (!last || !posOf(last) || posOf(last) === 1) return null;
      // "coming off a maiden win at Jebel Ali" means its last run THERE was a
      // win (31 Oct 2026, per Dinesh: Yasup, last Jebel Ali run 1st).
      const at = /^\s+(?:over \d+\s?m\s+)?at\s+([A-Z][A-Za-z'’]+(?:[ -][A-Z][A-Za-z'’]+){0,2})/.exec(text.slice(m.index + m[0].length));
      if (/\boff\b/i.test(m[0]) && at) {
        const course = at[1].toLowerCase();
        const there = f.runs.find((x) => {
          const c = String(x.Course || '').toLowerCase();
          return c && (c.startsWith(course) || course.startsWith(c));
        });
        if (there && posOf(there) === 1) return null;
      }
      // "Coming off / fresh off / off the back of a win" is fine with a win
      // in the last three runs (28 Oct 2026, per Dinesh: Trinity State
      // "coming off a solid maiden win" -- won its maiden 21 Sep, 2nd since;
      // 31 Oct: Yasup, maiden win then two poor runs the comment mentions).
      // "Won last start" / "just won" still mean the last start.
      if (/\boff\b/i.test(m[0]) && f.runs.slice(0, 3).some((x) => posOf(x) === 1)) return null;
      return `last start ${runText(last)}`;
    },
  },
  {
    claim: 'recent win',
    negatable: true,
    re: /\b(?:recent (?:win|victory|success|winner)|recently (?:won|scored|saluted|broke (?:his|her|its) maiden))\b/gi,
    check(f, m, text = '') {
      if (!f.runs.length) return null;
      // "a recent win on polytrack" is its latest on that surface (13 Nov 2026).
      if (/^\s*(?:on|over) (?:the )?(?:poly(?:track)?|tapeta|all[- ]weather|synthetic|dirt|turf|grass|sand|hurdles|fences)\b/i.test(clauseAfter(text, m.index + m[0].length))) return null;
      const i = f.runs.findIndex((x) => posOf(x) === 1);
      if (i === 0 || i === 1) return null;
      // The form lines can miss runs the figures have (Sujeed, "x314": a win the run before last).
      const fig = f.figures.indexOf(1);
      if (f.figures.length > f.runs.length && (fig === 0 || fig === 1)) return null;
      // Recent enough: within 60 days, or two runs back within 120 days
      // (28 Oct 2026, review: "has a recent win ... but has struggled after
      // that", 56 days and 3 runs back, is fair).
      if (i > 1 && daysBetween(f.runs[i].Date, f.raceDate) <= 60) return null;
      if (i === 2 && daysBetween(f.runs[i].Date, f.raceDate) <= 120) return null;
      return i === -1
        ? `no win in the ${f.runs.length} runs shown; last start ${runText(f.runs[0])}`
        : `last win ${shortDate(f.runs[i].Date)} at ${f.runs[i].Course} (${i} runs ago); last start ${runText(f.runs[0])}`;
    },
  },
  {
    claim: 'last-start placing',
    re: /\b(?:(close|narrow|tight|short-head|nose|neck|head)\s+)?(second|2nd|third|3rd|fourth|4th|fifth|5th|runner-up)(?:\s+place)?(?:\s+at\s+[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,2})?\s+(?:last (?:start|time(?: out)?|outing|run)|at (?:his|her|its) (?:last|latest) (?:start|outing|run)|(?:on|in) (?:his|her|its) (?:last|latest|most recent) (?:start|outing|run|race))\b|\blast[- ]start (second|2nd|third|3rd|runner-up)\b|\blast (?:start|time(?: out)?|run|outing),? (?:to (?:claim|finish|run|take)|finishing|(?:when )?(?:she|he|it) (?:finished|ran|was|ran on for)) (?:a |an )?(?:[a-z-]+ ){0,2}(second|2nd|third|3rd|fourth|4th|fifth|5th|runner-up)\b/gi,
    check(f, m) {
      const last = f.runs[0];
      if (!last || !posOf(last)) return null;
      // "at <course>" is capitalised words only -- the rule ignores case, so
      // "3rd at Kalgoorlie and struggled last time" took "and struggled" as
      // part of the course (13 Nov 2026).
      const at = /\bat\s+(?!(?:his|her|its|the)\b)(.+?)\s+(?:last|at|on|in)\b/i.exec(m[0]);
      if (at && at[1].split(/\s+/).some((w) => !/^[A-Z]/.test(w))) return null;
      // m[4]: the other word order (29 Oct 2026, Tuscan Rose: "Finished
      // strongly last start to claim second").
      const said = WORD_POS[String(m[2] || m[3] || m[4] || '').toLowerCase()];
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
    check(f, m, text = '') {
      const course = m[2].toLowerCase();
      if (/^(?:group|grade|listed|class|benchmark|odds|the|this|his|her|its|long|short|big|good|start|last|each|any)\b/.test(course)) return null;
      const isWin = /^(?:win|won|winning|victory|success)$/i.test(m[1]);
      const said = isWin ? 1 : WORD_POS[m[1].toLowerCase()];
      const there = f.runs.slice(0, 6).filter((x) => {
        const c = String(x.Course || '').toLowerCase();
        return c && (c.startsWith(course) || course.startsWith(c));
      });
      if (!there.length) return null;
      // "narrowly missed victory at MILAN" says it did NOT win there (12 Nov
      // 2026, per Dinesh: Orsa Suprema, 2nd at Milan) -- wrong only when its
      // last run there was a win. A negated placing ("missed a place at") is
      // left alone.
      // Only words that say it didn't win -- not NEGATED's "despite" / "needs"
      // / "regain": "Despite a previous win at Kalgoorlie, recent form is
      // concerning" says it DID win there (13 Nov 2026, per Dinesh: Moriah).
      const before = wordsOnly(String(text).slice(Math.max(0, m.index - 40), m.index));
      // "needs a win at Kalgoorlie", "could take a win at Moe": wanted, not done.
      if (isWin && WANTS.test(before)) return null;
      if (MISSED.test(before) || DIDNT.test(before)) {
        if (!isWin || posOf(there[0]) !== 1) return null;
        return `at ${there[0].Course}: won ${shortDate(there[0].Date)}`;
      }
      if (there.some((x) => posOf(x) === said)) return null;
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
    // "improvement after a layoff" is the run after the return (review 28 Oct 2026).
    skipBefore: /\bsecond\b[^.;]{0,30}$|\b(?:last|previous|latest|prior|most recent)\s+(?:race|start|run|outing|time|effort|appearance)\b[^.;]{0,25}$|\b(?:showed|shown|ran|was|finished|won|placed|raced|performed|returned|came|resumed|improv\w*|benefit\w*|fitter|sharper|progress\w*)\b[^.;]{0,40}$/i,
    re: /\b(?:first[- ]up|resum(?:es|ing)|returns? (?:from|after) (?:a |an )?(?:[a-z-]+ ){0,2}(?:break|spell|layoff|lay-off|absence|rest)|after (?:a |an )?(?:[a-z-]+ ){0,2}(?:break|spell|layoff|lay-off|absence)|first (?:run|start|outing) (?:back|since)|fresh(?:ened)? up)\b/gi,
    check(f, m, text) {
      // "a short break" is right for a few weeks; "absence from the winner's
      // circle" is no break at all (review 28 Oct 2026).
      if (/\b(?:short|brief|little|quick)\b/i.test(m[0])) return null;
      const after = text.slice(m.index + m[0].length);
      if (/^\s*from the winner/i.test(after)) return null;
      // "her first-up run raises doubts" is a run already run (13 Nov 2026).
      if (/^first[- ]up$/i.test(m[0]) && /^\s*(?:run|effort|start|outing|performance|win|victory)\b/i.test(after)) return null;
      // A sentence that also tells a run's result ("finished 2nd at Bursa,
      // showing fitness after a layoff") puts the break before that run, not
      // today (13 Nov 2026: Barlin Ağa, Yenibey, Surertay, Niğbolu).
      if ((sentenceAt(text, m.index, m.index + m[0].length).text.match(ANY_PLACE) || []).length) return null;
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
    // "no prior form" / "unraced" say the same (28 Oct 2026; "no recent form" is poor form, not this).
    re: /\b(?:makes? (?:his|her|its) (?:racecourse |career )?debut|debutant|first[- ]starter|on debut today|unraced|yet to (?:race|run|start|face the starter)|never (?:raced|run)|no (?:prior|previous|past|race) (?:form|runs?|starts?|experience|race experience))\b/gi,
    check(f, m, text) {
      // "debut for a new stable / over fences / in Britain" is no first start;
      // "a debutant with no prior form" is (Mirham, Abu Dhabi R7 28 Oct 2026).
      if (/^\s*(?:for|over|in|at|under|with (?!no\b|little\b|limited\b))\b/i.test(clauseAfter(text, m.index + m[0].length))) return null;
      // "first starter here … finishing last in his latest outing" is this
      // track only; "A debutant here adds uncertainty" is today's debut (13 Nov 2026).
      if (/^\s*here\b/i.test(clauseAfter(text, m.index + m[0].length))) {
        const s = sentenceAt(text, m.index, m.index + m[0].length).text;
        if ((s.match(ANY_PLACE) || []).length || LAST_RUN_REF.test(s) || /\b(?:latest|previous|prior|last) (?:outing|start|run|race|effort)s?\b/i.test(s)) return null;
      }
      // "no prior form to suggest competitiveness" is poor form, not no runs;
      // "at this track, where he has yet to run" is this track only (13 Nov 2026).
      if (/form$/i.test(m[0]) && /^\s*(?:to|that|which|of note|worth|suggest\w*)\b/i.test(text.slice(m.index + m[0].length))) return null;
      if (/\b(?:where|here|this (?:track|course|venue|distance|trip|surface))\b[^.;]{0,30}$/i.test(text.slice(Math.max(0, m.index - 40), m.index))) return null;
      // The career figures say no start: form lines then are another horse's.
      if (f.career) return f.career.starts > 0 ? `career ${f.career.text}` : null;
      return f.runs.length ? `${f.runs.length} runs in the form, last ${runText(f.runs[0])}` : null;
    },
  },
  {
    claim: 'record at this track',
    negatable: true,
    // No "winner here": "an unlikely winner here" is about today (review 28 Oct 2026).
    re: /\b(?:(?:course|track)(?: and distance)? (?:winner|specialist)|c ?& ?d winner|(?:has |previously |already )?won (?:here|at this (?:track|course|venue)|at the (?:track|course|venue))|winner at this (?:track|course|venue)|(?:strong|good|solid|excellent|impressive|great|fine|sound|proven|decent) (?:track |course )?(?:record|form) (?:(?:at|on|here at) (?:this|the) (?:track|course|venue)|here))\b/gi,
    check(f, m) {
      // A "specialist" with placings but no win is fair (review 28 Oct 2026).
      const winner = /winner|won/i.test(m[0]);
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
      // "Proven" with placings is fair; a win the form shows at about today's
      // distance (50 m either way) counts too (review 28 Oct 2026).
      const won = /winner|won/i.test(m[0]);
      if (won && f.raceDistance && f.allRuns.some((x) => posOf(x) === 1 && Math.abs(parseFloat(x.Distance) - f.raceDistance) <= 50)) return null;
      if (won ? rec.wins === 0 : rec.wins + rec.places === 0) return `distance record ${rec.text}`;
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
    allRuns: runsBefore(runner, String(race.rDate || '').slice(0, 10), true),
    raceDate: String(race.rDate || '').slice(0, 10),
    raceClass: race.rClass || '',
    raceDistance: parseFloat(race.rDistance) || null,
    country: race.rCountry,
    career: record(stats.career),
    track: record(stats.track),
    distance: record(stats.distance),
    trackDistance: record(stats.trackDistanceCombo),
    figures: figures(runner.formFigures),
  };
  const recent = f.allRuns.slice(0, 3).map(runText).join(' · ');
  const lastPositions = [f.runs[0], f.allRuns[0]].filter(Boolean).map(posOf);
  // One finding per phrase: "comes off a recent win at Rockhampton" is the
  // last-start rule's, not also "recent win" and "win at Rockhampton".
  const spans = [];
  for (const rule of RULES) {
    for (const m of String(text).matchAll(rule.re)) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (spans.some(([a, b]) => start < b && end > a)) continue;
      spans.push([start, end]);
      // All capitals is a horse's name ("RGS DEBUTANT"), not a claim (review 28 Oct 2026).
      if (!/[a-z]/.test(m[0])) continue;
      // One claim is one clause: "managed a 3rd at Kalgoorlie but struggled
      // last time" is a 3rd at Kalgoorlie, then a poor last run -- not "3rd
      // last time" (13 Nov 2026, per Dinesh: Is This Thing On).
      if (CLAUSE_BREAK.test(m[0])) continue;
      const sentence = sentenceAt(String(text), start, end);
      const before = wordsOnly(String(text).slice(Math.max(sentence.from, start - 40), start));
      if ((rule.negatable && (NEGATED.test(before) || MISSED.test(before))) || (rule.skipBefore && rule.skipBefore.test(before))) continue;
      if (OTHERS.test(before)) continue;
      let why = rule.check(f, m, String(text));
      // A win / placing the comment can mean from a barrier trial is fine
      // (28 Oct 2026, per Dinesh: Born To Fly "comes off an impressive win at
      // Randwick" -- a trial win the form shows like a race).
      if (why && TRIALS_COUNT.includes(rule.claim) && !rule.check({ ...f, runs: f.allRuns, figures: [] }, m, String(text))) why = null;
      // The sentence's own word on the last run goes over one phrase of it:
      // "narrowly missed victory at MILAN over 1400 last start, finishing
      // 2nd" with a 2nd last start is right. A course result only when the
      // last run was at that course.
      const stated = statedLastPlace(clauseAt(sentence, start), f.runs[0]);
      if (why && stated && lastPositions.includes(stated.pos) && ABOUT_LAST_RUN.includes(rule.claim)
        && (rule.claim !== 'result at a course' || sameCourseAs(f.runs[0], m[2]))) why = null;
      // recent: the last three runs (trials marked), for the ticket (28 Oct 2026).
      if (why && !out.some((x) => x.why === why)) out.push({ claim: rule.claim, quote: m[0].trim(), why, recent, sentence: sentence.text });
    }
  }
  // A sentence that says where the last run finished ("…last start,
  // finishing 2nd") when the form says otherwise.
  // The form figures can have a run the form lines miss (see 'recent win').
  const last = f.runs[0];
  if (last && posOf(last)) {
    for (const s of sentencesOf(String(text))) {
      for (const c of clausesOf(s.raw)) {
        const stated = statedLastPlace(c.text, f.runs[0]);
        if (!stated || lastPositions.includes(stated.pos) || f.figures[0] === stated.pos) continue;
        const why = `last start ${runText(last)}`;
        if (!out.some((x) => x.why === why)) out.push({ claim: 'last-start placing', quote: stated.quote, why, recent, sentence: s.text });
      }
    }
  }
  return out;
}

// --- The whole sentence (12 Nov 2026, per Dinesh: "comment full sentence
// edukkanu, padila eduth ada issue panna kudadu, full sentence-a read
// pannanum") -------------------------------------------------------------
// Every finding is read with the sentence it's in, and carries it
// (`sentence`) so the warning shows the whole thing. A sentence ends at ". "
// "! " "? " -- "1.5" and "2.5L" don't end one.
function sentencesOf(text) {
  const out = [];
  let from = 0;
  const add = (to) => {
    const raw = text.slice(from, to);
    if (raw.trim()) out.push({ from, to, raw, text: raw.trim() });
  };
  for (const x of text.matchAll(/[.!?](?=\s|$)/g)) {
    add(x.index + 1);
    from = x.index + 1;
  }
  add(text.length);
  return out;
}
function sentenceAt(text, start, end) {
  return sentencesOf(text).find((s) => s.from <= start && end <= s.to) || { from: 0, to: text.length, raw: text, text: text.trim() };
}
// A sentence's clauses: a "but" / "however" / "while" / "then" / ";" starts
// another thought -- "placed 2nd at Vichy, but struggled last start at Lyon"
// and "finished 7th last start, then ran a solid 2nd at Albany" are two. A
// comma doesn't: "missed victory at MILAN last start, finishing 2nd" is one.
function clausesOf(raw) {
  const out = [];
  let from = 0;
  for (const x of raw.matchAll(/;|\b(?:but|however|although|though|while|whereas|yet|then|before|after)\b/gi)) {
    out.push({ from, text: raw.slice(from, x.index) });
    from = x.index + x[0].length;
  }
  out.push({ from, text: raw.slice(from) });
  return out;
}
function clauseAt(sentence, start) {
  const at = start - sentence.from;
  const c = clausesOf(sentence.raw).filter((x) => x.from <= at).pop();
  return c ? c.text : sentence.text;
}
// Where a clause says the last run finished: "…last start, finishing 2nd",
// "ran a game third last time". Not when it also talks about another run
// ("two starts back", "prior") -- then the place could be that run's.
const LAST_RUN_REF = /\b(?:last (?:start|time(?: out)?|outing|run)|(?:his|her|its) (?:last|latest|most recent) (?:start|outing|run|race))\b/i;
const OTHER_RUN_REF = /\b(?:(?:two|three|four|five|2|3|4|5) (?:starts?|runs?|outings?|races?) (?:ago|back|before)|previous(?:ly)?|prior|before that|earlier (?:this|in)|first[- ]up|second[- ]up|third[- ]up|on debut)\b/i;
const STATED_PLACE = /\b(?:finish(?:ed|ing)|ran|running|came(?: home| in)?|coming(?: home| in)?|placed|placing|ended up|ending up)\s+(?:[a-z-]+\s+){0,2}?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|runner-up)\b/i;
// Two places in one clause ("finished 7th … ran 2nd"): which is the last
// run's isn't clear, so neither is used.
const ANY_PLACE = /\b(?:finish(?:ed|ing)|ran|running|came(?: home| in)?|coming(?: home| in)?|placed|placing|ended up|ending up)\s+(?:[a-z-]+\s+){0,2}?(?:\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|runner-up)\b/gi;
// A place named at another course than the last run's is that run's: "ran
// 3rd at Kalgoorlie and struggled last time at Northam" (13 Nov 2026).
function statedLastPlace(sentence, lastRun) {
  if (!LAST_RUN_REF.test(sentence) || OTHER_RUN_REF.test(sentence)) return null;
  if ((sentence.match(ANY_PLACE) || []).length > 1) return null;
  const m = STATED_PLACE.exec(sentence);
  if (!m) return null;
  const at = /^\s+(?:[^,.;]{0,30}?\s)?at\s+([A-Z][A-Za-z'’-]+(?:[ -][A-Z][A-Za-z'’-]+){0,2})/.exec(sentence.slice(m.index + m[0].length));
  if (at && lastRun && !sameCourseAs(lastRun, at[1])) return null;
  return { pos: WORD_POS[m[1].toLowerCase()], quote: m[0] };
}
// The claims a sentence's own place can settle -- not 'last-start placing',
// whose "close" also needs the margin ("close 2nd last time out", beaten 9L).
const ABOUT_LAST_RUN = ['last-start win', 'result at a course'];
function sameCourseAs(run, course) {
  const c = String((run && run.Course) || '').toLowerCase();
  const said = String(course || '').toLowerCase();
  return Boolean(c && said && (c.startsWith(said) || said.startsWith(c)));
}

const TRIALS_COUNT = ['last-start win', 'recent win', 'last-start placing', 'result at a course'];

module.exports = { checkClaims, classOf, compareClass };
