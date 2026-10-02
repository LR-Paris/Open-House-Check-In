// Open House kiosk — pure logic. No DOM, no storage.
// Imported by js/app.js in the browser and by test/core.test.js in Node.

export const VERSION = '1.0.0'; // human label shown in the admin view; the service worker's BUILD hash is what forces updates

export const EVENT = {
  tz: 'America/New_York',
  days: [
    { label: 'Oct 6', date: '2026-10-06' },
    { label: 'Oct 7', date: '2026-10-07' },
    { label: 'Oct 8', date: '2026-10-08' },
  ],
  declineDayLabel: "Sorry I can't make it", // days-property option meaning "not coming"; dropped on import
  goingStatus: "I'm Going",
  // Exact HubSpot enum values (hyphen-minus). Displayed with an en dash.
  slots: [
    '9:00am - 10:00am', '10:00am - 11:00am', '11:00am - 12:00pm', '12:00pm - 1:00pm',
    '1:00pm - 2:00pm', '2:00pm - 3:00pm', '3:00pm - 4:00pm', '4:00pm - 5:00pm',
    '5:00pm - 6:00pm', '6:00pm - 6:30pm',
  ],
};

export const LOOKUP = { firstMin: 0.3, lastMin: 0.5, maxResults: 5 };
export const STEPPER_MAX = 20;
export const PARTY_MAX = 50;
export const IDLE_MS = { lookup: 60_000, confirm: 60_000, walkin: 120_000, thanks: 20_000, admin: 120_000, pw: 60_000 };

// ---------- text helpers ----------

const clean = v => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/** Accent-folded, lowercased, punctuation-free name used for matching. */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd')
    .replace(/['’‘`´]/g, '')            // O'Brien == OBrien
    .replace(/[^\p{L}\p{N}]+/gu, ' ')   // hyphens, dots, commas → word breaks
    .trim();
}

/** Loose key for comparing headers and enum labels: lowercase, straight quotes, alphanumerics only. */
export function normKey(s) {
  return String(s ?? '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^a-z0-9]/g, '');
}

export const lowerEmail = s => String(s ?? '').trim().toLowerCase();
export const validEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s ?? '').trim());

// ---------- trigram similarity (port of PostgreSQL pg_trgm) ----------

/** Set of trigrams: each word padded with two leading spaces and one trailing space. Input must be normalizeName()d. */
export function trigrams(s) {
  const set = new Set();
  for (const w of String(s).split(' ')) {
    if (!w) continue;
    const p = '  ' + w + ' ';
    for (let i = 0; i + 3 <= p.length; i++) set.add(p.slice(i, i + 3));
  }
  return set;
}

/** pg_trgm similarity(): |A ∩ B| / |A ∪ B|. */
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- CSV ----------

function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

export class CsvError extends Error {}

/**
 * RFC 4180 parser: quoted fields, doubled quotes, delimiters and line breaks inside quotes, BOM, CRLF/LF/CR.
 * A quote opens quoting only at the start of a field (a stray `27" screen` stays literal, as in Excel).
 * Throws CsvError on a quote that is never closed (otherwise the rest of the file would vanish into one cell).
 */
export function parseCsv(text) {
  text = String(text ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [], field = '', inQ = false, atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && atStart) { inQ = true; atStart = false; continue; }
    if (ch === delim) { row.push(field); field = ''; atStart = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; atStart = true;
      continue;
    }
    field += ch;
    atStart = false;
  }
  if (inQ) throw new CsvError('unclosed-quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: always quoted; leading = + - @ neutralised so Excel doesn't run it as a formula. */
export function csvCell(v) {
  if (v === null || v === undefined) return '""';
  let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  if (FORMULA_START.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// ---------- RSVP import ----------

// Header aliases: HubSpot UI exports use property labels; API/internal names accepted too.
export const FIELD_ALIASES = {
  recordId: ['Record ID', 'Contact ID', 'Record ID - Contact', 'hs_object_id', 'id'],
  first: ['First Name', 'firstname', 'Prénom'],
  last: ['Last Name', 'lastname', 'Nom'],
  email: ['Email', 'E-mail', 'Email Address', 'email'],
  company: ['Company Name', 'Company', 'company'],
  jobTitle: ['Job Title', 'jobtitle'],
  status: ['Open House RSVP', 'nyc_oh_2026_10_rsvp'],
  days: ['Day(s) of Attendance', 'Days of Attendance', 'ny_oh_2026_10_days_of_attendance'],
  slot: ['Time of Attendance', 'nyc_oh_2026_10_time_of_attendance'],
  partySize: ['People in group', 'ny_oh_2026_10_guest_count'],
  rep: ['Your Sales Rep', 'nyc_oh_2026_10_invited_by'],
};
// 'status' is required: it is what makes a row an RSVP (a plain contacts export has no such column).
export const REQUIRED_FIELDS = ['first', 'last', 'email', 'status'];
export const RECOMMENDED_FIELDS = ['recordId', 'company', 'days', 'slot', 'partySize'];

export function mapHeaders(header) {
  const idx = {};
  const keys = header.map(normKey);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const want = aliases.map(normKey);
    const i = keys.findIndex(k => want.includes(k));
    if (i !== -1) idx[field] = i;
  }
  return {
    idx,
    missingRequired: REQUIRED_FIELDS.filter(f => !(f in idx)),
    missingRecommended: RECOMMENDED_FIELDS.filter(f => !(f in idx)),
  };
}

const DAY_BY_KEY = new Map(EVENT.days.map(d => [normKey(d.label), d.date]));
const DECLINE_KEY = normKey(EVENT.declineDayLabel);
const SLOT_BY_KEY = new Map(EVENT.slots.map(s => [normKey(s), s]));
const LABEL_BY_DATE = new Map(EVENT.days.map(d => [d.date, d.label]));

/** "Oct 6;Oct 8" → { dates: ['2026-10-06','2026-10-08'], unknown: [] }. The decline option is dropped silently. */
export function mapDays(cell) {
  const dates = [], unknown = [];
  for (const part of String(cell ?? '').split(/[;,]/)) {
    const k = normKey(part);
    if (!k || k === DECLINE_KEY) continue;
    const d = DAY_BY_KEY.get(k);
    if (d) { if (!dates.includes(d)) dates.push(d); } else unknown.push(part.trim());
  }
  return { dates: dates.sort(), unknown };
}

/** Any dash or spacing variant of a HubSpot slot → the canonical HubSpot value, else null. */
export function mapSlot(cell) {
  const k = normKey(String(cell ?? '').replace(/[–—]/g, '-'));
  return k ? (SLOT_BY_KEY.get(k) ?? null) : null;
}

export function parsePartySize(cell) {
  const s = String(cell ?? '').trim();
  if (s === '') return { value: null, invalid: false };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) return { value: null, invalid: true };
  return { value: Math.min(n, PARTY_MAX), invalid: n > PARTY_MAX };
}

export const isGoing = status => normKey(status) === normKey(EVENT.goingStatus);

// UTF-8 read as Latin-1/Windows-1252 ("Ã©"), or bytes that were not UTF-8 at all (U+FFFD).
const GARBLED = /[ÃÂ][\u0080-¿]|�/;

export function rsvpKeyOf({ recordId, email, first, last }) {
  if (recordId) return 'rec:' + recordId;
  if (email) return 'email:' + lowerEmail(email);
  return 'name:' + normalizeName(first) + '|' + normalizeName(last);
}

/**
 * Parse a HubSpot RSVP export. Never throws on bad rows; reports instead.
 * Returns { ok, errors[], warnings[], rows[], report }.
 */
export function parseRsvpCsv(text) {
  const errors = [], warnings = [];
  const fail = msg => { errors.push(msg); return { ok: false, errors, warnings, rows: [], report: null }; };
  let table;
  try { table = parseCsv(text); }
  catch (err) {
    if (err instanceof CsvError) return fail('The file has a quote character (") that is never closed, so it can’t be read reliably. Import the original HubSpot download.');
    throw err;
  }
  if (table.length < 2) return fail('The file has no data rows.');
  if (table[0].some(h => normKey(h) === 'checkinid')) {
    return fail('This is a check-ins export from the kiosk, not the HubSpot RSVP list. Pick the HubSpot file.');
  }
  const { idx, missingRequired, missingRecommended } = mapHeaders(table[0]);
  if (missingRequired.length) {
    const names = missingRequired.map(f => FIELD_ALIASES[f][0]).join(', ');
    errors.push(`Missing required column(s): ${names}. Export the saved HubSpot view as CSV with English headers.`);
    return { ok: false, errors, warnings, rows: [], report: null };
  }
  if (missingRecommended.length) {
    warnings.push('Missing column(s): ' + missingRecommended.map(f => FIELD_ALIASES[f][0]).join(', ') + '.');
  }

  const get = (r, f) => (f in idx ? r[idx[f]] : undefined);
  const byKey = new Map();
  let noName = 0, noStatus = 0, badParty = 0, dupRecord = 0, badRecordId = 0, garbled = 0;
  const unknownDays = new Set(), unknownSlots = new Set();

  for (const r of table.slice(1)) {
    const first = clean(get(r, 'first')) ?? '';
    const last = clean(get(r, 'last')) ?? '';
    if (!first && !last) { noName++; continue; }
    if (!clean(get(r, 'status'))) { noStatus++; continue; }
    const rid = clean(get(r, 'recordId'));
    if (rid && !/^\d+$/.test(rid)) badRecordId++;
    if (GARBLED.test(first + last + (clean(get(r, 'company')) ?? ''))) garbled++;
    const days = mapDays(get(r, 'days'));
    days.unknown.forEach(u => unknownDays.add(u));
    const slotRaw = clean(get(r, 'slot'));
    const slot = mapSlot(slotRaw);
    if (slotRaw && !slot) unknownSlots.add(slotRaw);
    const party = parsePartySize(get(r, 'partySize'));
    if (party.invalid) badParty++;
    const row = {
      recordId: clean(get(r, 'recordId')),
      first, last,
      firstNorm: normalizeName(first), lastNorm: normalizeName(last),
      email: clean(get(r, 'email')),
      company: clean(get(r, 'company')),
      jobTitle: clean(get(r, 'jobTitle')),
      status: clean(get(r, 'status')),
      days: days.dates,
      slot,
      partySize: party.value,
      rep: clean(get(r, 'rep')),
    };
    row.key = rsvpKeyOf(row);
    if (byKey.has(row.key)) dupRecord++;
    byKey.set(row.key, row); // later row wins
  }
  const rows = [...byKey.values()];
  if (badRecordId) return fail(`${badRecordId} Record ID(s) look changed (e.g. 1.23457E+11): the file was re-saved by Excel. Import the original HubSpot download.`);
  if (garbled) return fail(`${garbled} name(s) look garbled (e.g. "Ã©" instead of "é"): the file was re-saved by another program. Import the original HubSpot download.`);
  if (!rows.length) return fail('No RSVP rows were found (rows need a name and an "Open House RSVP" value).');

  if (noName) warnings.push(`${noName} row(s) skipped: no first or last name.`);
  if (noStatus) warnings.push(`${noStatus} row(s) skipped: no "Open House RSVP" value (not an RSVP).`);
  if (dupRecord) warnings.push(`${dupRecord} duplicate row(s) merged (same Record ID or email).`);
  if (unknownDays.size) warnings.push('Unrecognised day value(s) ignored: ' + [...unknownDays].join(' | '));
  if (unknownSlots.size) warnings.push('Unrecognised time slot value(s) ignored: ' + [...unknownSlots].join(' | '));
  if (badParty) warnings.push(`${badParty} row(s) with an invalid "People in group" value (treated as unknown or capped at ${PARTY_MAX}).`);
  const emailCounts = new Map();
  rows.forEach(r => r.email && emailCounts.set(lowerEmail(r.email), (emailCounts.get(lowerEmail(r.email)) || 0) + 1));
  const sharedEmails = [...emailCounts.values()].filter(n => n > 1).length;
  if (sharedEmails) warnings.push(`${sharedEmails} email address(es) are used by more than one RSVP; walk-in email matching picks the first.`);

  return { ok: true, errors, warnings, rows, report: rsvpReport(rows) };
}

export function rsvpReport(rows) {
  const byStatus = {};
  for (const r of rows) {
    const s = isGoing(r.status) ? EVENT.goingStatus : (r.status ?? '(blank)'); // "I’m Going" (curly) counts as going
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const byDay = EVENT.days.map(d => ({
    label: d.label, date: d.date,
    all: rows.filter(r => r.days.includes(d.date)).length,
    going: rows.filter(r => isGoing(r.status) && r.days.includes(d.date)).length,
  }));
  return {
    total: rows.length,
    byStatus,
    byDay,
    goingNoDay: rows.filter(r => isGoing(r.status) && r.days.length === 0).length,
    partySize: {
      unknown: rows.filter(r => r.partySize == null).length,
      one: rows.filter(r => r.partySize === 1).length,
      two: rows.filter(r => r.partySize === 2).length,
      threeToFive: rows.filter(r => r.partySize >= 3 && r.partySize <= 5).length,
      sixPlus: rows.filter(r => r.partySize >= 6).length,
    },
    noSlot: rows.filter(r => !r.slot).length,
    noCompany: rows.filter(r => !r.company).length,
  };
}

// ---------- lookup ----------

const squash = s => s.replace(/ /g, ''); // "van der berg" == "vanderberg"

function lastNameSimilar(ql, rl, cfg) {
  return similarity(ql, rl) >= cfg.lastMin || (ql.includes(' ') !== rl.includes(' ') && similarity(squash(ql), squash(rl)) >= cfg.lastMin);
}

function passes(qf, ql, rf, rl, cfg) {
  if (!rl) return false;
  if (!lastNameSimilar(ql, rl, cfg)) return false;
  return !rf || similarity(qf, rf) >= cfg.firstMin; // a record with no first name is decided by the last name
}

const sameNorm = (a, b) => a === b || squash(a) === squash(b);

/**
 * Find RSVPs for a typed name. Exact (accent/case/space-insensitive) matches win outright;
 * otherwise per-field trigram similarity, also trying the names swapped.
 * Returns { matches: rsvp[], exact: boolean }.
 */
export function lookup(rsvps, firstInput, lastInput, cfg = LOOKUP) {
  const qf = normalizeName(firstInput), ql = normalizeName(lastInput);
  if (!qf || !ql) return { matches: [], exact: false };
  const exact = [], fuzzy = [];
  for (const r of rsvps) {
    if ((sameNorm(r.firstNorm, qf) && sameNorm(r.lastNorm, ql)) || (sameNorm(r.firstNorm, ql) && sameNorm(r.lastNorm, qf))) {
      exact.push({ r, score: 1 });
    } else if (passes(qf, ql, r.firstNorm, r.lastNorm, cfg) || passes(ql, qf, r.firstNorm, r.lastNorm, cfg)) {
      fuzzy.push({ r, score: similarity(qf + ' ' + ql, r.firstNorm + ' ' + r.lastNorm) });
    }
  }
  const list = exact.length ? exact : fuzzy;
  list.sort((a, b) =>
    b.score - a.score ||
    a.r.lastNorm.localeCompare(b.r.lastNorm) ||
    a.r.firstNorm.localeCompare(b.r.firstNorm) ||
    String(a.r.company ?? '').localeCompare(String(b.r.company ?? '')));
  return { matches: list.slice(0, cfg.maxResults).map(x => x.r), exact: exact.length > 0 };
}

export function findByEmail(rsvps, email) {
  const e = lowerEmail(email);
  return e ? rsvps.find(r => r.email && lowerEmail(r.email) === e) ?? null : null;
}

/** Same surname, allowing a small typo ("Kimm" ~ "Kim") but not a different person ("Park" vs "Kim"). */
export function sameSurname(a, b, cfg = LOOKUP) {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return false;
  return sameNorm(x, y) || lastNameSimilar(x, y, cfg);
}

/**
 * The RSVP a new-guest form belongs to: same email AND a matching surname. A shared address
 * (info@studio.com) typed by a colleague with a different surname is not linked to someone else's RSVP.
 */
export function matchWalkinToRsvp(rsvps, email, last) {
  const r = findByEmail(rsvps, email);
  return r && sameSurname(r.last, last) ? r : null;
}

// ---------- display ----------

export const labelForDate = d => LABEL_BY_DATE.get(d) ?? d;
export const formatSlot = s => (s ? String(s).replace(' - ', ' – ') : '');

export function formatDays(dates) {
  const labels = (dates ?? []).map(labelForDate);
  if (labels.length <= 1) return labels.join('');
  return labels.slice(0, -1).join(', ') + ' & ' + labels[labels.length - 1];
}

// ---------- time ----------

function parts(date, tz, opts) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** 'YYYY-MM-DD' for the instant in the event time zone. */
export function ymdInTz(date = new Date(), tz = EVENT.tz) {
  const p = parts(date, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'YYYY-MM-DD HH:mm' (or with ':ss') in the event time zone. */
export function localStamp(date = new Date(), tz = EVENT.tz, seconds = false) {
  const p = parts(date, tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` + (seconds ? `:${p.second}` : '');
}

export const isEventDay = ymd => EVENT.days.some(d => d.date === ymd);

// ---------- check-ins ----------

/** The RSVP group size the guest is asked to confirm, or null if there is nothing to confirm against. */
export const rsvpCompareSize = rsvp => (rsvp && isGoing(rsvp.status) && rsvp.partySize ? rsvp.partySize : null);

export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Build a check-in record.
 * input = { path: 'lookup'|'walk_in', rsvp, first, last, company, email, jobTitle,
 *           groupAnswer: 'same'|'changed'|null, bring, walkinGroup, walkinDays, walkinSlot }
 */
export function buildCheckin(input, device, now = new Date()) {
  const { path, rsvp } = input;
  const N = rsvpCompareSize(rsvp);
  let groupToday, groupAnswer = null;
  if (path === 'lookup') {
    if (N != null) {
      groupAnswer = input.groupAnswer;
      groupToday = groupAnswer === 'same' ? N : input.bring + 1;
    } else {
      groupToday = input.bring + 1;
    }
  } else {
    groupToday = input.walkinGroup;
  }
  return {
    id: uuid(),
    device,
    eventDate: ymdInTz(now),
    atUtc: now.toISOString(),
    atLocal: localStamp(now),
    path,
    rsvpKey: rsvp?.key ?? null,
    recordId: rsvp?.recordId ?? null,
    emailMatched: path === 'walk_in' && !!rsvp,
    first: input.first,
    last: input.last,
    company: input.company || null,
    email: path === 'walk_in' ? input.email : (rsvp?.email ?? null),
    jobTitle: input.jobTitle || (path === 'lookup' ? rsvp?.jobTitle ?? null : null),
    rsvpStatus: rsvp?.status ?? null,
    rsvpDays: rsvp?.days ?? [],
    rsvpSlot: rsvp?.slot ?? null,
    partySizeOnRsvp: N,
    walkinDays: path === 'walk_in' ? input.walkinDays : [],
    walkinSlot: path === 'walk_in' ? input.walkinSlot ?? null : null,
    groupAnswer,
    groupToday,
    groupChanged: N == null ? null : groupToday !== N,
    groupUpdatedAtUtc: null,
    groupUpdatedAtLocal: null,
  };
}

/**
 * Same person, same day, on this iPad.
 * Two lookups of the same RSVP are always the same person. Anything involving a typed email
 * (new-guest form) also needs a matching surname, so two colleagues sharing info@studio.com stay two people.
 */
export function findSameDay(checkins, rec) {
  const e = lowerEmail(rec.email);
  return checkins.find(c => {
    if (c.eventDate !== rec.eventDate) return false;
    if (rec.rsvpKey && c.rsvpKey === rec.rsvpKey) {
      return (rec.path === 'lookup' && c.path === 'lookup') || sameSurname(c.last, rec.last);
    }
    return !!e && lowerEmail(c.email) === e && sameSurname(c.last, rec.last);
  }) ?? null;
}

/** A repeat visit with a bigger group raises the number; otherwise nothing changes (returns null). */
export function applyRepeatVisit(existing, groupToday, now = new Date()) {
  if (!(groupToday > existing.groupToday)) return null;
  return {
    ...existing,
    groupToday,
    groupChanged: existing.partySizeOnRsvp == null ? null : groupToday !== existing.partySizeOnRsvp,
    groupUpdatedAtUtc: now.toISOString(),
    groupUpdatedAtLocal: localStamp(now),
  };
}

export function dayStats(checkins, rsvps, ymd) {
  const today = checkins.filter(c => c.eventDate === ymd);
  const expected = rsvps.filter(r => isGoing(r.status) && r.days.includes(ymd));
  const expectedKeys = new Set(expected.map(r => r.key));
  const listedNotToday = today.filter(c => c.rsvpKey && !expectedKeys.has(c.rsvpKey));
  const otherDay = listedNotToday.filter(c => isGoing(c.rsvpStatus) && (c.rsvpDays ?? []).length);
  return {
    date: ymd,
    eventDay: isEventDay(ymd),
    parties: today.length,
    people: today.reduce((n, c) => n + (c.groupToday || 0), 0),
    rsvpArrived: today.filter(c => c.rsvpKey && expectedKeys.has(c.rsvpKey)).length,
    rsvpOtherDay: otherDay.length,
    rsvpNoDayOrDeclined: listedNotToday.length - otherDay.length,
    walkIns: today.filter(c => !c.rsvpKey).length,
    lookupMissed: today.filter(c => c.path === 'walk_in' && c.rsvpKey).length,
    expectedParties: expected.length,
    expectedPeople: expected.reduce((n, r) => n + (r.partySize || 1), 0),
  };
}

// ---------- export ----------

const daysCell = dates => (dates ?? []).map(labelForDate).join(';');

export const EXPORT_COLUMNS = [
  ['checkin_id', c => c.id],
  ['device', c => c.device],
  ['event_date', c => c.eventDate],
  ['checked_in_at_local', c => c.atLocal],
  ['checked_in_at_utc', c => c.atUtc],
  ['path', c => c.path],
  ['record_id', c => c.recordId],
  ['email_matched', c => c.emailMatched],
  ['first_name', c => c.first],
  ['last_name', c => c.last],
  ['company', c => c.company],
  ['email', c => c.email],
  ['job_title', c => c.jobTitle],
  ['rsvp_status', c => c.rsvpStatus],
  ['rsvp_days', c => daysCell(c.rsvpDays)],
  ['rsvp_slot', c => c.rsvpSlot],
  ['party_size_on_rsvp', c => c.partySizeOnRsvp],
  ['walkin_days', c => daysCell(c.walkinDays)],
  ['walkin_slot', c => c.walkinSlot],
  ['group_answer', c => c.groupAnswer],
  ['group_size_today', c => c.groupToday],
  ['group_changed', c => c.groupChanged],
  ['group_updated_at_local', c => c.groupUpdatedAtLocal],
];

/** UTF-8 BOM (Excel reads accents), CRLF, every cell quoted. */
export function checkinsToCsv(checkins) {
  const sorted = [...checkins].sort((a, b) => a.atUtc.localeCompare(b.atUtc));
  const lines = [EXPORT_COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const c of sorted) lines.push(EXPORT_COLUMNS.map(([, f]) => csvCell(f(c))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function exportFileName(device, now = new Date()) {
  const dev = String(device || 'iPad').replace(/[^A-Za-z0-9]+/g, '') || 'iPad';
  const stamp = localStamp(now, EVENT.tz, true).replace(/[-:]/g, '').replace(' ', '_'); // 20261006_130005
  return `checkins_${dev}_${stamp}.csv`;
}

/** Check-ins created or changed since the last export. */
export function unexportedCount(checkins, lastExportAtUtc) {
  if (!lastExportAtUtc) return checkins.length;
  return checkins.filter(c => (c.groupUpdatedAtUtc || c.atUtc) > lastExportAtUtc).length;
}

// ---------- staff password (PBKDF2-SHA256 via WebCrypto) ----------

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

export async function hashPassword(password, saltB64 = null, iterations = 150_000) {
  const salt = saltB64 ? unb64(saltB64) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)), iterations };
}

export async function verifyPassword(password, stored) {
  if (!stored?.hash) return false;
  const { hash } = await hashPassword(password, stored.salt, stored.iterations);
  if (hash.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}
