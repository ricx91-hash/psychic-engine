// Delivery to the review inbox via Resend (https://resend.com/docs/api-reference/emails/send-email).
// This only ever sends to REVIEW_TO (info@rxtnt.com.au). It never sends to the client.

import type { DeliveryConfig } from "./config.ts";

export interface Attachment {
  filename: string;
  bytes: Uint8Array;
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function sendReviewEmail(
  cfg: DeliveryConfig,
  subject: string,
  html: string,
  attachments: Attachment[],
): Promise<string> {
  if (!cfg.resendApiKey) throw new Error("RESEND_API_KEY is not set.");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.from,
      to: [cfg.reviewTo],
      subject,
      html,
      attachments: attachments.map((a) => ({ filename: a.filename, content: b64(a.bytes) })),
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${body}`);
  return (JSON.parse(body) as { id?: string }).id ?? "";
}
