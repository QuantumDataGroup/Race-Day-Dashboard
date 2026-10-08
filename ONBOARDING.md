# Race Day Dashboard — Handover / Technical Documentation

A single-server Node.js/Express app that shows one day's horse/harness/greyhound
race schedule as a **Meeting × Race-number grid**, flags data-quality problems
automatically, and lets you click through to full race and runner detail.

Production URL: `https://racedaydashboard.troyendata.com/`

---

## 1. Architecture — what each file does

```
server.js            Express routes, MongoDB queries, external-API fetches,
                      all the "attach a status flag to this doc" functions,
                      report/export generation (CSV/Excel/JSON/PDF), auth.
raceView.js           Pure functions, no DB/network access: turns raw race
                      docs into the schedule grid, the race/runner detail
                      payload, and renders every HTML page from templates.
                      Also home of every data-quality-check RULE (thresholds,
                      "what counts as an issue").
db-config.js          Shared helper: reads db.json, extracts a Mongo
                      connection string by connection name.
setup-auth.js         Run manually on the server to set/change the
                      dashboard's single login username + password.
prune-ignores.js       One-off cleanup utility (see §12) — not part of the
                      running app.
run.bat               Convenience local launcher (installs deps, starts
                      server.js, opens Chrome). NOT what production uses —
                      production runs as a WinSW Windows Service instead
                      (see §10).
views/dashboard.html  Main page template + ALL client-side JavaScript
                      (silk rendering, popups, filters, search, exports,
                      the Speed Map bar chart, the Chart tab's SVG, etc.)
views/login.html      Login page template.
views/meetings-list.html  Date-range "flat list of meetings" page template.
public/styles.css     All CSS (dark/light theme via CSS variables).
public/logo.png       Brand mark, also used as the browser-tab favicon.
public/discipline-icons/, public/silks/, public/greyhound-silks/,
public/speedmap-icons/   Static image assets referenced by the pages above.
```

Every template file under `views/` and `raceView.js`/`server.js` themselves
are loaded ONCE via `fs.readFileSync` at server startup — **editing any of
these requires a full process restart** to take effect. `public/styles.css`
is the one exception: it's served fresh on every request via
`express.static`, so a plain browser refresh picks up CSS changes without a
restart (a restart is still harmless/recommended for consistency).

---

## 2. Data sources

### MongoDB
- Connection: via `db-config.js`, reading a config file (see §10) for a
  connection string keyed by name **`mongodb-prod`**.
- Database: whatever the connection string's own path segment points to
  (confirmed in production: **`Troyen_Prod`**).
- Collections actually read by this app:
  - **`races`** — the core collection. One document per race, with a
    `runners[]` array embedded inside (tabNo, horseName, jockey, trainer,
    isScratched, age, sex, bp, fp, colors/silk description, etc.). Every
    discipline (Thoroughbred/Harness/Greyhound) lives here.
  - **`racecards`** — **Thoroughbred only**. A richer per-runner feed
    (multiple "Style/Client" source variants per race) with sire/dam,
    pastRaces (FormLines), performanceStatistics, runnerComment,
    currentOdds, weightKg, form-figures, race-level comment/weather. Joined
    onto the `races` doc by `RaceId`/`RunnerId` in `attachFormLineStatus`.
  - **`datadumps`** — a separate, richer per-runner feed (used for the raw
    "Data Dump" debug tab and as a fallback source for narrative comments).
  - **`meetings`** — one doc per meeting: `isTAB`, `isHidden`,
    `rsMeetingId` and `tabMeetingId` (two DIFFERENT external-system ids,
    see the Speed Map / Scratchings checks below — do not confuse them).
  - **`speedMaps`** — one doc per race (`rId` == `races._id`), with a
    `predictions[]` array of per-runner barrier/settling/closing speed
    measures + a pace rating/category. Only fetched for the single race a
    popup is open on, not the whole grid.

### External HTTP APIs (fetched server-side, per date)
- **Speed Map source**: `http://57.181.204.168:8085/getStatsGrey/{date}`
  — Greyhound-only predictions feed. Each row's `EventID` is shaped
  `"<rsMeetingId>:<raceNo>"`; joined to our own races via
  `meetings.rsMeetingId` (verified exact match against real data).
- **Scratchings source**:
  `http://57.181.204.168:8085/getScratchingsGrey/{date}` — covers ALL
  three disciplines. Each meeting's `MeetingID` matches
  `meetings.tabMeetingId` (**not** `rsMeetingId` — a different id space,
  confirmed against real meetings). Runners inside are matched to our own
  by tab/box number (`RunnerNo` ↔ `tabNo`).
- **Video listing**: `https://s3.troyendata.com/rob-rp-videos/` — an S3
  bucket file listing, used to check whether a video exists for
  today's race (by building the expected S3 key from
  date+country+course+race-number) and for past races (by horse's region).
- **Country flags** (client-side only, not fetched by the server):
  `https://flagcdn.com/20x15/{iso2}.png` — a free public flag-image CDN.

### Local JSON config/override files (all outside the git repo — see §10)
- `db.json` — Mongo connection string(s).
- `auth.json` — dashboard login (`username`, bcrypt `passwordHash`,
  session secret).
- `form-line-ignores.json`, `age-ignores.json`, `dup-jockey-ignores.json`,
  `missing-jockey-ignores.json` — the four manual "Confirm/Ignore" override
  stores (see §6).

---

## 3. How the schedule grid gets built (request lifecycle for `/`)

1. `fetchRaceDocs(dateStr, includeTrials)` (server.js) queries `races` for
   that date, joins in `meetings` extras (isTAB/isHidden/rsMeetingId/
   tabMeetingId), then runs 4 "attach a status" passes in parallel:
   `attachFormLineStatus` (racecards join, Thoroughbred only),
   `attachVideoStatus` (S3 listing), `attachSpeedMapStatus` (external Speed
   Map feed, Greyhound only), `attachScratchingStatus` (external
   Scratchings feed, all disciplines). A 60-second in-memory cache
   (`raceDocsCache`, keyed by `date|includeTrials`) avoids re-querying Mongo
   on every request.
2. `buildSchedule(docs, dateStr)` (raceView.js) groups races into meetings
   (course+country+discipline), computes every per-race and per-meeting
   issue flag (§4), and produces the `{ byDiscipline, countries }`
   structure the grid is rendered from.
3. `renderHtml(...)` fills the `views/dashboard.html` template.

**Speed (1 Oct 2026).** Everything slow goes through `cached()` in
server.js: fresh for a short TTL, then the old value is served instantly
while one background refresh runs. The day's race docs (60 s fresh, 10 min
stale), each race popup (30 s / 60 s), the three external feeds (per date,
shared by the grid and popups), search and the Upcoming ticker. Manual
confirms are applied on every read (`applyAllIgnores`), so nothing has to
clear the cache. The grid reads a light racecards aggregation (form-line
counts + comments, ~3 MB) instead of full past-race history (~49 MB);
only the popup loads full racecards. Today's data is kept warm while the
dashboard has been used in the last 30 min, and opening a race prefetches
the other races at that meeting. Measured: cold dashboard 43 s → instant
for today (15 s for a date nobody has opened yet), race popup 3-5 s → 1.2 s
first time, instant after.

Clicking a race calls `GET /api/race/:id` → `fetchRaceById` (a DIFFERENT,
single-race fetch path — same racecards/video/speedMap/scratchings joins,
but scoped to one race, no 60s cache) → `buildRaceDetail` → returned as
JSON and rendered client-side into the popup (or, via a `/race/...`
link, as a full standalone page — see §7).

---

## 4. Data-quality checks — the complete list

Every check below can be filtered on via the dashboard's **"All Issues"**
dropdown, and a meeting's Status column (✓ / ⚠) opens a race-by-race
breakdown of exactly which checks fired.

| Check | Scope | Discipline | Trigger |
|---|---|---|---|
| **Missing Jockey** | per-runner (meeting flagged if >0 in any race) | Thoroughbred + Harness only | `jockey` field blank, and not manually confirmed-no-issue |
| **Duplicate Jockey** | per-runner | T + H only | Same (non-placeholder) jockey name assigned to more than one runner in the same race |
| **Missing/Duplicate TAB number** | per-runner | all | Runner has no tab number, or shares one with another runner in the race |
| **Missing Trainer** | per-runner | all | `trainer` field blank |
| **Missing Form Lines** | per-race count, meeting flagged if count > 3 | Thoroughbred only | Runner has no racecards FormLines data from ANY feed variant |
| **Horse Age Issue** | per-runner | Thoroughbred only | Age > 10 years, and not manually confirmed-no-issue |
| **Missing Runner Comment** | per-runner | Thoroughbred only | No `runnerComment` on the racecards join |
| **Missing Race Comment** | per-race | Thoroughbred only | No race-level narrative comment |
| **Missing Video** | per-race, TODAY's date only | Thoroughbred, AUS/GB/SAF/IRE | No matching file in the S3 video listing |
| **Missing Speed Map** | per-race | Greyhound only | The external Speed Map feed HAS a prediction for this race, but our own `speedMaps` collection doesn't (a genuine sync gap, not "no prediction made yet") |
| **Scratching Not Updated** | per-race AND per-runner | all | The external Scratchings feed lists a runner (by tab/box number) as scratched, but our own race doc doesn't have that runner marked `isScratched` yet |
| **Results Missing** | per-race | all | This race has no result, but a LATER race (higher race number) at the SAME meeting already does — abandoned races and trials are excluded (no result is ever expected there) |
| **Schedule Issue** | per-race | all | Either: (a) scheduled time is a placeholder `00:00`, (b) two races at the same meeting share the exact same scheduled time, or (c) this race is scheduled less than 15 minutes after the previous race at the same meeting |

Two meeting-level filter options aggregate the above: **"Meetings with
Issues"** (any check above fired) and **"Healthy Meetings"** (none did).
`ABBN` is a separate status tag (a race is abandoned) — shown, but never
counted as a "data problem" issue.

---

## 5. Manual override system ("Confirm / Ignore")

Four of the checks above can be manually cleared by a logged-in user when
someone has actually verified the real source and confirmed it's not a real
problem (e.g. a genuine first-starter with no form, confirmed via the
"Site for check" link — see §7):

| Override | Keyed by | Endpoint |
|---|---|---|
| Missing Form Lines | `runnerId` | `POST /api/runner/:runnerId/form-ignore` |
| Horse Age Issue | `runnerId` | `POST /api/runner/:runnerId/age-ignore` |
| Duplicate Jockey | `raceId` + jockey name | `POST /api/race/:raceId/jockey-ignore` |
| Missing Jockey | `raceId` + `runnerId` | `POST /api/race/:raceId/runner/:runnerId/missing-jockey-ignore` |

Each writes to its own local JSON file (see §2) with who confirmed it and
when, and clears the 60-second race-docs cache immediately so the grid
reflects it without delay.

---

## 6. Pages & features

### Admin area access
The Admin link opens four section buttons: **User Activity** (`/admin`,
the default), **System Health** (`/system-health`), **Data Changes**
(`/changes`) and **Missing Data** (`/missing-meetings`). Admins get all
four plus user management. Anyone else gets
only the sections an admin ticked for them when adding the user (or later
with "Access"), stored as `permissions` on the user; with none ticked they
see just the dashboard. User Activity for a non-admin is read-only.

### Data Changes (`/changes`)
What was added, removed or changed in meetings/races after each scrape
(e.g. a missing jockey filled in = "Fixed", a runner scratched, race time
moved, result arrived, meeting/race/runner added). The database has no
change feed (not a replica set), so every 2 minutes the server re-reads
races whose `updatedAt` moved (plus a full re-read every 30 minutes) for
yesterday..today+2 and compares them with a snapshot
(`data-changes-snapshot.json`). Changes go to one file per race date,
`data-changes-YYYY-MM-DD.jsonl`, kept 30 days (`change-tracker.js`). A
date entering the window for the first time is recorded silently. Odds
are not tracked.

### Missing Data (`/missing-meetings`)
Two sub-tabs: **Missing Meetings** (below) and **Missing / Mismatched Runners**
(`#runners`, `/api/missing-runners`): every race where the last runners
check (see Runners check) found a Runner Missing / Runner Mismatched /
Runner Count Mismatched that is still true in our DB, with filters.

Missing Meetings: Thoroughbred meetings the Scratchings feed (`getScratchingsGrey`, which
lists every meeting of the day) has for UAE, KOR, MAL, MUS, ARG, BRZ, CHI,
GER, DEN, ITY, SAU, SWE and CAN, for today to 2 days ahead, compared with
our `meetings` collection (`missing-meetings.js`). Matched on the feed's
MeetingID (= `meetings.tabMeetingId`), else on date + country + course name
ignoring surface words (the feed splits WOODBINE / WOODBINE AW where we
have one WOODBINE). Shows our meeting name + OK, or Missing. Uses the same
cached feed fetch as the scratching check (one retry, since the feed often
504s). **Ignore** on a Missing row (for a meeting nobody needs or that
can't be added) stops it counting as missing; Undo brings it back. Saved
by the server in `missing-meeting-ignores.json` next to the other ignore
files (`MISSING_MEETING_IGNORE_PATH`), keyed by the feed MeetingID, with
who/when; entries for dates over a week old are dropped. Logged in User
Activity as a confirm. **Countries** (admins only): add/remove which
countries are checked; saved in `missing-meeting-countries.json`
(`MISSING_MEETING_COUNTRIES_PATH`), defaulting to `DEFAULT_COUNTRIES` in
missing-meetings.js until first changed. Countries with thoroughbred
meetings in the feed that aren't checked are offered as quick-add chips.
An earlier version used RAS `GetMeetingsByCountry` on
nextdc.racingandsports.com.au:8813, which production can't reach.

### Runners check (`runners-check.js`)
Every 8 hours the server compares runners with ours, for today to 2 days
ahead, for meetings we have: AUS + NZ (all three codes) plus the Missing
Data countries (thoroughbred). Every run reads both sources at the same
time (since 8 Oct 2026; they used to take turns): the RAS API
(`http://nextdc.racingandsports.com:9542/api/v1/neds/meetings?date=`, one
request per day) and the nedsform.com.au website (one page per day + one
per race we have, two at a time, ~5 min). `mergeRunnerChecks` shows the
differences from both, each tagged with its source (`src`: ras / neds /
both; the same difference from both shows once) -- the two sometimes list
a race differently, and Dinesh's team checks and Ignores the ones that are
fine. Jockey Missing is always from Neds; the 3-hourly jockey check keeps a
race's RAS flags and replaces its Neds ones. If one source fails, the other
is used alone. "Check now" on
Missing Data > Missing / Mismatched Runners runs it at once (at most once
every 10 minutes). Races already resulted are skipped.
Flags: Runner Missing (in the source, not ours), Runner Mismatched (cut-off
name / not in the field / scratched there), Runner Count Mismatched, and a
whole field that doesn't match. Runners are matched by name (the API's tab
numbers can be shifted); its scratched flag lags, so "running there,
scratched in ours" is not flagged. Neds dates overseas meetings by the AUS
day, so for overseas Neds meetings the day is picked by start times (median
gap within 6 h), then races pair by number; AUS/NZ go by date + race
number. A track listed twice for one day (Neds had two "Globe Derby"
meetings on 7 Oct 2026, the second with its own R3 and a later R4) is
merged into one; when two source races share a number, ours pairs with the
one starting closest to it, and one over 3 h away is not ours and is
skipped. "Vacant Box" (an empty greyhound box, RAS only), "TBD"/"TBA" placeholders
and nameless runners are not runners: left out of every comparison and
count on both sides (`isVacantBox`). Names that differ only in spacing
("EMOZIONEDEFLORINAS" / "Emozione De Florinas") or by an "AA" (Anglo-Arab)
suffix count as the same horse. On the Neds
website a runner of ours that isn't listed is not an issue (Neds leaves
runners off its pages), so from Neds only extra runners, a Neds count
higher than ours, and a field that doesn't match are flagged -- "not in
field" and "Neds has fewer" come from RAS only. Shown in the runner's Issue column, the
grid flag/Issues filter, popup lines, the Runners column of Missing
Meetings and its own sub-tab. Result in `runners-check-state.json` in the
logs folder (restarts don't add runs; a run where both sources fail retries
hourly); System Health shows the source used and the next one.
**Ignore** on an issue in the runners list hides it from the grid, popup and
Runners column (saved in `runner-check-ignores.json` next to the other
ignore files, `RUNNER_CHECK_IGNORE_PATH`; keyed by race + kind + runner +
text, so a changed count/name shows again; Undo brings it back; entries
over a week old are dropped). Logged in User Activity as a confirm.

### Jockey check + Neds politeness (server.js)
When the Neds website is the source, jockeys (blank in ours / different)
give "Jockey Missing (name)" when ours is blank. Jockey names that differ
and weights are not compared (Dinesh, 6 Oct 2026). The RAS API has no
jockeys. A separate **jockey check** runs every
`JOCKEY_CHECK_EVERY_MS` (3 h; Dinesh may ask for 2 h): only races starting
in the next 24 h that still have a running horse with no jockey, one Neds
page a second, updating those races' result. Every Neds request goes through
`fetchNeds()`: gaps between requests, and on a 429/403 all Neds requests
pause for 6 hours (`jockey-check-state.json`); the runners check then uses
RAS. System Health shows a "Jockey check (Neds)" row and any pause.

### System Health (`/system-health`, admins only)
Live checks, refreshed every 60 s (cached 60 s server-side): server uptime,
MongoDB ping, when a scrape was last seen (from the Data Changes tracker,
since the DB's `updatedAt` strings have no time zone), the Speed Map and
Scratchings feeds (warning over 20 s), the S3 video listing, the Data
Changes check (warning if over 6 min late), logins + whether the server
can write its folder, and deployed code, which warns when a code file was
uploaded after the server started (i.e. WinSW still needs a restart). The
bottom of the dashboard shows "Data last scraped / Changes checked / Page
updated" to everyone, plus the overall health status and a link for
admins. The public `/health` (DB ping only) stays for the uptime monitor.

### Admin page (`/admin`, admins only)
One login per person. Admins (e.g. `Dinesh`) see an **Admin** link in the
header: add users (username + password, optional admin role), reset a
password (logs that user out everywhere), make/remove admin, delete users,
and an activity log of logins, failed logins, page/race views, downloads
and confirms for the last 8 days. Normal users never see the link and get
"Admins only" on `/admin`. Users live in `auth-users.json` (created by the
server itself, because the service account can't modify an `auth.json`
uploaded by FTP); `auth.json` only seeds it. The activity log is one file
per month, `activity-log-YYYY-MM.jsonl`, in the same folder; the server
keeps the current month plus the 3 before it and deletes older files
automatically (`activity-log.js`). With no admin and no server
access, `node setup-auth.js --bootstrap` on any PC makes a hashed
`admin-bootstrap.json` to upload by FTP next to `server.js`.

### Login (`/login`)
One username/password per person (see Admin page above). Session cookie is
browser-session-only (no "remember me" — closing the browser fully logs
you out; this was deliberately fixed once, see the sessionStorage vs
localStorage note in dashboard.html's discipline-tab code).
Every page, `/api/*` call and report download requires this login (one
gate middleware in server.js). Only `/login`, `/logout`, `/health` and the
static files in `public/` are open. Logged out, `/api/*` returns 401 JSON
and everything else redirects to `/login`.
*(Google Authenticator 2FA was built and tested in this session, then
explicitly removed at Dinesh's request — the code paths no longer exist,
but the design is documented here in case it's wanted again later: opt-in
per-account via `setup-auth.js`, a second `/login/2fa` step using the
`otplib` + `qrcode-terminal` npm packages.)*

### Main Dashboard (`/`)
- Discipline tabs: Thoroughbred / Harness / Greyhound (each has its own
  race-count-per-meeting grid).
- Filters: search box (meeting name, live suggestions), Country (with a
  flag next to each country's SECTION HEADER row only — not repeated on
  every meeting row, per Dinesh's preference), TAB/Non-TAB, Issue (the
  full list from §4), Status (Upcoming/Running/Completed/Abandoned/
  Resulted), "Include trials" checkbox, "Show meeting downloads" toggle.
- **Global Search** (header, permanent): type a horse/jockey/trainer/
  meeting name, or a bare race number like `R5`, and get categorized
  results (Meetings/Races/Runners/Jockeys/Trainers) for the CURRENTLY
  selected date only (`GET /api/search?date=...&q=...`, server.js). Click
  a result to jump straight to that race.
- Per-meeting download widget (⬇ icon): CSV/Excel/JSON/PDF for just that
  meeting's full race+runner detail.
- Top-of-page "Download report" (CSV/Excel/JSON/PDF): every meeting/race
  with an issue, for the whole date.
- Auto-refresh: full page reload every 3 minutes (paused while a runner
  detail popup is open), with a live countdown pill.

### Race popup (click a race time)
Tabs: **Race Field** (runner table with the per-runner Issue column from
§4), **Speed Map** (Greyhound bar-chart pace visualisation — row height
auto-scales to field size, running-gait icon only shows for a runner with
actual pace data), **Race Card** (raw `racecards` documents, debug view),
**Data Dump** (raw `datadumps` documents, debug view). Plus "Watch race
video" (in-page overlay, not a new tab) when a video exists, and a
per-race Export Data menu.

**Spotlights** tab (only when the race has them): the 3 "horses to watch"
the company pipeline writes in `llmContent` (`contentType:
"RACE_CARD_COMMENTS"`, matched by `raceId`, one doc per style AU/UK/US,
newest `updatedAt` wins) — read in server.js's `attachSpotlights`, style
picked by race country in raceView.js's `pickSpotlights` (USA/CAN/MEX → US,
GB/IRE/Europe → UK, else AU). `llmContent` has no `raceId` index, so the
lookup is a ~0.4 s collection scan per popup. (A V1/V2 comments switch was
built and removed on 6 Oct 2026 at Dinesh's request.)

**Comments V2** tab (Thoroughbred only): race overview, 3 spotlights and a
comment per running horse, written by `comments-v2.js` from the race's
`racecards` doc (AU style preferred) — no AI, no API key, no cost; a few ms
on each popup load (server.js's `attachCommentsV2`), nothing saved. Facts
only: last run (position, field, distance, margin, winner, going), distance
change, spell, barrier, weight, track/distance record, past clashes between
runners, odds (for the order). AU/UK/US switch (units and terms only),
opening on the race country's style (`commentStyleFor` in raceView.js).
Runners scratched in ours are left out. Dinesh chose free over a paid AI
model on 7 Oct 2026.

### Standalone full-screen race view
Right-click (or ctrl/cmd/middle-click) any race time to open it in a new
tab at its readable link, e.g. `/race/thoroughbred/australia/kalgoorlie/2026-10-01/R1`
(discipline / country / meeting / date / race number) — same content as the popup above, but as a
genuine full page (no nested scrollboxes, race-number nav bar down the
right side, Home link instead of Logout). A plain click keeps the popup
behaviour instead, and the address bar still switches to that race's link.
`raceUrl()` in raceView.js builds the link; the `/race/...` route in
server.js finds the race by date + race number + discipline, then matches
the meeting and country slugs. Old `/?date=...&race=<id>` links still work
and get swapped for the readable one. A shared link opened while logged out
returns to that race after login.

### Runner detail (click a horse name)
Header detail grid: Trainer / Jockey / Colour / Sex / Age / Last Run
(most recent past race's date) / Sire / Dam / Weight. Runner's narrative
comment shown inline below that (always visible, not a tab). Then three
tabs: **Past Form** (full past-races table, click a row to open that old
race's own form page in a new tab), **Statistics** (Career/Win%/Place%/
Show% as bordered boxes with progress bars for the three percentages, plus
Last 10/Season/Track/Distance/etc. as smaller boxes), **Chart** (inline
SVG line chart of finishing position over time, oldest-to-newest,
1st place plotted at the TOP).

### Meetings List (`/meetings-list-view`)
A flat, no-grid list of meetings across a FROM/TO date range (not scoped to
one day like the main dashboard) — Country/Discipline/TAB filters, country
flags in its own Country column, CSV/Excel/JSON/PDF download of the range.

### "Site for check" links
Every race popup can show a link to the relevant real-world racing
authority's site for that country/discipline, for manually verifying a
flagged issue against the real source. A handful of countries (UAE, Saudi
Arabia, Bahrain, Hong Kong) get a DEEP link straight to that date+race;
every other country links to that authority's general racing/meetings
page (a deliberate choice — a working general link beats a guessed-wrong
or unpublished deep one). See `GENERAL_CHECK_SITE_BY_COUNTRY` and
`buildExternalCheckUrl` in raceView.js for the full per-country list.

---

## 7. Country code handling (a messy but important detail)

The upstream data feed uses INCONSISTENT country codes for the same
country (e.g. Great Britain appears as both `GB` and `GBR`, Ireland as
both `IRE` and `IRL`, South Africa as both `SAF` and `ZAF`). Two SEPARATE
normalization tables exist for two separate purposes — don't conflate
them:
- `COUNTRY_ALIASES` / `canonicalCountry()` (raceView.js) — used only to
  pick the right "Site for check" external link.
- `COUNTRY_FLAG_ISO` (duplicated in both raceView.js, server-side render,
  and dashboard.html, client-side render) — maps every code variant seen
  in the DB straight to its real ISO 3166-1 alpha-2 code for the flag CDN.

---

## 8. Deployment

**Not git-based.** Production is a Windows machine running the app as a
**WinSW-managed Windows Service** (listening on port 8996 behind an IIS
reverse proxy in front of the app's own port 3000). Deploys are manual:

1. Upload the changed files via FTP (FileZilla) to the production folder.
2. If `server.js`, `raceView.js`, or any `views/*.html` changed: **restart
   the WinSW service** (these are only read once at process startup).
   `public/styles.css` changes take effect on a plain browser refresh, no
   restart strictly required.
3. If `package.json` changed (a new npm dependency was added): SSH/RDP into
   the server and run `npm install` in the project folder BEFORE
   restarting the service, or the new `require(...)` will crash the
   process on startup.

Config files (never committed to git, live only on each machine):
- `C:\Thilina\Dinesh project\project - 1\db.json` — Mongo connection.
- `C:\Thilina\Dinesh project\project - 1\auth.json` — login.
- Same folder: the 4 ignore-override JSON files (§2).

> **Known inconsistency to be aware of:** `run.bat` (a convenience local
> launcher, NOT what production's WinSW service uses) defaults
> `DB_CONFIG_PATH`/`AUTH_CONFIG_PATH` to `C:\Users\Dinesh\projects-config\`
> if those env vars aren't set, while `server.js`'s own hardcoded fallback
> (used when nothing else sets the env var either) points at
> `C:\Thilina\Dinesh project\project - 1\`. Production has been confirmed
> all session to use the LATTER path. Worth reconciling at some point so
> `run.bat` can't silently point at the wrong config file.

---

## 9. Local development / testing

- Test login: `tduser` / `tduser123`.
- Start the dev server: use the project's `race-dashboard` launch config
  (`.claude/launch.json`), port 3000 — never run it via a bare terminal
  command when working in this Claude Code session, so the Browser pane
  tooling can track it.
- Reads the SAME production config files by default (same hardcoded paths
  in server.js) — there is no separate local/test database. Be careful
  with anything that writes (ignore-overrides, scratching sync state is
  read-only from our side so that's safe).
- MongoDB ad-hoc queries: use a throwaway Node script in the project root
  (`_tmp_*.js`) with `db-config.js` + the `mongodb` driver directly,
  connection name `mongodb-prod`, database `Troyen_Prod` — delete the
  script immediately after use. The MongoDB MCP tool has been unreliable
  for this in practice.

---

## 10. Utility scripts

- **`setup-auth.js`** — `node setup-auth.js`, interactive prompts for
  username + password (min 6 chars, hidden while typing, bcrypt-hashed
  before saving — the plaintext is never written anywhere or sent
  anywhere). Restart the server afterward.
- **`prune-ignores.js`** — a ONE-OFF cleanup utility (not part of the
  running app) that prunes the 4 ignore-override files down to only
  entries whose race is today-or-later, backing up the untouched
  originals into a timestamped zip first. Full run instructions are in
  its own header comment. Meant to be deleted after use, not kept around.
- **`run.bat`** — local convenience launcher only (see the config-path
  caveat in §8) — installs npm deps if missing, starts `server.js` in its
  own console window, opens the dashboard in Chrome.

---

## 11. Tech stack

Express 4, `express-session` (in-memory, browser-session cookies),
`bcryptjs` (password hashing), MongoDB driver 6.x, `exceljs` +`pdfkit`
(Excel/PDF report generation). No frontend framework or build step —
`views/dashboard.html` is one large template with plain inline
`<script>`/`<style>`, every dynamic bit (silks, Speed Map bars, the Chart
tab's line chart) hand-rendered as inline SVG rather than pulling in a
charting library.
