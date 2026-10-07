// Comments V2 (7 Oct 2026, per Dinesh: "Comment generat aguradukku engalukku
// edu oru program seiya mudiuma ... Free ha da wenu"). Race overview, runner
// comments and 3 spotlights written by code from the racecards data -- no AI
// model, no API key, no cost. Facts only: every sentence comes from a field
// in the racecard (last runs, margins, track/distance records, barrier,
// weight, odds, past clashes between runners). AU / UK / US styles differ
// only in units and terms.

const STYLES = ['AU', 'UK', 'US'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// --- Small helpers ------------------------------------------------------------
const num = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
};
const daysBetween = (a, b) => {
  const da = Date.parse(String(a || '').slice(0, 10));
  const db = Date.parse(String(b || '').slice(0, 10));
  return Number.isFinite(da) && Number.isFinite(db) ? Math.round((db - da) / 86400000) : null;
};
// Deterministic "random" pick so the same race always reads the same way.
const pick = (list, seed) => list[Math.abs(seed) % list.length];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

// --- Units per style ------------------------------------------------------------
function distance(metres, style) {
  const m = num(metres);
  if (!m) return '';
  if (style === 'AU') return `${Math.round(m)}m`;
  const halfFurlongs = Math.round((m / 201.168) * 2);
  const miles = Math.floor(halfFurlongs / 16);
  const furlongs = (halfFurlongs % 16) / 2;
  const f = furlongs ? `${Math.floor(furlongs)}${furlongs % 1 ? '½' : ''}` : '';
  if (style === 'UK') return `${miles ? `${miles}m` : ''}${f ? `${f}f` : ''}` || `${Math.round(m)}m`;
  if (!miles) return `${f} furlongs`;
  return `${miles} mile${miles > 1 ? 's' : ''}${f ? ` ${f}f` : ''}`;
}
function distanceGap(metres, style) {
  const m = Math.abs(num(metres) || 0);
  if (style === 'AU') return `${Math.round(m)}m`;
  const f = Math.round((m / 201.168) * 2) / 2;
  return f ? `${f % 1 ? `${Math.floor(f) || ''}½` : f} furlong${f > 1 ? 's' : ''}` : 'a little';
}
function weight(kg, style) {
  const k = num(kg);
  if (!k) return '';
  if (style === 'AU') return `${k}kg`;
  const lb = Math.round(k * 2.2046);
  return style === 'UK' ? `${Math.floor(lb / 14)}st ${lb % 14}lb` : `${lb} lb`;
}
const TERMS = {
  AU: { barrier: 'barrier', track: 'track', firstUp: 'first-up', spell: 'a spell' },
  UK: { barrier: 'stall', track: 'course', firstUp: 'on its return', spell: 'a break' },
  US: { barrier: 'post', track: 'track', firstUp: 'off the layoff', spell: 'a layoff' },
};

// --- Reading the racecard -------------------------------------------------------
// "2:0-1-0" -> { starts, wins, seconds, thirds }
function record(s) {
  const m = /^(\d+):(\d+)-(\d+)-(\d+)/.exec(String(s || ''));
  return m ? { starts: +m[1], wins: +m[2], seconds: +m[3], thirds: +m[4] } : null;
}
function recordText(rec) {
  if (!rec || !rec.starts) return '';
  const places = rec.seconds + rec.thirds;
  if (rec.wins === rec.starts) return rec.starts === 1 ? 'won its only start' : `unbeaten in ${rec.starts} starts`;
  if (rec.wins) return `${rec.wins} win${rec.wins > 1 ? 's' : ''}${places ? ` and ${places} placing${places > 1 ? 's' : ''}` : ''} from ${rec.starts}`;
  if (rec.starts === 1) return places ? 'placed in its only start' : '';
  if (places === rec.starts) return `placed in all ${rec.starts} starts`;
  if (places) return `${places} placing${places > 1 ? 's' : ''} from ${rec.starts} without a win`;
  return rec.starts >= 3 ? `unplaced in ${rec.starts} starts` : '';
}

function pastRuns(runner) {
  return (Array.isArray(runner.FormLines) ? runner.FormLines : [])
    .filter((f) => f && f.Type !== 'TRIAL' && f.FinishPosition != null && f.Date)
    .sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
}

// Runner strength for ordering: market first, then a recent-form score.
function strength(r) {
  if (r.odds) return 1000 - r.odds * 10;
  const runs = r.runs.slice(0, 4);
  if (!runs.length) return 0;
  const score = runs.reduce((s, f, i) => {
    const pos = num(f.FinishPosition) || 10;
    const starters = num(f.Starters) || 10;
    return s + (1 - (pos - 1) / Math.max(starters, 2)) * (4 - i);
  }, 0);
  const win = record(r.stats.career);
  return score * 10 + (win && win.starts ? (win.wins / win.starts) * 20 : 0);
}

function buildRunners(card, scratchedTabs) {
  return (card.Runners || [])
    .filter((r) => !r.IsScratched && !scratchedTabs.has(num(r.Number)))
    .map((r) => ({
      tab: num(r.Number),
      name: String(r.RunnerName || '').toUpperCase(),
      barrier: num(r.BarrierPosition || r.Draw),
      kg: num(r.CarryingWeight && r.CarryingWeight.WeightKg),
      claim: num(r.ApprenticeClaim),
      jockey: r.Jockey || '',
      trainer: r.Trainer || '',
      headgear: r.Headgear || '',
      odds: num(r.CurrentOdds),
      stats: r.PerformanceStatistics || {},
      runs: pastRuns(r),
    }))
    .filter((r) => r.tab != null && r.name);
}

// Runners that met before: same date + course + race number.
function clashes(runners) {
  const out = [];
  for (let i = 0; i < runners.length; i++) {
    for (let j = i + 1; j < runners.length; j++) {
      for (const a of runners[i].runs.slice(0, 6)) {
        const b = runners[j].runs.find((x) => x.Date === a.Date && sameText(x.Course, a.Course) && (x.RaceNumber == null || x.RaceNumber === a.RaceNumber));
        if (!b) continue;
        const pa = num(a.FinishPosition);
        const pb = num(b.FinishPosition);
        if (!pa || !pb || pa === pb) continue;
        const [win, lose, wRun, lRun] = pa < pb ? [runners[i], runners[j], a, b] : [runners[j], runners[i], b, a];
        out.push({ winner: win, loser: lose, run: wRun, winnerPos: num(wRun.FinishPosition), loserPos: num(lRun.FinishPosition) });
        break;
      }
    }
  }
  return out;
}

// --- Writing ----------------------------------------------------------------------
const nameTab = (r) => `${r.name} (${r.tab})`;

function lastRunSentence(r, f, style, todayCourse) {
  const pos = num(f.FinishPosition);
  const starters = num(f.Starters);
  const where = sameText(f.Course, todayCourse) ? `this ${TERMS[style].track}` : titleCase(f.Course);
  const dist = distance(f.Distance, style);
  const going = f.TrackCondition && !/^good$/i.test(f.TrackCondition) ? ` on a ${String(f.TrackCondition).toLowerCase()} ${style === 'UK' ? 'surface' : 'track'}` : '';
  const when = shortDate(f.Date);
  const margin = num(f.LengthsBehind);
  if (pos === 1) {
    const second = f.SecondName ? `, beating ${titleCase(f.SecondName)}` : '';
    return `Won over ${dist} at ${where} on ${when}${going}${second}.`;
  }
  const field = starters ? ` of ${starters}` : '';
  const beaten = margin != null && margin > 0 ? `, beaten ${margin < 0.3 ? 'a nose' : margin < 0.6 ? 'a head' : `${margin}L`}${f.WinnerName ? ` by ${titleCase(f.WinnerName)}` : ''}` : '';
  return `Ran ${ordinal(pos)}${field} over ${dist} at ${where} on ${when}${going}${beaten}.`;
}

function changeSentence(r, f, race, style, seed) {
  const parts = [];
  const gap = daysBetween(f.Date, race.date);
  if (gap != null && gap >= 70) parts.push(`returns from ${TERMS[style].spell} of ${Math.round(gap / 7)} weeks`);
  const diff = (num(race.distance) || 0) - (num(f.Distance) || 0);
  if (num(f.Distance) && race.distance) {
    if (diff >= 100) parts.push(`steps up ${distanceGap(diff, style)} to ${distance(race.distance, style)}`);
    else if (diff <= -100) parts.push(`drops back ${distanceGap(diff, style)} to ${distance(race.distance, style)}`);
    else parts.push(pick(['stays at a similar trip', 'is back over a similar distance'], seed));
  }
  if (r.barrier) parts.push(`jumps from ${TERMS[style].barrier} ${r.barrier}`);
  if (r.kg) parts.push(`carries ${weight(r.kg, style)}${r.claim ? ` (${r.jockey} claims ${r.claim})` : ''}`);
  if (!parts.length) return '';
  const lead = pick(['Today it', 'This time it', 'Now it'], seed);
  return `${lead} ${parts.join(', ')}.`;
}

function recordSentence(r, style) {
  const track = recordText(record(r.stats.track));
  const dist = recordText(record(r.stats.distance));
  const both = [];
  if (track) both.push(`${track} at this ${TERMS[style].track}`);
  if (dist) both.push(`${dist} at the distance`);
  if (!both.length) {
    const career = record(r.stats.career);
    if (!career || !career.starts) return '';
    const text = recordText(career);
    if (text) return `Career: ${text}.`;
    return career.starts === 1 ? 'Has had only the one start.' : `Lightly raced with ${career.starts} starts.`;
  }
  return `Record: ${both.join('; ')}.`;
}

function verdict(tier, r, seed, clash) {
  if (clash) return `Beat ${nameTab(clash.loser)} when they met at ${titleCase(clash.run.Course)} on ${shortDate(clash.run.Date)}.`;
  const lines = {
    top: ['Rates a leading chance.', 'Holds the strongest claims.', 'The one to beat on this form.'],
    mid: ['Each-way claims.', 'Can figure in the placings.', 'Capable of running a place.'],
    low: ['Others look stronger.', 'Needs more to win this.', 'Hard to make a winning case for.'],
  };
  return pick(lines[tier], seed);
}

function runnerComment(r, ctx, style) {
  const seed = hash(r.name + style);
  const f = r.runs[0];
  const clash = ctx.clashes.find((c) => c.winner === r && ctx.tierOf(c.loser) !== 'low');
  if (!f) {
    const bits = [`${nameTab(r)} has no race form on the card.`];
    if (r.barrier) bits.push(`Jumps from ${TERMS[style].barrier} ${r.barrier}${r.kg ? ` with ${weight(r.kg, style)}` : ''}.`);
    if (r.jockey || r.trainer) bits.push(`${[r.trainer && `Trained by ${r.trainer}`, r.jockey && `ridden by ${r.jockey}`].filter(Boolean).join(', ')}.`);
    return bits.join(' ');
  }
  const form = r.runs.slice(0, 4).map((x) => num(x.FinishPosition));
  const placings = form.filter((p) => p && p <= 3).length;
  const formNote = form.length >= 3
    ? (placings >= 3 ? ` Placed in ${placings} of its last ${form.length}.` : placings === 0 ? ` Unplaced in its last ${form.length}.` : '')
    : '';
  return [
    `${nameTab(r)}: ${lastRunSentence(r, f, style, ctx.race.course)}${formNote}`,
    changeSentence(r, f, ctx.race, style, seed),
    recordSentence(r, style),
    verdict(ctx.tierOf(r), r, seed, clash),
  ].filter(Boolean).join(' ');
}

function overview(ctx, style) {
  const top = ctx.ranked.slice(0, 4);
  if (!top.length) return '';
  const [a, b, c, d] = top;
  const sentences = [];
  const aRun = a.runs[0];
  sentences.push(`${nameTab(a)} ${a.odds ? 'heads the market' : 'has the best recent form'}${aRun ? `, ${lastRunSentence(a, aRun, style, ctx.race.course).replace(/\.$/, '').replace(/^Ran/, 'having run').replace(/^Won/, 'having won')}` : ''}.`);
  const meet = ctx.clashes.find((x) => top.includes(x.winner) && top.includes(x.loser));
  if (meet) sentences.push(`${meet.winner === a ? 'It' : nameTab(meet.winner)} finished ahead of ${nameTab(meet.loser)} at ${titleCase(meet.run.Course)} on ${shortDate(meet.run.Date)}.`);
  if (b) {
    const bRec = recordText(record(b.stats.track));
    sentences.push(`${nameTab(b)} ${b.runs[0] ? `${num(b.runs[0].FinishPosition) === 1 ? 'won' : `ran ${ordinal(num(b.runs[0].FinishPosition))}`} last start` : 'is lightly raced'}${bRec ? ` and has ${bRec} at this ${TERMS[style].track}` : ''}.`);
  }
  if (c) sentences.push(`${nameTab(c)}${d ? ` and ${nameTab(d)}` : ''} ${d ? 'round out the main chances' : 'is the other main chance'}.`);
  sentences.push(`Prefer ${a.name} over ${b ? b.name : 'the rest'}${c ? `, with ${c.name} the danger` : ''}.`);
  return sentences.join(' ');
}

function spotlights(ctx, style) {
  const out = [];
  const used = new Set();
  const add = (r, name, explanation) => {
    if (!r || used.has(r) || out.length >= 3) return;
    used.add(r);
    out.push({ horse: r.name, name, explanation });
  };
  const contenders = ctx.ranked.slice(0, Math.max(4, Math.ceil(ctx.ranked.length * 0.6)));
  // 1. Best last-start run among the contenders.
  const lastWin = contenders.find((r) => r.runs[0] && num(r.runs[0].FinishPosition) === 1);
  if (lastWin) add(lastWin, 'Last-Start Winner', `Won over ${distance(lastWin.runs[0].Distance, style)} at ${sameText(lastWin.runs[0].Course, ctx.race.course) ? `this ${TERMS[style].track}` : titleCase(lastWin.runs[0].Course)} on ${shortDate(lastWin.runs[0].Date)} and lines up again.`);
  // 2. A past clash.
  const clash = ctx.clashes.find((c) => contenders.includes(c.winner) && !used.has(c.winner));
  if (clash) add(clash.winner, 'Has The Edge', `Finished ${ordinal(clash.winnerPos)}, ahead of ${clash.loser.name} (${ordinal(clash.loserPos)}), when they met at ${titleCase(clash.run.Course)} on ${shortDate(clash.run.Date)}.`);
  // 3. Track or distance record.
  for (const r of contenders) {
    const t = record(r.stats.track);
    const d = record(r.stats.distance);
    if (t && t.wins && t.starts) { add(r, 'Track Specialist', `${recordText(t).replace(/^./, (x) => x.toUpperCase())} at this ${TERMS[style].track}.`); break; }
    if (d && d.wins && d.starts) { add(r, 'Right Trip', `${recordText(d).replace(/^./, (x) => x.toUpperCase())} at the distance.`); break; }
  }
  // 4. Fill with consistent placegetters, then the top of the order.
  for (const r of contenders) {
    const form = r.runs.slice(0, 4).map((x) => num(x.FinishPosition)).filter(Boolean);
    const placed = form.filter((p) => p <= 3).length;
    if (form.length >= 3 && placed >= 2) add(r, 'Model Of Consistency', `Placed in ${placed} of its last ${form.length} starts.`);
  }
  const fillNames = ['Knocking On The Door', 'Close Last Time', 'Worth A Look'];
  for (const r of contenders) {
    if (!r.runs[0] || used.has(r)) continue;
    const pos = num(r.runs[0].FinishPosition);
    add(r, pos && pos <= 3 ? fillNames[out.length % 2] : fillNames[2], lastRunSentence(r, r.runs[0], style, ctx.race.course));
  }
  return out;
}

// card: one `racecards` document (any style). scratchedTabs: tab numbers
// scratched in our races doc (the racecard's own flag can lag).
// -> { AU: { overview, runners: { tab: text }, spotlights }, UK, US }
function generateCommentsV2(card, scratchedTabs = new Set()) {
  const race = {
    course: card.Course,
    date: String(card.Date || card.OffTimeUtc || '').slice(0, 10),
    distance: num(card.RaceDistance && card.RaceDistance.DistanceM),
  };
  const runners = buildRunners(card, scratchedTabs);
  if (!runners.length) return null;
  const ranked = runners.slice().sort((a, b) => strength(b) - strength(a));
  const topN = Math.max(1, Math.round(ranked.length * 0.3));
  const midN = Math.round(ranked.length * 0.4);
  const tierOf = (r) => {
    const i = ranked.indexOf(r);
    return i < topN ? 'top' : i < topN + midN ? 'mid' : 'low';
  };
  const ctx = { race, ranked, tierOf, clashes: clashes(runners) };
  const out = {};
  for (const style of STYLES) {
    const comments = {};
    for (const r of runners) comments[String(r.tab)] = runnerComment(r, ctx, style);
    out[style] = { overview: overview(ctx, style), runners: comments, spotlights: spotlights(ctx, style) };
  }
  return out;
}

module.exports = { generateCommentsV2, distance, weight };
