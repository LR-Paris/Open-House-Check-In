#!/usr/bin/env python3
"""Merge check-in exports from the Open House kiosk iPads into one attendance file.

Usage:
    python3 merge_checkins.py <export files and/or folders...> [-o OUTPUT_DIR] [--include-non-event-days]

Reads every checkins_*.csv given (folders are searched, not recursively). Exports are cumulative,
so it is fine to pass every export from every iPad: each check-in (checkin_id) is kept once, using
its largest group size (the iPad only ever raises it). The same person checked in on both iPads
on the same day is then collapsed to one row, keeping the earliest time and the largest group.
Check-ins dated outside Oct 6-8 (tests, dry run) are ignored unless --include-non-event-days.

Writes, in OUTPUT_DIR (default: current directory):
    attendance_master.csv   one row per person per event day (names as typed/confirmed at the door)
    hubspot_import.csv      one row per person: Record ID / Email / days attended (";Oct 6;Oct 7") / largest group.
                            Name, company, job title and sales rep are filled only for people with no Record ID
                            (new contacts), so an import keyed on Record ID never overwrites CRM values with
                            door-typed ones.
Prints counts only (no names).

Standard library only. Python 3.9+.
"""
from __future__ import annotations

import argparse
import csv
import glob
import os
import re
import sys
from collections import defaultdict

DAY_LABELS = {"2026-10-06": "Oct 6", "2026-10-07": "Oct 7", "2026-10-08": "Oct 8"}
REQUIRED = {"checkin_id", "device", "event_date", "checked_in_at_utc", "group_size_today", "last_name", "email"}
FORMULA_START = re.compile(r"^[=+\-@\t\r]")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T[\d:.]+Z$")

MASTER_COLUMNS = [
    "event_date", "person_key", "record_id", "first_name", "last_name", "company", "email", "job_title",
    "sales_rep", "on_rsvp_list", "path", "email_matched", "rsvp_status", "rsvp_days", "party_size_on_rsvp",
    "group_size_today", "group_changed", "first_checked_in_at_local", "first_checked_in_at_utc",
    "devices", "duplicate_rows",
]
HUBSPOT_COLUMNS = ["Record ID", "Email", "First Name", "Last Name", "Company Name", "Job Title",
                   "Your Sales Rep", "Open House Days Attended", "Open House Largest Group"]


def unguard(value: str) -> str:
    """Undo the kiosk's formula guard (a leading apostrophe before = + - @)."""
    if len(value) > 1 and value[0] == "'" and FORMULA_START.match(value[1:]):
        return value[1:]
    return value


def guard(value) -> str:
    s = "" if value is None else str(value)
    return "'" + s if FORMULA_START.match(s) else s


def norm(s: str | None) -> str:
    return re.sub(r"[\W_]+", "", (s or "").lower())


def find_files(paths: list[str]) -> list[str]:
    files: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            files.extend(sorted(glob.glob(os.path.join(p, "checkins_*.csv"))))
        elif os.path.isfile(p):
            files.append(p)
        else:
            raise SystemExit(f"Not found: {p}")
    return sorted(set(files))


def read_export(path: str) -> list[dict]:
    name = os.path.basename(path)
    try:
        with open(path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            missing = REQUIRED - set(reader.fieldnames or [])
            if missing:
                raise SystemExit(f"{name} is not a kiosk export (missing {', '.join(sorted(missing))}).")
            rows = [{k: unguard(v or "") for k, v in row.items()} for row in reader]
    except UnicodeDecodeError:
        raise SystemExit(f"{name} is not UTF-8 (re-saved by Excel?). Use the original export from the iPad.")
    for n, row in enumerate(rows, 2):
        rid = row.get("record_id", "")
        if not ISO_DATE.match(row["event_date"]) or not ISO_UTC.match(row["checked_in_at_utc"]) or (rid and not rid.isdigit()):
            raise SystemExit(f"{name} line {n} was changed by Excel or another tool "
                             f"(event_date={row['event_date']!r}, record_id={rid!r}). Use the original export from the iPad.")
    return rows


def as_int(s: str | None) -> int | None:
    try:
        return int(s)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def merge(files: list[str], include_non_event_days: bool = False) -> tuple[list[dict], list[dict], dict]:
    # 1) one version per check-in id (largest group wins: the iPad only raises it); note per-iPad freshness
    by_id: dict[str, dict] = {}
    devices: dict[str, dict] = {}
    for path in files:
        for row in read_export(path):
            d = devices.setdefault(row["device"] or "?", {"files": set(), "latest": ""})
            d["files"].add(os.path.basename(path))
            d["latest"] = max(d["latest"], row.get("checked_in_at_local", ""))
            cid = row["checkin_id"]
            prev = by_id.get(cid)
            if prev is None or (as_int(row["group_size_today"]) or 0) > (as_int(prev["group_size_today"]) or 0):
                by_id[cid] = row
    all_rows = list(by_id.values())
    rows = all_rows if include_non_event_days else [r for r in all_rows if r["event_date"] in DAY_LABELS]

    # 2) person identity. A Record ID always identifies the person. A row without one (new-guest form)
    #    is linked to a Record ID through its email only when the surname matches too; otherwise its key is
    #    email + surname, so two colleagues sharing info@studio.com stay two people.
    email_to_rec: dict[str, tuple[str, str]] = {}
    for r in rows:
        if r.get("record_id") and r.get("email"):
            email_to_rec.setdefault(r["email"].strip().lower(), (r["record_id"], norm(r.get("last_name"))))

    def person_key(r: dict) -> str:
        if r.get("record_id"):
            return "rec:" + r["record_id"]
        email = (r.get("email") or "").strip().lower()
        last = norm(r.get("last_name"))
        hit = email_to_rec.get(email)
        if hit and hit[1] == last:
            return "rec:" + hit[0]
        if email:
            return f"email:{email}|{last}"
        return "name:" + "|".join(norm(r.get(k)) for k in ("first_name", "last_name", "company"))

    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        groups[(person_key(r), r["event_date"])].append(r)

    # 3) collapse duplicates (same person, same day, e.g. both iPads)
    master: list[dict] = []
    for (key, day), items in sorted(groups.items(), key=lambda kv: (kv[0][1], min(r["checked_in_at_utc"] for r in kv[1]))):
        items.sort(key=lambda r: r["checked_in_at_utc"])
        base = items[0]
        record_id = next((r["record_id"] for r in items if r.get("record_id")), "") or (key[4:] if key.startswith("rec:") else "")
        group = max((as_int(r["group_size_today"]) or 1) for r in items)
        party = next((as_int(r.get("party_size_on_rsvp")) for r in items if as_int(r.get("party_size_on_rsvp"))), None)
        master.append({
            "event_date": day,
            "person_key": key,
            "record_id": record_id,
            "first_name": base.get("first_name", ""),
            "last_name": base.get("last_name", ""),
            "company": base.get("company", ""),
            "email": next((r["email"] for r in items if r.get("email")), ""),
            "job_title": next((r["job_title"] for r in items if r.get("job_title")), ""),
            "sales_rep": next((r["sales_rep"] for r in items if r.get("sales_rep")), ""),  # absent in v1.0 exports
            "on_rsvp_list": "true" if any(r.get("record_id") for r in items) else "false",
            "path": base.get("path", ""),
            "email_matched": "true" if any((r.get("email_matched") or "").lower() == "true" for r in items) else "false",
            "rsvp_status": next((r["rsvp_status"] for r in items if r.get("rsvp_status")), ""),
            "rsvp_days": next((r["rsvp_days"] for r in items if r.get("rsvp_days")), ""),
            "party_size_on_rsvp": "" if party is None else party,
            "group_size_today": group,
            "group_changed": "" if party is None else ("true" if group != party else "false"),
            "first_checked_in_at_local": base.get("checked_in_at_local", ""),
            "first_checked_in_at_utc": base.get("checked_in_at_utc", ""),
            "devices": ";".join(sorted({r["device"] for r in items})),
            "duplicate_rows": len(items) - 1,
        })

    # 4) HubSpot-ready: one row per person, days attended appended (leading ';' = append in a HubSpot import)
    people: dict[str, dict] = {}
    for m in master:
        p = people.setdefault(m["person_key"], {
            "Record ID": m["record_id"], "Email": m["email"], "First Name": m["first_name"],
            "Last Name": m["last_name"], "Company Name": m["company"], "Job Title": m["job_title"],
            "Your Sales Rep": m["sales_rep"],
            "_days": set(), "Open House Largest Group": 0,
        })
        p["_days"].add(m["event_date"])
        p["Open House Largest Group"] = max(p["Open House Largest Group"], int(m["group_size_today"]))
    hubspot = []
    for p in people.values():
        days = sorted(p.pop("_days"))
        p["Open House Days Attended"] = ";" + ";".join(DAY_LABELS.get(d, d) for d in days)
        if p["Record ID"]:  # existing contact: never overwrite CRM identity with door-typed values
            for col in ("First Name", "Last Name", "Company Name", "Job Title", "Your Sales Rep"):
                p[col] = ""
        hubspot.append(p)

    stats = {
        "files": len(files),
        "checkins_read": len(all_rows),
        "ignored_non_event_days": len(all_rows) - len(rows),
        "duplicates_removed": sum(m["duplicate_rows"] for m in master),
        "devices": devices,
        "by_day": {},
    }
    for m in master:
        d = stats["by_day"].setdefault(m["event_date"], {"parties": 0, "people": 0, "walk_ins": 0, "rsvp": 0})
        d["parties"] += 1
        d["people"] += int(m["group_size_today"])
        d["walk_ins" if m["on_rsvp_list"] == "false" else "rsvp"] += 1
    return master, hubspot, stats


def write_csv(path: str, columns: list[str], rows: list[dict], guard_cells: bool = True) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writerow(columns)
        for r in rows:
            vals = ["" if r.get(c) is None else r.get(c, "") for c in columns]
            w.writerow([guard(v) if guard_cells else str(v) for v in vals])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="export CSV files and/or folders containing checkins_*.csv")
    ap.add_argument("-o", "--out", default=".", help="output folder (default: current directory)")
    ap.add_argument("--include-non-event-days", action="store_true", help="keep check-ins dated outside Oct 6-8")
    args = ap.parse_args(argv)

    files = find_files(args.paths)
    if not files:
        print("No checkins_*.csv files found.", file=sys.stderr)
        return 1
    master, hubspot, stats = merge(files, args.include_non_event_days)
    os.makedirs(args.out, exist_ok=True)
    write_csv(os.path.join(args.out, "attendance_master.csv"), MASTER_COLUMNS, master)
    write_csv(os.path.join(args.out, "hubspot_import.csv"), HUBSPOT_COLUMNS, hubspot, guard_cells=False)

    print(f"Read {stats['files']} file(s), {stats['checkins_read']} unique check-in(s); "
          f"removed {stats['duplicates_removed']} duplicate(s) (same person, same day).")
    if stats["ignored_non_event_days"]:
        print(f"Ignored {stats['ignored_non_event_days']} check-in(s) dated outside Oct 6-8 (tests / dry run).")
    print("Per iPad (check each one's latest check-in is recent):")
    for dev, d in sorted(stats["devices"].items()):
        print(f"  {dev}: {len(d['files'])} file(s), latest check-in {d['latest'] or '-'}")
    if len(stats["devices"]) < 2:
        print("WARNING: exports from only one iPad were found.", file=sys.stderr)
    for day in sorted(stats["by_day"]):
        d = stats["by_day"][day]
        print(f"  {DAY_LABELS.get(day, day):>10}: {d['parties']} parties, {d['people']} people "
              f"({d['rsvp']} on the RSVP list, {d['walk_ins']} walk-ins)")
    print(f"Wrote attendance_master.csv ({len(master)} rows) and hubspot_import.csv ({len(hubspot)} rows) to {os.path.abspath(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
