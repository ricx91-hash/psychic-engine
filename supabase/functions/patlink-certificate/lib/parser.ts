// Parser for the text of a PATLink (Metrel DeltaPAT MI 3309BT) PDF export.
//
// Input: the PDF's text as an ordered list of lines (see pdf_text.ts).
// Output: a ParsedReport. The parser never guesses. Anything it can't place
// is recorded as an issue, and an item with any issue is shown as UNVERIFIED.
//
// Expected shape (one sample export, Class 2 insulation only):
//
//   0 Node/
//   Comment: Narre Warren Dental
//   1 Node/dental room/
//   5 Node/home/004/ PASS
//   Name: hairdryer
//   (Room) Location: home
//   Test code: Class 2
//   Next test of appliance: 10.09.2027 00:00:00
//   Visual Inspection 10.09.2026 14:23:00 PASS      <- test block header
//   Instrument : 26150662
//   RESULTS
//   Result : 0
//   PARAMETERS
//   Output iso voltage : 500 V | Duration : 2 s |
//
// Test blocks are matched generically (name, timestamp, status, RESULTS and
// PARAMETERS key:value pairs). No test name is hard-coded, so RCD and
// 3-phase blocks go through the same path.

import type {
  GroupNode,
  Item,
  KV,
  ParsedReport,
  Status,
  TestBlock,
} from "./types.ts";

const STATUS_RE = "(PASS|FAIL|NO RESULT)";
const NODE_RE = /^(\d+)\s+Node\/(.*)$/;
const NODE_TAIL_RE = new RegExp(`^(.*?)(?:\\s+${STATUS_RE})?\\s*$`);
// "<name> dd.mm.yyyy hh:mm[:ss] [STATUS]". The name may not contain ':',
// which keeps "Next test of appliance: 10.09.2027 12:38:01" out.
const TEST_HEADER_RE = new RegExp(
  `^([^:]+?)\\s+(\\d{1,2}\\.\\d{1,2}\\.\\d{4}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)(?:\\s+${STATUS_RE})?\\s*$`,
);
// Page furniture the PDF renderer may insert between lines.
const NOISE_RES = [/^page\s+\d+(\s*(of|\/)\s*\d+)?$/i, /^\d+\s*\/\s*\d+$/];
const DATE_IN_KEY_RE = /\d{1,2}\.\d{1,2}\.\d{4}/;
const MODEL_RE = /\b(MI\s?\d{4}[A-Z]*|DeltaPAT[^,;|]*)/i;

/** Split "a : b | c : d |" into KV pairs. Returns null if any segment has no ':'. */
export function parseKVLine(line: string): KV[] | null {
  const segments = line.split("|").map((s) => s.trim()).filter((s) => s !== "");
  if (segments.length === 0) return null;
  const out: KV[] = [];
  for (const seg of segments) {
    const idx = seg.indexOf(":");
    if (idx <= 0) return null;
    // A date in the key means the colon came from a time, e.g. a test header
    // with an unexpected status word. Refuse rather than mis-split it.
    if (DATE_IN_KEY_RE.test(seg.slice(0, idx))) return null;
    out.push({ key: seg.slice(0, idx).trim(), value: seg.slice(idx + 1).trim() });
  }
  return out;
}

function normaliseLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function isNoise(line: string): boolean {
  return NOISE_RES.some((re) => re.test(line));
}

function newItem(node: number, path: string[], status: Status | null): Item {
  return {
    node,
    path,
    status,
    name: null,
    location: null,
    testCode: null,
    nextTest: null,
    fields: [],
    tests: [],
    issues: [],
  };
}

export function parsePatlinkText(rawLines: string[]): ParsedReport {
  const report: ParsedReport = {
    site: null,
    instrumentModel: null,
    instrumentSerials: [],
    headerLines: [],
    groups: [],
    items: [],
    issues: [],
  };

  // Current context while walking lines.
  type Ctx =
    | { kind: "header" }
    | { kind: "group"; group: GroupNode }
    | { kind: "item"; item: Item; block: TestBlock | null; section: "pre" | "results" | "parameters" };
  let ctx = { kind: "header" } as Ctx;
  let pendingNode: { node: number; path: string[]; status: Status | null; lines: string[] } | null = null;

  // A node becomes an item if it has a status, a Name/Test code line or a
  // test block. Otherwise it is a group (site root or location folder). The
  // decision is made once the node's own lines have been read, so collect
  // them first.
  const flushNode = () => {
    if (!pendingNode) return;
    const { node, path, status, lines } = pendingNode;
    pendingNode = null;
    const looksLikeItem =
      status !== null ||
      lines.some((l) => /^(Name|Test code)\s*:/i.test(l) || TEST_HEADER_RE.test(l));
    if (looksLikeItem) {
      const item = newItem(node, path, status);
      report.items.push(item);
      ctx = { kind: "item", item, block: null, section: "pre" };
      for (const l of lines) handleItemLine(l);
    } else {
      const group: GroupNode = { node, path, comment: null };
      report.groups.push(group);
      ctx = { kind: "group", group };
      for (const l of lines) handleGroupLine(group, l);
    }
  };

  const handleGroupLine = (group: GroupNode, line: string) => {
    const kv = parseKVLine(line);
    if (kv && kv.length === 1 && /^comment$/i.test(kv[0].key)) {
      group.comment = kv[0].value;
      return;
    }
    report.issues.push(`Unrecognised line under node ${group.node} ("${group.path.join("/") || "root"}"): "${line}"`);
  };

  const handleItemLine = (line: string) => {
    if (ctx.kind !== "item") return;
    const item = ctx.item;

    const header = TEST_HEADER_RE.exec(line);
    if (header) {
      const block: TestBlock = {
        name: header[1].trim(),
        timestamp: header[2],
        status: (header[3] as Status | undefined) ?? null,
        instrument: null,
        info: [],
        results: [],
        parameters: [],
        issues: [],
      };
      item.tests.push(block);
      ctx.block = block;
      ctx.section = "pre";
      return;
    }

    if (ctx.block) {
      const block = ctx.block;
      if (/^RESULTS$/i.test(line)) {
        ctx.section = "results";
        return;
      }
      if (/^PARAMETERS$/i.test(line)) {
        ctx.section = "parameters";
        return;
      }
      const kv = parseKVLine(line);
      if (!kv) {
        block.issues.push(`Unrecognised line: "${line}"`);
        return;
      }
      for (const pair of kv) {
        if (pair.value === "") block.issues.push(`Empty value for "${pair.key}"`);
        if (ctx.section === "pre" && /^instrument$/i.test(pair.key)) {
          block.instrument = pair.value;
        } else if (ctx.section === "results") {
          block.results.push(pair);
        } else if (ctx.section === "parameters") {
          block.parameters.push(pair);
        } else {
          block.info.push(pair);
        }
      }
      return;
    }

    // Item fields before the first test block.
    const kv = parseKVLine(line);
    if (!kv) {
      item.issues.push(`Unrecognised line: "${line}"`);
      return;
    }
    for (const pair of kv) {
      item.fields.push(pair);
      const key = pair.key.toLowerCase();
      if (key === "name") item.name = pair.value || null;
      else if (key.endsWith("location")) item.location = pair.value || null;
      else if (key === "test code") item.testCode = pair.value || null;
      else if (key.startsWith("next test")) item.nextTest = pair.value || null;
    }
  };

  for (const raw of rawLines) {
    const line = normaliseLine(raw);
    if (line === "" || isNoise(line)) continue;

    const nodeMatch = NODE_RE.exec(line);
    if (nodeMatch) {
      flushNode();
      const tail = NODE_TAIL_RE.exec(nodeMatch[2])!;
      const path = tail[1].split("/").map((s) => s.trim()).filter((s) => s !== "");
      pendingNode = {
        node: Number(nodeMatch[1]),
        path,
        status: (tail[2] as Status | undefined) ?? null,
        lines: [],
      };
      continue;
    }

    if (pendingNode) {
      // Buffer until we know whether this node is an item or a group. Once a
      // test header shows up it must be an item, so flush early.
      pendingNode.lines.push(line);
      if (TEST_HEADER_RE.test(line)) flushNode();
      continue;
    }

    if (ctx.kind === "header") report.headerLines.push(line);
    else if (ctx.kind === "group") handleGroupLine(ctx.group, line);
    else handleItemLine(line);
  }
  flushNode();

  // Header: instrument model and serial.
  for (const l of report.headerLines) {
    const kv = parseKVLine(l);
    if (kv) {
      for (const p of kv) {
        if (/serial/i.test(p.key) && p.value && !report.instrumentSerials.includes(p.value)) {
          report.instrumentSerials.push(p.value);
        }
        if (/(model|instrument)/i.test(p.key) && !report.instrumentModel && MODEL_RE.test(p.value)) {
          report.instrumentModel = p.value;
        }
      }
    }
    if (!report.instrumentModel) {
      const m = MODEL_RE.exec(l);
      if (m) report.instrumentModel = m[1].trim();
    }
  }
  for (const item of report.items) {
    for (const t of item.tests) {
      if (t.instrument && !report.instrumentSerials.includes(t.instrument)) {
        report.instrumentSerials.push(t.instrument);
      }
    }
  }

  const root = report.groups.find((g) => g.path.length === 0);
  report.site = root?.comment ?? null;
  if (!report.site) report.issues.push('Site name not found (expected "Comment:" on node 0).');
  if (report.items.length === 0) report.issues.push("No test items found in the PDF.");

  for (const item of report.items) validateItem(item);
  return report;
}

/** Add an issue for anything that can't be stated with confidence. */
export function validateItem(item: Item): void {
  if (item.status === null) item.issues.push("Overall item status not found.");
  if (!item.name) item.issues.push("Item name not found.");
  if (item.path.length === 0) item.issues.push("Item has no node path.");

  for (const t of item.tests) {
    if (t.status === null) t.issues.push("Test status not found.");
    if (t.results.length === 0) t.issues.push("No RESULTS values found.");
    if (t.issues.length > 0) {
      item.issues.push(`Test "${t.name}" (${t.timestamp}) could not be fully read.`);
    }
  }

  if ((item.status === "PASS" || item.status === "FAIL") && item.tests.length === 0) {
    item.issues.push(`Item is marked ${item.status} but no test blocks were found.`);
  }
  if (item.status === "PASS") {
    const bad = item.tests.filter((t) => t.status !== "PASS");
    if (bad.length > 0) {
      item.issues.push(
        `Item is marked PASS but test(s) ${bad.map((t) => `"${t.name}"=${t.status ?? "unknown"}`).join(", ")} did not pass.`,
      );
    }
    if (!item.nextTest) item.issues.push("Next test date not found.");
  }
  if (item.status === "FAIL" && item.tests.length > 0 && !item.tests.some((t) => t.status === "FAIL")) {
    item.issues.push("Item is marked FAIL but no test block is marked FAIL.");
  }
}
