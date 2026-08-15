const DEFAULT_GOBIZ_TOKEN_ENDPOINT = "https://api.gobiz.co.id/goid/token";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GobizAuthServiceOptions {
  email: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  password: string;
  timeoutMs?: number;
  uniqueId?: string;
}

export class GobizAuthService {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly uniqueId: string;
  private cachedAccessToken: string | null = null;

  public constructor(private readonly options: GobizAuthServiceOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_GOBIZ_TOKEN_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uniqueId = options.uniqueId ?? "248da1f2-55b6-46d7-be48-eb5861c447f3";
  }

  public async getAccessToken(): Promise<string> {
    if (this.cachedAccessToken) {
      return this.cachedAccessToken;
    }

    this.cachedAccessToken = await this.login();
    return this.cachedAccessToken;
  }

  public async refreshAccessToken(): Promise<string> {
    this.cachedAccessToken = await this.login();
    return this.cachedAccessToken;
  }

  private async login(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        body: JSON.stringify({
          client_id: "go-biz-web-new",
          data: {
            email: this.options.email.trim(),
            password: this.options.password,
          },
          grant_type: "password",
        }),
        headers: {
          Accept: "application/json",
          "Authentication-Type": "go-id",
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
          "X-AppVersion": "platform-v3.108.0-c57184d1",
          "X-PhoneMake": "Windows 10 64-bit",
          "X-PhoneModel": "Chrome 149.0.0.0 on Windows 10 64-bit",
          "X-Platform": "Web",
          "X-User-Locale": "en-GB",
          "X-User-Type": "merchant",
          "x-DeviceOS": "Web",
          "x-appId": "go-biz-web-dashboard",
          "x-uniqueid": this.uniqueId,
        },
        method: "POST",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`GoBiz login failed with status ${response.status}`);
      }

      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body["access_token"] !== "string") {
        throw new Error("GoBiz login response did not include an access token.");
      }

      const accessToken = body["access_token"].trim();
      if (!accessToken) {
        throw new Error("GoBiz login response did not include an access token.");
      }

      return accessToken;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("GoBiz login request timed out");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
