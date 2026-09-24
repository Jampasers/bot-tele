import type { InboundEmail, OtpServiceMatchers, ParsedOtpEmail } from "../contracts.js";

function matches(value: string, patterns: string[]): boolean {
  if (!patterns.length) return true;
  return patterns.some((pattern) => {
    if (!pattern || pattern.length > 200) return false;
    try { return new RegExp(pattern, "i").test(value); }
    catch { return value.toLowerCase().includes(pattern.toLowerCase()); }
  });
}

export function matchesOtpService(message: Pick<InboundEmail, "sender" | "subject">, service: OtpServiceMatchers): boolean {
  if (!service.senderPatterns.length && !service.subjectPatterns.length) return false;
  return matches(message.sender, service.senderPatterns) && matches(message.subject, service.subjectPatterns);
}

function plainText(message: InboundEmail): string {
  const html = message.html ?? "";
  const anchorText = html.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 $1 ");
  const withoutTags = anchorText.replace(/<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  return (message.subject + "\n" + message.text + "\n" + withoutTags).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 20_000);
}

function findCode(content: string, patterns: string[] = []): string | undefined {
  for (const pattern of patterns) {
    if (!pattern || pattern.length > 200) continue;
    try {
      const match = new RegExp(pattern, "i").exec(content);
      if (match) return (match[1] ?? match[0]).trim().replace(/\s+/g, " ").slice(0, 24);
    } catch { /* Ignore invalid admin patterns and use the generic matcher. */ }
  }
  const context = /(?:one[\s-]?time|verification|security|authentication|login|log in|otp|passcode|pin|verify|code)\b/ig;
  const candidates: Array<{ value: string; distance: number; index: number }> = [];
  for (const match of content.matchAll(context)) {
    const start = Math.max(0, (match.index ?? 0) - 12);
    const end = Math.min(content.length, (match.index ?? 0) + match[0].length + 110);
    const windowText = content.slice(start, end);
    const matcher = /\b[A-Z0-9]{2,8}(?:[ -][A-Z0-9]{2,8})?\b/ig;
    for (const candidate of windowText.matchAll(matcher)) {
      const value = candidate[0].trim();
      const compact = value.replace(/[ -]/g, "");
      if (compact.length < 4 || compact.length > 8 || !/\d/.test(compact)) continue;
      if (/^(?:19|20)\d{2}$/.test(compact)) continue;
      const candidateIndex = start + (candidate.index ?? 0);
      const nearby = content.slice(Math.max(0, candidateIndex - 28), Math.min(content.length, candidateIndex + value.length + 28));
      if (/(?:[$€£¥]|(?:usd|eur|idr|price|amount|order|transaction|invoice|year|expires?\s+in)\s*[:#]?\s*)/i.test(nearby)) continue;
      candidates.push({ value: value.replace(/[ -]/g, ""), distance: Math.abs(candidateIndex - (match.index ?? 0)), index: candidateIndex });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return candidates[0]?.value;
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/[),.;]+$/g, ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString().slice(0, 2048);
  } catch { return undefined; }
}

function findLink(message: InboundEmail, kind: "magic" | "verification"): string | undefined {
  const terms = kind === "magic" ? /magic\s+link|sign[\s-]?in|log[\s-]?in/i : /verif|verify|confirm|activate|authenticate/i;
  const html = message.html ?? "";
  for (const anchor of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const candidate = safeUrl(anchor[1] ?? "");
    const label = (anchor[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (candidate && (terms.test(label) || terms.test(candidate))) return candidate;
  }
  // Bare text URLs use a smaller context window; adjacent HTML anchors are
  // handled separately above so one link cannot inherit another link's label.
  for (const source of [message.text, html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ")]) {
    const links = Array.from(source.matchAll(/https?:\/\/[^\s"'<>]+/gi));
    for (const link of links) {
      const candidate = safeUrl(link[0]);
      if (!candidate) continue;
      const vicinity = source.slice(Math.max(0, (link.index ?? 0) - 48), Math.min(source.length, (link.index ?? 0) + link[0].length + 40));
      if (terms.test(vicinity) || terms.test(candidate)) return candidate;
    }
  }
  return undefined;
}

export function parseOtpEmail(message: InboundEmail, service: OtpServiceMatchers): ParsedOtpEmail {
  const content = plainText(message);
  const otpCode = findCode(content, service.otpPatterns);
  const verificationLink = service.allowVerificationLink ? findLink(message, "verification") : undefined;
  const magicLink = service.allowMagicLink ? findLink(message, "magic") : undefined;
  return {
    ...(otpCode ? { otpCode } : {}), ...(verificationLink ? { verificationLink } : {}), ...(magicLink ? { magicLink } : {}),
    subject: message.subject.slice(0, 500), sender: message.sender.slice(0, 320), receivedAt: message.receivedAt, preview: content.slice(0, 240),
  };
}
