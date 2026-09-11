// One-off cleanup: prunes the 4 "ignore" override files down to only entries
// whose race is today or later, backing up the untouched originals into a
// timestamped zip first. Mirrors the exact FORM_IGNORE_PATH/AGE_IGNORE_PATH/
// DUP_JOCKEY_IGNORE_PATH/MISSING_JOCKEY_IGNORE_PATH env-var-or-default logic
// server.js itself uses, so it reads from wherever THIS server is actually
// configured to read/write them (not a hardcoded guess).
//
// HOW TO RUN THIS ON THE PRODUCTION SERVER:
//   1. Copy this file into the SAME folder as server.js on production
//      (needs ./db-config.js and node_modules/{mongodb,archiver} to already
//      be there, which they are since server.js itself depends on them).
//   2. Stop the WinSW service first (so nothing is writing to these files
//      while this runs).
//   3. Open a command prompt in that folder and run: node prune-ignores.js
//   4. Check the printed kept/archived counts look sane, then start the
//      WinSW service again.
//   5. Delete this file -- it's a one-off, not part of the app.
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { MongoClient } = require('mongodb');
const { loadConfig, extractConnectionString } = require('./db-config');

const DB_CONFIG_PATH = process.env.DB_CONFIG_PATH || 'C:\\Users\\Dinesh\\projects-config\\db.json';
const CONNECTION_NAME = process.env.DB_CONNECTION_NAME || 'mongodb-prod';
const TODAY = new Date().toISOString().slice(0, 10); // rDate strings are YYYY-MM-DD, so string comparison works

const FILES = {
  formLine: process.env.FORM_IGNORE_PATH || 'C:\\Users\\Dinesh\\projects-config\\form-line-ignores.json',
  age: process.env.AGE_IGNORE_PATH || 'C:\\Users\\Dinesh\\projects-config\\age-ignores.json',
  dupJockey: process.env.DUP_JOCKEY_IGNORE_PATH || 'C:\\Users\\Dinesh\\projects-config\\dup-jockey-ignores.json',
  missingJockey: process.env.MISSING_JOCKEY_IGNORE_PATH || 'C:\\Users\\Dinesh\\projects-config\\missing-jockey-ignores.json',
};

function loadJson(p) {
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  console.log('Reading ignore files from:');
  for (const [label, p] of Object.entries(FILES)) console.log(' ', label, '->', p);

  const config = loadConfig(DB_CONFIG_PATH);
  const { connectionString } = extractConnectionString(config, CONNECTION_NAME);
  const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db();

  const formLine = loadJson(FILES.formLine);
  const age = loadJson(FILES.age);
  const dupJockey = loadJson(FILES.dupJockey);
  const missingJockey = loadJson(FILES.missingJockey);

  const runnerIds = [...new Set([...Object.keys(formLine), ...Object.keys(age)])];
  const runnerIdToDate = new Map();
  if (runnerIds.length) {
    const races = await db.collection('races')
      .find({ 'runners.runnerId': { $in: runnerIds } })
      .project({ rDate: 1, 'runners.runnerId': 1 })
      .toArray();
    for (const race of races) {
      for (const r of (race.runners || [])) {
        if (r.runnerId && runnerIds.includes(r.runnerId)) runnerIdToDate.set(r.runnerId, race.rDate);
      }
    }
  }

  const raceIds = [...new Set([
    ...Object.keys(dupJockey).map((k) => k.split('|')[0]),
    ...Object.keys(missingJockey).map((k) => k.split('|')[0]),
  ])];
  const raceIdToDate = new Map();
  if (raceIds.length) {
    const races = await db.collection('races').find({ _id: { $in: raceIds } }).project({ rDate: 1 }).toArray();
    for (const race of races) raceIdToDate.set(race._id, race.rDate);
  }

  function splitByDate(obj, dateForKey) {
    const kept = {};
    const archived = {};
    for (const [key, value] of Object.entries(obj)) {
      const rDate = dateForKey(key);
      if (rDate && rDate >= TODAY) kept[key] = value;
      else archived[key] = value;
    }
    return { kept, archived };
  }

  const formLineSplit = splitByDate(formLine, (k) => runnerIdToDate.get(k));
  const ageSplit = splitByDate(age, (k) => runnerIdToDate.get(k));
  const dupJockeySplit = splitByDate(dupJockey, (k) => raceIdToDate.get(k.split('|')[0]));
  const missingJockeySplit = splitByDate(missingJockey, (k) => raceIdToDate.get(k.split('|')[0]));

  console.log('\nform-line-ignores.json:', Object.keys(formLine).length, 'total ->', Object.keys(formLineSplit.kept).length, 'kept,', Object.keys(formLineSplit.archived).length, 'archived');
  console.log('age-ignores.json:', Object.keys(age).length, 'total ->', Object.keys(ageSplit.kept).length, 'kept,', Object.keys(ageSplit.archived).length, 'archived');
  console.log('dup-jockey-ignores.json:', Object.keys(dupJockey).length, 'total ->', Object.keys(dupJockeySplit.kept).length, 'kept,', Object.keys(dupJockeySplit.archived).length, 'archived');
  console.log('missing-jockey-ignores.json:', Object.keys(missingJockey).length, 'total ->', Object.keys(missingJockeySplit.kept).length, 'kept,', Object.keys(missingJockeySplit.archived).length, 'archived');

  const zipDir = path.dirname(FILES.formLine);
  const zipPath = path.join(zipDir, `ignore-files-backup-${TODAY}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const p of Object.values(FILES)) {
      if (fs.existsSync(p)) archive.file(p, { name: path.basename(p) });
    }
    archive.finalize();
  });
  console.log('\nBackup zip written:', zipPath);

  fs.writeFileSync(FILES.formLine, JSON.stringify(formLineSplit.kept, null, 2), 'utf8');
  fs.writeFileSync(FILES.age, JSON.stringify(ageSplit.kept, null, 2), 'utf8');
  fs.writeFileSync(FILES.dupJockey, JSON.stringify(dupJockeySplit.kept, null, 2), 'utf8');
  fs.writeFileSync(FILES.missingJockey, JSON.stringify(missingJockeySplit.kept, null, 2), 'utf8');
  console.log('Pruned files written. Restart the WinSW service now.');

  await client.close();
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
