// Data-integrity checks for the Trader (26 Nov 2026, per Dinesh: "Pudu trader
// seiranga adukku data enga kitta irundu da pogudu, so TD la ella data
// acurate ha irukkanu olunga check pannaum"). The other checks look for
// data that is MISSING; these look for data that is there but WRONG -- the
// kind a trading system would act on without noticing.
//
// Measured on 30 days of prod data (27 Oct - 26 Nov 2026) before building:
//   - Ascot AUS (Perth) 31 Oct R1-R7 carried the Ascot GB jumps fields
//     (same course name, different country) -> field-mixup.
//   - 18 horses ran (not scratched) in two races on one day, e.g. Desert
//     Charm at Morphettville AUS and Southwell GB -> horse-two-races.
//   - 167 runnerIds were shared by two different horses with the same name
//     (a filly in GB and a colt in the USA; one horse "running" in Sweden
//     and New Zealand 4 days apart) -> runner-id-clash.
//   - Healesville 31 Oct R1's UTC time was 5.5 h out, Warwick AUS 15 Nov had
//     GB local times -> utc-offset.
// Each rule was tuned on that data until only real problems were left
// (harness front/back-row barriers, quarter-horse sprints, abandoned
// meetings and timezone-less UTC strings all caused false alarms at first).

// code -> { label, filter (grid filter value) }
const INTEGRITY_CHECKS = {
  'field-mixup': { label: 'Wrong field (runners of another race)', filter: 'fieldmixup' },
  'horse-two-races': { label: 'Horse in two races on one day', filter: 'horsetworaces' },
  'runner-id-clash': { label: 'Runner ID shared by two horses', filter: 'runneridclash' },
  'utc-offset': { label: 'UTC time wrong', filter: 'utcoffset' },
  'race-data': { label: 'Barrier / distance problem', filter: 'racedata' },
};

const isAbandoned = (doc) => Boolean(doc.isAbandoned) || /abandon/i.test(String(doc.rStatus || ''));
const running = (doc) => (doc.runners || []).filter((r) => r && !r.isScratched);
const raceName = (doc) => `${doc.rCourseDisplayName || '?'}${doc.rCountry ? ` (${doc.rCountry})` : ''} R${doc.rNo}`;

// A UTC string without a zone ("2026-10-27T08:03:00" -- 43% of
// rStartTimeUTC values) is still UTC; Date.parse would read it as local.
function parseUtc(value) {
  const t = String(value || '').trim();
  if (!t) return NaN;
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(t) ? t : `${t}Z`);
}
// Local clock minus UTC, in minutes (null when either is missing).
function utcOffsetMinutes(doc) {
  const local = String(doc.rScheduleTime || '').trim();
  const utc = parseUtc(doc.rScheduleTimeUTC);
  if (!local || !Number.isFinite(utc)) return null;
  const l = Date.parse(`${local.replace(/(Z|[+-]\d\d:?\d\d)$/i, '')}Z`);
  return Number.isFinite(l) ? Math.round((l - utc) / 60000) : null;
}
const fmtOffset = (m) => `${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? `:${String(Math.abs(m) % 60).padStart(2, '0')}` : ''}`;

// Possible local-minus-UTC offsets (hours) per country, daylight saving
// included. A country not listed only gets the within-meeting check.
const COUNTRY_OFFSETS = {
  AUS: [[8, 11]], NZ: [[12, 13]], GB: [[0, 1]], IRE: [[0, 1]], FR: [[1, 2], [-4, -4], [4, 4]], // Martinique, Reunion
  GER: [[1, 2]], ITY: [[1, 2]], SPA: [[1, 2]], SWE: [[1, 2]], NOR: [[1, 2]], DEN: [[1, 2]], BEL: [[1, 2]], CZE: [[1, 2]], POL: [[1, 2]],
  USA: [[-10, -4]], CAN: [[-8, -3]], MEX: [[-8, -5]], PAN: [[-5, -5]], CHI: [[-4, -3]], ARG: [[-3, -3]], BRZ: [[-4, -2]],
  JPN: [[9, 9]], KOR: [[9, 9]], HK: [[8, 8]], SIN: [[8, 8]], MAL: [[8, 8]], SAF: [[2, 2]], MUS: [[4, 4]],
  ARE: [[4, 4]], UAE: [[4, 4]], SAU: [[3, 3]], TUR: [[3, 3]], IND: [[5.5, 5.5]],
};
const offsetFits = (country, minutes) => {
  const ranges = COUNTRY_OFFSETS[String(country || '').toUpperCase()];
  return !ranges || ranges.some(([a, b]) => minutes >= a * 60 && minutes <= b * 60);
};

// Horses move freely between these, so they count as one place.
const REGION = { GB: 'EU', IRE: 'EU', FR: 'EU', GER: 'EU', ITY: 'EU', SPA: 'EU', BEL: 'EU', NOR: 'EU', SWE: 'EU', DEN: 'EU', CZE: 'EU', POL: 'EU', AUS: 'ANZ', NZ: 'ANZ', USA: 'NAM', CAN: 'NAM' };
const regionOf = (c) => REGION[String(c || '').toUpperCase()] || String(c || '').toUpperCase();
const FEMALE = new Set(['F', 'M']);
const MALE = new Set(['C', 'G', 'H', 'R']);
const normName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\s*\([a-z]{2,3}\)\s*$/, '').replace(/[^a-z0-9]/g, '');
// Two far-apart countries this close together can't be one horse.
const FAR_RUN_MAX_DAYS = 7;

// Same-day checks over every race of one date: field-mixup, horse-two-races,
// utc-offset, race-data. -> Map raceId -> [{ code, text }]
function dayIntegrity(docs) {
  const out = new Map();
  const add = (doc, code, text) => {
    if (!out.has(doc._id)) out.set(doc._id, []);
    const list = out.get(doc._id);
    const same = list.find((x) => x.code === code);
    if (same) same.text += `; ${text}`;
    else list.push({ code, text });
  };
  const live = docs.filter((d) => !isAbandoned(d));

  // Which races each runner is in.
  const racesOf = new Map();
  for (const d of live) for (const r of d.runners || []) {
    if (!r || !r.runnerId) continue;
    if (!racesOf.has(r.runnerId)) racesOf.set(r.runnerId, []);
    racesOf.get(r.runnerId).push({ d, r });
  }

  // field-mixup: two races sharing most of their runners -- at another
  // meeting (Ascot AUS/GB) or an identical field at the same meeting.
  const mixedPairs = new Set();
  const shared = new Map(); // "idA|idB" -> count
  for (const list of racesOf.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i].d, list[j].d].sort((x, y) => (String(x._id) < String(y._id) ? -1 : 1));
      if (a._id === b._id) continue;
      const k = `${a._id}|${b._id}`;
      shared.set(k, (shared.get(k) || 0) + 1);
    }
  }
  const byId = new Map(live.map((d) => [d._id, d]));
  for (const [k, n] of shared) {
    const [a, b] = k.split('|').map((id) => byId.get(id));
    const sizeA = (a.runners || []).length;
    const sizeB = (b.runners || []).length;
    const sameMeeting = a.meetingId && a.meetingId === b.meetingId;
    const mixed = sameMeeting ? n >= 3 && n === sizeA && n === sizeB : n >= 2 && n >= Math.min(sizeA, sizeB) / 2;
    if (!mixed) continue;
    mixedPairs.add(k);
    add(a, 'field-mixup', `${n} of ${sizeA} runners are also in ${raceName(b)}`);
    add(b, 'field-mixup', `${n} of ${sizeB} runners are also in ${raceName(a)}`);
  }

  // horse-two-races: a horse running (not scratched) in two races of the
  // day, outside a mixed-up pair (that already says it).
  for (const list of racesOf.values()) {
    const runs = list.filter((x) => !x.r.isScratched);
    if (runs.length < 2) continue;
    for (const x of runs) {
      const others = runs.filter((y) => y.d._id !== x.d._id && !mixedPairs.has([String(x.d._id), String(y.d._id)].sort().join('|')));
      if (others.length) add(x.d, 'horse-two-races', `${x.r.horseName || '?'} is also running in ${others.map((y) => raceName(y.d)).join(', ')}`);
    }
  }

  // utc-offset: per meeting, the local-vs-UTC gap must be one the country
  // can have, and the same for every race.
  const byMeeting = new Map();
  for (const d of live) {
    const key = d.meetingId || `${d.rCourseDisplayName}|${d.rCountry}|${d.rDiscipline}`;
    if (!byMeeting.has(key)) byMeeting.set(key, []);
    byMeeting.get(key).push(d);
  }
  for (const list of byMeeting.values()) {
    const offs = list.map((d) => ({ d, m: utcOffsetMinutes(d) })).filter((x) => x.m != null);
    if (!offs.length) continue;
    const counts = new Map();
    offs.forEach((x) => counts.set(x.m, (counts.get(x.m) || 0) + 1));
    const [major, majorN] = [...counts].sort((a, b) => b[1] - a[1])[0];
    for (const { d, m } of offs) {
      const local = String(d.rScheduleTime || '').slice(11, 16);
      if (!offsetFits(d.rCountry, m)) {
        add(d, 'utc-offset', `local ${local} is UTC${fmtOffset(m)}, not possible in ${d.rCountry}`);
      } else if (m !== major && majorN > 1 && majorN > offs.length / 2) {
        add(d, 'utc-offset', `local ${local} is UTC${fmtOffset(m)}, the rest of the meeting UTC${fmtOffset(major)}`);
      }
    }
  }

  // race-data: Thoroughbred barriers drawn twice; distances no race has.
  for (const d of live) {
    if (d.rDiscipline !== 'T') continue;
    const bars = running(d).map((r) => Number(r.bp)).filter((b) => b > 0 && b < 90);
    const dup = [...new Set(bars.filter((b, i) => bars.indexOf(b) !== i))];
    if (dup.length) add(d, 'race-data', `barrier ${dup.join(', ')} drawn twice`);
    const dist = Number(d.rDistance);
    const min = ['USA', 'MEX', 'CAN', 'PAN', 'BRZ', 'ARG', 'CHI'].includes(String(d.rCountry || '').toUpperCase()) ? 150 : 700; // quarter horses
    if (d.rDistance != null && d.rDistance !== '' && (!(dist > 0) || dist < min || dist > 7400)) add(d, 'race-data', `distance ${d.rDistance}m`);
  }
  return out;
}

// runner-id-clash: the day's runners against every race they're in over the
// surrounding weeks (hist: [{ rDate, rCountry, rDiscipline, rCourseDisplayName,
// rNo, isAbandoned, rStatus, runners: [{ runnerId, horseName, sex, isScratched }] }]).
// -> Map raceId -> [{ code, text }]
function idClashes(docs, hist) {
  const out = new Map();
  const seen = new Map(); // runnerId -> [{ date, country, region, disc, name, sex, scratched, where }]
  for (const h of hist) {
    if (isAbandoned(h)) continue;
    for (const r of h.runners || []) {
      if (!r || !r.runnerId) continue;
      if (!seen.has(r.runnerId)) seen.set(r.runnerId, []);
      seen.get(r.runnerId).push({
        id: h._id, date: h.rDate, country: h.rCountry, region: regionOf(h.rCountry), disc: h.rDiscipline,
        name: r.horseName, sex: String(r.sex || '').toUpperCase(), scratched: Boolean(r.isScratched), where: `${h.rCourseDisplayName} (${h.rCountry}) ${h.rDate}`,
      });
    }
  }
  for (const d of docs) {
    if (isAbandoned(d)) continue;
    const lines = [];
    for (const r of running(d)) {
      const runs = (seen.get(r.runnerId) || []).filter((x) => x.id !== d._id);
      if (!runs.length) continue;
      const me = { date: d.rDate, region: regionOf(d.rCountry), disc: d.rDiscipline, name: r.horseName, sex: String(r.sex || '').toUpperCase() };
      const why = [];
      const otherName = runs.find((x) => normName(x.name) && normName(me.name) && normName(x.name) !== normName(me.name));
      if (otherName) why.push(`also ${otherName.name} at ${otherName.where}`);
      const otherDisc = runs.find((x) => x.disc && me.disc && x.disc !== me.disc);
      if (otherDisc && !otherName) why.push(`also a ${otherDisc.disc === 'G' ? 'greyhound' : otherDisc.disc === 'H' ? 'harness' : 'galloper'} at ${otherDisc.where}`);
      const otherSex = runs.find((x) => (FEMALE.has(me.sex) && MALE.has(x.sex)) || (MALE.has(me.sex) && FEMALE.has(x.sex)));
      if (otherSex && !otherName) why.push(`${me.sex} here, ${otherSex.sex} at ${otherSex.where}`);
      const far = runs.filter((x) => !x.scratched && x.region !== me.region && x.date !== me.date)
        .map((x) => ({ x, days: Math.abs(Date.parse(x.date) - Date.parse(me.date)) / 86400000 }))
        .filter((y) => y.days <= FAR_RUN_MAX_DAYS)
        .sort((a, b) => a.days - b.days)[0];
      if (far && !otherName && !otherSex) why.push(`also ran at ${far.x.where}, ${far.days} day${far.days === 1 ? '' : 's'} apart`);
      if (why.length) lines.push(`${r.horseName || '?'}: ${why.join(', ')}`);
    }
    if (lines.length) out.set(d._id, [{ code: 'runner-id-clash', text: lines.join('; ') }]);
  }
  return out;
}

module.exports = { INTEGRITY_CHECKS, dayIntegrity, idClashes, parseUtc, utcOffsetMinutes };
