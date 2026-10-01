/**
 * Shared reading/writing of the dashboard's login files (auth.json and
 * auth-users.json, see activeAuthPath), used by both server.js and
 * setup-auth.js so the two can't drift apart.
 *
 * File shape: { sessionSecret, users: [{ username, passwordHash, role, createdAt }] }
 * role is "admin" or "user". A pre-29-Sep-2026 single-login file
 * ({ username, passwordHash, sessionSecret }) is read as a one-user list and
 * saved in the new shape on the next change.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_RE = /^[A-Za-z0-9._-]{2,40}$/;

function loadAuthFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(parsed.users)
    ? parsed.users
    : [{ username: parsed.username, passwordHash: parsed.passwordHash }];
  const users = list
    .filter((u) => u && u.username && u.passwordHash)
    .map((u) => ({ ...u, role: u.role === 'admin' ? 'admin' : 'user' }));
  return { sessionSecret: parsed.sessionSecret || crypto.randomBytes(32).toString('hex'), users };
}

// Written to a temp file first and renamed over the real one, so a crash
// mid-write can never leave a half-written auth.json that locks everyone out.
// On production the service account may write to an auth.json uploaded by
// FTP but not replace it (29 Sep 2026: the rename failed and left
// auth.json.tmp behind), so it then falls back to overwriting in place.
function saveAuthFile(filePath, config) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify({ sessionSecret: config.sessionSecret, users: config.users }, null, 2);
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.writeFileSync(filePath, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch (e) { /* not ours to remove */ }
  }
}

// Users changed from the admin page are saved to auth-users.json next to
// auth.json, a file the server creates itself: on production the service
// account can't modify an auth.json uploaded by FTP (29 Sep 2026). Once
// auth-users.json exists it is the one in use; auth.json only seeds it.
function usersFilePath(authConfigPath) {
  return process.env.AUTH_USERS_PATH || path.join(path.dirname(authConfigPath), 'auth-users.json');
}
function activeAuthPath(authConfigPath) {
  const usersPath = usersFilePath(authConfigPath);
  return fs.existsSync(usersPath) ? usersPath : authConfigPath;
}

function findUserIndex(config, username) {
  if (!config || typeof username !== 'string') return -1;
  const wanted = username.trim().toLowerCase();
  return config.users.findIndex((u) => String(u.username).toLowerCase() === wanted);
}

module.exports = { MIN_PASSWORD_LENGTH, USERNAME_RE, loadAuthFile, saveAuthFile, findUserIndex, usersFilePath, activeAuthPath };
