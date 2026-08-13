/* ---------------------------------------------------------------------------
   lib/csv.js — roster CSV parsing and export.

   Import is CSV only, on purpose. Parsing .xlsx would mean a zip reader, an XML
   parser, and a dependency that has to keep working for years. "File > Save As >
   CSV" costs the admin ten seconds once a year. That is a good trade.

   The importer is HEADER-AWARE: it reads the column names in the first row and
   maps fields by name, not by position. A leftover column from an older export
   (for example a "Homeroom" or "Default Lane" column, neither of which this
   system uses any more) is harmlessly ignored instead of shifting every field
   one to the right.
--------------------------------------------------------------------------- */

const HEADERS = ['Hang Tag', 'Last Name', 'First Name', 'Grade', 'Notes'];

/* Split one CSV line, honouring quoted fields and doubled quotes. Also accepts tabs. */
function splitLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === '\t') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/* Which column holds each field. Built from the header row when there is one,
   otherwise the fixed positions of the current template. Any header we don't
   recognise (like an old Homeroom or Default Lane column) simply isn't mapped,
   so it's dropped. */
function columnMap(headerCells) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const find = (...names) => {
    for (let i = 0; i < headerCells.length; i++)
      if (names.includes(norm(headerCells[i]))) return i;
    return -1;
  };
  return {
    tag:   find('hangtag', 'tag'),
    last:  find('lastname', 'last'),
    first: find('firstname', 'first'),
    grade: find('grade'),
    notes: find('notes', 'note')
  };
}

// Positions used when the file has no header row at all.
const POSITIONAL = { tag: 0, last: 1, first: 2, grade: 3, notes: 4 };

/* A first row is a header if it names at least two known columns AND has no
   bare number where a hang tag could be. This recognises a header wherever the
   Hang Tag column happens to sit, so reordered exports still map correctly. */
function looksLikeHeaderRow(cells) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const known = ['hangtag', 'tag', 'lastname', 'last', 'firstname', 'first',
                 'grade', 'notes', 'note'];
  const hits = cells.filter(c => known.includes(norm(c))).length;
  const hasNumber = cells.some(c => /^\d+$/.test(String(c).trim()));
  return hits >= 2 && !hasNumber;
}

/*  Parse raw CSV text into { families, errors, skipped }.
    - Detects a header row and maps columns by name.
    - Skips rows whose Notes are marked SAMPLE ROW (so importing the blank
      template unmodified brings in nothing, rather than sample children).
    - Every rejected row is reported with its real line number and a reason.  */
function parseRoster(text) {
  const rawLines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const errors = [];
  const fams = new Map();
  let skipped = 0;
  let start = 0;
  let map = POSITIONAL;

  const first = splitLine(rawLines[0] || '');
  if (first.length && looksLikeHeaderRow(first)) { map = columnMap(first); start = 1; }

  const cellAt = (cells, idx) => (idx >= 0 && cells[idx] != null ? String(cells[idx]).trim() : '');

  for (let i = start; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i];
    if (!raw || !raw.trim()) continue;

    const cells = splitLine(raw);
    const tag = cellAt(cells, map.tag);
    const last = cellAt(cells, map.last);
    const firstName = cellAt(cells, map.first);
    const grade = cellAt(cells, map.grade);
    const notes = cellAt(cells, map.notes);

    if (/sample row/i.test(notes)) { skipped++; continue; }

    if (!tag) { errors.push(`Line ${lineNo}: missing hang tag`); continue; }
    if (!/^\d+$/.test(tag)) { errors.push(`Line ${lineNo}: hang tag "${tag}" is not a number`); continue; }
    if (!firstName) { errors.push(`Line ${lineNo}: missing first name`); continue; }
    if (!last) { errors.push(`Line ${lineNo}: missing last name`); continue; }

    if (!fams.has(tag)) fams.set(tag, { tag, students: [] });
    fams.get(tag).students.push({ first: firstName, last, grade, notes });
  }

  return { families: [...fams.values()], errors, skipped };
}

function esc(v) {
  v = v == null ? '' : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function exportRoster(families) {
  const lines = [HEADERS.join(',')];
  for (const f of families)
    for (const s of f.students)
      lines.push([f.tag, s.last, s.first, s.grade, s.notes].map(esc).join(','));
  return lines.join('\r\n');
}

function templateCsv() {
  return [
    HEADERS.join(','),
    '101,Whitfield,Ava,3,SAMPLE ROW - delete before import',
    '101,Whitfield,Caleb,K,SAMPLE ROW - delete before import (sibling: same hang tag as Ava)',
    '104,Boyd,Micah,5,SAMPLE ROW - delete before import',
    '107,Nash,Sloane,1,SAMPLE ROW - delete before import',
    ''
  ].join('\r\n');
}

module.exports = { HEADERS, splitLine, parseRoster, exportRoster, templateCsv };
