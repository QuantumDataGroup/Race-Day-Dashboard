/**
 * Shared MongoDB config-file loading helpers.
 *
 * Split out of server.js on 12 Aug 2026 so that manage-users.js (the CLI for
 * adding/removing dashboard login accounts) can connect to the same
 * database using the exact same config-file format/logic, without
 * duplicating it or accidentally letting the two copies drift apart.
 */

const fs = require('fs');

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    try {
      const wrapped = JSON.parse(`{${raw}}`);
      console.warn(`WARNING: ${configPath} is not valid JSON alone (missing outer "{ }"); recovered by wrapping. Please fix the source file.`);
      return wrapped;
    } catch (err2) {
      throw new Error(`${configPath} is not valid JSON and could not be recovered: ${err.message}`);
    }
  }
}

function extractConnectionString(config, preferredName) {
  const names = Object.keys(config);
  const ordered = preferredName ? [preferredName, ...names.filter((n) => n !== preferredName)] : names;
  for (const name of ordered) {
    const entry = config[name];
    const connStr = entry && entry.env && entry.env.MDB_MCP_CONNECTION_STRING;
    if (connStr) return { name, connectionString: connStr };
  }
  throw new Error('No MDB_MCP_CONNECTION_STRING found in config');
}

module.exports = { loadConfig, extractConnectionString };
