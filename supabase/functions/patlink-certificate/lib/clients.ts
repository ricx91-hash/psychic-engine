// Client lookup from the Obsidian vault note Clients.md.
//
// Expected note content, a markdown table (other text in the note is ignored):
//
//   | Site | Company | Contact | Email | Address |
//   |---|---|---|---|---|
//   | Narre Warren Dental | NW Dental Pty Ltd | Dr Smith | admin@nwdental.com.au | 12 Main St, Narre Warren VIC 3805 |
//
// Match rule: the PATLink "Comment" on node 0 must equal the Site column,
// ignoring case and extra spaces. No fuzzy matching, because attaching the
// wrong client to a compliance certificate is worse than finding none.

import type { Client, ClientLookup } from "./types.ts";

const COLUMNS = ["site", "company", "contact", "email", "address"] as const;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

export function normaliseSite(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseClientsMarkdown(md: string): { clients: Client[]; issues: string[] } {
  const issues: string[] = [];
  const lines = md.split(/\r?\n/);
  let header: string[] | null = null;
  let colIndex: Record<string, number> = {};
  const clients: Client[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) {
      if (header && clients.length > 0) break; // table ended
      continue;
    }
    const cells = splitRow(line);
    if (!header) {
      const lower = cells.map((c) => c.toLowerCase());
      if (!lower.includes("site")) continue;
      header = lower;
      colIndex = {};
      for (const col of COLUMNS) {
        const idx = lower.indexOf(col);
        if (idx === -1) issues.push(`Clients.md table has no "${col}" column.`);
        colIndex[col] = idx;
      }
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue; // separator row
    const get = (col: string) => (colIndex[col] >= 0 ? cells[colIndex[col]] ?? "" : "");
    const client: Client = {
      site: get("site"),
      company: get("company"),
      contact: get("contact"),
      email: get("email"),
      address: get("address"),
    };
    if (client.site) clients.push(client);
  }

  if (!header) issues.push('No table with a "Site" column found in Clients.md.');
  return { clients, issues };
}

export function lookupClient(md: string | null, site: string | null): ClientLookup {
  if (md === null || md.trim() === "") {
    return { found: false, client: null, issues: ["Clients.md was not supplied."] };
  }
  if (!site) {
    return { found: false, client: null, issues: ["No site name in the PDF to match against."] };
  }
  const { clients, issues } = parseClientsMarkdown(md);
  const key = normaliseSite(site);
  const matches = clients.filter((c) => normaliseSite(c.site) === key);
  if (matches.length === 0) {
    return { found: false, client: null, issues: [...issues, `No row in Clients.md with Site = "${site}".`] };
  }
  if (matches.length > 1) {
    return {
      found: false,
      client: null,
      issues: [...issues, `${matches.length} rows in Clients.md match Site = "${site}". Make it unique.`],
    };
  }
  const client = matches[0];
  const own: string[] = [];
  if (!client.company) own.push("Client company is blank in Clients.md.");
  if (!client.address) own.push("Client address is blank in Clients.md.");
  if (!client.email) own.push("Client email is blank in Clients.md.");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email)) own.push(`Client email "${client.email}" looks invalid.`);
  return { found: true, client, issues: [...issues, ...own] };
}
