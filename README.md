# LR Paris Open House — iPad check-in kiosk

An offline iPad app for guest sign-in at the Open House (1412 Broadway, Oct 6–8 2026).

- **Guest view:** the five approved screens. Guests can find their RSVP by name, or sign in as a new guest.
- **Admin view:** behind a password. Import the HubSpot RSVP list, view it and every check-in as searchable, sortable tables, export check-ins, change settings, clear data.
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

## 2. Set up each iPad (before the dry run, on wifi)

**Check the model and version first** in **Settings › General › About**:
- **Model Name.** The office's iPads are most likely **iPad (A16)**: the 2025 basic iPad, often called the "11th generation", though Apple never uses that name. They could also be **iPad (10th generation)** or **iPad (9th generation)**. The 9th gen has a round Home button; the other two have Touch ID in the top button. All three work with the app.
- **iPadOS Version.** 16 or later is needed. **26.5 or later is recommended**: it fixes a storage bug and a keyboard bug that affect this app. If it's older, update now, **before** adding the app to the Home Screen. Don't update iPadOS once the app is installed.
- Remove any keyboard case, and unpair any Bluetooth keyboard (**Settings › Bluetooth**; keep Bluetooth itself on for AirDrop). With a hardware keyboard attached, guests get no on-screen keyboard.
- **General › iPad Storage:** keep at least a few GB free. iPadOS deletes website data first when storage runs low.

**Settings**
1. **Accessibility › Guided Access:** on. Set a passcode. Set Display Auto-Lock to *Never*.
2. **General › Keyboard:** Auto-Correction off, Predictive Text off, Check Spelling off, Shortcuts off, Split Keyboard off (if shown).
3. **Apps › Safari › AutoFill:** Use Contact Info off. Also **General › AutoFill & Passwords:** AutoFill Passwords and Passkeys off.
4. **General › Software Update › Automatic Updates:** under iPadOS Updates, turn off **Automatically Install**, then **Automatically Download** (it only appears once Install is off). Also **Privacy & Security › Background Security Improvements:** Automatically Install off. Leave both off until Oct 9. Plugged in on wifi, the iPad would otherwise update and restart overnight.
5. **Multitasking & Gestures** (iPadOS 26 and later): choose **Full Screen Apps**, not Windowed Apps or Stage Manager. Otherwise a guest can drag the app into a small window. Set **Swipe Finger from Corner** to Off for both corners.
6. **Focus › Do Not Disturb:** on during the event. Keep the iPad plugged in.

**Install**
1. In **Safari**, open `https://lr-paris.github.io/Open-House-Check-In/`. You'll see *"Please ask a member of staff — This is a Safari tab…"*. That's expected: the app refuses to be set up in a Safari tab.
2. Tap **Share**, then **Add to Home Screen**. If it isn't in the list, tap **More (…)** or **View More** first. Make sure **Open as Web App** is on (iPadOS 26 and later; earlier versions have no switch), then tap Add.
3. **From now on, only ever open the app from the Home Screen icon.** A Safari tab has separate, empty storage.
4. Open the icon. The **Set up this iPad** screen appears. Enter the name (*iPad A* on one, *iPad B* on the other; it goes into every export) and the staff password: the same on both iPads, stored in the password manager. **There is no password recovery.**
5. The admin view opens. In the **This iPad** card, check:
   - Works offline: **yes** (if it says "not yet", wait a few seconds and tap *Reload app*)
   - Running as: **Home Screen app**
   - Storage protected: **yes**, **no** or **unknown** are all fine. iPadOS may answer *no* even for a correctly installed Home Screen app (a known WebKit bug). What protects the data is free storage space and exporting regularly.

**Import the RSVP list** (see §3 for the export)
1. AirDrop the CSV to the iPad and save it to **Files › On My iPad**. If the iPad doesn't show up in AirDrop: check wifi and Bluetooth are on and Airplane mode is off, then set **Control Center › AirDrop › Everyone for 10 Minutes**.
2. In the admin view, tap **Import RSVP list (CSV)** and pick the file. If a menu appears first, tap **Choose File**.
3. Check the preview. On 1 Oct the figures were 87 RSVPs; 86 going, 1 declined; Oct 6 / 7 / 8 = 28 / 28 / 27; 4 going with no day. Then tap **Import**.
4. Optional: tap **View RSVP list** to see every imported row as a table (search by any name, company, email or rep; tap a heading to sort). **View all check-ins** in the check-ins card does the same for this iPad's check-ins. Both close after 2 minutes untouched, like the rest of the admin view.

**Lock it**
1. Tap **Back to guest view**.
2. **Stand the iPad upright (portrait)** if the stand allows. In portrait every guest screen fits, and the keyboard leaves most of the form visible. In landscape the keyboard covers about half the screen.
3. Triple-click the **top button** (the **Home button** on a 9th gen) and choose Guided Access. Tap **Options**: leave Software Keyboards and Touch on, turn **Motion off** (this locks the screen orientation and stops shake-to-undo pop-ups), and set no time limit. Tap **Start**.

To leave Guided Access (to change an iPad setting or restart the app; the Staff button, import and export all work inside it), triple-click the same button, enter the Guided Access passcode (or use Touch ID), then tap **End**. If an Accessibility Shortcuts panel appears first, tap Guided Access. On iPadOS 18 or earlier, double-click instead of triple-clicking.

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
- `attendance_master.csv`: one row per person per day. Someone who signed in on both iPads is merged into one row, keeping the earliest time and the largest group. `sales_rep` is the rep picked on the new-guest form, or else the rep on the guest's RSVP.
- `hubspot_import.csv`: one row per person with `Open House Days Attended` (for example `;Oct 6;Oct 7`) and `Open House Largest Group`. It also carries `Your Sales Rep` for new contacts. For existing contacts (with a Record ID) the name, company, job title and sales rep columns are left blank, so an import never overwrites CRM data with what was typed at the door. This is for the future attendance write-back; nothing is written to HubSpot by this project.

The script prints counts only, never names. It uses Python's standard library, so there's nothing to install.

---

## 6. Test checklist (both iPads, in the Home Screen app, before Monday)

1. Import the real CSV. The counts match HubSpot, and accented names look right in the preview.
2. Look up real names: an exact match, a last name only, a first name only, a typo, two people with the same name, no match (which offers the new-guest form). Use the new-guest form with an RSVP'd email: it should say *already signed in* if that guest is already in, or otherwise link to their RSVP.
3. The same person twice gives *welcome back*. A bigger group the second time raises the number.
4. Leave a screen half-filled and wait. It returns to Welcome, empty: after 60 s on lookup or confirm, 120 s on new guest, 20 s on thank you.
5. **Airplane mode**, then force-quit the app and reopen it from the icon. It works, and the check-ins are still in the admin view. **Restart the iPad**: still there.
6. Export › Save to Files › OneDrive folder. Open the file in Excel on the laptop and check the accents. AirDrop also works. (The OneDrive folder only appears if the OneDrive app is installed and signed in on the iPad. Otherwise, use AirDrop.)
7. Guided Access on. The Staff button and password work inside Guided Access, and so do the share sheet and the Files picker.
8. **Keyboard, in the orientation you'll use at the door:** open New guest and tap each field in turn. Each one must move above the keyboard, and *Complete sign-in* must be reachable by scrolling or by hiding the keyboard.
9. **Guided Access on, try to escape:** drag the bottom-right corner inward, swipe in from each bottom corner, swipe down from the top centre, and rotate the iPad. Nothing should happen, and the app must stay full screen.
10. **Top of the screen:** the LR Paris logo is sharp, with no blurred band behind it (reported on iPadOS 27).
11. Staff › **Clear test check-ins** (type CLEAR). It deletes only check-ins dated outside Oct 6–8. The RSVP list stays.

---

## 7. Dry run (Mon) and after the event

- **After the dry run:** **Clear test check-ins** on both iPads (it only removes check-ins dated outside Oct 6–8, so real event data can never be hit), re-import the fresh CSV, and reset the keyboard dictionary (*Settings › General › Transfer or Reset iPad › Reset › Reset Keyboard Dictionary*). The merge script also ignores any test-day rows that end up in an export.
- **Fallback:** if lookup misbehaves, turn on Staff › Settings › **Walk-in-only mode**. Both home buttons then open the new-guest form; the day and time questions are hidden, and the day is recorded automatically.
- **Fri Oct 9:** do a final export from both iPads and run the merge. Then **Clear everything** (type DELETE). It refuses while any check-in is unshared. Delete the RSVP and check-in CSV files from Files, delete the Home Screen icon, and reset the keyboard dictionary.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Please ask a member of staff — This iPad isn't ready yet." | No RSVP list imported. Staff › Import. |
| "This sign-in couldn't be saved." | Storage error. After a second failure the app restarts itself (older iPadOS can leave storage stuck until a restart), and the guest signs in again. If it keeps happening: Staff › export immediately, then restart the iPad. Use the paper sheet meanwhile. |
| Export shows no *Save to Files* | Scroll to the bottom of the share sheet › **Edit Actions** › turn on Save to Files. On iPadOS 17.5.1 it's a known bug: update, or use AirDrop. |
| AirDrop doesn't show the laptop or iPad | Wifi and Bluetooth on, Airplane mode off, Personal Hotspot off. On the receiving device, set Control Center › AirDrop › **Everyone for 10 Minutes**. |
| Keyboard is small, split or floating mid-screen | A guest changed it. Spread two fingers on it, or touch and hold the keyboard key at the bottom right and choose **Dock** / **Merge**. |
| App is in a small window | Multitasking & Gestures isn't set to Full Screen Apps (§2). Leave Guided Access, tap the green window button or drag the window's corner out to full screen, then change the setting. |
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

**Event constants** (days, time slots, the sales-rep list, lookup thresholds, idle timers) are at the top of `js/core.js`. The sales-rep list copies the options of the HubSpot property *Your Sales Rep* (`nyc_oh_2026_10_invited_by`). If a rep is added in HubSpot, add them there too.

**Brand fonts:** they're not shipped, because the web licence for Trade Gothic Next and IvyOra Display isn't confirmed and the website is publicly reachable. The page falls back to fonts built into iPadOS. If the licence is confirmed:
1. Add the `.woff2` files under `fonts/`.
2. Add `@font-face` rules in `index.html` for the families `Trade Gothic Next` (weights 300/400/700), `Trade Gothic Next HvCn` (800) and `IvyOra Display` (300 italic).
3. Add the files to `ASSETS` in `sw.js` and bump the version.
