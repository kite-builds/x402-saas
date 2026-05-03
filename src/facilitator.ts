/**
 * Coinbase x402 facilitator client + payment-payload decoder.
 * Lifted (and lightly adapted) from x402-kit/packages/server.
 *
 * Two facilitator implementations:
 *   - HttpFacilitator: real client that talks to https://facilitator.x402.org
 *     (or any compatible endpoint) for /verify and /settle.
 *   - StubFacilitator: dev/test mode. Accepts "stub:<addr>" headers without
 *     touching the chain. Lets us run the data-plane tests offline.
 */

const X402_VERSION = 1;
const USDC_DECIMALS = 6;

/** Networks we currently support. */
export type Network =
  | "base"
  | "base-sepolia"
  | "polygon"
  | "arbitrum"
  | "optimism";

export const USDC_ADDRESSES: Record<Network, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};

export interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmAuthorization;
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: Network;
  payload: ExactEvmPayload;
}

export interface PaymentRequirements {
  scheme: "exact";
  network: Network;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: { name: string; version: string };
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network?: string;
}

export interface FacilitatorClient {
  /**
   * Verify a payment from a base64-encoded X-PAYMENT header.
   * Returns the recovered payer + tx hash on success, or a reason on failure.
   */
  verify(args: {
    paymentHeader: string;
    payTo: string;
    amountUsd: string;
    network: string;
  }): Promise<
    | { ok: true; payer: string; txHash: string | null; payload?: PaymentPayload; requirements?: PaymentRequirements }
    | { ok: false; reason: string }
  >;
  /**
   * Settle a previously-verified payment (called async after the upstream response).
   * Implementations may be no-ops in tests.
   */
  settle?(args: {
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  }): Promise<SettleResponse>;
}

/**
 * Convert a USD decimal string ("0.10") into atomic USDC units ("100000").
 */
export function priceToAtomic(usdPrice: string): string {
  const [whole, frac = ""] = usdPrice.split(".");
  const padded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const combined = (whole + padded).replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/**
 * Decode a base64-encoded x402 PaymentPayload header.
 * Returns null if the header is missing fields or fails JSON parsing.
 */
export function decodePayload(headerValue: string): PaymentPayload | null {
  try {
    const json = Buffer.from(headerValue, "base64").toString("utf8");
    const parsed = JSON.parse(json) as PaymentPayload;
    if (
      parsed.x402Version !== X402_VERSION ||
      parsed.scheme !== "exact" ||
      typeof parsed.network !== "string" ||
      !parsed.payload?.signature ||
      !parsed.payload?.authorization
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function matchAuthorization(
  auth: ExactEvmAuthorization,
  requirements: PaymentRequirements,
): { ok: true } | { ok: false; reason: string } {
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { ok: false, reason: "authorization.to does not match payTo" };
  }
  if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
    return { ok: false, reason: "authorization.value below maxAmountRequired" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validBefore) <= now) {
    return { ok: false, reason: "authorization expired" };
  }
  if (Number(auth.validAfter) > now) {
    return { ok: false, reason: "authorization not yet valid" };
  }
  return { ok: true };
}

export function buildRequirements(args: {
  payTo: string;
  network: Network;
  amountUsd: string;
  resource: string;
  description?: string;
  asset?: string;
}): PaymentRequirements {
  return {
    scheme: "exact",
    network: args.network,
    maxAmountRequired: priceToAtomic(args.amountUsd),
    resource: args.resource,
    description: args.description ?? `Access to ${args.resource}`,
    mimeType: "application/json",
    payTo: args.payTo,
    maxTimeoutSeconds: 60,
    asset: args.asset ?? USDC_ADDRESSES[args.network],
    extra: { name: "USD Coin", version: "2" },
  };
}

/**
 * Stub facilitator for development + tests. Accepts "stub:<address>" tokens.
 */
export const STUB_FACILITATOR: FacilitatorClient = {
  async verify({ paymentHeader }) {
    if (!paymentHeader) return { ok: false, reason: "missing X-PAYMENT" };
    if (paymentHeader.startsWith("stub:")) {
      const payer = paymentHeader.slice("stub:".length) || "0xstubpayer";
      return { ok: true, payer, txHash: null };
    }
    return { ok: false, reason: "unknown payment scheme (stub facilitator)" };
  },
};

/**
 * HTTP facilitator client. Talks to a Coinbase-compatible /verify and /settle.
 */
export class HttpFacilitator implements FacilitatorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(args: {
    paymentHeader: string;
    payTo: string;
    amountUsd: string;
    network: string;
  }) {
    const payload = decodePayload(args.paymentHeader);
    if (!payload) {
      return { ok: false as const, reason: "malformed X-PAYMENT header" };
    }
    if (payload.network !== args.network) {
      return {
        ok: false as const,
        reason: `network mismatch: requested ${args.network}, payload was ${payload.network}`,
      };
    }
    const requirements = buildRequirements({
      payTo: args.payTo,
      network: args.network as Network,
      amountUsd: args.amountUsd,
      resource: "https://x402-saas.local/route",
    });
    const local = matchAuthorization(payload.payload.authorization, requirements);
    if (!local.ok) {
      return { ok: false as const, reason: local.reason };
    }

    let res: globalThis.Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: X402_VERSION,
          paymentPayload: payload,
          paymentRequirements: requirements,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, reason: `facilitator unreachable: ${msg}` };
    }

    if (!res.ok) {
      return { ok: false as const, reason: `facilitator /verify HTTP ${res.status}` };
    }

    const json = (await res.json()) as VerifyResponse;
    if (!json.isValid) {
      return { ok: false as const, reason: json.invalidReason ?? "facilitator rejected" };
    }
    return {
      ok: true as const,
      payer: json.payer ?? payload.payload.authorization.from,
      txHash: null,
      payload,
      requirements,
    };
  }

  async settle(args: { payload: PaymentPayload; requirements: PaymentRequirements }) {
    let res: globalThis.Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: X402_VERSION,
          paymentPayload: args.payload,
          paymentRequirements: args.requirements,
        }),
      });
    } catch (err) {
      return {
        success: false,
        errorReason: `facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!res.ok) {
      return { success: false, errorReason: `facilitator /settle HTTP ${res.status}` };
    }
    return (await res.json()) as SettleResponse;
  }
}

/**
 * Default Coinbase-hosted facilitator URL.
 */
export const DEFAULT_FACILITATOR_URL = "https://facilitator.x402.org";
