#!/bin/sh
# Points every state file at the /data volume (the app defaults are Windows
# paths) and seeds the first admin login from env on first boot.
set -e

D="${DATA_DIR:-/data}"
export AUTH_CONFIG_PATH="${AUTH_CONFIG_PATH:-$D/auth.json}"
export FORM_IGNORE_PATH="${FORM_IGNORE_PATH:-$D/form-line-ignores.json}"
export AGE_IGNORE_PATH="${AGE_IGNORE_PATH:-$D/age-ignores.json}"
export DUP_JOCKEY_IGNORE_PATH="${DUP_JOCKEY_IGNORE_PATH:-$D/dup-jockey-ignores.json}"
export MISSING_JOCKEY_IGNORE_PATH="${MISSING_JOCKEY_IGNORE_PATH:-$D/missing-jockey-ignores.json}"
export RUNNER_CHECK_IGNORE_PATH="${RUNNER_CHECK_IGNORE_PATH:-$D/runner-check-ignores.json}"
export MISSING_MEETING_IGNORE_PATH="${MISSING_MEETING_IGNORE_PATH:-$D/missing-meeting-ignores.json}"
export MISSING_MEETING_COUNTRIES_PATH="${MISSING_MEETING_COUNTRIES_PATH:-$D/missing-meeting-countries.json}"

if [ -z "$MONGODB_URI" ] && [ -z "$DB_CONFIG_PATH" ]; then
  echo "[entrypoint] ERROR: MONGODB_URI is not set" >&2
  exit 1
fi

mkdir -p "$D"

# First boot only: create the admin login. After that users are managed from
# the dashboard's admin page and stored in the volume.
if [ ! -f "$D/auth-users.json" ] && [ ! -f "$AUTH_CONFIG_PATH" ]; then
  if [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
    node -e '
      const bcrypt = require("bcryptjs");
      const crypto = require("crypto");
      const fs = require("fs");
      const e = process.env;
      const cfg = {
        sessionSecret: e.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
        users: [{ username: e.ADMIN_USERNAME, passwordHash: bcrypt.hashSync(e.ADMIN_PASSWORD, 10),
                  role: "admin", createdAt: new Date().toISOString() }],
      };
      fs.writeFileSync(e.AUTH_CONFIG_PATH, JSON.stringify(cfg, null, 2));
    '
    echo "[entrypoint] Created admin login '$ADMIN_USERNAME'"
  else
    echo "[entrypoint] WARNING: no login exists and ADMIN_USERNAME/ADMIN_PASSWORD not set - nobody can log in" >&2
  fi
fi

exec "$@"
