/* ---------------------------------------------------------------------------
   Pickup — server

   One Node process serves everything: the static frontend, the JSON API, and
   the WebSocket that keeps every device in sync. There is no second service,
   no message broker, no build step.

   SYNC MODEL (the only non-obvious part of this codebase):
     A client sends a mutation. The server applies it to SQLite, then broadcasts
     the ENTIRE queue state to every connected client. No diffs, no sequence
     numbers, no conflict resolution.

     Full state for both lanes is ~5 KB and there are fewer than ten clients.
     Diffing would save bandwidth nobody is short of, in exchange for a class of
     bug that only shows up under load in the car line. Don't "optimise" this.
--------------------------------------------------------------------------- */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const db = require('./db');
const csv = require('./lib/csv');

const PORT = parseInt(process.env.PORT, 10) || 8888;
const app = express();
const server = http.createServer(app);

db.open();

/* =========================================================================
   BRANDING PALETTE — shared shape + validation
   The colour scheme is 8 named tokens per theme. Kept here so the broadcast,
   the settings API and the defaults all agree on exactly which keys exist and
   what a valid value looks like (#rrggbb, nothing else).
   ========================================================================= */
const PALETTE_TOKENS = ['accent', 'laneA', 'laneB', 'bg', 'panel', 'line', 'text', 'muted'];
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_PALETTE = {
  light: { accent: '#4F46E5', laneA: '#0F766E', laneB: '#F59E0B', bg: '#F7F8FA', panel: '#FFFFFF', line: '#E4E7EC', text: '#1A2333', muted: '#5B6472' },
  dark:  { accent: '#8098F7', laneA: '#2DD4BF', laneB: '#FBBF24', bg: '#0F1420', panel: '#171E2B', line: '#2A3342', text: '#E8EDF4', muted: '#9BA6B7' }
};

// Parse a stored palette JSON string, filling any missing/invalid token from the
// fallback so a client never receives a half-empty scheme.
function parsePalette(json, fallback) {
  let obj = {};
  try { obj = JSON.parse(json || '{}') || {}; } catch { obj = {}; }
  const out = {};
  for (const k of PALETTE_TOKENS) out[k] = HEX6.test(obj[k]) ? obj[k] : fallback[k];
  return out;
}

// Validate an incoming palette from the client. Throws on a bad colour so a
// typo can't wipe the scheme; returns a clean token-only object.
function cleanPalette(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('palette must be an object');
  const out = {};
  for (const k of PALETTE_TOKENS) {
    const v = String(obj[k] || '').trim();
    if (!HEX6.test(v)) throw new Error(`palette colour "${k}" must be a #rrggbb value`);
    out[k] = v;
  }
  return out;
}

/* =========================================================================
   STATE PROJECTION — what every client receives
   ========================================================================= */

/*  Split one lane's queue into groups of at most `size` NAME slots, never
    splitting a family across two groups.

    If the next car has three children and only two slots remain, that whole
    family moves to the next group and the current group shows four names.
    Splitting siblings would leave a car waiting at the curb for a child who
    was told to stay put — so the rule is: whole families only.               */
function assignGroups(entries, size) {
  let group = 0, slots = 0;
  for (const e of entries) {
    const need = e.students.length;
    if (slots > 0 && slots + need > size) { group++; slots = 0; }
    e.group = group;

    /*  SPOT NUMBERS
        The waiting area has numbered, coloured spots painted on the ground and
        children stand on the one matching their name on the board. So every
        student in the loading group needs a spot number, 1..size.

        Assigned here rather than on the clients because the walker tablet, the
        marshal tablet and the gym display must all name the same spot for the
        same child. One computation, one answer.

        Every group is numbered the same way, restarting 1..size within each
        group (slots resets to 0 at each new group below). Group 0 is the
        children standing on a spot right now; the on-deck groups show the spot
        each child WILL take when their group moves up, so the board, the
        marshal and the walker can line the next waves up in order and keep the
        curb moving. Same number, same colour, one group earlier.

        Siblings take consecutive spots (3 children = 3 different spots), which
        is correct: each child stands on their own.                          */
    e.students.forEach((st, i) => {
      st.spot = slots + i + 1;
    });

    slots += need;
    if (slots >= size) { group++; slots = 0; }
  }
  return entries;
}

function buildState() {
  const s = db.getSettings();
  const rows = db.queueRows();

  // Lane colour is deliberately NOT sent. It is a presentation concern that
  // changes with the client's light/dark theme, so it lives in styles.css as
  // --laneA / --laneB. The server owns names and order, nothing visual.
  const lanes = [
    { id: 'A', name: s.lane_a_name },
    { id: 'B', name: s.lane_b_name }
  ];

  const queues = { A: [], B: [] };
  for (const r of rows) {
    const fam = db.familyByTag(r.tag);
    if (!fam) continue;                       // student deleted mid-day; skip
    const inCar = db.inCarMap(r.id);
    const entry = {
      qid: r.id,
      tag: r.tag,
      addedAt: r.added_at,
      students: fam.students.map(st => ({
        id: st.id, first: st.first, last: st.last,
        grade: st.grade,
        inCar: !!inCar[st.id]
      }))
    };
    (queues[r.lane] || queues.A).push(entry);
  }

  for (const l of lanes) assignGroups(queues[l.id], s.group_size);

  return {
    type: 'STATE',
    serverTime: Date.now(),
    settings: {
      groupSize: s.group_size,
      schoolName: s.school_name, maxSpots: db.MAX_SPOTS
    },
    /*  Branding rides the same broadcast so every screen — staff tablets and the
        gym board — restyles the instant an admin saves, with no reload. Only the
        tiny logo_version travels here; the logo bytes are fetched separately from
        /api/branding/logo (see db.js note). Colours are applied client-side as
        CSS variables, keeping the server's "no visual data" rule intact for the
        queue itself. */
    branding: {
      appName: s.app_name,
      schoolName: s.school_name,
      paletteLight: parsePalette(s.palette_light, DEFAULT_PALETTE.light),
      paletteDark: parsePalette(s.palette_dark, DEFAULT_PALETTE.dark),
      logoVersion: s.logo_version || ''
    },
    lanes,
    queues
  };
}

/* =========================================================================
   WEBSOCKET
   ========================================================================= */
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast() {
  const payload = JSON.stringify(buildState());
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}
function sendTo(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  sendTo(ws, buildState());

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const ref = msg.ref || null;
    const actor = String(msg.actor || '').slice(0, 40);

    try {
      switch (msg.type) {
        case 'PING':
          return sendTo(ws, { type: 'PONG', ref });

        case 'ADD_TAG': {
          const tag = String(msg.tag || '').trim();
          if (!tag) return sendTo(ws, { type: 'ERROR', ref, message: 'Enter a tag number.' });

          const fam = db.familyByTag(tag);
          if (!fam) return sendTo(ws, { type: 'ERROR', ref, message: `Tag ${tag} is not on the rider list.` });

          const existing = db.queueRows().find(r => r.tag === tag);
          if (existing) {
            const ln = existing.lane === 'A' ? db.getSettings().lane_a_name : db.getSettings().lane_b_name;
            return sendTo(ws, { type: 'ERROR', ref, message: `Tag ${tag} is already in ${ln}.` });
          }

          // Lanes are first-come, first-served: the tag goes into whichever lane
          // the walker has selected. No per-family routing.
          const settings = db.getSettings();
          const lane = (msg.lane === 'B' ? 'B' : 'A');

          db.addToQueue(tag, lane, actor);
          db.logEvent(actor, 'ADD_TAG', `Tag ${tag} → lane ${lane}`);
          broadcast();
          return sendTo(ws, {
            type: 'ACK', ref, tag, lane,
            names: fam.students.map(s => s.first),
            message: `${tag} — ${fam.students.map(s => s.first).join(', ')} → ${lane === 'A' ? settings.lane_a_name : settings.lane_b_name}`
          });
        }

        case 'REMOVE_ENTRY': {
          const row = db.removeFromQueue(msg.qid);
          if (row) db.logEvent(actor, 'RELEASE', `Tag ${row.tag} released from lane ${row.lane}`);
          broadcast();
          return;
        }

        case 'TOGGLE_STUDENT': {
          const res = db.toggleInCar(msg.qid, msg.studentId);
          if (res && res.allIn) {
            const row = db.removeFromQueue(msg.qid);
            if (row) db.logEvent(actor, 'LOADED', `Tag ${row.tag} fully loaded, released from lane ${row.lane}`);
          }
          broadcast();
          return;
        }

        case 'MOVE_ENTRY': {
          const lane = msg.lane === 'B' ? 'B' : 'A';
          db.moveQueue(msg.qid, lane);
          db.logEvent(actor, 'MOVE', `Queue entry ${msg.qid} → lane ${lane}`);
          broadcast();
          return;
        }

        case 'RELEASE_GROUP': {
          // Release every car in a lane's "Loading now" group at once — for when
          // the whole front row pulls away together. Computed here, from the same
          // grouping the display shows, so "the loading group" means exactly what
          // the marshal sees. Never touches Next Up.
          const lane = msg.lane === 'B' ? 'B' : 'A';
          const st = buildState();
          const loading = (st.queues[lane] || []).filter(e => e.group === 0);
          for (const e of loading) db.removeFromQueue(e.qid);
          if (loading.length)
            db.logEvent(actor, 'RELEASE_GROUP',
              `Released loading group in lane ${lane} — ${loading.length} car(s): ${loading.map(e => e.tag).join(', ')}`);
          broadcast();
          return;
        }

        case 'CLEAR_LANES': {
          const n = db.clearLanes();
          db.logEvent(actor, 'CLEAR', `Cleared both lanes (${n} cars)`);
          broadcast();
          return;
        }
      }
    } catch (err) {
      console.error('[ws]', msg.type, err.message);
      sendTo(ws, { type: 'ERROR', ref, message: 'Server error: ' + err.message });
    }
  });
});

/* Drop dead sockets so a tablet that went to sleep doesn't linger forever. */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

/* Roll the queue over at midnight without anyone having to remember. */
setInterval(() => { if (db.rolloverIfNewDay()) broadcast(); }, 60000);

/* =========================================================================
   ADMIN AUTH — deliberately minimal, see README "Security posture"
   ========================================================================= */
const tokens = new Map();                       // token -> expiry (ms)
const TOKEN_TTL = 12 * 60 * 60 * 1000;

function issueToken() {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, Date.now() + TOKEN_TTL);
  return t;
}
function requireAdmin(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const exp = tokens.get(t);
  if (!exp || exp < Date.now()) {
    tokens.delete(t);
    return res.status(401).json({ error: 'Admin sign-in required.' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
}, 60 * 60 * 1000);

/* =========================================================================
   HTTP API
   ========================================================================= */
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/csv', limit: '20mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '200mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    clients: wss.clients.size,
    students: db.getRoster().reduce((a, f) => a + f.students.length, 0),
    tags: db.getRoster().length,
    queued: db.queueRows().length,
    dbPath: db.DB_PATH,
    version: require('./package.json').version
  });
});

app.post('/api/login', (req, res) => {
  const pin = String((req.body && req.body.pin) || '');
  if (pin !== db.getSettings().admin_pin) {
    db.logEvent('', 'LOGIN_FAIL', 'Bad admin PIN');
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }
  db.logEvent('admin', 'LOGIN', 'Admin signed in');
  res.json({ token: issueToken() });
});

app.get('/api/settings', requireAdmin, (_req, res) => {
  const s = db.getSettings();
  res.json({
    laneAName: s.lane_a_name, laneBName: s.lane_b_name,
    groupSize: s.group_size,
    adminPin: s.admin_pin, schoolName: s.school_name,
    appName: s.app_name,
    paletteLight: parsePalette(s.palette_light, DEFAULT_PALETTE.light),
    paletteDark: parsePalette(s.palette_dark, DEFAULT_PALETTE.dark)
  });
});
app.patch('/api/settings', requireAdmin, (req, res) => {
  const map = {
    laneAName: 'lane_a_name', laneBName: 'lane_b_name', groupSize: 'group_size',
    adminPin: 'admin_pin', schoolName: 'school_name', appName: 'app_name'
  };
  try {
    for (const [k, col] of Object.entries(map)) {
      if (k in req.body) {
        let v = req.body[k];
        if (col === 'group_size') v = Math.max(2, Math.min(db.MAX_SPOTS, parseInt(v, 10) || 6));
        if (col === 'admin_pin') v = String(v).trim() || '1234';
        if (col === 'app_name') v = String(v).trim().slice(0, 40) || 'Pickup';
        if (col === 'school_name') v = String(v).trim().slice(0, 80);
        db.setSetting(col, v);
      }
    }
    // Palettes are validated as a whole (all 8 tokens, all #rrggbb) before either
    // is written, so a bad value in one field aborts the save cleanly.
    if ('paletteLight' in req.body) db.setSetting('palette_light', JSON.stringify(cleanPalette(req.body.paletteLight)));
    if ('paletteDark' in req.body) db.setSetting('palette_dark', JSON.stringify(cleanPalette(req.body.paletteDark)));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  db.logEvent('admin', 'SETTINGS', 'Settings updated');
  broadcast();
  res.json({ ok: true });
});

/* ---------------- branding logo ----------------
   The logo is stored as a data: URL inside the settings table (so it rides along
   in the .db backup) but is SERVED as real image bytes here, and referenced by a
   plain <img src>. That keeps it out of the WebSocket broadcast — only the short
   logo_version token is broadcast, as a ?v= cache-buster.

   GET is public: the gym board and every staff tablet load it without a token,
   exactly like any other image. POST/DELETE require the admin token. */
app.get('/api/branding/logo', (_req, res) => {
  const { dataUrl } = db.getLogo();
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (m) {
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(m[2], 'base64'));
  }
  // No custom logo set — fall back to the bundled default.
  res.sendFile(path.join(__dirname, 'public', 'logo.png'));
});

app.post('/api/branding/logo', requireAdmin, (req, res) => {
  const dataUrl = String((req.body && req.body.dataUrl) || '');
  const m = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Upload a PNG, JPG, GIF, WEBP or SVG image.' });
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 512 * 1024)
    return res.status(400).json({ error: 'Logo must be under 500 KB. Resize it and try again.' });
  const version = crypto.createHash('sha1').update(dataUrl).digest('hex').slice(0, 10);
  db.setSetting('logo_data', dataUrl);
  db.setSetting('logo_version', version);
  db.logEvent('admin', 'BRANDING', 'Logo updated');
  broadcast();
  res.json({ ok: true, version });
});

app.delete('/api/branding/logo', requireAdmin, (_req, res) => {
  db.setSetting('logo_data', '');
  db.setSetting('logo_version', '');
  db.logEvent('admin', 'BRANDING', 'Logo reset to default');
  broadcast();
  res.json({ ok: true });
});

app.get('/api/roster', requireAdmin, (_req, res) => res.json({ families: db.getRoster() }));

app.get('/api/roster/template.csv', (_req, res) => {
  res.type('text/csv').attachment('Pickup-Roster-Template.csv').send(csv.templateCsv());
});
app.get('/api/roster/export.csv', requireAdmin, (_req, res) => {
  const name = `Pickup-Roster-${new Date().toISOString().slice(0, 10)}.csv`;
  res.type('text/csv').attachment(name).send(csv.exportRoster(db.getRoster()));
});

/* Preview first, commit second. Nothing is written until the admin confirms. */
app.post('/api/roster/preview', requireAdmin, (req, res) => {
  const text = typeof req.body === 'string' ? req.body : (req.body && req.body.csv) || '';
  const r = csv.parseRoster(text);
  res.json({
    families: r.families.length,
    students: r.families.reduce((a, f) => a + f.students.length, 0),
    siblingFamilies: r.families.filter(f => f.students.length > 1).length,
    skippedSampleRows: r.skipped,
    errors: r.errors,
    payload: r.families
  });
});
app.post('/api/roster/import', requireAdmin, (req, res) => {
  const { families, replace } = req.body || {};
  if (!Array.isArray(families) || !families.length)
    return res.status(400).json({ error: 'Nothing to import.' });
  const n = db.importRoster(families, !!replace);
  db.logEvent('admin', 'IMPORT', `${replace ? 'Replaced' : 'Merged'} roster — ${n} students`);
  broadcast();
  res.json({ ok: true, imported: n, total: db.getRoster().reduce((a, f) => a + f.students.length, 0) });
});

app.post('/api/students', requireAdmin, (req, res) => {
  const { tag, first, last } = req.body || {};
  if (!tag || !first || !last) return res.status(400).json({ error: 'Hang tag, first name and last name are required.' });
  if (!/^\d+$/.test(String(tag).trim())) return res.status(400).json({ error: 'Hang tag must be a number.' });
  const id = db.addStudent(req.body);
  db.logEvent('admin', 'ADD_STUDENT', `${first} ${last} → tag ${tag}`);
  broadcast();
  res.json({ ok: true, id });
});
app.patch('/api/students/:id', requireAdmin, (req, res) => {
  db.updateStudent(parseInt(req.params.id, 10), req.body || {});
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/students/:id', requireAdmin, (req, res) => {
  const s = db.deleteStudent(parseInt(req.params.id, 10));
  if (s) db.logEvent('admin', 'DEL_STUDENT', `${s.first} ${s.last} (tag ${s.tag})`);
  broadcast();
  res.json({ ok: true });
});
app.get('/api/events', requireAdmin, (_req, res) => res.json({ events: db.recentEvents(300) }));

/* ---------------- backup / restore ----------------
   Backup streams a consistent copy of the database to the admin's device.
   Restore accepts one back. Both are single files on purpose — the whole
   disaster-recovery story is "download a file, keep it somewhere, upload it
   back". No scripts to run, no shell access needed.                        */
app.get('/api/backup', requireAdmin, async (_req, res) => {
  const tmp = path.join(db.DATA_DIR, `backup-${Date.now()}.db`);
  try {
    await db.handle().backup(tmp);              // consistent even mid-write
    const name = `pickup-backup-${new Date().toISOString().slice(0, 10)}.db`;
    db.logEvent('admin', 'BACKUP', `Downloaded ${name}`);
    res.download(tmp, name, () => fs.unlink(tmp, () => {}));
  } catch (err) {
    fs.unlink(tmp, () => {});
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

app.post('/api/restore', requireAdmin, (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 16)
    return res.status(400).json({ error: 'No file received.' });

  // A SQLite file always begins with this exact string. Cheap guard against
  // someone uploading a CSV, a photo, or a half-finished download.
  if (buf.slice(0, 15).toString('utf8') !== 'SQLite format 3')
    return res.status(400).json({ error: 'That is not a SQLite backup file. Upload the .db file you downloaded from Admin > Download backup.' });

  if (buf.length < 4096)
    return res.status(400).json({ error: 'That backup file looks truncated. Try downloading it again.' });

  const staging = path.join(db.DATA_DIR, `restore-${Date.now()}.db`);
  try {
    fs.writeFileSync(staging, buf);

    // Verify the upload really is one of ours BEFORE touching the live file.
    const Database = require('better-sqlite3');
    const probe = new Database(staging, { readonly: true });
    const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const students = probe.prepare('SELECT COUNT(*) c FROM students').get().c;
    probe.close();
    for (const t of ['families', 'students', 'queue', 'settings']) {
      if (!names.includes(t)) throw new Error(`backup is missing the "${t}" table`);
    }

    // Keep the current database next to the new one rather than deleting it.
    const safety = path.join(db.DATA_DIR, `pre-restore-${Date.now()}.db`);
    db.close();
    fs.copyFileSync(db.DB_PATH, safety);
    for (const suffix of ['', '-wal', '-shm']) {
      const f = db.DB_PATH + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    fs.copyFileSync(staging, db.DB_PATH);
    fs.unlinkSync(staging);
    db.open();

    db.logEvent('admin', 'RESTORE', `Restored from uploaded backup (${students} students). Previous db kept at ${path.basename(safety)}`);
    broadcast();
    res.json({ ok: true, students, previousDatabaseKeptAs: path.basename(safety) });
  } catch (err) {
    try { if (fs.existsSync(staging)) fs.unlinkSync(staging); } catch {}
    if (!db.handle()) { try { db.open(); } catch {} }
    res.status(400).json({ error: 'Restore failed: ' + err.message });
  }
});

/* ---------------- static ---------------- */
/* maxAge is deliberately 0. With a 1-hour cache, rebuilding the container left
   tablets and the gym panel serving the OLD app.js and styles.css until the
   cache expired — you'd deploy a fix and swear nothing had changed. ETags still
   make repeat loads a 304 with no body, and the whole frontend is ~40 KB on a
   LAN, so there is nothing to gain by caching harder than this. */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));
app.get('/display', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.use((_req, res) => res.redirect('/'));

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Pickup is running.');
  console.log(`  Staff app : http://<this-server-ip>:${PORT}/`);
  console.log(`  TV display: http://<this-server-ip>:${PORT}/display`);
  console.log(`  Database  : ${db.DB_PATH}`);
  console.log('');
});

function shutdown() {
  console.log('Shutting down…');
  try { db.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
