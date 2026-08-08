/**
 * Race Day Dashboard - Login Setup
 * ---------------------------------
 * One-time (or run-again-anytime) script to set/change the dashboard's
 * shared login username and password. Run it directly on the machine
 * hosting the server:
 *
 *   node setup-auth.js
 *
 * It writes { username, passwordHash, sessionSecret } to AUTH_CONFIG_PATH
 * (default C:\Users\Dinesh\projects-config\auth.json -- same folder as
 * db.json, outside the project folder so it can never be accidentally
 * committed to git). The password itself is never written anywhere -- only
 * a securely-hashed (bcrypt) version, and this script never sends the
 * password anywhere over the network or through chat/AI.
 *
 * After running this, restart the dashboard server (close and re-run
 * run.bat, or restart `node server.js`) for the new login to take effect.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const AUTH_CONFIG_PATH = process.env.AUTH_CONFIG_PATH || 'C:\\Users\\Dinesh\\projects-config\\auth.json';

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

async function main() {
  console.log('Race Day Dashboard - Login Setup');
  console.log('----------------------------------');
  console.log(`This writes the dashboard's login (username + securely-hashed password) to:\n  ${AUTH_CONFIG_PATH}\n`);

  let existing = null;
  if (fs.existsSync(AUTH_CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.warn(`(Existing file at ${AUTH_CONFIG_PATH} could not be read as JSON -- it will be replaced.)`);
    }
    if (existing && existing.username) {
      console.log(`A login is already configured (username: "${existing.username}").`);
      const proceed = await ask('Overwrite it with a new username/password? (y/N): ');
      if (!/^y(es)?$/i.test((proceed || '').trim())) {
        console.log('Cancelled -- existing login left unchanged.');
        process.exit(0);
      }
    }
  }

  const username = (await ask('Choose a username: ')).trim();
  if (!username) {
    console.error('Username cannot be empty. Nothing was saved.');
    process.exit(1);
  }

  let password;
  let confirm;
  try {
    password = await askPassword('Choose a password (hidden while typing): ');
    if (!password || password.length < 6) {
      console.error('\nPassword must be at least 6 characters. Nothing was saved.');
      process.exit(1);
    }
    confirm = await askPassword('Confirm password: ');
  } catch (err) {
    console.error('Cancelled. Nothing was saved.');
    process.exit(1);
  }
  if (confirm !== password) {
    console.error('Passwords did not match. Nothing was saved -- run this again.');
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const sessionSecret = (existing && existing.sessionSecret) || crypto.randomBytes(32).toString('hex');

  const dir = path.dirname(AUTH_CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify({ username, passwordHash, sessionSecret }, null, 2), 'utf8');

  console.log(`\nDone. Login saved to ${AUTH_CONFIG_PATH}`);
  console.log('Restart the dashboard server (close and re-run run.bat, or restart "node server.js") for it to take effect.');
  console.log('Note: only a securely-hashed version of the password was saved -- the plaintext password is not stored anywhere.');
  // Explicitly exit rather than relying on the event loop draining -- stdin
  // (used for the masked password prompts above) can be left in a state
  // that keeps the process alive otherwise, especially for non-interactive
  // input.
  process.exit(0);
}

main();
