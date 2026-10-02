// Certificate-level summary. Dates are parsed only to find the first, last
// and earliest values. Output strings are always the originals from the PDF.

import type { DisplayStatus, Item, ParsedReport, Summary } from "./types.ts";

export function displayStatus(item: Item): DisplayStatus {
  if (item.issues.length > 0 || item.status === null) return "UNVERIFIED";
  return item.status;
}

/** "dd.mm.yyyy hh:mm[:ss]" -> sortable number, or null. */
export function dateKey(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s.trim());
  if (!m) return null;
  const [, d, mo, y, h = "0", mi = "0", sec = "0"] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
}

function extreme(values: (string | null)[], pick: "min" | "max"): string | null {
  let best: string | null = null;
  let bestKey: number | null = null;
  for (const v of values) {
    const k = dateKey(v);
    if (k === null) continue;
    if (bestKey === null || (pick === "min" ? k < bestKey : k > bestKey)) {
      best = v;
      bestKey = k;
    }
  }
  return best;
}

export function summarise(report: ParsedReport, extraIssues: string[] = []): Summary {
  const statuses = report.items.map(displayStatus);
  const count = (s: DisplayStatus) => statuses.filter((x) => x === s).length;
  const pass = count("PASS");
  const fail = count("FAIL");
  const noResult = count("NO RESULT");
  const unverified = count("UNVERIFIED");
  const reportIssues = report.issues.length + extraIssues.length;

  let overall: Summary["overall"];
  let overallReason: string;
  if (unverified > 0 || reportIssues > 0 || report.items.length === 0) {
    overall = "REVIEW REQUIRED";
    const parts: string[] = [];
    if (unverified > 0) parts.push(`${unverified} item(s) UNVERIFIED`);
    if (reportIssues > 0) parts.push(`${reportIssues} report-level issue(s)`);
    if (report.items.length === 0) parts.push("no items found");
    overallReason = `${parts.join(", ")}. Check against the source PDF before issuing.`;
  } else if (fail > 0) {
    overall = "FAILURES PRESENT";
    overallReason = `${fail} item(s) failed and must be withdrawn from service until repaired and retested.`;
  } else if (noResult > 0) {
    overall = "INCOMPLETE";
    overallReason = `${noResult} item(s) have no test result and are not covered by this certificate.`;
  } else {
    overall = "COMPLIANT";
    overallReason = `All ${pass} item(s) passed inspection and testing.`;
  }

  const stamps = report.items.flatMap((i) => i.tests.map((t) => t.timestamp));
  const nextTests = report.items.filter((i) => displayStatus(i) === "PASS").map((i) => i.nextTest);

  return {
    overall,
    overallReason,
    total: report.items.length,
    pass,
    fail,
    noResult,
    unverified,
    firstTest: extreme(stamps, "min"),
    lastTest: extreme(stamps, "max"),
    earliestNextTest: extreme(nextTests, "min"),
  };
}
