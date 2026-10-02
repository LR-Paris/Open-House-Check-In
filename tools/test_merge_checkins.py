"""Run: python3 -m unittest discover -s tools -p 'test_*.py'"""
import csv
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import merge_checkins as m  # noqa: E402

HEADER = ["checkin_id", "device", "event_date", "checked_in_at_local", "checked_in_at_utc", "path", "record_id",
          "email_matched", "first_name", "last_name", "company", "email", "job_title", "rsvp_status", "rsvp_days",
          "rsvp_slot", "party_size_on_rsvp", "walkin_days", "walkin_slot", "group_answer", "group_size_today",
          "group_changed", "group_updated_at_local"]


def row(cid, device, day, utc, path="lookup", rec="", email="", first="A", last="B", company="C", group=1, party=""):
    r = dict.fromkeys(HEADER, "")
    r.update(checkin_id=cid, device=device, event_date=day, checked_in_at_utc=utc, checked_in_at_local=utc[:16],
             path=path, record_id=rec, email=email, first_name=first, last_name=last, company=company,
             group_size_today=str(group), party_size_on_rsvp=str(party))
    return r


def write(dirpath, name, rows):
    path = os.path.join(dirpath, name)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=HEADER, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("'" + v if v and v[0] in "=+-@" else v) for k, v in r.items()})
    return path


class MergeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_cumulative_exports_and_cross_ipad_duplicates(self):
        sarah_a = row("a1", "iPad A", "2026-10-07", "2026-10-07T14:00:00Z", rec="1001", email="sarah@x.com", group=2, party=2)
        walkin = row("a2", "iPad A", "2026-10-07", "2026-10-07T15:00:00Z", path="walk_in", email="t@x.com", first="Taylor")
        # first export from iPad A, then a later cumulative one where Sarah's group was raised to 3
        write(self.d, "checkins_iPadA_20261007_1300.csv", [sarah_a])
        write(self.d, "checkins_iPadA_20261007_1830.csv", [dict(sarah_a, group_size_today="3"), walkin])
        # Sarah also signed in on iPad B (later), and on another day
        write(self.d, "checkins_iPadB_20261007_1830.csv", [
            row("b1", "iPad B", "2026-10-07", "2026-10-07T16:00:00Z", rec="1001", email="sarah@x.com", group=1, party=2),
            row("b2", "iPad B", "2026-10-08", "2026-10-08T14:00:00Z", rec="1001", email="sarah@x.com", group=2, party=2),
        ])
        master, hubspot, stats = m.merge(m.find_files([self.d]))
        self.assertEqual(stats["checkins_read"], 4)          # a1 (once), a2, b1, b2
        self.assertEqual(stats["duplicates_removed"], 1)     # a1 + b1 same person same day
        oct7 = [r for r in master if r["event_date"] == "2026-10-07"]
        sarah7 = next(r for r in oct7 if r["record_id"] == "1001")
        self.assertEqual(sarah7["group_size_today"], 3)       # largest
        self.assertEqual(sarah7["first_checked_in_at_utc"], "2026-10-07T14:00:00Z")  # earliest
        self.assertEqual(sarah7["devices"], "iPad A;iPad B")
        self.assertEqual(sarah7["group_changed"], "true")
        self.assertEqual(stats["by_day"]["2026-10-07"], {"parties": 2, "people": 4, "walk_ins": 1, "rsvp": 1})
        sarah_hs = next(p for p in hubspot if p["Record ID"] == "1001")
        self.assertEqual(sarah_hs["Open House Days Attended"], ";Oct 7;Oct 8")
        self.assertEqual(sarah_hs["Open House Largest Group"], 3)

    def test_walkin_linked_by_email_to_record(self):
        write(self.d, "checkins_iPadA_x.csv", [
            row("a1", "iPad A", "2026-10-06", "2026-10-06T14:00:00Z", rec="1001", email="Sarah@X.com"),
        ])
        write(self.d, "checkins_iPadB_x.csv", [
            row("b1", "iPad B", "2026-10-06", "2026-10-06T15:00:00Z", path="walk_in", email="sarah@x.com", first="Sally"),
        ])
        master, hubspot, stats = m.merge(m.find_files([self.d]))
        self.assertEqual(len(master), 1)
        self.assertEqual(master[0]["record_id"], "1001")
        self.assertEqual(stats["duplicates_removed"], 1)

    def test_formula_guard_round_trip_and_output_files(self):
        write(self.d, "checkins_iPadA_x.csv", [
            row("a1", "iPad A", "2026-10-06", "2026-10-06T14:00:00Z", path="walk_in", email="z@x.com", company="=HYPERLINK(1)"),
        ])
        out = os.path.join(self.d, "out")
        self.assertEqual(m.main([self.d, "-o", out]), 0)
        with open(os.path.join(out, "attendance_master.csv"), encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(rows[0]["company"], "'=HYPERLINK(1)")   # guarded again for Excel
        self.assertEqual(rows[0]["on_rsvp_list"], "false")
        self.assertEqual(m.unguard("'=HYPERLINK(1)"), "=HYPERLINK(1)")
        self.assertEqual(m.unguard("'Neill"), "'Neill")           # a real apostrophe stays

    def test_ignores_non_event_days(self):
        write(self.d, "checkins_iPadA_x.csv", [
            row("t1", "iPad A", "2026-10-05", "2026-10-05T14:00:00Z", rec="1001", email="s@x.com", group=9),
            row("a1", "iPad A", "2026-10-07", "2026-10-07T14:00:00Z", rec="1001", email="s@x.com", group=2),
        ])
        master, hubspot, stats = m.merge(m.find_files([self.d]))
        self.assertEqual(stats["ignored_non_event_days"], 1)
        self.assertEqual([r["event_date"] for r in master], ["2026-10-07"])
        self.assertEqual(hubspot[0]["Open House Days Attended"], ";Oct 7")
        self.assertEqual(hubspot[0]["Open House Largest Group"], 2)
        master2, _, _ = m.merge(m.find_files([self.d]), include_non_event_days=True)
        self.assertEqual(len(master2), 2)

    def test_shared_email_different_surnames_are_two_people(self):
        write(self.d, "checkins_iPadA_x.csv", [
            row("a1", "iPad A", "2026-10-06", "2026-10-06T14:00:00Z", path="walk_in", email="info@studio.com", first="Tom", last="Lane"),
        ])
        write(self.d, "checkins_iPadB_x.csv", [
            row("b1", "iPad B", "2026-10-06", "2026-10-06T15:00:00Z", path="walk_in", email="INFO@studio.com", first="Ana", last="Ruiz"),
            row("b2", "iPad B", "2026-10-06", "2026-10-06T16:00:00Z", rec="1001", email="info@studio.com", first="Sarah", last="Kim"),
        ])
        master, hubspot, stats = m.merge(m.find_files([self.d]))
        self.assertEqual(len(master), 3)
        self.assertEqual(stats["duplicates_removed"], 0)

    def test_hubspot_file_never_overwrites_crm_names(self):
        write(self.d, "checkins_iPadA_x.csv", [
            row("a1", "iPad A", "2026-10-06", "2026-10-06T14:00:00Z", path="walk_in", rec="1001", email="s@x.com", first="Sally", last="Kim", company="+Plus"),
            row("a2", "iPad A", "2026-10-06", "2026-10-06T15:00:00Z", path="walk_in", email="new@x.com", first="Neo", last="Guest", company="+Plus"),
        ])
        out = os.path.join(self.d, "out")
        m.main([self.d, "-o", out])
        with open(os.path.join(out, "hubspot_import.csv"), encoding="utf-8-sig", newline="") as f:
            rows = {r["Email"]: r for r in csv.DictReader(f)}
        self.assertEqual(rows["s@x.com"]["Record ID"], "1001")
        self.assertEqual(rows["s@x.com"]["First Name"], "")      # existing contact: names left blank
        self.assertEqual(rows["new@x.com"]["First Name"], "Neo")  # new contact: names filled
        self.assertEqual(rows["new@x.com"]["Company Name"], "+Plus")  # no Excel guard in the HubSpot file

    def test_rejects_excel_resaved_export(self):
        bad = row("a1", "iPad A", "10/6/26", "2026-10-06T14:00:00Z", rec="1001")
        write(self.d, "checkins_iPadA_x.csv", [bad])
        with self.assertRaises(SystemExit):
            m.merge(m.find_files([self.d]))

    def test_rejects_non_kiosk_csv(self):
        path = os.path.join(self.d, "checkins_bad.csv")
        with open(path, "w") as f:
            f.write("a,b\n1,2\n")
        with self.assertRaises(SystemExit):
            m.merge([path])


if __name__ == "__main__":
    unittest.main()
