/**
 * Race Day Dashboard - User Manager
 * ---------------------------------
 * Adds, removes and changes dashboard logins -- one login per person. Run it
 * directly on the machine hosting the server:
 *
 *   node setup-auth.js
 *
 * It writes { sessionSecret, users: [{ username, passwordHash, role, createdAt }] }
 * (role "admin" can open the dashboard's user-activity page; "user" can't)
 * to AUTH_CONFIG_PATH (default C:\Thilina\Dinesh project\project - 1\auth.json
 * -- same folder as db.json on the production machine). Passwords are never
 * written anywhere -- only a securely-hashed (bcrypt) version, and this
 * script never sends a password anywhere over the network or through chat/AI.
 *
 * No server restart needed: the running dashboard picks up changes on the
 * next request, and a removed user is logged out on their next click.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { MIN_PASSWORD_LENGTH, USERNAME_RE, loadAuthFile, saveAuthFile, findUserIndex, activeAuthPath } = require('./auth-store');
const { activityLogDir, listMonthFiles, readEntries } = require('./activity-log');

const AUTH_CONFIG_PATH = process.env.AUTH_CONFIG_PATH || 'C:\\Thilina\\Dinesh project\\project - 1\\auth.json';
const ACTIVITY_LOG_DIR = activityLogDir(AUTH_CONFIG_PATH);
const ADMIN_BOOTSTRAP_PATH = path.join(__dirname, 'admin-bootstrap.json');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Prompts for a password without echoing it to the screen (shows "*" per
// character instead). Walks each stdin chunk character-by-character rather
// than assuming one event == one keystroke, since a multi-character chunk
// (paste, or non-interactive/piped input) would otherwise never match the
// newline check and hang forever.
function askPassword(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.resume();
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.setEncoding('utf8');

    let password = '';
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      const str = chunk.toString();
      for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char === '\n' || char === '\r' || char === '\u0004') { // Enter / Ctrl+D
          settled = true;
          cleanup();
          process.stdout.write('\n');
          resolve(password);
          return;
        }
        if (char === '\u0003') { // Ctrl+C
          settled = true;
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') { // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        password += char;
        process.stdout.write('*');
      }
    };
    function cleanup() {
      if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
      stdin.removeListener('data', onData);
      stdin.pause();
    }
    stdin.on('data', onData);
  });
}

// Edits whichever login file the dashboard is using (auth-users.json once
// the admin page has saved a change, otherwise auth.json).
function loadConfig() {
  return loadAuthFile(activeAuthPath(AUTH_CONFIG_PATH)) || { sessionSecret: crypto.randomBytes(32).toString('hex'), users: [] };
}

function saveConfig(config) {
  saveAuthFile(activeAuthPath(AUTH_CONFIG_PATH), config);
}

const findIndex = findUserIndex;

async function askNewPassword() {
  const password = await askPassword(`Password (at least ${MIN_PASSWORD_LENGTH} characters, hidden while typing): `);
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    console.log(`Password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was saved.`);
    return null;
  }
  const confirm = await askPassword('Confirm password: ');
  if (confirm !== password) {
    console.log('Passwords did not match. Nothing was saved.');
    return null;
  }
  return password;
}

function listUsers(config) {
  if (!config.users.length) {
    console.log('No users yet.');
    return;
  }
  console.log(`${config.users.length} user(s):`);
  config.users.forEach((u) => console.log(`  - ${String(u.username).padEnd(20)} ${u.role === 'admin' ? 'ADMIN' : 'user '}${u.createdAt ? `  (added ${u.createdAt.slice(0, 10)})` : ''}`));
}

function adminCount(config) {
  return config.users.filter((u) => u.role === 'admin').length;
}

async function addUser(config) {
  const username = (await ask('New username: ')).trim();
  if (!USERNAME_RE.test(username)) {
    console.log('Username must be 2-40 characters: letters, numbers, dot, dash or underscore. Nothing was saved.');
    return;
  }
  if (findIndex(config, username) !== -1) {
    console.log(`"${username}" already exists. Use "Change a password" instead.`);
    return;
  }
  const password = await askNewPassword();
  if (!password) return;
  const makeAdmin = /^y(es)?$/i.test((await ask('Make this user an ADMIN (can see every user\'s activity)? (y/N): ')).trim());
  config.users.push({ username, passwordHash: bcrypt.hashSync(password, 10), role: makeAdmin ? 'admin' : 'user', createdAt: new Date().toISOString() });
  saveConfig(config);
  console.log(`Added "${username}" as ${makeAdmin ? 'an ADMIN' : 'a normal user'}. They can log in now.`);
}

async function toggleAdmin(config) {
  const username = (await ask('Username: ')).trim();
  const idx = findIndex(config, username);
  if (idx === -1) {
    console.log(`No user called "${username}".`);
    return;
  }
  const user = config.users[idx];
  if (user.role === 'admin') {
    if (adminCount(config) === 1) {
      console.log(`"${user.username}" is the only admin -- make someone else an admin first.`);
      return;
    }
    user.role = 'user';
    console.log(`"${user.username}" is now a normal user.`);
  } else {
    user.role = 'admin';
    console.log(`"${user.username}" is now an ADMIN.`);
  }
  saveConfig(config);
}

async function changePassword(config) {
  const username = (await ask('Username: ')).trim();
  const idx = findIndex(config, username);
  if (idx === -1) {
    console.log(`No user called "${username}".`);
    return;
  }
  const password = await askNewPassword();
  if (!password) return;
  config.users[idx].passwordHash = bcrypt.hashSync(password, 10);
  config.users[idx].sessionVersion = (config.users[idx].sessionVersion || 0) + 1;
  saveConfig(config);
  console.log(`Password changed for "${config.users[idx].username}".`);
}

async function removeUser(config) {
  const username = (await ask('Username to remove: ')).trim();
  const idx = findIndex(config, username);
  if (idx === -1) {
    console.log(`No user called "${username}".`);
    return;
  }
  if (config.users.length === 1) {
    console.log('That is the only user -- add another user first, otherwise nobody could log in.');
    return;
  }
  if (config.users[idx].role === 'admin' && adminCount(config) === 1) {
    console.log('That is the only admin -- make someone else an admin first.');
    return;
  }
  const name = config.users[idx].username;
  const sure = await ask(`Remove "${name}"? They will be logged out on their next click. (y/N): `);
  if (!/^y(es)?$/i.test(sure.trim())) {
    console.log('Cancelled.');
    return;
  }
  config.users.splice(idx, 1);
  saveConfig(config);
  console.log(`Removed "${name}".`);
}

function showActivity() {
  const files = listMonthFiles(ACTIVITY_LOG_DIR).slice(-2);
  const entries = files.flatMap((f) => readEntries(f.path, 1024 * 1024)).slice(-40);
  if (!entries.length) {
    console.log(`No activity recorded yet (${ACTIVITY_LOG_DIR}).`);
    return;
  }
  console.log(`Last ${entries.length} entries from ${ACTIVITY_LOG_DIR}:`);
  entries.forEach((e) => {
    const who = e.user || e.attemptedUser || '-';
    console.log(`  ${String(e.time).replace('T', ' ').slice(0, 19)}  ${String(who).padEnd(14)} ${String(e.action).padEnd(18)} ${e.file || e.detail || ''}  ${e.ip || ''}`);
  });
}

// `node setup-auth.js --bootstrap`: for when there's no admin yet and no
// RDP access to the server. Writes admin-bootstrap.json (hashed password
// only) next to this script; upload it by FTP to the dashboard folder and
// the server makes that user an admin on its next request, then deletes it.
async function bootstrap() {
  console.log('Race Day Dashboard - First admin file');
  console.log('-------------------------------------');
  const entered = (await ask('Admin username [Dinesh]: ')).trim();
  const username = entered || 'Dinesh';
  if (!USERNAME_RE.test(username)) {
    console.log('Username must be 2-40 characters: letters, numbers, dot, dash or underscore. Nothing was saved.');
    return;
  }
  const password = await askNewPassword();
  if (!password) return;
  fs.writeFileSync(ADMIN_BOOTSTRAP_PATH, JSON.stringify({ username, passwordHash: bcrypt.hashSync(password, 10) }, null, 2), 'utf8');
  console.log(`\nCreated ${ADMIN_BOOTSTRAP_PATH}`);
  console.log('Next: upload admin-bootstrap.json by FTP into the dashboard folder on the server (same folder as server.js),');
  console.log(`then open the dashboard website once. "${username}" becomes an admin and the server deletes the file.`);
  console.log('Delete the local copy afterwards too.');
}

async function main() {
  if (process.argv.includes('--bootstrap')) {
    try {
      await bootstrap();
    } catch (err) {
      console.log(err.message === 'Cancelled' ? 'Cancelled. Nothing was saved.' : `Error: ${err.message}`);
    }
    process.exit(0);
  }
  console.log('Race Day Dashboard - User Manager');
  console.log('---------------------------------');
  console.log(`Login file: ${activeAuthPath(AUTH_CONFIG_PATH)}\n`);
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Could not read ${AUTH_CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }

  for (;;) {
    console.log('\n1) List users\n2) Add a user\n3) Change a password\n4) Make admin / remove admin\n5) Remove a user\n6) Show recent activity\n7) Exit');
    const choice = (await ask('Choose 1-7: ')).trim();
    try {
      if (choice === '1') listUsers(config);
      else if (choice === '2') await addUser(config);
      else if (choice === '3') await changePassword(config);
      else if (choice === '4') await toggleAdmin(config);
      else if (choice === '5') await removeUser(config);
      else if (choice === '6') showActivity();
      else if (choice === '7' || choice === '') break;
      else console.log('Please type a number from 1 to 7.');
    } catch (err) {
      console.log(err.message === 'Cancelled' ? 'Cancelled. Nothing was saved.' : `Error: ${err.message}`);
    }
  }
  // Explicitly exit rather than relying on the event loop draining -- stdin
  // (used for the masked password prompts above) can be left in a state
  // that keeps the process alive otherwise.
  process.exit(0);
}

main();
