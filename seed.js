/* ---------------------------------------------------------------------------
   seed.js — load a fake roster so you can try the system before real data exists.

     docker compose exec pickup node seed.js

   Safe by design: it refuses to run if there are already students in the
   database, so it can never overwrite a real roster.
--------------------------------------------------------------------------- */
const db = require('./db');

const FIRST = ['Ava','Liam','Noah','Mia','Ethan','Zoe','Caleb','Layla','Owen','Nora','Eli','Ruby','Jonah','Ivy','Micah','Hazel','Levi','Cora','Silas','Wren','Asher','Elle','Jude','Nova','Tate','Sloane','Beau','Piper','Reid','Maeve','Knox','Adley','Cash','June','Rhett','Lark','Emmy','Grant','Poppy','Dean'];
const LAST  = ['Adams','Baker','Cole','Dixon','Ellis','Ford','Gray','Hayes','Irwin','Jones','Keller','Lyons','Moore','Nash','Owens','Price','Quinn','Reed','Shaw','Tate','Vance','Ward','Young','Boyd','Duke','Hunt'];
const HRS   = ['K-01','K-02','1-01','1-02','2-01','2-02','3-01','3-02','4-01','5-01'];

db.open();

const existing = db.getRoster().reduce((a, f) => a + f.students.length, 0);
if (existing > 0) {
  console.error(`Refusing to seed: there are already ${existing} students in the database.`);
  console.error('Clear the roster from Admin first if you really want sample data.');
  db.close();
  process.exit(1);
}

let n = 7;
const rnd = () => (n = (n * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = arr => arr[Math.floor(rnd() * arr.length)];

const families = [];
for (let i = 0; i < 48; i++) {
  const last = pick(LAST);
  const kids = rnd() < 0.26 ? (rnd() < 0.22 ? 3 : 2) : 1;   // ~1 in 4 families has siblings
  const students = [];
  for (let k = 0; k < kids; k++) {
    const hr = pick(HRS);
    students.push({ first: pick(FIRST), last, grade: hr.split('-')[0], notes: '' });
  }
  families.push({ tag: String(101 + i * 3), students });
}

const count = db.importRoster(families, true);
db.logEvent('system', 'SEED', `Loaded ${count} sample students`);
console.log(`Seeded ${count} students across ${families.length} hang tags.`);
console.log('Hang tags run 101, 104, 107, … 242. Admin PIN is 1234.');
db.close();
