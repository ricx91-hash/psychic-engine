# Tasker setup: PATLink share → certificate in info@rxtnt.com.au

Requires **Tasker 6.2+** (for the *Received Share* event). No plugins needed.

## 0. One-off phone setup

1. Android Settings → Apps → Tasker → Permissions → **Files / All files access: Allow**
   (so Tasker can read your Obsidian vault folder).
2. Find your vault's folder on the phone. It's usually
   `/storage/emulated/0/Documents/<VaultName>/`. Note the full path to `Clients.md`.
3. Tasker → **VARS** tab → add global variables:
   - `%RXTNT_URL` = `https://<project-ref>.supabase.co/functions/v1/patlink-certificate`
   - `%RXTNT_TOKEN` = the same value you set as the `PIPELINE_TOKEN` secret
   - `%RXTNT_CLIENTS` = full path to Clients.md, e.g. `Documents/RX/RX Test N Tag/Clients.md`

## 1. Profile

**PROFILES → + → Event → System → Received Share**
- Mime Type: `application/pdf`
- Name the profile **RX Certificate**. That name appears in the Android share sheet.

Link it to a new task called **RX Certificate** (below).

## 2. Task: RX Certificate

| # | Action | Settings |
|---|---|---|
| A1 | **Flash** | Text: `%rs_all_extras`. *First run only.* See the note below, then disable this action. |
| A2 | **Variable Set** | Name `%src`, To: the shared file variable (see note). |
| A3 | **Copy File** | From `%src`, To `Download/rxtnt/patlink.pdf`. Tick *Overwrite*. |
| A4 | **Read Binary** | File `Download/rxtnt/patlink.pdf`, To Var `%pdf64` |
| A5 | **Read Binary** | File `%RXTNT_CLIENTS`, To Var `%cli64` |
| A6 | **HTTP Request** | see below |
| A7 | **If** `%http_response_code` `~` `200` | |
| A8 | → **Flash** | `Sent for review: %http_data.overall (%http_data.site)` |
| A9 | **Else** | |
| A10 | → **Notify** | Title `RX certificate FAILED`, Text `%http_response_code %http_data` |
| A11 | **End If** | |

**A6 HTTP Request**
- Method: `POST`
- URL: `%RXTNT_URL`
- Headers (one per line):
  ```
  Content-Type:application/json
  x-rxtnt-token:%RXTNT_TOKEN
  ```
- Body:
  ```
  {"filename":"patlink.pdf","pdf_base64":"%pdf64","clients_md_base64":"%cli64"}
  ```
- Timeout (seconds): `120`

**Note on A1/A2 (do this once).** I couldn't check the exact name of the Received Share
file variable against Tasker's docs from the build environment. The first time you
share a PATLink PDF to **RX Certificate**, A1 flashes all the share data. Find the
entry holding the `content://…` or file path of the PDF (usually `%rs_files1` or
similar), put that variable in A2, then disable A1.

## 3. Use it

PATLink → export/share report PDF → **RX Certificate**. Within about 20 seconds you
should see the flash, and info@rxtnt.com.au gets:

- `RXTNT_Certificate_<Site>_<date>.pdf`: certificate plus itemised test report
- the original PATLink PDF, so you can cross-check

Subject line starts with `[REVIEW] COMPLIANT`, `[REVIEW] FAILURES PRESENT`,
`[REVIEW] INCOMPLETE` or `[REVIEW] REVIEW REQUIRED`. If processing crashes you still get a
`[FAILED]` email with the original PDF attached.

Nothing goes to the client. You forward it once you've reviewed it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| 401 Unauthorised | `%RXTNT_TOKEN` ≠ `PIPELINE_TOKEN` secret |
| 400 "not a PDF" | A2 points at the wrong variable, or the copy failed |
| "Client lookup: No row…" in email | Site Comment in PATLink ≠ Site column in Clients.md |
| "Clients.md was not supplied" | `%RXTNT_CLIENTS` path wrong or no file access permission |
| Resend 403 in `[FAILED]` email | Without a verified domain, Resend only delivers to your Resend login email. Sign up to Resend with info@rxtnt.com.au, or verify rxtnt.com.au |
