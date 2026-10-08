// Runners check (2 Oct 2026, per Dinesh; file renamed from neds-check.js):
// runners from two sources compared with our own race docs, for the
// meetings we have. server.js runs it every 8 hours, the sources taking
// turns (falling back to the other when one fails), and shows the
// differences as Runner Missing / Runner Mismatched / Runner Count
// Mismatched.
//
// 1. Racing and Sports' meetings API (its path says /neds/) -- one request
//    per day. GET ?date=YYYY-MM-DD -> { meetings: [{ course, country,
//    discipline, local_race_dates, events: [{ race_no, event_id, runners:
//    [{ tab_no, runner_name, scratched }] }] }] }. A meeting can be listed
//    under the day before its own local date, so local_race_dates is used.
//    Its scratched flag lags and its tab numbers can be shifted.
// 2. The nedsform.com.au website -- see "Second source" below.
//
// Only each runner's tab number, name and scratched state are compared (the
// API has nothing else) -- not jockey, trainer, barrier or weight.

const RUNNERS_API_URL = process.env.RUNNERS_API_URL || 'http://nextdc.racingandsports.com:9542/api/v1/neds/meetings';
const DISCIPLINES = new Set(['T', 'H', 'G']);
// The API's country codes where ours differ (matched by course name,
// 2 Oct 2026: MYS = our MAL, CA = CAN, UK = GB, ITA = ITY), plus likely ones
// for the Missing Meetings countries.
const API_TO_OUR_COUNTRY = {
  MYS: 'MAL', CA: 'CAN', UK: 'GB', ITA: 'ITY', DEU: 'GER', DNK: 'DEN', URY: 'URU',
  ARE: 'UAE', KSA: 'SAU', BRA: 'BRZ', HKG: 'HK', NZL: 'NZ',
};
function ourCountry(apiCode) {
  const code = String(apiCode || '').toUpperCase();
  return API_TO_OUR_COUNTRY[code] || code;
}
// Our DB has written New Zealand both ways.
function sameCountry(dbCode, code) {
  return dbCode === code || (code === 'NZ' && dbCode === 'NZL');
}

// API response -> [{ discipline, track, country (our code), date, races: [{ rNo, id, runners }] }].
function parseRunnerMeetings(json) {
  return (json && Array.isArray(json.meetings) ? json.meetings : [])
    .filter((m) => DISCIPLINES.has(m.discipline) && Array.isArray(m.events) && m.events.length)
    .map((m) => ({
      discipline: m.discipline,
      track: m.course,
      country: ourCountry(m.country),
      date: (Array.isArray(m.local_race_dates) && m.local_race_dates[0]) || m.race_date,
      races: m.events.map((e) => ({
        rNo: Number(e.race_no),
        id: e.event_id,
        runners: (e.runners || []).map((r) => ({ tab: Number(r.tab_no), name: fixMojibake(r.runner_name), scratched: Boolean(r.scratched) }))
          .filter((r) => Number.isFinite(r.tab)),
      })).filter((r) => r.rNo > 0),
    }));
}

// --- Second source: the nedsform.com.au website (2 Oct 2026, per Dinesh:
// "RAS api work pannallanna inda API use panni check pannunga... Oru thadawa
// RAS Api check pannunga next time NEDS Api check pannunga"). A Next.js
// site: each page carries its data in `self.__next_f.push([1,"..."])`. The
// day page (/YYYY-MM-DD) lists meetings and race EventIDs; each race page
// (/form/<id>) lists that race's runners -- only the ones still running
// (scratched runners are left out). robots.txt allows crawling.
const NEDS_SITE_BASE = process.env.NEDS_SITE_BASE || 'https://nedsform.com.au';
const NEDS_SITE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (RaceDayDashboard runners check)' };
const NEDS_RACE_TYPES = { horse_racing: 'T', harness_racing: 'H', greyhound_racing: 'G' };

function rscPayload(html) {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  return [...String(html).matchAll(re)].map((m) => JSON.parse('"' + m[1] + '"')).join('');
}
// The JSON value right after `"key":` in the payload (string-aware bracket matching).
function jsonAfter(text, key) {
  const k = text.indexOf(`"${key}":`);
  if (k === -1) return null;
  const start = k + key.length + 3;
  const open = text[start];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (ch === '\\') j++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(text.slice(start, j + 1));
  }
  return null;
}

// Day page -> same shape as parseRunnerMeetings, but each race has `id`
// (its page) and no runners yet; finished races are marked `final`.
function parseNedsSiteMeetings(html) {
  const found = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.RaceType && Array.isArray(v.Races)) found.push(v);
      else Object.values(v).forEach(walk);
    }
  })(jsonAfter(rscPayload(html), 'meetings'));
  return found
    .filter((m) => NEDS_RACE_TYPES[m.RaceType])
    .map((m) => ({
      discipline: NEDS_RACE_TYPES[m.RaceType],
      track: m.Track,
      country: ourCountry(m.Country),
      date: m.Day,
      races: m.Races.map((r) => ({
        rNo: Number(r.RaceNumber),
        id: String(r.EventID || '').replace(/^racingform-betmakers-/, ''),
        final: /final|result|abandon/i.test(r.Status || ''),
        // Start time (UTC ms). Neds is an Australian site and dates overseas
        // meetings by the AUS day (Canada's 2 Oct evening shows as 3 Oct), so
        // its races are matched to ours by start time, not date + number.
        start: Number(r.StartTime) || null,
        runners: null,
      })).filter((r) => r.rNo > 0 && r.id),
    }));
}

// Some names come double-encoded -- "LicarayÃ©n" for "Licarayén" (Neds,
// 2 Oct 2026). Read the UTF-8 bytes back when that pattern shows.
function fixMojibake(s) {
  // The source can also title-case the broken text ("Licarayã©N"), so a
  // lower-case ã/â before such a byte is put back first.
  const str = String(s || '').replace(/ã(?=[-¿])/g, 'Ã').replace(/â(?=[-¿])/g, 'Â');
  if (!/[ÃÂ][-¿]/.test(str)) return String(s || '');
  try {
    const fixed = Buffer.from(str, 'latin1').toString('utf8');
    return fixed.includes('�') ? String(s || '') : fixed;
  } catch (e) {
    return str;
  }
}

// Race page -> [{ tab, name, scratched }] (scratched runners aren't listed).
function parseNedsSiteRunners(html) {
  const runners = jsonAfter(rscPayload(html), 'Runners');
  return (Array.isArray(runners) ? runners : [])
    .map((r) => ({
      tab: Number(r.SaddleNumber),
      name: fixMojibake(r.Name),
      scratched: /scratch/i.test(r.Status || ''),
      // Jockey + weight (5 Oct 2026, per Dinesh): the Neds site has them,
      // often before our feed (the RAS API doesn't have them at all).
      // Weight "Total" is the handicap weight (= ours); "Allocated" is after
      // the apprentice claim.
      jockey: fixMojibake((r.Jockey && r.Jockey.Name) || ''),
      weight: r.Weight && r.Weight.Total ? Number(r.Weight.Total) : null,
    }))
    .filter((r) => Number.isFinite(r.tab));
}

function norm(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Harness names can end in the country ("Blackjack Nz").
// Country suffixes, plus "AA" (Anglo-Arab -- Italian sources add it: our
// "GIUBILO" is "Giubilo Aa" there, Florence 8 Oct 2026).
const NAME_COUNTRY_SUFFIX = new Set(['nz', 'aus', 'usa', 'us', 'ire', 'gb', 'fr', 'can', 'swe', 'ger', 'jpn', 'arg', 'chi', 'brz', 'saf', 'ity', 'aa']);
function horseKey(name) {
  const t = norm(name).split(' ').filter(Boolean);
  while (t.length > 1 && NAME_COUNTRY_SUFFIX.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

// "Vacant Box" is an empty greyhound box, not a runner -- left out of every
// comparison and count, on both sides (6 Oct 2026, per Dinesh: "Vacant Box
// vanda adu empty box so apdi vanda ada ignore pannunga").
// Also not runners: a field not yet released ("TBD" / "TBA", Port Pirie
// 8 Oct 2026) and a runner with no name at all (Busan R5).
function isVacantBox(name) {
  return /^(vacant( box)?|tbd|tba|tbc)?$/.test(norm(name).trim());
}

// Same horse when only the spacing differs: our "EMOZIONEDEFLORINAS" is
// "Emozione De Florinas" in the source (Florence 8 Oct 2026).
const sameKey = (a, b) => a === b || a.replace(/ /g, '') === b.replace(/ /g, '');
const realRunners = (list, nameOf) => (list || []).filter((x) => !isVacantBox(nameOf(x)));

// Our value of one compared field, as a string. Saved with each difference
// so that, between the 8-hourly checks, a difference whose value has since
// changed in our DB (e.g. the scratching got updated) stops showing at once.
function ourValue(dbRace, tab, field) {
  const runners = realRunners(dbRace.runners, (x) => x.horseName);
  if (field === 'field') return runners.map((x) => horseKey(x.horseName)).join('|');
  const r = runners.find((x) => x.tabNo === tab);
  if (field === 'present') return r ? 'yes' : 'no';
  if (field === 'count') return String(runners.filter((x) => !x.isScratched).length);
  if (!r) return '';
  if (field === 'name') return String(r.horseName || '');
  if (field === 'scratched') return String(Boolean(r.isScratched));
  if (field === 'jockey') return String(r.jockey || '').trim();
  if (field === 'weight') return r.weight == null ? '' : String(r.weight);
  return '';
}

// --- Jockey matching (5 Oct 2026) -------------------------------------------
// "Unknown" / "TBA" means not declared yet -- nothing to compare.
function realJockey(name) {
  const n = String(name || '').trim();
  return n && !/^(unknown|tba|tbc|n\/?a|-)$/i.test(n) ? n : '';
}
const PERSON_SUFFIX = /^(snr|jnr|jr|sr|a\d*)$/; // generation suffixes and our apprentice marker ("Bella Youngberry A3")
const NICKNAMES = [
  ['liz', 'elizabeth'], ['beth', 'elizabeth'], ['tony', 'anthony'], ['bill', 'william'], ['will', 'william'],
  ['bob', 'robert'], ['rob', 'robert'], ['jim', 'james'], ['mick', 'michael'], ['mike', 'michael'],
  ['chris', 'christopher'], ['matt', 'matthew'], ['dan', 'daniel'], ['danny', 'daniel'], ['ben', 'benjamin'],
  ['sam', 'samuel'], ['tom', 'thomas'], ['steve', 'stephen'], ['steve', 'steven'], ['dave', 'david'],
  ['pete', 'peter'], ['nick', 'nicholas'], ['josh', 'joshua'], ['alex', 'alexander'], ['kate', 'katherine'],
  ['jenny', 'jennifer'], ['jen', 'jennifer'], ['sue', 'susan'], ['ted', 'edward'], ['ed', 'edward'],
  ['tash', 'natasha'], ['nat', 'natalie'], ['nat', 'nathan'], ['pat', 'patrick'], ['andy', 'andrew'],
];
function personTokens(s) {
  const t = norm(s).split(' ').filter(Boolean);
  while (t.length > 1 && PERSON_SUFFIX.test(t[t.length - 1])) t.pop();
  return t;
}
// Same person: identical, spacing only ("McCarney"/"Mc Carney"), or the
// same surname -- any of our words, since ARG names carry two given names
// ("FACUNDO MARCELO CORIA") -- with the same first initial or a nickname pair.
function samePerson(a, b) {
  const ta = personTokens(a);
  const tb = personTokens(b);
  if (!ta.length || !tb.length) return ta.length === tb.length;
  if (ta.join('') === tb.join('')) return true;
  const sa = ta[ta.length - 1];
  const sb = tb[tb.length - 1];
  if (sa !== sb && !ta.includes(sb) && !tb.includes(sa)) return false;
  const fa = ta[0];
  const fb = tb[0];
  if (fa[0] === fb[0]) return true;
  return NICKNAMES.some(([x, y]) => (fa === x && fb === y) || (fa === y && fb === x));
}

// One name cut short of the other at a word boundary: our "Taxi It" for
// "Taxi It Is", "Captain Said" for "Captain Said So" (2 Oct 2026).
function truncatedName(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long !== short && long.startsWith(`${short} `);
}

// dbRace: { runners: [{ tabNo, horseName, isScratched }] }
// -> [{ tab, field, ours, text, raceLevel }]. raceLevel items are about a
// horse only the API has (or the whole field), so they're shown for the
// race rather than in a runner's Issue column.
//
// Runners are matched by NAME, not tab number: the API's tab numbers can be
// shifted (Gloucester Park R8, 2 Oct 2026: an extra runner at #2 moved every
// number after it). Its scratched flag often lags -- many runners scratched
// in our DB were still scratched:false there -- so only "scratched there,
// running in ours" is flagged, not the other way round.
//
// fromNeds: the Neds website leaves runners off its race pages (scratched
// ones, and some it just doesn't list -- The Meadows R11, 7 Oct 2026, had no
// Mister Manfredi there while RAS, the scratchings feed and ours all had it
// running), so a runner of ours missing on Neds, or Neds having fewer, is
// not an issue (6 Oct 2026, per Dinesh: "NEDS adu missing irundadukku adu
// issue illa"). Neds having a runner we don't is still flagged.
function compareRunners(dbRace, allSourceRunners, { fromNeds = false } = {}) {
  const items = [];
  const sourceRunners = realRunners(allSourceRunners, (n) => n.name);
  if (!sourceRunners.length) return items; // no field in the source for this race yet
  // Labels are plain "Runner Missing" / "Runner Mismatched", no source name (2 Oct 2026, per Dinesh).
  const add = (tab, field, text, raceLevel = false) => items.push({ tab, field, ours: ourValue(dbRace, tab, field), text, raceLevel });
  const ours = realRunners(dbRace.runners, (r) => r.horseName).map((r) => ({ r, key: horseKey(r.horseName) }));
  // A horse listed twice is the source's own data error (Gloucester Park R8,
  // 2 Oct 2026) -- only its first listing counts.
  const firstSeen = new Set();
  const theirs = sourceRunners.filter((n) => { const k = horseKey(n.name); if (firstSeen.has(k)) return false; firstSeen.add(k); return true; })
    .map((n) => ({ n, key: horseKey(n.name) }));

  // Every exact name first, then cut-short names among what's left -- in one
  // pass, "Blackjack Sam" grabbed our "Blackjack" (really "Blackjack Nz")
  // before the exact match got its turn (Albion Park R1, 2 Oct 2026).
  const matched = new Set();
  const pairs = [];
  for (const sameName of [true, false]) {
    for (const t of theirs) {
      if (pairs.some(([p]) => p === t)) continue;
      const o = ours.find((x) => !matched.has(x) && (sameName ? sameKey(x.key, t.key) : truncatedName(x.key, t.key)));
      if (o) { matched.add(o); pairs.push([t, o]); }
    }
  }
  const unmatchedTheirs = theirs.filter((t) => !pairs.some(([p]) => p === t) && !t.n.scratched);

  // Runner count (2 Oct 2026, per Dinesh: "Runner Count mismatched"):
  // running horses there vs ours. A horse scratched in ours doesn't count
  // on their side either, since their scratched flag lags.
  const totals = runnerCounts(ours, pairs, theirs);
  if (fromNeds ? totals.source > totals.ours : totals.source !== totals.ours) add(null, 'count', `Runner Count Mismatched (source ${totals.source}, ours ${totals.ours})`, true);

  // A field that mostly doesn't match (3 Oct 2026: our ALBION PARK R2-R8 had
  // no horse in common with the source) is one race-level difference, not a flag
  // on every runner.
  const running = theirs.filter((t) => !t.n.scratched).length;
  if (running >= 3 && unmatchedTheirs.length > running / 2) {
    add(null, 'field', `Runner Mismatched: field doesn't match (${unmatchedTheirs.length} of ${running} horses not in ours)`, true);
    return items;
  }
  for (const [t, o] of pairs) {
    if (o.r.isScratched) continue;
    if (t.n.scratched) add(o.r.tabNo, 'scratched', 'Runner Mismatched (scratched)');
    if (!sameKey(t.key, o.key)) add(o.r.tabNo, 'name', `Runner Mismatched (${t.n.name})`);
    if (t.n.scratched) continue;
    // Jockey -- only when the source has it (Neds website), and only a
    // jockey MISSING in ours (6 Oct 2026, per Dinesh: weight not compared,
    // "Jockey names mismatched issue illa, Jockey missing mattu check").
    const theirJockey = realJockey(t.n.jockey);
    if (theirJockey && !String(o.r.jockey || '').trim()) add(o.r.tabNo, 'jockey', `Jockey Missing (${theirJockey})`);
  }
  for (const t of unmatchedTheirs) add(null, 'present', `Runner Missing: ${t.n.name}`, true);
  if (!fromNeds) {
    for (const o of ours) {
      if (!o.r.isScratched && !matched.has(o)) add(o.r.tabNo, 'present', 'Runner Mismatched (not in field)');
    }
  }
  return items;
}

function runnerCounts(ours, pairs, theirs) {
  const source = theirs.filter((t) => {
    if (t.n.scratched) return false;
    const pair = pairs.find(([p]) => p === t);
    return !(pair && pair[1].r.isScratched);
  }).length;
  return { source, ours: ours.filter((o) => !o.r.isScratched).length };
}

// Running-horse counts for a race, for the Missing Data page's Runners column.
function countRunners(dbRace, sourceRunners) {
  const ours = realRunners(dbRace.runners, (r) => r.horseName).map((r) => ({ r, key: horseKey(r.horseName) }));
  const theirs = realRunners(sourceRunners, (n) => n.name).map((n) => ({ n, key: horseKey(n.name) }));
  const matched = new Set();
  const pairs = [];
  for (const t of theirs) {
    const o = ours.find((x) => !matched.has(x) && sameKey(x.key, t.key)) || ours.find((x) => !matched.has(x) && truncatedName(x.key, t.key));
    if (o) { matched.add(o); pairs.push([t, o]); }
  }
  return runnerCounts(ours, pairs, theirs);
}

// Still a difference now? Only while our value is what it was at the check.
function stillDiffers(dbRace, item, source) {
  // Neds flags saved before 6 Oct 2026 that are no longer raised (see
  // compareRunners' fromNeds) -- hidden at once, no re-check needed.
  if (/^neds/.test(source || '')) {
    if (item.text === 'Runner Mismatched (not in field)') return false;
    const count = /^Runner Count Mismatched \(source (\d+), ours (\d+)\)/.exec(item.text || '');
    if (count && Number(count[1]) < Number(count[2])) return false;
  }
  // Weight and jockey-name checks were dropped 6 Oct 2026; hides any saved from before.
  if (item.field === 'weight' || /^Jockey Mismatched/.test(item.text || '')) return false;
  // Vacant Box flags saved before 6 Oct 2026 -- hidden at once, no re-check needed.
  if (/vacant box/i.test(item.text || '') || /^Runner Missing: *(tbd|tba|tbc)?$/i.test(item.text || '')) return false;
  return ourValue(dbRace, item.tab, item.field) === item.ours;
}

module.exports = {
  RUNNERS_API_URL, NEDS_SITE_BASE, NEDS_SITE_HEADERS, parseNedsSiteMeetings, parseNedsSiteRunners,
  ourCountry, sameCountry, parseRunnerMeetings, compareRunners, countRunners, samePerson, realJockey, stillDiffers, horseKey };
