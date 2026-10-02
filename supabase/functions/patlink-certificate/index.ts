// Supabase Edge Function: PATLink PDF -> RX Test N Tag certificate -> review inbox.
//
// POST from Tasker (JSON):
//   { "filename": "report.pdf", "pdf_base64": "...", "clients_md_base64": "..." }
// Also accepted: multipart/form-data with fields "pdf" and "clients", or a raw
// application/pdf body (the certificate then shows the client as NOT FOUND).
// Auth: header "x-rxtnt-token: <PIPELINE_TOKEN>".
//
// This function only emails REVIEW_TO (info@rxtnt.com.au). It never contacts the client.

import { businessConfig, deliveryConfig, missingBusinessFields } from "./lib/config.ts";
import { lookupClient } from "./lib/clients.ts";
import { esc, sendReviewEmail } from "./lib/email.ts";
import { parsePatlinkText } from "./lib/parser.ts";
import { extractLines } from "./lib/pdf_text.ts";
import { createDocument, renderCertificate, sourceStrings, unsupportedChars } from "./lib/render.ts";
import { displayStatus, summarise } from "./lib/summary.ts";

interface Payload {
  filename: string;
  pdf: Uint8Array;
  clientsMd: string | null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function readPayload(req: Request): Promise<Payload> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json();
    if (typeof body.pdf_base64 !== "string") throw new Error("pdf_base64 missing from JSON body.");
    let clientsMd: string | null = null;
    if (typeof body.clients_md_base64 === "string" && body.clients_md_base64.trim()) {
      clientsMd = new TextDecoder().decode(fromBase64(body.clients_md_base64));
    } else if (typeof body.clients_md === "string") {
      clientsMd = body.clients_md;
    }
    return { filename: String(body.filename || "patlink.pdf"), pdf: fromBase64(body.pdf_base64), clientsMd };
  }
  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    const pdf = form.get("pdf");
    if (!(pdf instanceof File)) throw new Error('Multipart field "pdf" missing.');
    const clients = form.get("clients");
    const clientsMd = clients instanceof File ? await clients.text() : typeof clients === "string" ? clients : null;
    return { filename: pdf.name || "patlink.pdf", pdf: new Uint8Array(await pdf.arrayBuffer()), clientsMd };
  }
  return {
    filename: req.headers.get("x-filename") || "patlink.pdf",
    pdf: new Uint8Array(await req.arrayBuffer()),
    clientsMd: null,
  };
}

function melbourneNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Melbourne",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    display: `${parts.day}/${parts.month}/${parts.year} ${hour}:${parts.minute}`,
    certNo: `RXT-${parts.year}${parts.month}${parts.day}-${hour}${parts.minute}${parts.second}`,
    fileDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "Site";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const delivery = deliveryConfig();
  if (!delivery.pipelineToken) return json(500, { ok: false, error: "PIPELINE_TOKEN secret not set" });
  const token = req.headers.get("x-rxtnt-token") ?? "";
  if (!timingSafeEqual(token, delivery.pipelineToken)) return json(401, { ok: false, error: "Unauthorised" });

  let payload: Payload;
  try {
    payload = await readPayload(req);
  } catch (e) {
    return json(400, { ok: false, error: `Bad request: ${(e as Error).message}` });
  }
  if (new TextDecoder().decode(payload.pdf.subarray(0, 5)) !== "%PDF-") {
    return json(400, { ok: false, error: "Upload is not a PDF." });
  }

  const now = melbourneNow();
  try {
    const business = businessConfig();
    const lines = await extractLines(payload.pdf);
    const report = parsePatlinkText(lines);
    const client = lookupClient(payload.clientsMd, report.site);

    const { doc, fonts } = await createDocument({ reg: delivery.fontUrl, bold: delivery.fontBoldUrl });
    const reviewNotes: string[] = [...client.issues.map((i) => `Client lookup: ${i}`)];
    const missing = missingBusinessFields(business);
    if (missing.length) reviewNotes.push(`Business details not set: ${missing.join(", ")} (Supabase secrets).`);
    const bad = unsupportedChars(sourceStrings(report), fonts.reg);
    if (bad.length) {
      reviewNotes.push(
        `Characters ${bad.map((c) => `"${c}"`).join(" ")} cannot be printed by the ${fonts.unicode ? "embedded" : "fallback Helvetica"} font and are shown as [U+XXXX] codes.`,
      );
    }
    // Only unreadable characters change the result. Client or config gaps are
    // admin problems, not test data, but they are still listed.
    const summary = summarise(report, bad.length ? ["unprintable characters"] : []);

    const pdfBytes = await renderCertificate(doc, fonts, {
      report,
      summary,
      client,
      business,
      certificateNo: now.certNo,
      issuedAt: now.display,
      reviewNotes,
      sourceFilename: payload.filename,
    }, delivery.logoUrl);

    const outName = `RXTNT_Certificate_${slug(report.site ?? "Unknown-Site")}_${now.fileDate}.pdf`;
    const attention = report.items.filter((i) => displayStatus(i) !== "PASS");
    const c = client.client;
    const html = `
<div style="font-family:Arial,sans-serif;color:#1A1A1A;max-width:640px">
  <div style="background:#0B1F3A;color:#fff;padding:14px 18px;border-bottom:4px solid #C9A227">
    <strong style="font-size:18px">RX Test N Tag</strong> · certificate ready for review
  </div>
  <p><strong>Overall: ${esc(summary.overall)}</strong><br>${esc(summary.overallReason)}</p>
  <table cellpadding="4" style="border-collapse:collapse;font-size:14px">
    <tr><td>Site (PATLink)</td><td><strong>${esc(report.site ?? "NOT FOUND")}</strong></td></tr>
    <tr><td>Client</td><td>${c ? esc(`${c.company} · ${c.contact} · ${c.email}`) : "<b style='color:#C45A00'>NOT FOUND</b>"}</td></tr>
    <tr><td>Address</td><td>${esc(c?.address ?? "")}</td></tr>
    <tr><td>Items</td><td>${summary.total} (pass ${summary.pass}, fail ${summary.fail}, no result ${summary.noResult}, unverified ${summary.unverified})</td></tr>
    <tr><td>Tested</td><td>${esc(summary.firstTest ?? "")}${summary.lastTest !== summary.firstTest ? ` to ${esc(summary.lastTest ?? "")}` : ""}</td></tr>
    <tr><td>Next due (earliest)</td><td>${esc(summary.earliestNextTest ?? "—")}</td></tr>
    <tr><td>Certificate No.</td><td>${esc(now.certNo)}</td></tr>
  </table>
  ${
      [...report.issues, ...reviewNotes].length || attention.length
        ? `<h3 style="color:#8B1A1A">Check before sending</h3><ul>${
          [...report.issues, ...reviewNotes].map((n) => `<li style="color:#C45A00">${esc(n)}</li>`).join("")
        }${
          attention.map((i) =>
            `<li>${esc(displayStatus(i))}: #${i.node} ${esc(i.path.join("/"))} ${esc(i.name ?? "")}${
              i.issues.length ? ` <i>(${esc(i.issues.join(" "))})</i>` : ""
            }</li>`
          ).join("")
        }</ul>`
        : "<p>No issues detected. Still spot-check against the attached PATLink PDF.</p>"
    }
  <p style="font-size:12px;color:#5A6270">This has NOT been sent to the client. Attached: the generated certificate and the original PATLink export.</p>
</div>`;
    const subject = `[REVIEW] ${summary.overall} · ${report.site ?? "Unknown site"} · ${now.fileDate}`;
    const emailId = await sendReviewEmail(delivery, subject, html, [
      { filename: outName, bytes: pdfBytes },
      { filename: payload.filename, bytes: payload.pdf },
    ]);

    return json(200, {
      ok: true,
      emailed: delivery.reviewTo,
      emailId,
      certificate: outName,
      site: report.site,
      clientFound: client.found,
      overall: summary.overall,
      counts: { total: summary.total, pass: summary.pass, fail: summary.fail, noResult: summary.noResult, unverified: summary.unverified },
      notes: [...report.issues, ...reviewNotes],
    });
  } catch (e) {
    const err = e as Error;
    console.error(err);
    // Report the failure to the review inbox too, with the original attached.
    let failureEmailed = false;
    try {
      await sendReviewEmail(
        delivery,
        `[FAILED] PATLink certificate could not be generated · ${now.fileDate}`,
        `<p>The pipeline failed for <b>${esc(payload.filename)}</b>:</p><pre>${esc(err.stack ?? err.message)}</pre><p>The original PATLink PDF is attached. No certificate was produced.</p>`,
        [{ filename: payload.filename, bytes: payload.pdf }],
      );
      failureEmailed = true;
    } catch (mailErr) {
      console.error("Failure email also failed:", mailErr);
    }
    return json(500, { ok: false, error: err.message, failureEmailed });
  }
});
