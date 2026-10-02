# LR Paris Open House — iPad check-in kiosk

An offline iPad app for guest sign-in at the Open House (1412 Broadway, Oct 6–8 2026).

- **Guest view:** the five approved screens. Guests can find their RSVP by name, or sign in as a new guest.
- **Admin view:** behind a password. Import the HubSpot RSVP list, export check-ins, change settings, clear data.
- **Storage:** everything stays **on each iPad** (IndexedDB). The two iPads never talk to each other, and the app makes no network calls once installed.
- **Merging:** `tools/merge_checkins.py` combines both iPads' exports on a laptop.

The repo (public, `LR-Paris/Open-House-Check-In`) and its GitHub Pages site (`https://lr-paris.github.io/Open-House-Check-In/`) contain **code only — never guest data**. The `.gitignore` blocks `*.csv` except the synthetic test fixture, which holds made-up names. Both are public; that's fine, because they hold no data and the admin view needs the password set on each iPad. **Never commit an RSVP or check-in CSV.**

```
index.html             screens + styles (ported from the approved mockup)
js/core.js             pure logic: CSV import/export, fuzzy name lookup, check-in rules (unit-tested)
js/app.js              UI controller: guest flow, admin view, idle reset
js/db.js               IndexedDB storage
sw.js                  service worker: caches the app so it runs offline
manifest.webmanifest   Home Screen app settings
icons/                 app icons
tools/merge_checkins.py   laptop-only: merge iPad exports → attendance_master.csv + hubspot_import.csv
test/                  Node unit tests + synthetic fixture
```

---

## 1. Publish (once)

The code lives in a **public** repo in the LR-Paris organisation, published with **GitHub Pages**. LR-Paris is on GitHub's free plan, where Pages only works for public repos. Every push to `main` republishes the site within about a minute.

**1. Push the code**

```bash
cd ~/code/openhouse-kiosk && npm test && git status --short
```
```bash
cd ~/code/openhouse-kiosk && gh repo create LR-Paris/Open-House-Check-In --public --source . --push --disable-wiki
```

**2. Turn on GitHub Pages** (serve the `main` branch root)

```bash
gh api repos/LR-Paris/Open-House-Check-In/pages -X POST -f 'source[branch]=main' -f 'source[path]=/'
```

Wait about a minute, then check. Repeat until it says `built`:

```bash
gh api repos/LR-Paris/Open-House-Check-In/pages/builds/latest --jq .status
```

The site is at **https://lr-paris.github.io/Open-House-Check-In/**. On a Mac you'll see "This is a Safari tab…", which is expected. Add `?browser` to the URL to look around; whatever you enter there stays in that browser only.

After any code change, run `npm run stamp` before committing (see §9), so the installed iPads pick up the update.

---

## 2. Set up each iPad (Saturday, on wifi)

Check the version first in **Settings › General › About**. iPadOS 16 or later is needed, and 17.6 or later is recommended.

**Settings**
1. **Accessibility › Guided Access:** on. Set a passcode. Set Display Auto-Lock to *Never*.
2. **General › Keyboard:** Auto-Correction off, Predictive off, Check Spelling off.
3. **Apps › Safari › AutoFill:** Contact Info off. Also **Passwords › AutoFill** off.
4. **General › Software Update › Automatic Updates:** off until Oct 9.
5. **Focus › Do Not Disturb:** on during the event. Keep the iPad plugged in.

**Install**
1. In **Safari**, open `https://lr-paris.github.io/Open-House-Check-In/`. You'll see *"Please ask a member of staff — This is a Safari tab…"*. That's expected: the app refuses to be set up in a Safari tab.
2. Tap Share › **Add to Home Screen**. Leave **Open as Web App** on, then tap Add.
3. **From now on, only ever open the app from the Home Screen icon.** A Safari tab has separate, empty storage.
4. Open the icon. The **Set up this iPad** screen appears. Enter the name (*iPad A* on one, *iPad B* on the other; it goes into every export) and the staff password: the same on both iPads, stored in the password manager. **There is no password recovery.**
5. The admin view opens. In the **This iPad** card, check:
   - Works offline: **yes** (if it says "not yet", wait a few seconds and tap *Reload app*)
   - Running as: **Home Screen app**
   - Storage protected: ideally **yes** (it can say *unknown* on older iPadOS; that's fine)

**Import the RSVP list** (see §3 for the export)
1. AirDrop the CSV to the iPad and save it to **Files › On My iPad**.
2. In the admin view, tap **Import RSVP list (CSV)** and pick the file.
3. Check the preview. On 1 Oct the figures were 87 RSVPs; 86 going, 1 declined; Oct 6 / 7 / 8 = 28 / 28 / 27; 4 going with no day. Then tap **Import**.

**Lock it**
1. Tap **Back to guest view**.
2. Triple-click the top button and choose Guided Access. Leave Software Keyboard and Touch on, and set no time limit. Tap **Start**.

---

## 3. HubSpot export (each morning)

Set this up once:
1. Contacts › filter **Open House RSVP is known**.
2. Show exactly these columns, then save the view:
   `Record ID · First Name · Last Name · Email · Company Name · Job Title · Open House RSVP · Day(s) of Attendance · Time of Attendance · People in group · Your Sales Rep`

Each morning: **Export** › **CSV**, English headers, "Properties in your view". HubSpot emails a download link. Download the file on the laptop, then AirDrop it to both iPads.

The importer matches columns by name, accepting HubSpot labels or internal names. If a required column is missing, it refuses the file and names the missing column. Re-importing **replaces** the RSVP list and keeps every check-in.

---

## 4. Daily routine (Oct 6–8)

| When | What |
|---|---|
| 08:30 | Import the fresh HubSpot CSV on **both** iPads (Staff › password › Import). Back to guest view, Guided Access on. |
| ~13:00 | Staff › **Export check-ins** › *Save to Files* › the OneDrive check-ins folder (or AirDrop to the laptop). Do this on both iPads. |
| Close | Export again from both iPads. The admin view shows how many check-ins haven't been exported yet. |
| Evening | On the laptop, run the merge (§5). Print tomorrow's door list from the HubSpot export in Excel (last name, first name, company, day). |

Keep a **paper sign-in sheet** at the door as a backup, and type any paper entries in through the new-guest form later.

**Never** delete the Home Screen icon (iPadOS calls it "Delete Bookmark"), open the URL in a Safari tab, or clear Safari website data. **Never** use *Clear everything* before exporting. Any of these loses the check-ins.

---

## 5. Merge the exports (laptop)

```bash
python3 ~/code/openhouse-kiosk/tools/merge_checkins.py ~/Library/CloudStorage/OneDrive-LRParis/Documents/HubSpot/"Oct 2026 Open House"/checkins -o ~/Desktop/openhouse-merge
```

You can pass every export from both iPads; they're cumulative, so duplicates are handled. AirDropped files land in `~/Downloads`; move them into the checkins folder first, or add `~/Downloads` to the command. Check-ins dated outside Oct 6–8 (tests, dry run) are ignored. The script prints each iPad's latest check-in time (check both are recent) and warns if only one iPad's files were found. It refuses files that Excel has re-saved. The script writes:
- `attendance_master.csv`: one row per person per day. Someone who signed in on both iPads is merged into one row, keeping the earliest time and the largest group.
- `hubspot_import.csv`: one row per person with `Open House Days Attended` (for example `;Oct 6;Oct 7`) and `Open House Largest Group`. For existing contacts (with a Record ID) the name and company columns are left blank, so an import never overwrites CRM data with what was typed at the door. This is for the future attendance write-back; nothing is written to HubSpot by this project.

The script prints counts only, never names. It uses Python's standard library, so there's nothing to install.

---

## 6. Test checklist (both iPads, in the Home Screen app, before Monday)

1. Import the real CSV. The counts match HubSpot, and accented names look right in the preview.
2. Look up real names: an exact match, a typo, two people with the same name, no match (which offers the new-guest form). Use the new-guest form with an RSVP'd email: it should say *already signed in* if that guest is already in, or otherwise link to their RSVP.
3. The same person twice gives *welcome back*. A bigger group the second time raises the number.
4. Leave a screen half-filled and wait. It returns to Welcome, empty: after 60 s on lookup or confirm, 120 s on new guest, 20 s on thank you.
5. **Airplane mode**, then force-quit the app and reopen it from the icon. It works, and the check-ins are still in the admin view. **Restart the iPad**: still there.
6. Export › Save to Files › OneDrive folder. Open the file in Excel on the laptop and check the accents. AirDrop also works.
7. Guided Access on. The Staff button and password work inside Guided Access, and so do the share sheet and the Files picker.
8. Staff › **Clear test check-ins** (type CLEAR). It deletes only check-ins dated outside Oct 6–8. The RSVP list stays.

---

## 7. Dry run (Mon) and after the event

- **After the dry run:** **Clear test check-ins** on both iPads (it only removes check-ins dated outside Oct 6–8, so real event data can never be hit), re-import the fresh CSV, and reset the keyboard dictionary (*Settings › General › Transfer or Reset › Reset › Reset Keyboard Dictionary*). The merge script also ignores any test-day rows that end up in an export.
- **Fallback:** if lookup misbehaves, turn on Staff › Settings › **Walk-in-only mode**. Both home buttons then open the new-guest form; the day and time questions are hidden, and the day is recorded automatically.
- **Fri Oct 9:** do a final export from both iPads and run the merge. Then **Clear everything** (type DELETE). It refuses while any check-in is unshared. Delete the RSVP and check-in CSV files from Files, delete the Home Screen icon, and reset the keyboard dictionary.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Please ask a member of staff — This iPad isn't ready yet." | No RSVP list imported. Staff › Import. |
| "This sign-in couldn't be saved." | Storage error. Staff › check the status; export immediately; restart the app. Use the paper sheet meanwhile. |
| Export shows no *Save to Files* | Update iPadOS (a 17.5.1 bug), or use AirDrop. |
| "This is a Safari tab…" / admin shows "Running as: Safari tab" | You opened it in Safari. Close the tab and use the Home Screen icon. The data is in the icon's app. |
| "Works offline: NOT YET" | Keep wifi on, tap Reload app, and wait for "yes" before going offline. |
| Forgot the password | There is no recovery. Use the password manager. |
| New version published | Staff › **Reload app** (with wifi). The status line shows the build code; check that both iPads match. If the download fails, it says so. Avoid updating during the event. |

---

## 9. Development

```bash
npm test
```
```bash
npm run serve
```

`npm test` runs Node's built-in test runner for `js/core.js` and Python's `unittest` for the merge script. `npm run serve` serves the app at http://localhost:8765. Service workers and WebCrypto work on localhost, and setup is allowed in a normal browser tab there (or anywhere with `?browser` in the URL).

**Releasing a change:** run `npm run stamp`. It recomputes `BUILD` in `sw.js` from the app files; `npm test` fails until you do, so a fix can't be pushed in a form the iPads would never pick up. Bump `VERSION` in `js/core.js` too if you want a new human-readable label. If you add a file, list it in `ASSETS` in `sw.js` (a test checks that every file the page references is cached). Then commit `sw.js` with your change and push.

**Event constants** (days, time slots, lookup thresholds, idle timers) are at the top of `js/core.js`.

**Brand fonts:** they're not shipped, because the web licence for Trade Gothic Next and IvyOra Display isn't confirmed and the website is publicly reachable. The page falls back to fonts built into iPadOS. If the licence is confirmed:
1. Add the `.woff2` files under `fonts/`.
2. Add `@font-face` rules in `index.html` for the families `Trade Gothic Next` (weights 300/400/700), `Trade Gothic Next HvCn` (800) and `IvyOra Display` (300 italic).
3. Add the files to `ASSETS` in `sw.js` and bump the version.
