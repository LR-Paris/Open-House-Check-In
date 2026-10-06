// Open House kiosk — UI controller. Guest view (sign-in flow) and admin view (password-gated).
import * as core from './core.js';
import * as db from './db.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const GUEST_INPUTS = ['#lf', '#ll', '#cf', '#cl', '#cc', '#wf', '#wl', '#we', '#wc', '#wj', '#wr'];
const ADMIN_INPUTS = ['#pwInput', '#setupPw1', '#setupPw2', '#admPw1', '#admPw2', '#admClearCheckins', '#admClearAll', '#dataSearch'];
const OFFLINE_URLS = ['./', './index.html', './js/app.js', './js/core.js', './js/db.js'];
const SUBMIT_LABEL = 'Complete sign-in';
const DEFAULT_SETTINGS = { device: '', pw: null, walkinOnly: false, lastExportAtUtc: null, lastExportAtLocal: null, lastExportCount: 0 };
// A Safari tab has its own (empty) storage. Only the Home Screen app may be set up — except for local testing.
const ALLOW_BROWSER_TAB = ['localhost', '127.0.0.1'].includes(location.hostname) || new URLSearchParams(location.search).has('browser');

const S = {
  settings: { ...DEFAULT_SETTINGS },
  rsvpMeta: null,
  rsvps: [],
  rsvpByKey: new Map(),
  checkins: [],
  screen: null,
  lastActivity: Date.now(),
  // guest flow
  current: null,
  bring: 0,
  wgroup: 1,
  busy: false,
  flow: 0,          // bumped on every reset; a save that finishes after a reset must not touch the screen
  saveFailures: 0,
  lookupName: null,
  // admin
  pwFails: 0,
  pwLockedUntil: 0,
  pendingImport: null,
  dataView: null,   // the RSVP / check-in table on the data screen: { kind, columns, rows, sortCol, sortDir }
  modal: false,     // share sheet / Files picker open: the page gets no touches, so don't idle-reset under it
  modalSince: 0,    // when modal was set; it expires after MODAL_MAX_MS so a missed event can never pin a screen open
  sharing: false,   // an export share sheet is opening: a second tap must not start another
  sharingSince: 0,
  enterTimer: null, // input guard after a screen change (double taps)
  // environment
  storageFailed: false,
  hadController: false,
  updateReady: false,
  persisted: null,
};

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

const blur = () => document.activeElement?.blur?.();

let nudgeTimer = null;
function nudge(msg, ms = 2400) {
  blur(); // the toast sits near the bottom; with the keyboard up it would be hidden
  const n = $('#nudge');
  n.textContent = msg;
  n.classList.add('show');
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => n.classList.remove('show'), ms);
}
function hideNudge() { clearTimeout(nudgeTimer); $('#nudge').classList.remove('show'); }

const MODAL_MAX_MS = 5 * 60_000;
const modalActive = () => S.modal && Date.now() - S.modalSince < MODAL_MAX_MS;
function setModal() { S.modal = true; S.modalSince = Date.now(); }
// iPhone/iPad (iPadOS reports itself as a Mac with touch): exports go through the share sheet; laptops download
const isAppleTouch = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const today = () => core.ymdInTz(new Date());

function show(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  const screen = $('#s-' + id);
  void screen.offsetWidth; // restart the rise animation
  screen.classList.add('active');
  // the second tap of a double tap must not land on the new screen (e.g. on "Complete sign-in")
  $$('.screen').forEach(s => s.classList.remove('entering'));
  screen.classList.add('entering');
  clearTimeout(S.enterTimer);
  S.enterTimer = setTimeout(() => screen.classList.remove('entering'), 450);
  S.screen = id;
  S.lastActivity = Date.now();
  const chip = $('#viewChip');
  chip.hidden = id !== 'admin' && id !== 'data';
  chip.textContent = 'Staff · ' + (S.settings.device || 'iPad');
  $('#stage').classList.toggle('wide', id === 'admin');
  $('#stage').classList.toggle('full', id === 'data');
  $('#staffBtn').hidden = !(id === 'home' || id === 'staffmsg');
  window.scrollTo(0, 0);
}

function setStaffMsg(text) { $('#staffMsg').textContent = text; }

// ---------------------------------------------------------------- reset

function resetGuest() {
  S.flow++;
  GUEST_INPUTS.forEach(s => { $(s).value = ''; });
  $$('#wdays input, #slots input').forEach(i => { i.checked = false; });
  $('#chg').value = '';
  $('#bringField').hidden = true;
  $('#chgField').hidden = false;
  S.current = null; S.bring = 0; S.wgroup = 1; S.lookupName = null; S.saveFailures = 0;
  $('#bring').textContent = '0';
  $('#wg').textContent = '1';
  $('#results').replaceChildren();
  $('#ctx').replaceChildren();
  $('#ctx').hidden = false;
  $('#chgHint').textContent = '';
  $('#bringHint').textContent = 'Not including yourself.';
  $('#thanksMsg').textContent = "You're signed in. Enjoy the showroom.";
  $('#findBtn').disabled = false;
  for (const b of [$('#rsvpSubmit'), $('#walkinSubmit')]) { b.disabled = false; b.textContent = SUBMIT_LABEL; }
  hideNudge();
  blur();
}

function resetAdmin() {
  ADMIN_INPUTS.forEach(s => { $(s).value = ''; });
  closeData();
  S.pendingImport = null;
  $('#admPreview').hidden = true;
  $('#admPreview').replaceChildren();
}

/** Every path back to the guest start screen goes through here. */
function goHome() {
  if (S.updateReady && !S.busy && !modalActive()) { location.reload(); return; }
  resetGuest();
  resetAdmin();
  if (S.storageFailed) {
    setStaffMsg('This iPad can’t store check-ins (storage unavailable). Restart the app.');
    return show('staffmsg');
  }
  if (!S.settings.pw) {
    if (!isStandalone() && !ALLOW_BROWSER_TAB) {
      setStaffMsg('This is a Safari tab, which keeps its own separate data. Tap Share › Add to Home Screen, then open the Check-In icon.');
      return show('staffmsg');
    }
    return show('setup');
  }
  if (!S.rsvps.length && !S.settings.walkinOnly) {
    setStaffMsg("This iPad isn't ready yet.");
    return show('staffmsg');
  }
  show('home');
}

// ---------------------------------------------------------------- idle

function checkIdle() {
  const limit = core.IDLE_MS[S.screen];
  if (!limit || S.busy || modalActive()) return;
  if (Date.now() - S.lastActivity > limit) goHome();
}

// ---------------------------------------------------------------- guest: lookup

function goLookup() {
  if (S.settings.walkinOnly) return goWalkin(false);
  show('lookup');
  $('#lf').focus(); // synchronous inside the tap so iPadOS raises the keyboard
}

function emptyBox(...children) { return el('div', { class: 'empty' }, ...children); }

function doLookup() {
  const first = $('#lf').value.trim(), last = $('#ll').value.trim();
  const box = $('#results');
  box.replaceChildren();
  blur();
  if (!first && !last) { box.append(emptyBox('Please enter your first name, your last name, or both.')); return; }
  const { matches, exact, total, single } = core.lookup(S.rsvps, first, last);
  // carried to the new-guest form; a full name typed in the First name box is split into first and last
  const words = first && !last ? first.split(/\s+/) : null;
  S.lookupName = words && words.length > 1 ? { first: words.slice(0, -1).join(' '), last: words.at(-1) } : { first, last };
  if (!matches.length) {
    box.append(emptyBox(
      "We couldn't find an RSVP under ", el('strong', { text: `${first} ${last}`.trim() }), '.',
      el('br'),
      el('button', { class: 'link', dataset: { action: 'go-walkin-carry' }, text: 'Not listed? Sign in as a new guest →' }),
    ));
    return;
  }
  const n = matches.length;
  if (exact && !single && total > 1) box.append(el('p', { class: 'hint', text: `We found ${total} people with that name. Please pick your company.` }));
  else if (!exact || single) box.append(el('p', { class: 'hint', text: total === 1 ? 'We found a possible match. Please check it’s you.' : `We found ${total} possible matches. Please pick yours.` }));
  if (total > n) box.append(el('p', { class: 'hint', text: `Showing the first ${n}. Type your first and last name to narrow the list.` }));
  for (const r of matches) {
    box.append(el('button', { class: 'result', dataset: { action: 'select', key: r.key } },
      el('span', {},
        el('span', { class: 'name', text: `${r.first} ${r.last}`.trim() }),
        r.company ? el('span', { class: 'co', text: r.company }) : null),
      el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' })));
  }
  box.append(el('button', { class: 'link', dataset: { action: 'go-walkin-carry' }, text: 'Not you? Sign in as a new guest →' }));
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------- guest: confirm

function renderCtx(r, N) {
  const ctx = $('#ctx');
  ctx.replaceChildren();
  // "Your RSVP" only for a going RSVP with a day (a decline or a no-day RSVP has nothing meaningful to show)
  const when = core.isGoing(r.status) && r.days.length
    ? [core.formatDays(r.days), core.formatSlot(r.slot)].filter(Boolean).join(' · ')
    : '';
  if (when) ctx.append(el('div', {}, el('span', { class: 'k', text: 'Your RSVP' }), el('span', { class: 'v serif', text: when })));
  if (N != null) {
    ctx.append(el('div', {}, el('span', { class: 'k', text: 'Group size on RSVP' }),
      el('span', { class: 'v' }, String(N) + ' ', el('span', { class: 'sub', text: '(including you)' }))));
  }
  ctx.hidden = !ctx.childElementCount;
}

function bringMax() {
  const N = core.rsvpCompareSize(S.current);
  return Math.max(core.STEPPER_MAX, N != null ? N - 1 : 0);
}

function updateBring() {
  $('#bring').textContent = String(S.bring);
  const N = core.rsvpCompareSize(S.current);
  const total = S.bring + 1;
  let hint = `Not including yourself — that's ${total} in total.`;
  if (N != null) {
    hint = total !== N
      ? `Not including yourself — that's ${total} in total, updated from ${N}.`
      : `Not including yourself — that's ${total} in total, same as your RSVP.`;
  }
  $('#bringHint').textContent = hint;
}

function selectRsvp(key) {
  const r = S.rsvpByKey.get(key);
  if (!r) return;
  S.current = r;
  $('#cf').value = r.first;
  $('#cl').value = r.last;
  $('#cc').value = r.company ?? '';
  const N = core.rsvpCompareSize(r);
  renderCtx(r, N);
  $('#chg').value = '';
  if (N != null) {
    $('#chgField').hidden = false;
    $('#chgLabel').replaceChildren('Has your group size changed from the ', el('u', { text: String(N) }),
      ' you signed up with? ', el('span', { class: 'req', text: '*' }));
    $('#chgHint').textContent = `You signed up with ${N} ${N === 1 ? 'person' : 'people'}, including yourself.`;
    $('#bringField').hidden = true;
    S.bring = Math.max(0, N - 1);
  } else {
    $('#chgField').hidden = true;
    $('#bringField').hidden = false;
    S.bring = 0;
  }
  updateBring();
  show('confirm');
}

function onChg() {
  const v = $('#chg').value, bf = $('#bringField');
  const N = core.rsvpCompareSize(S.current);
  S.bring = Math.max(0, (N ?? 1) - 1);
  if (v === 'changed') {
    bf.hidden = false;
    bf.classList.remove('reveal'); void bf.offsetWidth; bf.classList.add('reveal');
  } else {
    bf.hidden = true;
  }
  updateBring();
}

async function submitRsvp() {
  if (S.busy || !S.current) return;
  const first = $('#cf').value.trim(), last = $('#cl').value.trim(), company = $('#cc').value.trim();
  const N = core.rsvpCompareSize(S.current);
  const answer = $('#chg').value;
  if (!first || !last || !company) return nudge('Please complete your name and company.');
  if (N != null && !answer) return nudge('Please tell us whether your group size has changed.');
  const rec = core.buildCheckin({
    path: 'lookup', rsvp: S.current, first, last, company,
    groupAnswer: N != null ? answer : null, bring: S.bring,
  }, S.settings.device);
  await save(rec, first, $('#rsvpSubmit'));
}

// ---------------------------------------------------------------- guest: walk-in

function goWalkin(carry) {
  const walkinOnly = S.settings.walkinOnly;
  $('#wDaysField').hidden = walkinOnly;
  $('#wSlotField').hidden = walkinOnly;
  const t = today();
  $$('#wdays input').forEach(i => { i.checked = i.value === t; }); // today preselected (they're here)
  if (carry && S.lookupName) {
    $('#wf').value = S.lookupName.first;
    $('#wl').value = S.lookupName.last;
  }
  show('walkin');
  // after a lookup, start at the first field still empty (one name may have been typed)
  (carry && S.lookupName ? ['#wf', '#wl', '#we'].map(sel => $(sel)).find(i => !i.value) ?? $('#we') : $('#wf')).focus();
}

async function submitWalkin() {
  if (S.busy) return;
  const first = $('#wf').value.trim(), last = $('#wl').value.trim(), email = $('#we').value.trim();
  const company = $('#wc').value.trim(), jobTitle = $('#wj').value.trim(), salesRep = $('#wr').value;
  const walkinOnly = S.settings.walkinOnly;
  const days = $$('#wdays input:checked').map(i => i.value);
  const slot = $('#slots input:checked')?.value ?? null;
  if (!first || !last || !email || !company || !jobTitle) return nudge('Please complete the required fields.');
  if (!core.validEmail(email)) return nudge('Please enter a valid email address.');
  if (!walkinOnly && !days.length) return nudge('Please pick at least one day.');
  if (!walkinOnly && !slot) return nudge('Please pick a time of attendance.');
  const match = core.matchWalkinToRsvp(S.rsvps, email, last); // same email AND surname → their RSVP
  const rec = core.buildCheckin({
    path: 'walk_in', rsvp: match, first, last, company, email, jobTitle, salesRep: salesRep || null,
    walkinGroup: S.wgroup,
    walkinDays: walkinOnly ? [today()] : days,
    walkinSlot: walkinOnly ? null : slot,
  }, S.settings.device);
  await save(rec, first, $('#walkinSubmit'));
}

// ---------------------------------------------------------------- guest: save + thanks

async function save(rec, firstName, btn) {
  S.busy = true;
  const flow = S.flow;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  let outcome = 'created', failed = false;
  try {
    const existing = core.findSameDay(S.checkins, rec);
    if (existing) {
      outcome = 'already';
      const updated = core.applyRepeatVisit(existing, rec.groupToday);
      if (updated) {
        await db.putCheckin(updated);
        S.checkins[S.checkins.indexOf(existing)] = updated;
      }
    } else {
      await db.putCheckin(rec); // committed to disk before the guest sees "Thank you"
      S.checkins.push(rec);
    }
  } catch (err) {
    failed = true; // judged by the catch, never by the error value (WebKit can reject with null)
    console.error('Check-in save failed:', err?.name || err);
  }
  S.busy = false;
  if (flow !== S.flow) return; // the screen was reset meanwhile: never paint onto the next guest
  btn.textContent = SUBMIT_LABEL;
  btn.disabled = false;
  if (!failed) {
    S.saveFailures = 0;
    return showThanks(firstName, outcome, rec.path);
  }
  S.saveFailures++;
  if (S.saveFailures >= 2) {
    // iPadOS before 26.5 can leave IndexedDB broken until the page reloads (WebKit bug 309386).
    // Every committed check-in is already on disk, so restarting the app is safe.
    resetGuest();
    setStaffMsg("This sign-in couldn't be saved. Restarting…");
    show('staffmsg');
    setTimeout(() => location.reload(), 3000);
  } else {
    nudge("This sign-in couldn't be saved. Please try again.", 4000);
  }
}

function showThanks(first, outcome, path) {
  $('#thanksMsg').textContent = outcome === 'already'
    ? `You're already signed in, ${first} — welcome back.`
    : `You're signed in, ${first}. Enjoy the showroom.`;
  $('#thanksStep').hidden = path === 'walk_in'; // new guests never saw steps 1–2
  show('thanks');
}

// ---------------------------------------------------------------- admin: access

function openAdmin() {
  if (S.storageFailed) { location.reload(); return; } // retry storage instead of offering setup
  resetGuest();
  if (!S.settings.pw) return goHome();
  show('pw');
  $('#pwInput').value = '';
  $('#pwInput').focus();
}

async function submitPw() {
  const wait = Math.ceil((S.pwLockedUntil - Date.now()) / 1000);
  if (wait > 0) return nudge(`Too many attempts. Try again in ${wait} s.`);
  const pw = $('#pwInput').value;
  if (!pw) return;
  const btn = $('#pwBtn');
  btn.disabled = true;
  let ok = false;
  try { ok = await core.verifyPassword(pw, S.settings.pw); } finally { btn.disabled = false; }
  $('#pwInput').value = '';
  if (!ok) {
    S.pwFails++;
    if (S.pwFails >= 5) { S.pwFails = 0; S.pwLockedUntil = Date.now() + 30_000; }
    return nudge('Incorrect password.');
  }
  S.pwFails = 0;
  blur();
  resetAdmin();
  renderAdmin();
  show('admin');
}

/** Write first, then adopt: if the write fails, memory keeps matching what's on disk. */
async function saveSettings(patch) {
  const next = { ...S.settings, ...patch };
  await db.kvPut('settings', next);
  S.settings = next;
}

async function setupSave() {
  const device = $('#setupDevice').value.trim();
  const pw1 = $('#setupPw1').value, pw2 = $('#setupPw2').value;
  if (!device) return nudge('Please name this iPad (iPad A or iPad B).');
  if (pw1.length < 6) return nudge('Use at least 6 characters for the password.');
  if (pw1 !== pw2) return nudge("The passwords don't match.");
  let existing;
  try { existing = await db.kvGet('settings'); }
  catch { return nudge("Couldn't read this iPad's storage. Restart the app.", 4000); }
  if (existing?.pw) { location.reload(); return; } // already set up: never overwrite
  try { await saveSettings({ device, pw: await core.hashPassword(pw1) }); }
  catch { return nudge("Couldn't save settings on this iPad.", 4000); }
  $('#setupPw1').value = ''; $('#setupPw2').value = '';
  db.requestPersistence().then(p => { S.persisted = p; });
  blur();
  renderAdmin();
  show('admin');
}

// ---------------------------------------------------------------- admin: render

function stat(n, t) { return el('div', { class: 'stat' }, el('div', { class: 'n', text: String(n) }), el('div', { class: 't', text: t })); }
function yes(v, okText, badText, unknownText = 'unknown') {
  if (v === true) return el('span', { class: 'ok', text: okText });
  if (v === false) return el('span', { class: 'bad', text: badText });
  return el('span', { class: 'warn', text: unknownText });
}

/** Offline-ready = a service worker controls the page AND its cache really holds the app files. */
async function offlineStatus() {
  if (!('caches' in window) || !navigator.serviceWorker?.controller) return { ready: false, build: null };
  const names = (await caches.keys()).filter(k => k.startsWith('oh-kiosk-'));
  for (const cacheName of names) {
    const hits = await Promise.all(OFFLINE_URLS.map(u => caches.match(new URL(u, location.href).href, { cacheName })));
    if (hits.every(Boolean)) return { ready: true, build: cacheName.slice('oh-kiosk-'.length) };
  }
  return { ready: false, build: null };
}

async function renderAdmin() {
  const t = today();
  const off = await offlineStatus().catch(() => ({ ready: null, build: null }));
  if (S.persisted == null) S.persisted = await db.isPersisted();

  $('#admStatus').replaceChildren(
    el('span', {}, 'Name: ', el('strong', { text: S.settings.device || '—' })),
    el('span', { text: `Version ${core.VERSION}${off.build ? ' · build ' + off.build.slice(0, 7) : ''}` }),
    el('span', {}, 'Works offline: ', yes(off.ready, 'yes', 'NOT YET — keep wifi on and tap Reload app')),
    el('span', {}, 'Storage protected: ', yes(S.persisted, 'yes', 'no', 'unknown')),
    el('span', {}, 'Running as: ', isStandalone() ? el('span', { class: 'ok', text: isAppleTouch() ? 'Home Screen app' : 'installed app window' }) : ALLOW_BROWSER_TAB && !isAppleTouch() ? el('span', { text: 'browser tab (?browser)' }) : el('span', { class: 'bad', text: 'Safari tab — use the Home Screen icon' })),
    el('span', {}, 'Mode: ', S.settings.walkinOnly ? el('span', { class: 'warn', text: 'walk-in only' }) : el('span', { text: 'normal' })),
  );

  const info = $('#admRsvpInfo');
  if (S.rsvpMeta) {
    const rep = core.rsvpReport(S.rsvps);
    info.className = '';
    info.replaceChildren(
      el('strong', { text: `${S.rsvps.length} RSVPs` }), ` from “${S.rsvpMeta.fileName}”, imported ${S.rsvpMeta.importedAtLocal}.`,
      el('br'), el('span', { class: 'muted', text: Object.entries(rep.byStatus).map(([k, v]) => `${k}: ${v}`).join(' · ') }),
      el('br'), el('span', { class: 'muted', text: rep.byDay.map(d => `${d.label}: ${d.going}`).join(' · ') + ` · going, no day: ${rep.goingNoDay}` }),
    );
  } else {
    info.className = 'warn';
    info.textContent = 'No RSVP list imported yet. Guests can’t use this iPad until you import one (or switch on walk-in-only mode).';
  }

  const st = core.dayStats(S.checkins, S.rsvps, t);
  $('#admTodayLabel').textContent = `Today ${core.labelForDate(t)}${st.eventDay ? '' : ' (not an event day)'} — this iPad only. For the total, add the other iPad's parties and people (not the expected figure).`;
  $('#admStats').replaceChildren(
    stat(st.parties, 'Parties signed in'),
    stat(st.people, 'People'),
    stat(st.rsvpArrived, `RSVPs arrived (of ${st.expectedParties} expected)`),
    stat(st.walkIns, 'Walk-ins (not on list)'),
    stat(st.rsvpOtherDay, 'RSVP’d for another day'),
    stat(st.rsvpNoDayOrDeclined, 'On list, no day / declined'),
  );
  $('#admDays').replaceChildren(el('table', { class: 'list' },
    el('thead', {}, el('tr', {}, ['Day', 'Parties', 'People', 'Walk-ins'].map(h => el('th', { text: h })))),
    el('tbody', {}, core.EVENT.days.map(d => {
      const s = core.dayStats(S.checkins, S.rsvps, d.date);
      return el('tr', {}, [d.label, s.parties, s.people, s.walkIns].map(v => el('td', { text: String(v) })));
    }))));

  const un = core.unexportedCount(S.checkins, S.settings.lastExportAtUtc);
  $('#admExportInfo').replaceChildren(
    un ? el('span', { class: 'warn', text: `${un} check-in(s) not shared yet. ` }) : !S.settings.lastExportAtUtc ? el('span', { class: 'muted', text: 'Nothing to share yet. ' }) : el('span', { class: 'ok', text: 'Nothing new since the last share. ' }),
    el('span', { class: 'muted', text: S.settings.lastExportAtLocal ? `Last shared ${S.settings.lastExportAtLocal} (${S.settings.lastExportCount} rows) — check it reached the laptop / OneDrive. ` : 'Not shared yet. ' }),
    el('span', { class: 'muted', text: `${S.checkins.length} check-in(s) stored on this iPad in total.` }),
  );

  const recent = S.checkins.filter(c => c.eventDate === t).sort((a, b) => b.atUtc.localeCompare(a.atUtc)).slice(0, 20);
  $('#admRecent').replaceChildren(recent.length
    ? el('table', { class: 'list' },
        el('thead', {}, el('tr', {}, ['Time', 'Name', 'Company', 'Group', 'How'].map(h => el('th', { text: h })))),
        el('tbody', {}, recent.map(c => el('tr', {},
          el('td', { text: c.atLocal.slice(11) }),
          el('td', { text: `${c.first} ${c.last}` }),
          el('td', { text: c.company ?? '' }),
          el('td', { text: String(c.groupToday) }),
          el('td', { text: core.checkinHow(c) })))))
    : el('p', { class: 'muted', text: 'No check-ins today on this iPad yet.' }));

  $('#admDevice').value = S.settings.device;
  $('#admWalkinOnly').checked = !!S.settings.walkinOnly;
}

// ---------------------------------------------------------------- admin: data tables

function openData(kind) {
  if (S.screen !== 'admin') return;
  const t = kind === 'rsvps' ? core.rsvpTable(S.rsvps, S.checkins) : core.checkinTable(S.checkins);
  S.dataView = { kind, ...t, sortCol: null, sortDir: 'asc' };
  $('#dataSearch').value = '';
  $('#dataTitle').textContent = kind === 'rsvps' ? 'RSVP list' : 'Check-ins on this iPad';
  $('#dataNote').textContent = kind === 'rsvps'
    ? (S.rsvpMeta
      ? `As imported from “${S.rsvpMeta.fileName}” on ${S.rsvpMeta.importedAtLocal}. “Signed in” shows the days each person checked in on this iPad.`
      : 'No RSVP list imported yet.')
    : 'Every check-in stored on this iPad, newest first, including test days. The other iPad’s check-ins are not here.';
  renderData();
  show('data');
  fitDataTable();
}

function renderData() {
  const v = S.dataView;
  if (!v) return;
  let rows = core.filterRows(v.rows, $('#dataSearch').value);
  if (v.sortCol != null) rows = core.sortRows(rows, v.sortCol, v.sortDir);
  const noun = n => `${n} ${v.kind === 'rsvps' ? 'RSVP' : 'check-in'}${n === 1 ? '' : 's'}`;
  $('#dataCount').textContent = rows.length === v.rows.length ? noun(v.rows.length) : `${rows.length} of ${noun(v.rows.length)}`;
  const head = el('tr', {}, ...v.columns.map((c, i) => el('th', {},
    el('button', {
      type: 'button', class: v.sortCol === i ? 'sort on' : 'sort', dataset: { action: 'data-sort', col: String(i) },
      text: c + (v.sortCol === i ? (v.sortDir === 'asc' ? ' ▲' : ' ▼') : ''),
    }))));
  const body = rows.length
    ? rows.map(r => el('tr', {}, ...r.map(c => el('td', { text: c }))))
    : [el('tr', {}, el('td', { colspan: String(v.columns.length), class: 'muted', text: v.rows.length ? 'No rows match the search.' : 'Nothing here yet.' }))];
  $('#dataTable').replaceChildren(el('table', { class: 'list data' }, el('thead', {}, head), el('tbody', {}, ...body)));
  $('#dataTable').scrollTop = 0; // a new sort or search starts at its first row (sideways position kept)
}

/** Let the table's own scroll area end just above the bottom of the screen, so its last rows can be reached. */
function fitDataTable() {
  if (S.screen !== 'data') return;
  const wrap = $('#dataTable');
  const top = wrap.getBoundingClientRect().top + window.scrollY;
  wrap.style.maxHeight = `${Math.max(240, document.documentElement.clientHeight - top - 32)}px`;
}

function sortData(btn) {
  const v = S.dataView;
  if (!v) return;
  const col = Number(btn.dataset.col);
  if (v.sortCol === col) v.sortDir = v.sortDir === 'asc' ? 'desc' : 'asc';
  else { v.sortCol = col; v.sortDir = 'asc'; }
  renderData();
}

/** Guest data never lingers in the page once staff leave the table. */
function closeData() {
  S.dataView = null;
  $('#dataTable').replaceChildren();
}

// ---------------------------------------------------------------- admin: import

async function onImportFile(e) {
  S.modal = false;
  S.lastActivity = Date.now();
  const input = e.target;
  const file = input.files?.[0];
  if (!file) return;
  let buf;
  try { buf = await file.arrayBuffer(); }
  catch { input.value = ''; return nudge("Couldn't read that file.", 4000); }
  input.value = '';
  const bytes = new Uint8Array(buf);
  let res;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    res = { ok: false, errors: ['This is a ZIP or Excel (.xlsx) file. Unzip it in Files, or export from HubSpot as CSV.'], warnings: [] };
  } else {
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {}
    res = text == null
      ? { ok: false, errors: ['This file is not UTF-8 (it was probably re-saved by Excel). Import the original HubSpot download.'], warnings: [] }
      : core.parseRsvpCsv(text);
  }
  S.pendingImport = res.ok ? { rows: res.rows, fileName: file.name } : null;
  if (S.screen === 'admin') renderPreview(res, file.name);
}

function renderPreview(res, fileName) {
  const box = $('#admPreview');
  box.hidden = false;
  const parts = [el('hr', { class: 'rule' }), el('p', {}, el('strong', { text: `Preview of “${fileName}”` }))];
  if (!res.ok) {
    parts.push(el('ul', { class: 'msgs' }, res.errors.map(m => el('li', { class: 'bad', text: m }))),
      el('p', { class: 'muted', text: 'Nothing was imported.' }),
      el('div', { class: 'actions' }, el('button', { class: 'btn small ghost', dataset: { action: 'import-cancel' }, text: 'Close' })));
    box.replaceChildren(...parts);
    return;
  }
  const r = res.report;
  const nonAscii = s => /[^\x00-\x7F]/.test(s.first + s.last);
  const sample = [...res.rows].sort((a, b) => nonAscii(b) - nonAscii(a)).slice(0, 3);
  parts.push(
    el('div', { class: 'stats' },
      stat(r.total, 'RSVPs in file'),
      ...r.byDay.map(d => stat(`${d.all}`, `${d.label} (going ${d.going})`)),
      stat(r.goingNoDay, 'Going, no day')),
    el('p', { class: 'muted', text: 'By status: ' + Object.entries(r.byStatus).map(([k, v]) => `${k}: ${v}`).join(' · ') }),
    el('p', { class: 'muted', text: `Group size: 1 → ${r.partySize.one} · 2 → ${r.partySize.two} · 3–5 → ${r.partySize.threeToFive} · 6+ → ${r.partySize.sixPlus} · unknown → ${r.partySize.unknown}. No time slot: ${r.noSlot}. No company: ${r.noCompany}.` }),
    el('p', { class: 'muted', text: 'Sample: ' + sample.map(s => `${s.first} ${s.last}${s.company ? ' (' + s.company + ')' : ''}`).join(' · ') }),
  );
  if (res.warnings.length) parts.push(el('ul', { class: 'msgs' }, res.warnings.map(m => el('li', { class: 'warn', text: m }))));
  parts.push(
    el('p', { class: 'muted', text: S.rsvps.length ? `This replaces the current list (${S.rsvps.length} RSVPs). Check-ins already recorded are kept.` : 'Check-ins already recorded are kept.' }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn small', dataset: { action: 'import-confirm' }, text: `Import ${r.total} RSVPs` }),
      el('button', { class: 'btn small ghost', dataset: { action: 'import-cancel' }, text: 'Cancel' })));
  box.replaceChildren(...parts);
}

async function confirmImport() {
  const p = S.pendingImport;
  if (!p) return;
  const now = new Date();
  const meta = { fileName: p.fileName, importedAtUtc: now.toISOString(), importedAtLocal: core.localStamp(now), count: p.rows.length };
  try { await db.kvPut('rsvps', { meta, rows: p.rows }); }
  catch { return nudge("Couldn't save the RSVP list on this iPad.", 4000); }
  S.rsvps = p.rows;
  S.rsvpMeta = meta;
  rebuildRsvpIndex();
  S.pendingImport = null;
  $('#admPreview').hidden = true;
  $('#admPreview').replaceChildren();
  await renderAdmin();
  nudge(`Imported ${p.rows.length} RSVPs.`);
}

function rebuildRsvpIndex() {
  S.rsvpByKey = new Map(S.rsvps.map(r => [r.key, r]));
}

// ---------------------------------------------------------------- admin: export

/** Must stay synchronous up to navigator.share(): iPadOS only allows sharing straight from the tap. */
function exportCheckins() {
  if (S.sharing && Date.now() - S.sharingSince < 3000) return; // the same double tap, before the sheet appears
  if (isAppleTouch()) return shareCheckins();
  return downloadCheckins();
}

/** iPad/iPhone: the share sheet (Save to Files, AirDrop). Runs synchronously inside the tap, as WebKit requires. */
function shareCheckins() {
  if (!S.checkins.length) return nudge('There are no check-ins to export yet.');
  const now = new Date();
  const csv = core.checkinsToCsv(S.checkins);
  const name = core.exportFileName(S.settings.device, now);
  const file = new File([csv], name, { type: 'text/csv' });
  const count = S.checkins.length;
  if (!navigator.canShare?.({ files: [file] })) {
    return nudge('Sharing files isn’t available on this iPad (needs iPadOS 15 or later).', 5000);
  }
  setModal();
  S.sharing = true;
  S.sharingSince = Date.now();
  navigator.share({ files: [file] })
    .then(() => recordExport(now, count))
    .catch(err => {
      if (err?.name === 'AbortError') return;
      nudge(err?.name === 'InvalidStateError'
        ? 'An earlier share is still open. Tap Reload app below, then Export again. The check-ins are safe on this iPad.'
        : `Export failed (${err?.name || 'error'}). Try again, or try AirDrop.`, 6000);
    })
    .finally(() => { S.sharing = false; S.modal = false; S.lastActivity = Date.now(); });
}

/** Laptops: save the CSV to the Downloads folder. Re-reads storage first, so check-ins from another window are included. */
async function downloadCheckins() {
  try { S.checkins = await db.getAllCheckins(); } catch {}
  if (!S.checkins.length) return nudge('There are no check-ins to export yet.');
  const now = new Date();
  const csv = core.checkinsToCsv(S.checkins);
  const name = core.exportFileName(S.settings.device, now);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  // a download can fail or be blocked without the page knowing: only a confirmed file counts as exported
  // (an export is what allows Clear everything)
  await new Promise(r => setTimeout(r, 1500));
  if (window.confirm(`Is ${name} in your Downloads folder?\n\nOK = yes, it's there. Cancel = no, it isn't.`)) {
    await recordExport(now, S.checkins.length, `Exported: ${name}.`);
  } else {
    nudge('Not counted as exported. Check the browser\'s download settings, then tap Export check-ins again.', 6000);
  }
}

async function recordExport(now, count, message = 'Shared. Check that the file arrived on the laptop / in OneDrive.') {
  try {
    await saveSettings({ lastExportAtUtc: now.toISOString(), lastExportAtLocal: core.localStamp(now), lastExportCount: count });
  } catch {}
  if (S.screen === 'admin') renderAdmin();
  nudge(message, 5000);
}

// ---------------------------------------------------------------- admin: settings + maintenance

async function saveDevice() {
  const v = $('#admDevice').value.trim();
  if (!v) return nudge('Please enter a name for this iPad.');
  try { await saveSettings({ device: v }); }
  catch { return nudge("Couldn't save the name. Reload the app and try again.", 5000); }
  $('#viewChip').textContent = 'Staff · ' + v;
  renderAdmin();
  nudge('Saved.');
}

async function toggleWalkinOnly() {
  const cb = $('#admWalkinOnly');
  try { await saveSettings({ walkinOnly: cb.checked }); }
  catch {
    cb.checked = !!S.settings.walkinOnly;
    return nudge("Couldn't save the setting. Reload the app and try again.", 5000);
  }
  renderAdmin();
  nudge(S.settings.walkinOnly ? 'Walk-in-only mode is on.' : 'Walk-in-only mode is off.');
}

async function changePw() {
  const p1 = $('#admPw1').value, p2 = $('#admPw2').value;
  if (p1.length < 6) return nudge('Use at least 6 characters for the password.');
  if (p1 !== p2) return nudge("The passwords don't match.");
  try { await saveSettings({ pw: await core.hashPassword(p1) }); }
  catch { return nudge("Couldn't save the new password. The old one still works.", 5000); }
  $('#admPw1').value = ''; $('#admPw2').value = '';
  nudge('Password changed.');
}

/** Deletes only test check-ins (dated outside Oct 6–8). Real event-day check-ins are never touched. */
async function clearTestCheckins() {
  if ($('#admClearCheckins').value.trim().toUpperCase() !== 'CLEAR') return nudge('Type CLEAR to confirm.');
  const ids = S.checkins.filter(c => !core.isEventDay(c.eventDate)).map(c => c.id);
  const kept = S.checkins.length - ids.length;
  if (!ids.length) return nudge(`No test check-ins to clear.${kept ? ` ${kept} event-day check-in(s) are kept.` : ''}`, 4000);
  try { await db.deleteCheckins(ids); }
  catch { return nudge("Couldn't delete. Reload the app and try again.", 5000); }
  const gone = new Set(ids);
  S.checkins = S.checkins.filter(c => !gone.has(c.id));
  $('#admClearCheckins').value = '';
  renderAdmin();
  nudge(`${ids.length} test check-in(s) deleted.${kept ? ` ${kept} event-day check-in(s) kept.` : ''} The RSVP list is kept.`, 5000);
}

async function clearAll() {
  if ($('#admClearAll').value.trim().toUpperCase() !== 'DELETE') return nudge('Type DELETE to confirm.');
  try { S.checkins = await db.getAllCheckins(); } catch {} // another window may have saved check-ins since boot
  const un = core.unexportedCount(S.checkins, S.settings.lastExportAtUtc);
  if (un > 0) return nudge(`${un} check-in(s) haven't been exported. Export first, check the file on the laptop, then clear.`, 6000);
  try { await db.clearEverything(); }
  catch { return nudge("Couldn't delete. Reload the app and try again.", 5000); }
  S.settings = { ...DEFAULT_SETTINGS };
  S.rsvps = []; S.rsvpMeta = null; S.checkins = [];
  rebuildRsvpIndex();
  $('#admClearAll').value = '';
  goHome(); // → first-time setup
  nudge('Everything in this app was deleted. Now delete the RSVP and check-in CSV files from Files, then the Home Screen icon.', 8000);
}

async function reloadApp() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    const w = reg?.installing;
    if (w) {
      nudge('Downloading the new version…', 20_000);
      const state = await new Promise(res => {
        const to = setTimeout(() => res(w.state), 20_000);
        w.addEventListener('statechange', () => {
          if (w.state === 'activated' || w.state === 'redundant') { clearTimeout(to); res(w.state); }
        });
      });
      if (state === 'redundant') return nudge(`The update failed to download. Still on version ${core.VERSION}. Check the wifi and try again.`, 6000);
    }
  } catch {}
  location.reload();
}

// ---------------------------------------------------------------- wiring

const ACTIONS = {
  'logo': () => (S.screen === 'setup' ? null : goHome()),
  'home': goHome,
  'go-lookup': goLookup,
  'go-walkin': () => goWalkin(false),
  'go-walkin-carry': () => goWalkin(true),
  'lookup': doLookup,
  'select': btn => {
    $$('#results .result').forEach(b => { b.disabled = true; });
    selectRsvp(btn.dataset.key);
  },
  'back-lookup': () => { S.current = null; $$('#results .result').forEach(b => { b.disabled = false; }); show('lookup'); },
  'bring-minus': () => { S.bring = Math.max(0, S.bring - 1); updateBring(); },
  'bring-plus': () => { S.bring = Math.min(bringMax(), S.bring + 1); updateBring(); },
  'wg-minus': () => { S.wgroup = Math.max(1, S.wgroup - 1); $('#wg').textContent = String(S.wgroup); },
  'wg-plus': () => { S.wgroup = Math.min(core.STEPPER_MAX, S.wgroup + 1); $('#wg').textContent = String(S.wgroup); },
  'submit-rsvp': submitRsvp,
  'submit-walkin': submitWalkin,
  'open-admin': openAdmin,
  'pw-submit': submitPw,
  'setup-save': setupSave,
  'exit-admin': goHome,
  'view-rsvps': () => openData('rsvps'),
  'view-checkins': () => openData('checkins'),
  'data-sort': sortData,
  'data-back': () => { closeData(); $('#dataSearch').value = ''; renderAdmin(); show('admin'); },
  'import-confirm': confirmImport,
  'import-cancel': () => { S.pendingImport = null; $('#admPreview').hidden = true; $('#admPreview').replaceChildren(); },
  'export': exportCheckins,
  'save-device': saveDevice,
  'change-pw': changePw,
  'clear-checkins': clearTestCheckins,
  'clear-all': clearAll,
  'reload': reloadApp,
};

function wire() {
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const fn = ACTIONS[btn.dataset.action];
    if (!fn) return;
    e.preventDefault();
    // fn runs synchronously here, so exportCheckins reaches navigator.share() inside the tap
    Promise.resolve(fn(btn)).catch(err => {
      console.error(err);
      nudge('Something went wrong. Please try again.', 4000);
    });
  });
  $('#chg').addEventListener('change', onChg);
  $('#importFile').addEventListener('change', onImportFile);
  $('label[for="importFile"]').addEventListener('click', setModal); // Files picker opening
  $('#importFile').addEventListener('cancel', () => { S.modal = false; S.lastActivity = Date.now(); }); // picker dismissed
  $('#admWalkinOnly').addEventListener('change', () => toggleWalkinOnly().catch(() => {}));
  const onEnter = (sel, fn) => $(sel).addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fn(); }
  });
  onEnter('#lf', () => $('#ll').focus());
  onEnter('#ll', doLookup);
  onEnter('#pwInput', submitPw);
  onEnter('#dataSearch', blur);
  $('#dataSearch').addEventListener('input', renderData);
  window.addEventListener('resize', fitDataTable);

  for (const ev of ['pointerdown', 'keydown', 'input', 'change', 'wheel']) {
    document.addEventListener(ev, () => {
      S.lastActivity = Date.now();
      if (ev === 'pointerdown') S.modal = false; // a touch on the page means no native sheet is open
    }, { capture: true, passive: true });
  }
  setInterval(checkIdle, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkIdle();
    db.ping(); // replace a connection WebKit dropped while the app was in the background
  });
  // Kiosk: no pinch-zoom or double-tap zoom left behind for the next guest.
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
}

function buildStaticUi() {
  $('#wdays').replaceChildren(...core.EVENT.days.map(d =>
    el('label', { class: 'pill' }, el('input', { type: 'checkbox', name: 'wd', value: d.date }), el('span', { text: d.label }))));
  $('#slots').replaceChildren(...core.EVENT.slots.map(s =>
    el('label', { class: 'pill' }, el('input', { type: 'radio', name: 'ws', value: s }), el('span', { text: core.formatSlot(s) }))));
  $('#wr').append(...core.EVENT.reps.map(r => el('option', { value: r, text: r })));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  S.hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (S.hadController) S.updateReady = true; // a newer build took over; reload at the next quiet moment
    S.hadController = true;
  });
  navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service worker not registered:', err?.message));
}

async function boot() {
  buildStaticUi();
  wire();
  registerServiceWorker();
  try {
    const [settings, rsvpData, checkins] = await Promise.all([db.kvGet('settings'), db.kvGet('rsvps'), db.getAllCheckins()]);
    if (settings) S.settings = { ...S.settings, ...settings };
    if (rsvpData?.rows) {
      // refresh the name matching keys with the current rules (not the record keys: saved check-ins point at those)
      S.rsvps = rsvpData.rows.map(r => ({ ...r, firstNorm: core.normalizeName(r.first), lastNorm: core.normalizeName(r.last) }));
      S.rsvpMeta = rsvpData.meta;
    }
    S.checkins = checkins ?? [];
    rebuildRsvpIndex();
  } catch (err) {
    console.error('Storage unavailable:', err?.name || err);
    S.storageFailed = true;
    goHome();
    setTimeout(() => location.reload(), 30_000); // retry on its own; never fall through to setup
    return;
  }
  db.requestPersistence().then(p => { S.persisted = p; });
  goHome();
}

boot();
