import { CloudflareService } from "../../services/cloudflare.js";
import type { EmailDomainProvider } from "../contracts.js";

export class CloudflareEmailDomainProvider implements EmailDomainProvider {
  async createAlias(input: { zoneId: string; domain: string; localPart: string; destinationEmail: string }): Promise<{ address: string; ruleId: string }> {
    const result = await CloudflareService.createEmailRule({
      zoneId: input.zoneId, domain: input.domain, prefix: input.localPart, destinationEmail: input.destinationEmail,
      name: "OTP rental alias " + input.localPart,
    });
    if (!result.success || !result.email || !result.ruleId) throw new Error("Cloudflare gagal membuat rule Email Routing.");
    return { address: result.email.toLowerCase(), ruleId: result.ruleId };
  }
  async deleteAlias(input: { zoneId: string; ruleId: string }): Promise<void> {
    const result = await CloudflareService.deleteEmailRule(input.zoneId, input.ruleId);
    if (!result.success) throw new Error("Cloudflare gagal menghapus rule Email Routing.");
  }
}
export const cloudflareEmailDomainProvider = new CloudflareEmailDomainProvider();
