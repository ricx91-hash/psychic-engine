// Shared types for the PATLink -> certificate pipeline.
// Every value that came from the source PDF is kept as the exact string that
// appeared there. Nothing is converted, rounded or re-formatted.

export type Status = "PASS" | "FAIL" | "NO RESULT";

/** What is shown to the reader. UNVERIFIED is never rendered as PASS. */
export type DisplayStatus = Status | "UNVERIFIED";

export interface KV {
  key: string;
  value: string;
}

export interface TestBlock {
  name: string;
  timestamp: string;
  status: Status | null;
  instrument: string | null;
  /** key:value lines that appeared before RESULTS (captured verbatim). */
  info: KV[];
  results: KV[];
  parameters: KV[];
  issues: string[];
}

export interface Item {
  /** Node number as printed by PATLink, e.g. 5 for "5 Node/home/004/". */
  node: number;
  /** Full node path, e.g. ["home", "004"]. */
  path: string[];
  status: Status | null;
  name: string | null;
  location: string | null;
  testCode: string | null;
  nextTest: string | null;
  /** Every key:value line on the item before its first test block. */
  fields: KV[];
  tests: TestBlock[];
  issues: string[];
}

export interface GroupNode {
  node: number;
  path: string[];
  comment: string | null;
}

export interface ParsedReport {
  site: string | null;
  instrumentModel: string | null;
  instrumentSerials: string[];
  /** Lines before the first node (report header), verbatim. */
  headerLines: string[];
  groups: GroupNode[];
  items: Item[];
  /** Report-level problems: unrecognised lines, missing site, etc. */
  issues: string[];
}

export interface Client {
  site: string;
  company: string;
  contact: string;
  email: string;
  address: string;
}

export type ClientLookup =
  | { found: true; client: Client; issues: string[] }
  | { found: false; client: null; issues: string[] };

export type Overall =
  | "COMPLIANT"
  | "FAILURES PRESENT"
  | "INCOMPLETE"
  | "REVIEW REQUIRED";

export interface Summary {
  overall: Overall;
  overallReason: string;
  total: number;
  pass: number;
  fail: number;
  noResult: number;
  unverified: number;
  firstTest: string | null;
  lastTest: string | null;
  earliestNextTest: string | null;
}
