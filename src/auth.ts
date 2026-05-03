import { recoverMessageAddress, isAddress, type Hex } from "viem";

export interface SiweChallenge {
  walletAddress: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  domain: string;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 min

export function makeChallenge(walletAddress: string, domain: string): SiweChallenge {
  if (!isAddress(walletAddress)) {
    throw new Error(`invalid wallet address "${walletAddress}"`);
  }
  const issuedAt = Date.now();
  return {
    walletAddress: walletAddress.toLowerCase(),
    nonce: cryptoNonce(),
    issuedAt,
    expiresAt: issuedAt + CHALLENGE_TTL_MS,
    domain,
  };
}

export function challengeToMessage(c: SiweChallenge): string {
  return [
    `${c.domain} wants you to sign in with your Ethereum account:`,
    c.walletAddress,
    "",
    "Sign in to x402-kit SaaS — proves you control the wallet that will receive USDC payouts.",
    "",
    `Nonce: ${c.nonce}`,
    `Issued At: ${new Date(c.issuedAt).toISOString()}`,
    `Expires At: ${new Date(c.expiresAt).toISOString()}`,
  ].join("\n");
}

export async function verifyChallengeSignature(
  challenge: SiweChallenge,
  signature: Hex,
): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  if (Date.now() > challenge.expiresAt) {
    return { ok: false, reason: "challenge expired" };
  }
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: challengeToMessage(challenge),
      signature,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `signature recovery failed: ${msg}` };
  }
  if (recovered.toLowerCase() !== challenge.walletAddress.toLowerCase()) {
    return {
      ok: false,
      reason: `recovered address ${recovered.toLowerCase()} does not match challenge ${challenge.walletAddress}`,
    };
  }
  return { ok: true, address: recovered.toLowerCase() };
}

function cryptoNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
