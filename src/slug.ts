import { randomBytes } from "node:crypto";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED = new Set([
  "www",
  "api",
  "admin",
  "kite",
  "x402",
  "x402kit",
  "facilitator",
  "dashboard",
  "docs",
  "blog",
  "status",
  "login",
  "signup",
  "auth",
  "settings",
  "support",
]);

export function deriveSlug(walletAddress: string): string {
  const lower = walletAddress.toLowerCase().replace(/^0x/, "");
  const prefix = lower.slice(0, 8);
  const nonce = randomBytes(2).toString("hex");
  return `t-${prefix}-${nonce}`;
}

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug "${slug}" — 3-30 chars, [a-z0-9-], must start with letter/digit`,
    );
  }
  if (RESERVED.has(slug)) {
    throw new Error(`slug "${slug}" is reserved`);
  }
}
