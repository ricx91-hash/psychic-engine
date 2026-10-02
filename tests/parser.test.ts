// Run: npm test   (Node >= 22.6, uses built-in type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePatlinkText, parseKVLine } from "../supabase/functions/patlink-certificate/lib/parser.ts";
import { displayStatus, summarise } from "../supabase/functions/patlink-certificate/lib/summary.ts";
import { lookupClient } from "../supabase/functions/patlink-certificate/lib/clients.ts";

const sample = readFileSync(new URL("./fixtures/sample_export.txt", import.meta.url), "utf8").split("\n");
const parse = (text: string) => parsePatlinkText(text.trim().split("\n"));

test("sample export: site, instrument, hierarchy", () => {
  const r = parsePatlinkText(sample);
  assert.equal(r.site, "Narre Warren Dental");
  assert.equal(r.instrumentModel, "DeltaPAT MI 3309BT");
  assert.deepEqual(r.instrumentSerials, ["26150662"]);
  assert.deepEqual(r.groups.map((g) => g.path.join("/")), ["", "dental room", "home"]);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.issues, []);
});

test("sample export: PASS item with two generic test blocks, values verbatim", () => {
  const item = parsePatlinkText(sample).items[1];
  assert.equal(item.node, 5);
  assert.deepEqual(item.path, ["home", "004"]);
  assert.equal(item.name, "hairdryer");
  assert.equal(item.location, "home");
  assert.equal(item.testCode, "Class 2");
  assert.equal(item.nextTest, "10.09.2027 00:00:00");
  assert.equal(item.tests.length, 2);
  const [visual, iso] = item.tests;
  assert.equal(visual.name, "Visual Inspection");
  assert.deepEqual(visual.results, [{ key: "Result", value: "0" }]);
  assert.equal(iso.name, "Insulation");
  assert.equal(iso.timestamp, "10.09.2026 14:23:00");
  assert.equal(iso.status, "PASS");
  assert.equal(iso.instrument, "26150662");
  assert.deepEqual(iso.results, [
    { key: "Riso", value: ">200 MOhm" },
    { key: "Limit", value: "1 MOhm" },
  ]);
  assert.deepEqual(iso.parameters, [
    { key: "Output iso voltage", value: "500 V" },
    { key: "Duration", value: "2 s" },
  ]);
  assert.deepEqual(item.issues, []);
  assert.equal(displayStatus(item), "PASS");
});

test("sample export: NO RESULT item stays NO RESULT, overall INCOMPLETE", () => {
  const r = parsePatlinkText(sample);
  assert.equal(r.items[0].status, "NO RESULT");
  assert.equal(displayStatus(r.items[0]), "NO RESULT");
  const s = summarise(r);
  assert.equal(s.overall, "INCOMPLETE");
  assert.equal(s.pass, 1);
  assert.equal(s.noResult, 1);
  assert.equal(s.earliestNextTest, "10.09.2027 00:00:00");
  assert.equal(s.lastTest, "10.09.2026 14:23:00");
});

test("unknown test types (RCD, 3-phase) parse generically", () => {
  const r = parse(`
0 Node/
Comment: Site
7 Node/workshop/010/ PASS
Name: lead
Test code: Class 1
Next test of appliance: 01.01.2027 00:00:00
RCD Test 11.09.2026 09:01:02 PASS
Instrument : 26150662
RESULTS
t x1/2 : >300 ms | t x1 : 18.4 ms |
PARAMETERS
IΔN : 30 mA | Type : AC
3-Phase Leakage 11.09.2026 09:05:00 PASS
RESULTS
Ileak : 0.21 mA
`);
  const item = r.items[0];
  assert.deepEqual(item.tests.map((t) => t.name), ["RCD Test", "3-Phase Leakage"]);
  assert.deepEqual(item.tests[0].results, [
    { key: "t x1/2", value: ">300 ms" },
    { key: "t x1", value: "18.4 ms" },
  ]);
  assert.deepEqual(item.tests[0].parameters[0], { key: "IΔN", value: "30 mA" });
  assert.equal(displayStatus(item), "PASS");
});

test("item with missing status is UNVERIFIED, never PASS", () => {
  const r = parse(`
0 Node/
Comment: Site
2 Node/a/001/
Name: kettle
Next test of appliance: 01.01.2027 00:00:00
Insulation 10.09.2026 14:23:00 PASS
RESULTS
Riso : >200 MOhm
`);
  assert.equal(r.items.length, 1);
  assert.equal(displayStatus(r.items[0]), "UNVERIFIED");
  assert.equal(summarise(r).overall, "REVIEW REQUIRED");
});

test("test block with missing status or unreadable line is UNVERIFIED", () => {
  const r = parse(`
0 Node/
Comment: Site
2 Node/a/001/ PASS
Name: kettle
Next test of appliance: 01.01.2027 00:00:00
Insulation 10.09.2026 14:23:00
RESULTS
Riso : >200 MOhm
3 Node/a/002/ PASS
Name: toaster
Next test of appliance: 01.01.2027 00:00:00
Insulation 10.09.2026 14:24:00 PASS
RESULTS
Riso >200 MOhm
`);
  assert.equal(displayStatus(r.items[0]), "UNVERIFIED");
  assert.equal(displayStatus(r.items[1]), "UNVERIFIED");
  assert.match(r.items[1].tests[0].issues[0], /Unrecognised line/);
});

test("item PASS with a FAIL block is flagged as inconsistent", () => {
  const r = parse(`
0 Node/
Comment: Site
2 Node/a/001/ PASS
Name: kettle
Next test of appliance: 01.01.2027 00:00:00
Earth Bond 10.09.2026 14:23:00 FAIL
RESULTS
Rpe : 2.5 Ohm
`);
  assert.equal(displayStatus(r.items[0]), "UNVERIFIED");
  assert.match(r.items[0].issues.join(" "), /marked PASS/);
});

test("FAIL item gives FAILURES PRESENT", () => {
  const r = parse(`
0 Node/
Comment: Site
2 Node/a/001/ FAIL
Name: kettle
Earth Bond 10.09.2026 14:23:00 FAIL
RESULTS
Rpe : 2.5 Ohm
`);
  assert.equal(displayStatus(r.items[0]), "FAIL");
  assert.equal(summarise(r).overall, "FAILURES PRESENT");
});

test("unexpected status word (e.g. PASSED) is not accepted", () => {
  const r = parse(`
0 Node/
Comment: Site
2 Node/a/001/ PASS
Name: kettle
Next test of appliance: 01.01.2027 00:00:00
Insulation 10.09.2026 14:23:00 PASSED
RESULTS
Riso : >200 MOhm
`);
  assert.equal(displayStatus(r.items[0]), "UNVERIFIED");
  assert.match(r.items[0].issues[0], /Unrecognised line: "Insulation 10.09.2026 14:23:00 PASSED"/);
  assert.equal(r.items[0].fields.some((f) => f.key.startsWith("Insulation")), false);
});

test("missing site comment is a report issue", () => {
  const r = parse(`
0 Node/
2 Node/a/001/ NO RESULT
Name: kettle
`);
  assert.equal(r.site, null);
  assert.equal(summarise(r).overall, "REVIEW REQUIRED");
});

test("parseKVLine", () => {
  assert.deepEqual(parseKVLine("Output iso voltage : 500 V | Duration : 2 s |"), [
    { key: "Output iso voltage", value: "500 V" },
    { key: "Duration", value: "2 s" },
  ]);
  assert.deepEqual(parseKVLine("Next test of appliance: 10.09.2027 12:38:01"), [
    { key: "Next test of appliance", value: "10.09.2027 12:38:01" },
  ]);
  assert.equal(parseKVLine("RESULTS"), null);
});

// Real PATLink export (Narre Warren Dental, 14/9/26), text extracted from the PDF.
test("real export: every item and value read exactly", () => {
  const lines = readFileSync(new URL("./fixtures/narre_warren_dental_2026-09-14.txt", import.meta.url), "utf8").split("\n");
  const r = parsePatlinkText(lines);
  assert.equal(r.site, "Narre Warren Dental");
  assert.equal(r.instrumentModel, "MI 3309BT");
  assert.deepEqual(r.instrumentSerials, ["26150662"]);
  assert.deepEqual(r.issues, []);
  assert.equal(r.groups.find((g) => g.path.join("/") === "dental room")?.comment, "suite 3");

  const rows = r.items.map((i) => [i.path.join("/"), i.name, i.testCode, displayStatus(i), i.nextTest, i.tests.map((t) => t.name).join(",")]);
  assert.deepEqual(rows, [
    ["dental room/011", "curing light", "Class 2", "PASS", "11.09.2027 00:00:00", "Visual Inspection,Insulation-P,Subleakage-P"],
    ["dental room/019", "dental chair", "Class 1", "PASS", "14.09.2027 00:00:00", "Visual Inspection,Earth Continuity,Insulation"],
    ["dental room/020", "setting box", "Class 2", "PASS", "14.09.2027 00:00:00", "Visual Inspection,Insulation-P,Subleakage-P"],
    ["dental room/021", "computer", "Class 2", "PASS", "14.09.2027 00:00:00", "Visual Inspection,Insulation-P,Subleakage-P"],
    ["dental room/022", "monitor", "Class 2", "PASS", "14.09.2027 00:00:00", "Visual Inspection,Insulation-P,Subleakage-P"],
    ["dental room/018", "dental chair", "custom", "PASS", "14.09.2027 00:00:00", "Touch Leakage"],
  ]);

  // Earth continuity block spans a page break in the source PDF.
  const earth = r.items[1].tests[1];
  assert.deepEqual(earth.results, [{ key: "R", value: "0.11 Ohm" }, { key: "Limit", value: "1.00 Ohm" }]);
  assert.deepEqual(earth.parameters, [{ key: "I out", value: "200 mA" }, { key: "Duration", value: "2 s" }]);

  assert.deepEqual(r.items[0].tests[2].results, [{ key: "Isub-S", value: "0.03 mA" }, { key: "Limit", value: "0.25 mA" }]);
  assert.deepEqual(r.items[0].tests[2].parameters, [{ key: "Duration", value: "5 s" }, { key: "Output", value: "30.0 V" }]);
  assert.deepEqual(r.items[5].tests[0].results, [
    { key: "Itou", value: "0.00 mA" },
    { key: "Limit", value: "0.50 mA" },
    { key: "S", value: "0.04 kVA" },
  ]);

  const s = summarise(r);
  assert.equal(s.overall, "COMPLIANT");
  assert.equal(s.total, 6);
  assert.equal(s.firstTest, "11.09.2026 12:20:00");
  assert.equal(s.lastTest, "14.09.2026 09:24:00");
  assert.equal(s.earliestNextTest, "11.09.2027 00:00:00");
});

const clientsMd = `# Clients

Some notes here.

| Site | Company | Contact | Email | Address |
|---|---|---|---|---|
| Narre Warren Dental | NW Dental Pty Ltd | Dr Smith | admin@nwdental.com.au | 12 Main St, Narre Warren VIC 3805 |
| Berwick Gym | Berwick Fitness | Sam | sam@berwickgym.com.au | 1 High St, Berwick VIC 3806 |
| Dup Site | A | | a@a.com | x |
| dup  site | B | | b@b.com | y |
`;

test("client lookup: exact match ignoring case/whitespace", () => {
  const r = lookupClient(clientsMd, "  narre warren   DENTAL ");
  assert.equal(r.found, true);
  assert.equal(r.client?.company, "NW Dental Pty Ltd");
  assert.equal(r.client?.address, "12 Main St, Narre Warren VIC 3805");
  assert.deepEqual(r.issues, []);
});

test("client lookup: no fuzzy match, duplicates rejected, missing file", () => {
  assert.equal(lookupClient(clientsMd, "Narre Warren Dental Clinic").found, false);
  assert.equal(lookupClient(clientsMd, "Dup Site").found, false);
  assert.equal(lookupClient(null, "Berwick Gym").found, false);
  assert.equal(lookupClient("no table here", "Berwick Gym").found, false);
});
