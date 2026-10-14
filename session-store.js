/**
 * Logins that survive a server restart (Oct 2026, with the installable app:
 * every deploy restarted the server and the old in-memory session store
 * logged everyone out).
 *
 * A small express-session store kept in sessions.json in the data folder.
 * A normal login is still a browser-session cookie (closing the browser logs
 * you out); the server forgets it after 12 hours without use. "Keep me
 * signed in" logins keep their cookie's 30-day expiry.
 */
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const IDLE_MS = 12 * 60 * 60 * 1000;
const WRITE_DELAY_MS = 2000;

class FileSessionStore extends session.Store {
  constructor({ file }) {
    super();
    this.file = file;
    this.data = {};
    this.timer = null;
    try {
      if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (err) {
      this.data = {};
    }
  }

  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires ? Date.parse(sess.cookie.expires) : NaN;
    return Number.isFinite(e) ? e : Date.now() + IDLE_MS;
  }

  persist() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      for (const [sid, e] of Object.entries(this.data)) if (!e || e.exp < now) delete this.data[sid];
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
        fs.renameSync(tmp, this.file);
      } catch (err) { /* logins still work from memory */ }
    }, WRITE_DELAY_MS);
  }

  get(sid, cb) {
    const e = this.data[sid];
    if (!e) return cb(null, null);
    if (e.exp < Date.now()) { delete this.data[sid]; this.persist(); return cb(null, null); }
    return cb(null, e.sess);
  }

  set(sid, sess, cb) {
    this.data[sid] = { sess, exp: this.expiry(sess) };
    this.persist();
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    const e = this.data[sid];
    if (e) { e.exp = this.expiry(sess); e.sess.cookie = sess.cookie; this.persist(); }
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    delete this.data[sid];
    this.persist();
    if (cb) cb(null);
  }
}

module.exports = { FileSessionStore };
