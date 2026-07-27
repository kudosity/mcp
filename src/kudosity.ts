/**
 * Client for the Kudosity messaging API.
 *
 * Two API versions with different auth:
 *   v2 — `x-api-key` header, JSON       → api.transmitmessage.com (send, webhooks)
 *   v1 — HTTP Basic key:secret, form    → api.transmitsms.com     (lists, balance)
 *
 * v1 tools require KUDOSITY_API_SECRET in addition to KUDOSITY_API_KEY.
 */
const V2_BASE = "https://api.transmitmessage.com";
const V1_BASE = "https://api.transmitsms.com";

export class KudosityClient {
  private readonly apiKey: string;
  private readonly apiSecret: string | undefined;
  private readonly v2Base: string;
  private readonly v1Base: string;

  constructor(
    apiKey: string,
    apiSecret?: string,
    v2Base: string = process.env.KUDOSITY_API_BASE_URL || V2_BASE,
    v1Base: string = process.env.KUDOSITY_V1_BASE_URL || V1_BASE,
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.v2Base = v2Base.replace(/\/$/, "");
    this.v1Base = v1Base.replace(/\/$/, "");
  }

  private async parse(res: Response): Promise<unknown> {
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* leave as raw text */
    }
    if (!res.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(`Kudosity API error ${res.status}: ${detail}`);
    }
    return data;
  }

  /** v2 request — x-api-key + JSON body. */
  async v2(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.v2Base}${path}`, {
      method,
      headers: { "x-api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parse(res);
  }

  /** v1 request — HTTP Basic (key:secret) + form-urlencoded body. */
  async v1(method: string, path: string, form?: Record<string, string>): Promise<unknown> {
    if (!this.apiSecret) {
      throw new Error(
        "This tool requires KUDOSITY_API_SECRET (v1 Basic auth) in addition to KUDOSITY_API_KEY. " +
          "Find the API secret in the Kudosity platform under Settings → API Settings.",
      );
    }
    const basic = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64");
    const res = await fetch(`${this.v1Base}${path}`, {
      method,
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/json",
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    return this.parse(res);
  }
}
