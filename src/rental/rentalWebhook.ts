import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { checkRentalPayment } from "./rentalPayment.service.js";

/** Signature for an optional trusted relay, not an assumed native GoPay webhook. */
export function verifyRentalWebhook(body: Buffer, timestamp: string, signature: string, secret: string, now = Date.now()): boolean {
  if (secret.length < 32 || !/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const time = Number(timestamp) * (timestamp.length === 10 ? 1000 : 1);
  if (Math.abs(now - time) > 5 * 60_000) return false;
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function createRentalWebhookServer(secret: string): Server {
  if (secret.length < 32) throw new Error("RENTAL_WEBHOOK_SECRET must be at least 32 characters.");
  let active = 0;
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST" || req.url !== "/webhooks/rental-payment") { res.writeHead(404).end('{"error":"not_found"}'); return; }
    if (active >= 8) { res.writeHead(429).end('{"error":"busy"}'); return; }
    active++;
    req.setTimeout(10_000, () => req.destroy());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        const chunk = Buffer.from(part);
        size += chunk.length;
        if (size > 4096) { res.writeHead(413).end('{"error":"too_large"}'); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const stamp = req.headers["x-rental-timestamp"];
      const signature = req.headers["x-rental-signature"];
      if (typeof stamp !== "string" || typeof signature !== "string" || !verifyRentalWebhook(body, stamp, signature, secret)) {
        res.writeHead(401).end('{"error":"unauthorized"}'); return;
      }
      let input: unknown;
      try { input = JSON.parse(body.toString("utf8")); } catch { res.writeHead(400).end('{"error":"invalid_body"}'); return; }
      const reference = input && typeof input === "object" && "providerReference" in input ? input.providerReference : undefined;
      if (typeof reference !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(reference)) { res.writeHead(400).end('{"error":"invalid_reference"}'); return; }
      // Payload tenant/status/amount is never authoritative. The stored invoice
      // chooses its rental and a fresh platform merchant query proves payment.
      const result = await runWithTenant(platformContext(), () => checkRentalPayment(reference));
      res.writeHead(200).end(JSON.stringify({ status: result.status }));
    } catch { res.writeHead(503).end('{"error":"retry_later"}'); }
    finally { active--; }
  });
}
