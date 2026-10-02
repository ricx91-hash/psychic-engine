// Business, technician and delivery settings, read from Supabase secrets
// (supabase secrets set KEY=value). Anything blank shows as "NOT SET" on the
// certificate and is listed in the review email.

export interface BusinessConfig {
  businessName: string;
  tagline: string;
  technician: string;
  abn: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  standard: string;
}

export interface DeliveryConfig {
  resendApiKey: string;
  from: string;
  reviewTo: string;
  pipelineToken: string;
  logoUrl: string;
  fontUrl: string;
  fontBoldUrl: string;
}

const env = (k: string, fallback = "") => (Deno.env.get(k) ?? fallback).trim();

export function businessConfig(): BusinessConfig {
  return {
    businessName: env("BUSINESS_NAME", "RX Test N Tag"),
    tagline: env("BUSINESS_TAGLINE", "Tested. Tagged. Trusted."),
    technician: env("TECH_NAME"),
    abn: env("BUSINESS_ABN"),
    phone: env("BUSINESS_PHONE"),
    email: env("BUSINESS_EMAIL", "info@rxtnt.com.au"),
    website: env("BUSINESS_WEBSITE"),
    address: env("BUSINESS_ADDRESS", "Narre Warren VIC"),
    standard: env("TEST_STANDARD", "AS/NZS 3760"),
  };
}

export function deliveryConfig(): DeliveryConfig {
  return {
    resendApiKey: env("RESEND_API_KEY"),
    // Without a verified domain Resend only sends from onboarding@resend.dev,
    // and only to the address that owns the Resend account.
    from: env("RESEND_FROM", "RX Test N Tag <onboarding@resend.dev>"),
    reviewTo: env("REVIEW_TO", "info@rxtnt.com.au"),
    pipelineToken: env("PIPELINE_TOKEN"),
    logoUrl: env("LOGO_URL"),
    // Unicode font so unit symbols like Ω, µ, Δ print exactly as in the source.
    fontUrl: env(
      "FONT_URL",
      "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf",
    ),
    fontBoldUrl: env(
      "FONT_BOLD_URL",
      "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf",
    ),
  };
}

export function missingBusinessFields(c: BusinessConfig): string[] {
  const missing: string[] = [];
  if (!c.technician) missing.push("TECH_NAME");
  if (!c.abn) missing.push("BUSINESS_ABN");
  if (!c.phone) missing.push("BUSINESS_PHONE");
  return missing;
}
