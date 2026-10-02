// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from '../js/core.js';
import { computeBuild } from '../tools/stamp-build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = readFileSync(join(ROOT, 'test/fixtures/rsvp_sample.csv'), 'utf8');
const parsed = core.parseRsvpCsv(sample);
const R = parsed.rows;
const byId = id => R.find(r => r.recordId === id);
const close = (a, b) => Math.abs(a - b) < 0.001;

// ---------- matching primitives ----------

test('similarity matches pg_trgm figures', () => {
  assert.ok(close(core.similarity('sarah kim', 'sarah lee'), 6 / 14));
  assert.ok(close(core.similarity('sara kim', 'sarah kim'), 8 / 11));
  assert.equal(core.similarity('kim', 'kim'), 1);
  assert.equal(core.similarity('', 'kim'), 0);
  assert.ok(close(core.similarity('sara', 'sarah'), 4 / 7));
  assert.ok(core.similarity('sally', 'sarah') < 0.3);
});

test('normalizeName folds accents, case, apostrophes and punctuation', () => {
  assert.equal(core.normalizeName('  Hélène  Dupré '), 'helene dupre');
  assert.equal(core.normalizeName("O'Brien"), 'obrien');
  assert.equal(core.normalizeName('O’Brien'), 'obrien');
  assert.equal(core.normalizeName('Jean-Luc'), 'jean luc');
  assert.equal(core.normalizeName('Zoë'), 'zoe');
  assert.equal(core.normalizeName('Søren Æbelø'), 'soren aebelo');
  assert.equal(core.normalizeName(null), '');
});

// ---------- CSV parsing ----------

test('parseCsv handles quotes, embedded delimiters, line breaks, BOM, CRLF', () => {
  const t = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3\n';
  assert.deepEqual(core.parseCsv(t), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['1', '2', '3']]);
});

test('parseCsv keeps a stray quote literal and rejects an unclosed one', () => {
  assert.deepEqual(core.parseCsv('a,b\n27" screen,VP "Sales\nx,y'), [['a', 'b'], ['27" screen', 'VP "Sales'], ['x', 'y']]);
  assert.throws(() => core.parseCsv('a,b\n"Jo,x\ny,z'), core.CsvError);
});

test('parseCsv detects semicolon-delimited files (Excel, French locale)', () => {
  assert.deepEqual(core.parseCsv('First Name;Last Name\nAnne;Dupont'), [['First Name', 'Last Name'], ['Anne', 'Dupont']]);
});

test('csvCell quotes everything and neutralises formulas', () => {
  assert.equal(core.csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(core.csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(core.csvCell('-5'), '"\'-5"');
  assert.equal(core.csvCell(null), '""');
  assert.equal(core.csvCell(true), '"true"');
  assert.equal(core.csvCell(3), '"3"');
});

// ---------- RSVP import ----------

test('imports a HubSpot label-header export', () => {
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.equal(R.length, 12); // 13 data rows, 1 without a name skipped
  assert.deepEqual(byId('1007').days, ['2026-10-06', '2026-10-07']);
  assert.equal(byId('1007').slot, '11:00am - 12:00pm'); // en dash in file → canonical hyphen value
  assert.equal(core.isGoing(byId('1007').status), true); // curly apostrophe
  assert.deepEqual(byId('1008').days, []); // decline option dropped
  assert.equal(core.isGoing(byId('1008').status), false);
  assert.equal(byId('1011').partySize, null); // 0 is invalid
  assert.equal(byId('1012').partySize, null); // blank
  assert.equal(byId('1012').first, 'Mary "MJ"');
  assert.equal(byId('1012').company, 'Line One\nLine Two Co');
  assert.equal(byId('1013').slot, null); // unknown slot
  assert.deepEqual(byId('1013').days, ['2026-10-06']); // unknown day ignored
  assert.equal(byId('1001').rep, 'Piper Bucholz');
  assert.equal(byId('1001').key, 'rec:1001');
});

test('import report counts and warnings', () => {
  const r = parsed.report;
  assert.equal(r.total, 12);
  assert.equal(r.byDay[0].all, 5); // Oct 6: 1002, 1004, 1007, 1012, 1013
  assert.deepEqual(r.byDay.map(d => d.label), ['Oct 6', 'Oct 7', 'Oct 8']);
  assert.equal(r.goingNoDay, 1); // Noah
  assert.deepEqual(r.byStatus, { "I'm Going": 11, "Sorry, I can't make it": 1 }); // curly apostrophe grouped
  const w = parsed.warnings.join(' | ');
  assert.match(w, /1 row\(s\) skipped/);
  assert.match(w, /Saturday/);
  assert.match(w, /7:00pm - 8:00pm/);
  assert.match(w, /invalid "People in group"/);
});

test('import accepts internal property names as headers', () => {
  const t = 'hs_object_id,firstname,lastname,email,company,nyc_oh_2026_10_rsvp,ny_oh_2026_10_days_of_attendance,nyc_oh_2026_10_time_of_attendance,ny_oh_2026_10_guest_count\n' +
            '7,Ann,Lee,ann@x.com,Co,I\'m Going,Oct 8,9:00am - 10:00am,3\n';
  const p = core.parseRsvpCsv(t);
  assert.equal(p.ok, true);
  assert.equal(p.rows[0].recordId, '7');
  assert.equal(p.rows[0].partySize, 3);
  assert.deepEqual(p.warnings, []);
});

test('import refuses a file without required columns', () => {
  const p = core.parseRsvpCsv('Record ID,Name\n1,Ann Lee\n');
  assert.equal(p.ok, false);
  assert.match(p.errors[0], /First Name, Last Name, Email/);
  assert.equal(core.parseRsvpCsv('').ok, false);
});

test('duplicate Record IDs collapse to the last row', () => {
  const p = core.parseRsvpCsv('Record ID,First Name,Last Name,Email,Open House RSVP\n1,Ann,Lee,a@x.com,I\'m Going\n1,Anne,Lee,a@x.com,I\'m Going\n');
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].first, 'Anne');
  assert.match(p.warnings.join(), /duplicate/);
});

test('import refuses the wrong files', () => {
  const kiosk = core.checkinsToCsv([core.buildCheckin({ path: 'walk_in', rsvp: null, first: 'A', last: 'B', company: 'C', email: 'a@b.co', walkinGroup: 1, walkinDays: [], walkinSlot: null }, 'iPad A')]);
  assert.match(core.parseRsvpCsv(kiosk).errors[0], /check-ins export/);
  const H = 'Record ID,First Name,Last Name,Email,Open House RSVP\n';
  assert.match(core.parseRsvpCsv(H + '1.23457E+11,Ann,Lee,a@x.com,I\'m Going\n').errors[0], /re-saved by Excel/);
  assert.match(core.parseRsvpCsv(H + '7,HÃ©lÃ¨ne,DuprÃ©,h@x.com,I\'m Going\n').errors[0], /garbled/);
  assert.match(core.parseRsvpCsv(H + '7,"Jo,Lee,a@x.com,I\'m Going\n').errors[0], /quote/);
  assert.match(core.parseRsvpCsv('Record ID,First Name,Last Name,Email\n1,A,B,a@b.co\n').errors[0], /Open House RSVP/); // plain contacts export
});

test('rows without an RSVP status are skipped', () => {
  const p = core.parseRsvpCsv('Record ID,First Name,Last Name,Email,Open House RSVP\n1,Ann,Lee,a@x.com,I\'m Going\n2,Bob,Ray,b@x.com,\n');
  assert.equal(p.rows.length, 1);
  assert.match(p.warnings.join(), /no "Open House RSVP" value/);
});

// ---------- lookup ----------

const names = res => res.matches.map(r => `${r.first} ${r.last} / ${r.company}`);

test('lookup: exact match wins and is flagged exact', () => {
  const res = core.lookup(R, 'sarah', 'KIM');
  assert.deepEqual(names(res), ['Sarah Kim / Maison Clair']);
  assert.equal(res.exact, true);
});

test('lookup: same name, two companies', () => {
  const res = core.lookup(R, 'Alex', 'Rivera');
  assert.deepEqual(names(res).sort(), ['Alex Rivera / Company A', 'Alex Rivera / Company B']);
});

test('lookup: typo still finds, flagged not exact', () => {
  const res = core.lookup(R, 'Sara', 'Kim');
  assert.deepEqual(names(res), ['Sarah Kim / Maison Clair']);
  assert.equal(res.exact, false);
  assert.equal(core.lookup(R, 'Alex', 'Rivers').matches.length, 2);
});

test('lookup: does not surface other guests on first name alone', () => {
  assert.equal(core.lookup(R, 'Sarah', 'Lee').matches.length, 0);
  assert.equal(core.lookup(R, 'Sally', 'Kim').matches.length, 0);
  assert.equal(core.lookup(R, 'Taylor', 'Morgan').matches.length, 0);
});

test('lookup: swapped names and accents', () => {
  assert.deepEqual(names(core.lookup(R, 'Kim', 'Sarah')), ['Sarah Kim / Maison Clair']);
  const h = core.lookup(R, 'Helene', 'Dupre');
  assert.equal(h.matches[0].recordId, '1007');
  assert.equal(h.exact, true);
});

test('lookup: needs both names; never more than 5', () => {
  assert.equal(core.lookup(R, 'Sarah', '').matches.length, 0);
  const many = Array.from({ length: 9 }, (_, i) => ({ key: 'k' + i, first: 'Jo', last: 'Smith', firstNorm: 'jo', lastNorm: 'smith', company: 'C' + i }));
  assert.equal(core.lookup(many, 'Jo', 'Smith').matches.length, 5);
});

test('lookup: compound surnames typed without spaces', () => {
  const rows = [{ key: 'a', first: 'Pieter', last: 'Van Der Berg', firstNorm: 'pieter', lastNorm: 'van der berg', company: 'X' }];
  assert.equal(core.lookup(rows, 'Pieter', 'Vanderberg').exact, true);
  assert.equal(core.lookup(rows, 'Pieter', 'Vanderburg').matches.length, 1);
});

test('walk-in links to an RSVP only when the surname matches too', () => {
  assert.equal(core.matchWalkinToRsvp(R, 'sarah.kim@example.com', 'Kim').recordId, '1001');
  assert.equal(core.matchWalkinToRsvp(R, 'sarah.kim@example.com', 'Kimm').recordId, '1001'); // typo
  assert.equal(core.matchWalkinToRsvp(R, 'sarah.kim@example.com', 'Park'), null);           // colleague / shared address
  assert.equal(core.sameSurname('Dupré', 'dupre'), true);
});

test('findByEmail is case-insensitive', () => {
  assert.equal(core.findByEmail(R, ' SARAH.KIM@example.com ').recordId, '1001');
  assert.equal(core.findByEmail(R, 'nobody-here@example.com'), null);
});

// ---------- check-ins ----------

const NOW = new Date('2026-10-07T14:05:00Z'); // 10:05 in New York
const sarah = byId('1001');

test('lookup check-in: group unchanged', () => {
  const c = core.buildCheckin({ path: 'lookup', rsvp: sarah, first: 'Sarah', last: 'Kim', company: 'Maison Clair', groupAnswer: 'same', bring: 1 }, 'iPad A', NOW);
  assert.equal(c.eventDate, '2026-10-07');
  assert.equal(c.atLocal, '2026-10-07 10:05');
  assert.equal(c.groupToday, 2);
  assert.equal(c.partySizeOnRsvp, 2);
  assert.equal(c.groupChanged, false);
  assert.equal(c.rsvpKey, 'rec:1001');
  assert.equal(c.email, 'sarah.kim@example.com');
  assert.equal(c.emailMatched, false);
  assert.match(c.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('lookup check-in: group changed', () => {
  const c = core.buildCheckin({ path: 'lookup', rsvp: sarah, first: 'Sarah', last: 'Kim', company: 'MC', groupAnswer: 'changed', bring: 3 }, 'iPad A', NOW);
  assert.equal(c.groupToday, 4);
  assert.equal(c.groupChanged, true);
  assert.equal(c.groupAnswer, 'changed');
  assert.equal(c.company, 'MC'); // edited value kept on the check-in
});

test('lookup check-in: declined RSVP has nothing to compare against', () => {
  const c = core.buildCheckin({ path: 'lookup', rsvp: byId('1008'), first: 'Dana', last: 'Decline', company: 'N', groupAnswer: null, bring: 0 }, 'iPad A', NOW);
  assert.equal(c.partySizeOnRsvp, null);
  assert.equal(c.groupChanged, null);
  assert.equal(c.groupToday, 1);
});

test('walk-in check-in: email matches an RSVP', () => {
  const c = core.buildCheckin({ path: 'walk_in', rsvp: sarah, first: 'Sally', last: 'Park', company: 'X', email: 'Sarah.Kim@example.com', walkinGroup: 3, walkinDays: ['2026-10-07'], walkinSlot: '10:00am - 11:00am' }, 'iPad B', NOW);
  assert.equal(c.emailMatched, true);
  assert.equal(c.recordId, '1001');
  assert.equal(c.first, 'Sally'); // typed name kept
  assert.equal(c.partySizeOnRsvp, 2);
  assert.equal(c.groupChanged, true);
  assert.equal(c.groupToday, 3);
});

test('walk-in check-in: not on the list', () => {
  const c = core.buildCheckin({ path: 'walk_in', rsvp: null, first: 'Taylor', last: 'Morgan', company: 'T', email: 't@x.com', walkinGroup: 1, walkinDays: ['2026-10-07'], walkinSlot: '9:00am - 10:00am' }, 'iPad A', NOW);
  assert.equal(c.rsvpKey, null);
  assert.equal(c.groupChanged, null);
  assert.equal(c.partySizeOnRsvp, null);
});

test('same person same day is found by RSVP key or email; other days are not', () => {
  const a = core.buildCheckin({ path: 'lookup', rsvp: sarah, first: 'Sarah', last: 'Kim', company: 'MC', groupAnswer: 'same', bring: 1 }, 'iPad A', NOW);
  const viaEmail = core.buildCheckin({ path: 'walk_in', rsvp: null, first: 'Sarah', last: 'Kim', company: 'MC', email: 'SARAH.KIM@example.com', walkinGroup: 1, walkinDays: [], walkinSlot: null }, 'iPad A', NOW);
  assert.equal(core.findSameDay([a], viaEmail), a);
  const viaRsvp = core.buildCheckin({ path: 'walk_in', rsvp: sarah, first: 'Sara', last: 'Kim', company: 'MC', email: 'sarah.kim@example.com', walkinGroup: 1, walkinDays: [], walkinSlot: null }, 'iPad A', NOW);
  assert.equal(core.findSameDay([a], viaRsvp), a);
  // two colleagues sharing one address are two people
  const tom = core.buildCheckin({ path: 'walk_in', rsvp: null, first: 'Tom', last: 'Lane', company: 'S', email: 'info@studio.com', walkinGroup: 1, walkinDays: [], walkinSlot: null }, 'iPad A', NOW);
  const ana = core.buildCheckin({ path: 'walk_in', rsvp: null, first: 'Ana', last: 'Ruiz', company: 'S', email: 'INFO@studio.com', walkinGroup: 2, walkinDays: [], walkinSlot: null }, 'iPad A', NOW);
  assert.equal(core.findSameDay([tom], ana), null);
  const nextDay = core.buildCheckin({ path: 'lookup', rsvp: sarah, first: 'Sarah', last: 'Kim', company: 'MC', groupAnswer: 'same', bring: 1 }, 'iPad A', new Date('2026-10-08T14:00:00Z'));
  assert.equal(core.findSameDay([a], nextDay), null);
});

test('repeat visit only ever raises the group', () => {
  const a = core.buildCheckin({ path: 'lookup', rsvp: sarah, first: 'Sarah', last: 'Kim', company: 'MC', groupAnswer: 'same', bring: 1 }, 'iPad A', NOW);
  assert.equal(core.applyRepeatVisit(a, 2), null);
  assert.equal(core.applyRepeatVisit(a, 1), null);
  const up = core.applyRepeatVisit(a, 4, new Date('2026-10-07T18:00:00Z'));
  assert.equal(up.groupToday, 4);
  assert.equal(up.groupChanged, true);
  assert.equal(up.groupUpdatedAtLocal, '2026-10-07 14:00');
  assert.equal(up.id, a.id);
});

test('dayStats separates expected RSVPs, other-day RSVPs and walk-ins', () => {
  const d = '2026-10-07';
  const mk = (path, rsvp, extra = {}) => ({ ...core.buildCheckin({ path, rsvp, first: 'x', last: 'y', company: 'c', email: 'w@x.com', groupAnswer: 'same', bring: 0, walkinGroup: 2, walkinDays: [d], walkinSlot: null }, 'iPad A', NOW), ...extra });
  const list = [mk('lookup', sarah), mk('lookup', byId('1004')), mk('walk_in', null)];
  const s = core.dayStats(list, R, d);
  assert.equal(s.parties, 3);
  assert.equal(s.people, 2 + 1 + 2); // Sarah 2, Jordan 1, walk-in 2
  assert.equal(s.rsvpArrived, 1);   // Sarah booked Oct 7
  assert.equal(s.rsvpOtherDay, 1);  // Jordan booked Oct 6
  assert.equal(s.walkIns, 1);
  assert.equal(s.rsvpNoDayOrDeclined, 0);
  const s2 = core.dayStats([...list, mk('lookup', byId('1008')), mk('lookup', byId('1009'))], R, d);
  assert.equal(s2.rsvpOtherDay, 1);          // decliner and no-day RSVP are not "another day"
  assert.equal(s2.rsvpNoDayOrDeclined, 2);
  assert.equal(s.expectedParties, 3); // Sarah, Marcus, Hélène
  assert.equal(s.expectedPeople, 2 + 2 + 2);
  assert.equal(s.eventDay, true);
  assert.equal(core.dayStats([], R, '2026-10-05').eventDay, false);
});

// ---------- export ----------

test('checkinsToCsv: BOM, CRLF, header, labels, formula guard', () => {
  const c = core.buildCheckin({ path: 'lookup', rsvp: byId('1011'), first: '=cmd', last: 'Formula', company: '=HYPERLINK("http://x")', groupAnswer: null, bring: 0 }, 'iPad A', NOW);
  const h = core.buildCheckin({ path: 'lookup', rsvp: byId('1007'), first: 'Hélène', last: 'Dupré', company: 'Dupré, Fils & Cie', groupAnswer: 'same', bring: 1 }, 'iPad A', NOW);
  const csv = core.checkinsToCsv([c, h]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 4); // header, 2 rows, trailing empty
  assert.ok(lines[0].startsWith('"checkin_id","device","event_date"'));
  assert.ok(csv.includes('"\'=cmd"'));
  assert.ok(csv.includes('"Dupré, Fils & Cie"'));
  assert.ok(csv.includes('"Oct 6;Oct 7"'));
  const back = core.parseCsv(csv);
  assert.equal(back.length, 3);
  assert.equal(back[0].length, core.EXPORT_COLUMNS.length);
});

test('exportFileName and unexportedCount', () => {
  assert.equal(core.exportFileName('iPad A', new Date('2026-10-06T17:00:05Z')), 'checkins_iPadA_20261006_130005.csv');
  const a = { atUtc: '2026-10-06T14:00:00.000Z', groupUpdatedAtUtc: null };
  const b = { atUtc: '2026-10-06T16:00:00.000Z', groupUpdatedAtUtc: null };
  const c = { atUtc: '2026-10-06T13:00:00.000Z', groupUpdatedAtUtc: '2026-10-06T16:30:00.000Z' };
  assert.equal(core.unexportedCount([a, b, c], null), 3);
  assert.equal(core.unexportedCount([a, b, c], '2026-10-06T15:00:00.000Z'), 2);
});

test('time helpers use New York time', () => {
  assert.equal(core.ymdInTz(new Date('2026-10-07T03:30:00Z')), '2026-10-06'); // 23:30 the evening before
  assert.equal(core.localStamp(new Date('2026-10-06T04:00:00Z')), '2026-10-06 00:00');
});

test('display helpers', () => {
  assert.equal(core.formatDays(['2026-10-06']), 'Oct 6');
  assert.equal(core.formatDays(['2026-10-06', '2026-10-07']), 'Oct 6 & Oct 7');
  assert.equal(core.formatDays(['2026-10-06', '2026-10-07', '2026-10-08']), 'Oct 6, Oct 7 & Oct 8');
  assert.equal(core.formatDays([]), '');
  assert.equal(core.formatSlot('10:00am - 11:00am'), '10:00am – 11:00am');
});

// ---------- password ----------

test('password hash round-trip', async () => {
  const h = await core.hashPassword('open-house-2026', null, 1000);
  assert.equal(await core.verifyPassword('open-house-2026', h), true);
  assert.equal(await core.verifyPassword('open-house-2025', h), false);
  assert.equal(await core.verifyPassword('x', null), false);
});

// ---------- packaging ----------

test('service worker BUILD matches the cached files (run `npm run stamp` after any change)', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.equal(sw.match(/const BUILD = '([0-9a-f]+)'/)[1], computeBuild(ROOT), 'Files changed: run `npm run stamp`, then commit sw.js too');
});

test('service worker caches every file the page uses', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const assets = [...sw.matchAll(/'\.\/([^']*)'/g)].map(m => m[1]).filter(Boolean);
  for (const a of assets) assert.ok(existsSync(join(ROOT, a)), `missing cached asset ${a}`);
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const ref of [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1])) {
    assert.ok(existsSync(join(ROOT, ref)), `index.html references missing file ${ref}`);
    assert.ok(assets.includes(ref), `index.html references ${ref} but sw.js does not cache it`);
  }
});
