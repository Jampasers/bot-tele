/** sizeSlug → Set of regionSlugs that support that size on a specific DO account. */
export type AvailabilityMap = Map<string, Set<string>>;
/** Sanitized UI contracts. Tokens and decrypted passwords never occur in order/list DTOs. */
export type VpsServiceType = "purchase" | "install";
export interface VpsUiPlan {
  id: string;
  name: string;
  serviceType: VpsServiceType;
  sizeSlug: string;
  regions: string[];
  osPrices: { os: string; label: string; price: number | null; family?: "linux" | "windows" }[];
  priceMatrix?: { region: string; os: string; price: number }[];
  catalogManaged?: boolean;
  sizeLabel?: string;
  regionLabels?: Record<string, string>;
  providerPrice?: string;
  transfer?: string;
  enabled: boolean;
}
export interface VpsUiOrder {
  _id: string;
  serviceType: VpsServiceType;
  sourceMode?: "digitalocean" | "direct";
  paymentStatus: string;
  paymentMethod?: "balance" | "qris" | null;
  stage: string;
  price: number;
  planName: string;
  sizeSlug: string;
  os: string;
  region: string;
  installChrome?: boolean;
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
  listOs(): { id: string; label: string; family?: "linux" | "windows" }[];
  listCatalog?(): Promise<{ regions: { slug: string; name: string; country: string }[]; sizes: { slug: string; label: string }[]; os: { id: string; label: string; family: "linux" | "windows" }[] }>;
  addCatalogEntry?(actor: string, input: { kind: "region" | "size" | "os"; value: string[] }): Promise<void>;
  listPlans(serviceType?: VpsServiceType, includeDisabled?: boolean): Promise<VpsUiPlan[]>;
  acceptBuyerToken(actor: string, orderId: string, token: string): Promise<{ accountId: string }>;
  clearBuyerToken(actor: string, orderId: string): void;
  /**
   * Fetch and cache which regions support each size slug on the buyer's DO account.
   * Returns null if token is not available or the DO API call fails.
   * Results are cached in the token vault for the session duration.
   */
  fetchBuyerAvailability?(actor: string, sessionId: string): Promise<AvailabilityMap | null>;
  /**
   * Fetch which regions support each size slug on the platform's active DO credential.
   * Returns null if no active credential is configured or the DO API call fails.
   */
  fetchPlatformAvailability?(): Promise<AvailabilityMap | null>;
  checkout(input: { actorTelegramId: string; chatId: string; requestId: string; serviceType: VpsServiceType; planId: string; os: string; region: string; installChrome?: boolean; buyerSessionId?: string; direct?: { ip: string; username: string; password: string } }): Promise<VpsUiOrder>;
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
  updatePlan(actor: string, id: string, input: { enabled?: boolean; price?: number; os?: string; region?: string }): Promise<void>;
}

