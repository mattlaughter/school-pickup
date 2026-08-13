/* ---------------------------------------------------------------------------
   db.js — all SQLite access lives here.

   Design notes for whoever maintains this:
   - One file on disk. Back it up by copying it. Restore it by copying it back.
   - `queue` is cleared automatically when the date rolls over (see rolloverIfNewDay).
   - `families` + `students` persist across the school year.
   - Queue order is simply `queue.id ASC` — arrival order at the server. There is no
     separate position column, because there is nothing that reorders a queue.
--------------------------------------------------------------------------- */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

/* Number of physical coloured spots painted in each lane's waiting area.
   If the school ever paints more, raise this AND add matching colours to
   --spot-N in public/styles.css and public/display.html. Those three places
   must agree. */
const MAX_SPOTS = 6;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'pickup.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS families (
  tag    TEXT PRIMARY KEY,
  notes  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS students (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tag       TEXT NOT NULL REFERENCES families(tag) ON DELETE CASCADE,
  first     TEXT NOT NULL,
  last      TEXT NOT NULL,
  grade     TEXT NOT NULL DEFAULT '',
  notes     TEXT NOT NULL DEFAULT '',
  active    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS students_tag ON students(tag);

CREATE TABLE IF NOT EXISTS queue (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lane      TEXT NOT NULL,
  tag       TEXT NOT NULL,
  added_at  INTEGER NOT NULL,
  added_by  TEXT NOT NULL DEFAULT ''
);
-- A hang tag can only be in one lane at a time. This constraint is the reason
-- double-entry by two walkers cannot corrupt the queue.
CREATE UNIQUE INDEX IF NOT EXISTS queue_tag_unique ON queue(tag);

CREATE TABLE IF NOT EXISTS queue_students (
  queue_id   INTEGER NOT NULL REFERENCES queue(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL,
  in_car     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queue_id, student_id)
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL DEFAULT '',
  kind   TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  lane_a_name: 'Lane A',
  lane_b_name: 'Lane B',
  group_size: '6',
  admin_pin: '1234',
  school_name: '',                 // subtitle under the title — set in Admin > Branding
  last_service_day: '',

  /* ---- Branding (customisable from Admin > Branding) ----
     app_name      : the big title shown in the header and on the TV board.
     palette_light / palette_dark : the full colour scheme for each theme, as a
                   JSON object of 8 tokens (accent, laneA, laneB, bg, panel, line,
                   text, muted). Light and dark are kept separate so a school can
                   tune each; the client applies whichever matches the screen's
                   current theme. Applied as CSS variables — the server still
                   sends no visual data about the QUEUE itself.
     logo_data     : the uploaded logo as a data: URL, or '' to use the bundled
                   default. Kept IN the settings table on purpose, so it travels
                   inside the .db backup — one file still restores everything.
     logo_version  : a short hash of logo_data, broadcast to clients as a
                   cache-buster so a new logo appears without a manual refresh.
     Because logo_data lives here it is NEVER put in the broadcast payload (it
     would bloat every state message); clients fetch it from /api/branding/logo
     and only the tiny logo_version rides the socket. */
  app_name: 'Pickup',
  palette_light: JSON.stringify({
    accent: '#4F46E5', laneA: '#0F766E', laneB: '#F59E0B',
    bg: '#F7F8FA', panel: '#FFFFFF', line: '#E4E7EC', text: '#1A2333', muted: '#5B6472'
  }),
  palette_dark: JSON.stringify({
    accent: '#8098F7', laneA: '#2DD4BF', laneB: '#FBBF24',
    bg: '#0F1420', panel: '#171E2B', line: '#2A3342', text: '#E8EDF4', muted: '#9BA6B7'
  }),
  logo_data: '',
  logo_version: ''
};

function open() {
  db = new Database(DB_PATH);
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  rolloverIfNewDay();
  return db;
}
function close() { if (db) { db.close(); db = null; } }
function handle() { return db; }

/* ---------------- settings ---------------- */
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  // Capped at MAX_SPOTS because each name slot maps to a physical coloured spot
  // painted in the waiting area. More names than spots means a child is told to
  // stand somewhere that does not exist.
  out.group_size = Math.max(2, Math.min(MAX_SPOTS, parseInt(out.group_size, 10) || 6));
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

/* The logo is read on its own — it can be sizeable and only the /api/branding/logo
   route ever needs the bytes, so it stays out of the general settings path. */
function getLogo() {
  const data = db.prepare("SELECT value FROM settings WHERE key='logo_data'").get();
  const ver = db.prepare("SELECT value FROM settings WHERE key='logo_version'").get();
  return { dataUrl: data ? data.value : '', version: ver ? ver.value : '' };
}

/* ---------------- day rollover ----------------
   The queue is meaningless the next morning. Clear it rather than making staff
   remember to. Runs on boot and on a timer from server.js.               */
function rolloverIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  const last = db.prepare("SELECT value FROM settings WHERE key='last_service_day'").get();
  if (last && last.value === today) return false;
  const n = db.prepare('SELECT COUNT(*) c FROM queue').get().c;
  db.exec('DELETE FROM queue');
  setSetting('last_service_day', today);
  if (n > 0) logEvent('system', 'DAY_ROLLOVER', `Cleared ${n} cars left in the queue overnight`);
  return true;
}

/* ---------------- events ---------------- */
function logEvent(actor, kind, detail) {
  db.prepare('INSERT INTO events (at,actor,kind,detail) VALUES (?,?,?,?)')
    .run(Date.now(), actor || '', kind, detail || '');
}
function recentEvents(limit = 200) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- roster ---------------- */
function getRoster() {
  const fams = db.prepare('SELECT * FROM families ORDER BY CAST(tag AS INTEGER)').all();
  const studs = db.prepare('SELECT * FROM students WHERE active=1 ORDER BY last, first').all();
  const byTag = new Map(fams.map(f => [f.tag, { tag: f.tag, notes: f.notes, students: [] }]));
  for (const s of studs) {
    const f = byTag.get(s.tag);
    if (f) f.students.push({ id: s.id, first: s.first, last: s.last, grade: s.grade, notes: s.notes });
  }
  return [...byTag.values()].filter(f => f.students.length > 0);
}
function familyByTag(tag) {
  const f = db.prepare('SELECT * FROM families WHERE tag=?').get(String(tag).trim());
  if (!f) return null;
  const students = db.prepare('SELECT * FROM students WHERE tag=? AND active=1 ORDER BY id').all(f.tag);
  if (!students.length) return null;
  return { tag: f.tag, notes: f.notes, students };
}

/* Replace or merge the whole roster. `families` shape comes from lib/csv.js. */
function importRoster(families, replace) {
  const tx = db.transaction(() => {
    if (replace) {
      db.exec('DELETE FROM queue');
      db.exec('DELETE FROM students');
      db.exec('DELETE FROM families');
    }
    const insF = db.prepare(`INSERT INTO families (tag, notes) VALUES (?,?)
                             ON CONFLICT(tag) DO NOTHING`);
    const insS = db.prepare('INSERT INTO students (tag,first,last,grade,notes) VALUES (?,?,?,?,?)');
    let count = 0;
    for (const f of families) {
      insF.run(f.tag, '');
      for (const s of f.students) {
        insS.run(f.tag, s.first, s.last, s.grade || '', s.notes || '');
        count++;
      }
    }
    return count;
  });
  return tx(families, replace);
}

function addStudent({ tag, first, last, grade, notes }) {
  tag = String(tag).trim();
  db.prepare('INSERT INTO families (tag) VALUES (?) ON CONFLICT(tag) DO NOTHING').run(tag);
  const info = db.prepare('INSERT INTO students (tag,first,last,grade,notes) VALUES (?,?,?,?,?)')
    .run(tag, first.trim(), last.trim(), (grade || '').trim(), notes || '');
  return info.lastInsertRowid;
}
function updateStudent(id, fields) {
  const allowed = ['first', 'last', 'grade', 'notes'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in fields) { sets.push(`${k}=?`); vals.push(String(fields[k])); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE students SET ${sets.join(',')} WHERE id=?`).run(...vals);
}
function deleteStudent(id) {
  const s = db.prepare('SELECT * FROM students WHERE id=?').get(id);
  if (!s) return null;
  db.prepare('DELETE FROM students WHERE id=?').run(id);
  const left = db.prepare('SELECT COUNT(*) c FROM students WHERE tag=?').get(s.tag).c;
  if (!left) {
    db.prepare('DELETE FROM queue WHERE tag=?').run(s.tag);
    db.prepare('DELETE FROM families WHERE tag=?').run(s.tag);
  }
  return s;
}

/* ---------------- queue ---------------- */
function queueRows() {
  return db.prepare('SELECT * FROM queue ORDER BY id ASC').all();
}
function addToQueue(tag, lane, actor) {
  const info = db.prepare('INSERT INTO queue (lane, tag, added_at, added_by) VALUES (?,?,?,?)')
    .run(lane, String(tag).trim(), Date.now(), actor || '');
  const fam = familyByTag(tag);
  const ins = db.prepare('INSERT OR IGNORE INTO queue_students (queue_id, student_id, in_car) VALUES (?,?,0)');
  for (const s of fam.students) ins.run(info.lastInsertRowid, s.id);
  return info.lastInsertRowid;
}
function removeFromQueue(qid) {
  const row = db.prepare('SELECT * FROM queue WHERE id=?').get(qid);
  if (!row) return null;
  db.prepare('DELETE FROM queue WHERE id=?').run(qid);
  db.prepare('DELETE FROM queue_students WHERE queue_id=?').run(qid);
  return row;
}
function moveQueue(qid, lane) {
  db.prepare('UPDATE queue SET lane=? WHERE id=?').run(lane, qid);
}
function toggleInCar(qid, studentId) {
  const cur = db.prepare('SELECT in_car FROM queue_students WHERE queue_id=? AND student_id=?').get(qid, studentId);
  if (!cur) return null;
  const next = cur.in_car ? 0 : 1;
  db.prepare('UPDATE queue_students SET in_car=? WHERE queue_id=? AND student_id=?').run(next, qid, studentId);
  const remaining = db.prepare('SELECT COUNT(*) c FROM queue_students WHERE queue_id=? AND in_car=0').get(qid).c;
  return { inCar: !!next, allIn: remaining === 0 };
}
function inCarMap(qid) {
  const rows = db.prepare('SELECT student_id, in_car FROM queue_students WHERE queue_id=?').all(qid);
  const m = {};
  for (const r of rows) m[r.student_id] = !!r.in_car;
  return m;
}
function clearLanes() {
  const n = db.prepare('SELECT COUNT(*) c FROM queue').get().c;
  db.exec('DELETE FROM queue');
  return n;
}

module.exports = {
  DB_PATH, DATA_DIR, MAX_SPOTS,
  open, close, handle,
  getSettings, setSetting, getLogo, rolloverIfNewDay,
  logEvent, recentEvents,
  getRoster, familyByTag, importRoster,
  addStudent, updateStudent, deleteStudent,
  queueRows, addToQueue, removeFromQueue, moveQueue, toggleInCar, inCarMap, clearLanes
};
