/** Sanitized UI contracts. Tokens and decrypted passwords never occur in order/list DTOs. */
export type VpsServiceType = "purchase" | "install";
export interface VpsUiPlan {
  id: string;
  name: string;
  serviceType: VpsServiceType;
  sizeSlug: string;
  regions: string[];
  osPrices: { os: string; label: string; price: number }[];
  enabled: boolean;
}
export interface VpsUiOrder {
  _id: string;
  serviceType: VpsServiceType;
  paymentStatus: string;
  paymentMethod?: "balance" | "qris" | null;
  stage: string;
  price: number;
  planName: string;
  sizeSlug: string;
  os: string;
  region: string;
  vcpus?: number;
  memory?: number;
  disk?: number;
  installerLogUrl?: string | null;
  ip?: string | null;
  dropletId?: number | null;
  needsToken?: boolean;
  evidence?: string;
  createdAt?: Date | string;
}
export type VpsCredentialFilter = "all" | "active" | "warning" | "locked" | "available" | "problem";
export interface VpsUiCredential {
  id: string;
  label: string;
  priority: number;
  enabled: boolean;
  accountId?: string | null;
  accountStatus?: string | null;
  statusMessage?: string | null;
  tokenStatus?: string | null;
  dropletLimit?: number | null;
  used?: number | null;
  reserved?: number | null;
  available?: number | null;
  checkedAt?: Date | string | null;
  lastCreateResult?: string | null;
  lastCreateAt?: Date | string | null;
}
export interface VpsUiDependencies {
  enabled(): boolean;
  listOs(): { id: string; label: string }[];
  listPlans(serviceType?: VpsServiceType, includeDisabled?: boolean): Promise<VpsUiPlan[]>;
  acceptBuyerToken(actor: string, orderId: string, token: string): Promise<{ accountId: string }>;
  clearBuyerToken(actor: string, orderId: string): void;
  checkout(input: { actorTelegramId: string; chatId: string; requestId: string; serviceType: VpsServiceType; planId: string; os: string; region: string; buyerSessionId?: string }): Promise<VpsUiOrder>;
  listOwned(actor: string, options: { purchaseOnly: boolean; offset: number; limit: number }): Promise<VpsUiOrder[]>;
  getOwned(actor: string, orderId: string): Promise<VpsUiOrder | null>;
  credentials(actor: string, orderId: string): Promise<{ ip: string; username: string; password: string; evidence: string }>;
  payBalance(actor: string, orderId: string): Promise<{ status: string; message?: string; methodLocked?: boolean }>;
  createInvoice(actor: string, orderId: string): Promise<{ buffer: Buffer; amount: number; expiresAt: Date | string }>;
  checkPayment(actor: string, orderId: string): Promise<{ status: string }>;
  cancel(actor: string, orderId: string): Promise<void>;
  reboot(actor: string, orderId: string): Promise<{ status: string }>;
  listCredentials(actor: string, filter: VpsCredentialFilter, offset: number, limit: number): Promise<VpsUiCredential[]>;
  getCredential(actor: string, id: string): Promise<VpsUiCredential | null>;
  addCredential(actor: string, input: { label: string; token: string; priority: number }): Promise<VpsUiCredential>;
  checkCredential(actor: string, id: string): Promise<VpsUiCredential>;
  checkAllCredentials(actor: string): Promise<void>;
  updateCredential(actor: string, id: string, input: { enabled?: boolean; priority?: number }): Promise<void>;
  savePlan(actor: string, input: Omit<VpsUiPlan, "id">): Promise<VpsUiPlan>;
  updatePlan(actor: string, id: string, input: { enabled?: boolean; price?: number; os?: string }): Promise<void>;
}
