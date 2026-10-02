# RX Test N Tag: PATLink → Certificate of Compliance

Share a PATLink (Metrel DeltaPAT MI 3309BT) PDF export from your phone. A branded
**Certificate of Compliance + itemised Test Report** arrives at **info@rxtnt.com.au** for
review. Nothing is sent to the client.

```
PATLink PDF ──share──▶ Tasker ──POST (PDF + Clients.md)──▶ Supabase Edge Function
                                                             │ extract text (unpdf)
                                                             │ parse + validate
                                                             │ client lookup (Clients.md)
                                                             │ render branded PDF (pdf-lib)
                                                             ▼
                                                  Resend ──▶ info@rxtnt.com.au
```

Free tier only: Supabase Edge Functions (500k calls/month) and Resend (3,000 emails/month).

## Accuracy rules (built into the code)

- The only data source is the PATLink **PDF**. `.padfx`/`.apx` files are never read.
- Every value is printed **exactly** as it appears in the PDF: no rounding, unit conversion or re-formatting.
- Anything that can't be read with confidence is marked **UNVERIFIED — check source PDF**
  and is never shown as PASS. Triggers include: missing item or test status, an
  unrecognised line, a status word other than `PASS`/`FAIL`/`NO RESULT`, a test with no
  RESULTS, an item marked PASS with a failed or missing test, or a PASS item with no next-test date.
- Any UNVERIFIED item makes the overall result **REVIEW REQUIRED** and puts a
  "DRAFT: DO NOT ISSUE" banner on the certificate.
- Test blocks are parsed generically (name → timestamp → status → RESULTS → PARAMETERS),
  so RCD and 3-phase tests go through the same path as insulation.
- Client lookup is an exact site-name match (case and spacing ignored). No fuzzy matching.

## Layout

```
supabase/functions/patlink-certificate/
  index.ts          HTTP handler, orchestration, review email
  lib/pdf_text.ts   PDF → ordered text lines (unpdf / pdf.js)
  lib/parser.ts     text lines → nodes, items, test blocks + validation
  lib/summary.ts    overall result, counts, dates
  lib/clients.ts    Clients.md table parsing + lookup
  lib/render.ts     branded certificate + report (pdf-lib)
  lib/email.ts      Resend delivery (review inbox only)
  lib/config.ts     business details + secrets
docs/TASKER_SETUP.md  phone wiring
docs/Clients.md       vault note template
tests/                parser + lookup tests
```

## Deploy (about 15 minutes)

1. **Resend.** Sign up at resend.com **using info@rxtnt.com.au** (until your domain is
   verified, Resend only delivers to the account's own email). Create an API key.
2. **Supabase.** Create a free project. Install the CLI, then from this repo:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase secrets set \
     PIPELINE_TOKEN="$(openssl rand -hex 24)" \
     RESEND_API_KEY="re_..." \
     TECH_NAME="Ric <surname>" \
     BUSINESS_ABN="<your ABN>" \
     BUSINESS_PHONE="<mobile>" \
     BUSINESS_WEBSITE="rxtnt.com.au"
   supabase functions deploy patlink-certificate --no-verify-jwt
   supabase secrets list   # copy PIPELINE_TOKEN into Tasker
   ```
   `--no-verify-jwt` is intentional. The function checks its own `x-rxtnt-token` header,
   so Tasker only needs one secret.

   Optional secrets: `REVIEW_TO` (default info@rxtnt.com.au), `RESEND_FROM` (after
   verifying your domain, e.g. `RX Test N Tag <certs@rxtnt.com.au>`), `LOGO_URL` (PNG
   of your crest; otherwise a vector shield/RX/bolt crest is drawn), `BUSINESS_ADDRESS`,
   `TEST_STANDARD`, `FONT_URL`/`FONT_BOLD_URL`.
3. **Vault.** Put [`docs/Clients.md`](docs/Clients.md) in your Obsidian vault and fill it in.
4. **Phone.** Follow [`docs/TASKER_SETUP.md`](docs/TASKER_SETUP.md).
5. **Test from a computer** before relying on the phone:
   ```bash
   curl -sS -X POST "https://<project-ref>.supabase.co/functions/v1/patlink-certificate" \
     -H "x-rxtnt-token: <PIPELINE_TOKEN>" \
     -F "pdf=@report.pdf;type=application/pdf" \
     -F "clients=@Clients.md"
   ```

## Tests

```bash
npm test     # Node 22+, no dependencies
```

## Known limits / verify on first real use

- **Checked against a real export** (Narre Warren Dental, 14/9/26, 3 pages, 6 items:
  Visual Inspection, Insulation, Insulation-P, Subleakage-P, Earth Continuity, Touch
  Leakage, plus a test block split across a page break). Every value matches the source,
  with zero UNVERIFIED flags. The text is in `tests/fixtures/` as a regression test.
  That text was pulled out with a stand-in extractor. The deployed function uses pdf.js,
  so check the first live email against the PDF too. Any line pdf.js reads differently
  shows up as UNVERIFIED rather than being guessed.
- RCD / 3-phase blocks are parsed generically but haven't been seen yet. Check the first ones.
- The Unicode font (Noto Sans, for Ω/µ/Δ) is fetched from jsDelivr on first run. If that
  fails, it falls back to Helvetica. Any symbol Helvetica can't print is shown as
  `[U+XXXX]` and the report is forced to REVIEW REQUIRED.
- Free-tier Edge Functions have a 2 s CPU limit per request. Typical site reports
  should be well under it. If a very large job fails with a CPU-limit error, split the export.
