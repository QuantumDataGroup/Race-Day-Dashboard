/**
 * ClickUp tickets for data issues (Oct 2026, per Dinesh: the team raises a
 * ClickUp ticket for every data issue; every ticket is assigned to him).
 *
 * Config (server environment, never in code or chat):
 *   CLICKUP_API_TOKEN  personal or service-user API token
 *   CLICKUP_LIST_ID    the List the data-issue tickets live in
 * Without both, everything here reports "not connected" and makes no calls.
 *
 * tickets.json (data folder) remembers what ClickUp doesn't: which dashboard
 * issue a ticket was raised for (so it isn't raised twice), which dashboard
 * user raised it (the API token's owner is ClickUp's creator), reminders
 * sent, and tickets an admin chose to ignore on the dashboard.
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.clickup.com/api/v2';
// Reminders while a ticket sits in To Do: after 1, 2, 3, 6, 12 and 24 hours,
// then once a day (11 Oct 2026, per Dinesh: "1, 2, 3, 6, 12, 24").
const REMINDER_HOURS = [1, 2, 3, 6, 12, 24];
const TASKS_FRESH_MS = 60 * 1000;
const MEMBERS_FRESH_MS = 60 * 60 * 1000;

function remindersDue(ageHours) {
  let n = REMINDER_HOURS.filter((h) => ageHours >= h).length;
  if (ageHours >= 48) n += Math.floor((ageHours - 24) / 24);
  return n;
}

function nextReminderHours(sent) {
  if (sent < REMINDER_HOURS.length) return REMINDER_HOURS[sent];
  return 24 + (sent - REMINDER_HOURS.length + 1) * 24;
}

// "to do" / "in progress" / "review" / "done". Only a closed status counts as
// done: the team list (Race Day Dashboard Issues, Oct 2026) has Backlog, To
// Do, In Progress, Need Update, On Hold, Review and Done, and ClickUp files
// Review under its "done" group, so that type means review here.
const IN_PROGRESS_STATUSES = ['in progress', 'need update', 'on hold'];
function statusKey(task) {
  const s = String((task.status && task.status.status) || '').trim().toLowerCase();
  const type = task.status && task.status.type;
  if (type === 'closed' || s === 'done' || s === 'complete' || s === 'closed') return 'done';
  if (s === 'review' || s === 'in review' || type === 'done') return 'review';
  if (IN_PROGRESS_STATUSES.includes(s)) return 'in_progress';
  return 'todo';
}
// New tickets start in To Do, not the list's first status (Backlog).
const NEW_TICKET_STATUS = 'to do';
const REPORT_TAG = 'report';

function createClickUp({ dir, env = process.env, fetchImpl = fetch, now = () => Date.now() }) {
  const token = env.CLICKUP_API_TOKEN || '';
  const listId = env.CLICKUP_LIST_ID || '';
  const baseUrl = (env.CLICKUP_API_BASE || API).replace(/\/$/, '');
  const enabled = Boolean(token && listId);
  // Critical race alerts go to a ClickUp Chat channel (Oct 2026, per Dinesh):
  // "Race day dashboard - Alert" (15 Oct 2026; was "- Issues") in the Quantum Data Group workspace unless
  // the server says otherwise; CLICKUP_CHAT_CHANNEL_ID=off turns them off.
  const workspaceId = env.CLICKUP_WORKSPACE_ID || '90161415163';
  const chatChannelId = env.CLICKUP_CHAT_CHANNEL_ID || '2kz0m0zv-12256';
  const chatEnabled = enabled && chatChannelId !== 'off';
  // The weekly report goes to Dinesh's "Weekly data report" channel (27 Oct
  // 2026; "RDD - Weekly Update" before); CLICKUP_REPORT_CHANNEL_ID overrides,
  // "off" stops it.
  const reportChannelId = env.CLICKUP_REPORT_CHANNEL_ID || '2kz0m0zv-12556';
  const reportChatEnabled = enabled && reportChannelId !== 'off';
  const v3Url = baseUrl.replace(/\/api\/v2$/, '/api/v3');
  const storePath = path.join(dir, 'tickets.json');
  let store = { byTask: {}, byIssue: {}, ignored: {}, reports: {} };
  try {
    if (fs.existsSync(storePath)) store = { ...store, ...JSON.parse(fs.readFileSync(storePath, 'utf8')) };
  } catch (err) {
    console.warn(`[race-dashboard] WARNING: could not read ${storePath}: ${err.message} -- starting with no ticket links`);
  }
  let tasksCache = null;
  let membersCache = null;
  let lastError = null;

  function save() {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, storePath);
  }

  async function api(method, urlPath, body) {
    if (!enabled) throw new Error('ClickUp is not connected (CLICKUP_API_TOKEN / CLICKUP_LIST_ID not set)');
    let res;
    try {
      res = await fetchImpl(/^https?:/.test(urlPath) ? urlPath : `${baseUrl}${urlPath}`, {
        method,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      lastError = `ClickUp not reachable: ${err.message}`;
      throw new Error(lastError);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!res.ok) {
      lastError = `ClickUp answered ${res.status}${json && json.err ? `: ${json.err}` : ''}`;
      throw new Error(lastError);
    }
    lastError = null;
    return json;
  }

  async function members() {
    if (membersCache && now() - membersCache.at < MEMBERS_FRESH_MS) return membersCache.list;
    const json = await api('GET', `/list/${encodeURIComponent(listId)}/member`);
    const list = (json.members || []).map((m) => ({ id: m.id, name: m.username || m.email, email: String(m.email || '').toLowerCase() }));
    membersCache = { at: now(), list };
    return list;
  }

  async function memberByEmail(email) {
    if (!email) return null;
    const wanted = String(email).trim().toLowerCase();
    return (await members()).find((m) => m.email === wanted) || null;
  }

  async function allPages(query) {
    const out = [];
    for (let page = 0; page < 20; page++) {
      const json = await api('GET', `/list/${encodeURIComponent(listId)}/task?subtasks=true&page=${page}&${query}`);
      out.push(...(json.tasks || []));
      if (json.last_page !== false || !(json.tasks || []).length) break;
    }
    return out;
  }

  function isReportTask(t) {
    return Boolean(store.reports && store.reports[t.id]) || (t.tags || []).some((g) => g && g.name === REPORT_TAG);
  }

  // Every open task in the list, plus tasks closed in the last 14 days.
  async function tasks(fresh) {
    if (!fresh && tasksCache && now() - tasksCache.at < TASKS_FRESH_MS) return tasksCache.list;
    const open = await allPages('include_closed=false');
    const recent = await allPages(`include_closed=true&date_updated_gt=${now() - 14 * 86400000}`);
    const byId = new Map();
    // The daily / weekly report tasks share the list but aren't tickets.
    for (const t of [...open, ...recent]) if (!isReportTask(t)) byId.set(t.id, t);
    const list = [...byId.values()];
    tasksCache = { at: now(), list };
    return list;
  }

  // A ticket as the dashboard shows it.
  function view(task) {
    const link = store.byTask[task.id] || {};
    const created = Number(task.date_created) || null;
    const ageHours = created ? (now() - created) / 3600000 : 0;
    const status = statusKey(task);
    return {
      id: task.id,
      name: task.name,
      url: task.url || null,
      status,
      statusLabel: (task.status && task.status.status) || '',
      createdAt: created ? new Date(created).toISOString() : null,
      updatedAt: Number(task.date_updated) ? new Date(Number(task.date_updated)).toISOString() : null,
      ageHours: Math.round(ageHours * 10) / 10,
      assignees: (task.assignees || []).map((a) => ({ id: a.id, name: a.username || a.email, email: String(a.email || '').toLowerCase() })),
      creatorEmail: String((task.creator && task.creator.email) || '').toLowerCase(),
      raisedBy: link.raisedBy || null,
      raisedOnDashboard: Boolean(link.raisedBy),
      issueKey: link.issueKey || null,
      raceDate: link.raceDate || null,
      raceUrl: link.raceUrl || null,
      remindersSent: link.reminders || 0,
      nextReminderHours: status === 'todo' ? nextReminderHours(link.reminders || 0) : null,
      ignored: Boolean(store.ignored[task.id]),
    };
  }

  // The open ticket already raised for an issue, if any.
  async function ticketForIssue(issueKey, fresh) {
    const id = store.byIssue[issueKey];
    if (!id) return null;
    const t = (await tasks(fresh)).find((x) => x.id === id);
    if (!t || statusKey(t) === 'done') return null;
    return view(t);
  }

  async function createTicket({ issueKey, raceDate, raceUrl, title, details, priority, raisedBy, ownerEmail, developerId, tags }) {
    // Fresh from ClickUp: a ticket just closed there must not block a new one.
    const existing = issueKey ? await ticketForIssue(issueKey, true) : null;
    if (existing) return { duplicate: true, ticket: existing };
    const owner = await memberByEmail(ownerEmail);
    const assignees = [owner && owner.id, developerId ? Number(developerId) : null].filter(Boolean);
    const body = {
      name: String(title).slice(0, 250),
      markdown_description: String(details || '').slice(0, 8000),
      assignees: [...new Set(assignees)],
      tags: (tags || []).slice(0, 8),
      priority: { urgent: 1, high: 2, normal: 3, low: 4 }[priority] || 3,
    };
    let task;
    try {
      task = await api('POST', `/list/${encodeURIComponent(listId)}/task`, { ...body, status: NEW_TICKET_STATUS });
    } catch (err) {
      // A list without a "to do" status: the list's own first status then.
      if (!/status/i.test(err.message)) throw err;
      task = await api('POST', `/list/${encodeURIComponent(listId)}/task`, body);
    }
    store.byTask[task.id] = { issueKey: issueKey || null, raceDate: raceDate || null, raceUrl: raceUrl || null, raisedBy, raisedAt: new Date(now()).toISOString(), reminders: 0 };
    if (issueKey) store.byIssue[issueKey] = task.id;
    save();
    tasksCache = null;
    return { duplicate: false, ticket: view(task) };
  }

  async function addDeveloper(taskId, developerId, byUser) {
    const dev = (await members()).find((m) => String(m.id) === String(developerId));
    if (!dev) throw new Error('No such ClickUp member in this list');
    await api('PUT', `/task/${encodeURIComponent(taskId)}`, { assignees: { add: [dev.id] } });
    await api('POST', `/task/${encodeURIComponent(taskId)}/comment`, { comment_text: `${dev.name} is looking at this (assigned by ${byUser} from the Race Day Dashboard).`, notify_all: true });
    tasksCache = null;
    return dev;
  }

  function setIgnored(taskId, ignored, byUser) {
    if (ignored) store.ignored[taskId] = { by: byUser, at: new Date(now()).toISOString() };
    else delete store.ignored[taskId];
    save();
  }

  // Comments a reminder on every To Do ticket that is due one. Returns how
  // many were sent.
  async function sendReminders() {
    if (!enabled) return 0;
    let sent = 0;
    for (const t of await tasks(true)) {
      if (statusKey(t) !== 'todo') continue;
      const created = Number(t.date_created);
      if (!created) continue;
      const ageHours = (now() - created) / 3600000;
      const link = store.byTask[t.id] || (store.byTask[t.id] = { reminders: 0, external: true });
      // A ticket raised before the dashboard watched it starts from its age today.
      if (link.external && link.reminders === 0 && !link.watchedFrom) {
        link.watchedFrom = new Date(now()).toISOString();
        link.reminders = Math.max(0, remindersDue(ageHours) - 1);
      }
      if (remindersDue(ageHours) <= (link.reminders || 0)) continue;
      const waited = ageHours >= 48 ? `${Math.floor(ageHours / 24)} days` : `${Math.floor(ageHours)} h`;
      try {
        await api('POST', `/task/${encodeURIComponent(t.id)}/comment`, {
          comment_text: `Reminder: this data issue has been in To Do for ${waited}. (Race Day Dashboard)`,
          notify_all: true,
        });
        link.reminders = (link.reminders || 0) + 1;
        link.lastReminderAt = new Date(now()).toISOString();
        sent++;
      } catch (err) {
        console.warn(`[race-dashboard] WARNING: ClickUp reminder for ${t.id} failed: ${err.message}`);
      }
    }
    save();
    return sent;
  }

  // A message in a Chat channel (markdown) -- the alerts channel unless
  // another is given. ClickUp shows it as from the API token's owner.
  async function postChat(text, channelId) {
    const channel = channelId || chatChannelId;
    if (!enabled || !channel || channel === 'off') throw new Error('ClickUp Chat is off');
    await api('POST', `${v3Url}/workspaces/${encodeURIComponent(workspaceId)}/chat/channels/${encodeURIComponent(channel)}/messages`, {
      type: 'message', content: String(text).slice(0, 39000), content_format: 'text/md',
    });
  }

  // The daily / weekly report: a task in the list (tagged "report", assigned
  // to the owner, kept out of the tickets pages and reminders) with the PDF
  // attached. Returns { id, url }.
  async function createReportTask({ name, markdown, pdf, filename, ownerEmail, kind }) {
    const owner = await memberByEmail(ownerEmail).catch(() => null);
    const body = {
      name: String(name).slice(0, 250),
      markdown_description: String(markdown || '').slice(0, 8000),
      assignees: owner ? [owner.id] : [],
      tags: [REPORT_TAG],
      priority: 4,
    };
    let task;
    try {
      task = await api('POST', `/list/${encodeURIComponent(listId)}/task`, { ...body, status: NEW_TICKET_STATUS });
    } catch (err) {
      if (!/status/i.test(err.message)) throw err;
      task = await api('POST', `/list/${encodeURIComponent(listId)}/task`, body);
    }
    store.reports = store.reports || {};
    store.reports[task.id] = { kind: kind || 'report', at: new Date(now()).toISOString() };
    save();
    if (pdf) {
      const form = new FormData();
      form.append('attachment', new Blob([pdf], { type: 'application/pdf' }), filename || 'report.pdf');
      const res = await fetchImpl(`${baseUrl}/task/${encodeURIComponent(task.id)}/attachment`, {
        method: 'POST', headers: { Authorization: token }, body: form, signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        lastError = `ClickUp attachment answered ${res.status}`;
        throw new Error(`${lastError} (task ${task.id} was created)`);
      }
      let att = null;
      try { att = await res.json(); } catch (e) { /* no link back */ }
      return { id: task.id, url: task.url || null, pdfUrl: (att && (att.url || att.url_w_query)) || null };
    }
    return { id: task.id, url: task.url || null, pdfUrl: null };
  }

  function status() {
    return { enabled, listId: enabled ? listId : null, chat: chatEnabled ? chatChannelId : null, lastError };
  }

  return { enabled, chatEnabled, reportChannelId: reportChatEnabled ? reportChannelId : null, status, members, memberByEmail, tasks, view, ticketForIssue, createTicket, addDeveloper, setIgnored, sendReminders, postChat, createReportTask, store: () => store };
}

module.exports = { createClickUp, statusKey, remindersDue, nextReminderHours, REMINDER_HOURS };
