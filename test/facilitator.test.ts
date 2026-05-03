import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodePayload,
  priceToAtomic,
  matchAuthorization,
  buildRequirements,
  HttpFacilitator,
  STUB_FACILITATOR,
} from "../dist/facilitator.js";

const PAY_TO = "0xC504Fd656330A823C3ffcBAB048c05cF45F60Bdf";

function basePayload(overrides: Partial<{
  network: string;
  to: string;
  value: string;
  validBefore: string;
  validAfter: string;
}> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: 1,
    scheme: "exact",
    network: overrides.network ?? "base-sepolia",
    payload: {
      signature: "0xdeadbeef",
      authorization: {
        from: "0xpayer1111111111111111111111111111111111",
        to: overrides.to ?? PAY_TO,
        value: overrides.value ?? "100000",
        validAfter: overrides.validAfter ?? String(now - 60),
        validBefore: overrides.validBefore ?? String(now + 60),
        nonce: "0x00",
      },
    },
  };
}

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

test("priceToAtomic converts decimal USD to USDC atomic units", () => {
  assert.equal(priceToAtomic("0.05"), "50000");
  assert.equal(priceToAtomic("0.10"), "100000");
  assert.equal(priceToAtomic("1.00"), "1000000");
  assert.equal(priceToAtomic("0.000001"), "1");
  assert.equal(priceToAtomic("0"), "0");
});

test("decodePayload accepts a valid base64-encoded PaymentPayload", () => {
  const p = decodePayload(encode(basePayload()));
  assert.ok(p);
  assert.equal(p?.scheme, "exact");
  assert.equal(p?.x402Version, 1);
});

test("decodePayload rejects malformed input", () => {
  assert.equal(decodePayload(""), null);
  assert.equal(decodePayload("not-base64-=="), null);
  assert.equal(
    decodePayload(Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64")),
    null,
  );
});

test("matchAuthorization checks payTo, amount, and validity window", () => {
  const reqs = buildRequirements({
    payTo: PAY_TO,
    network: "base-sepolia",
    amountUsd: "0.05",
    resource: "https://x.example/y",
  });

  const auth = basePayload().payload.authorization;
  assert.deepEqual(matchAuthorization(auth, reqs), { ok: true });

  const wrongTo = matchAuthorization({ ...auth, to: "0xbad" }, reqs);
  assert.equal(wrongTo.ok, false);
  if (!wrongTo.ok) assert.match(wrongTo.reason, /authorization.to/);

  const tooLow = matchAuthorization({ ...auth, value: "1" }, reqs);
  assert.equal(tooLow.ok, false);
  if (!tooLow.ok) assert.match(tooLow.reason, /below maxAmountRequired/);

  const expired = matchAuthorization({ ...auth, validBefore: "1" }, reqs);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.reason, /expired/);
});

test("StubFacilitator accepts stub:<addr> and rejects everything else", async () => {
  const a = await STUB_FACILITATOR.verify({
    paymentHeader: "stub:0xabc",
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(a.ok, true);
  if (a.ok) assert.equal(a.payer, "0xabc");

  const b = await STUB_FACILITATOR.verify({
    paymentHeader: "garbage",
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(b.ok, false);

  const c = await STUB_FACILITATOR.verify({
    paymentHeader: "",
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(c.ok, false);
});

test("HttpFacilitator forwards verify to /verify with the payload + requirements", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ isValid: true, payer: "0xrecovered" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const f = new HttpFacilitator("https://facilitator.example", fakeFetch);
  const result = await f.verify({
    paymentHeader: encode(basePayload()),
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payer, "0xrecovered");
    assert.ok(result.payload);
    assert.ok(result.requirements);
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/verify$/);
  const sentBody = JSON.parse(calls[0].body);
  assert.equal(sentBody.x402Version, 1);
  assert.equal(sentBody.paymentRequirements.payTo, PAY_TO);
  assert.equal(sentBody.paymentRequirements.maxAmountRequired, "50000");
});

test("HttpFacilitator returns reason when /verify says invalid", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ isValid: false, invalidReason: "OFAC blocked" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const f = new HttpFacilitator("https://facilitator.example", fakeFetch);
  const r = await f.verify({
    paymentHeader: encode(basePayload()),
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /OFAC/);
});

test("HttpFacilitator handles /verify HTTP 5xx", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response("upstream down", { status: 502 })) as typeof fetch;
  const f = new HttpFacilitator("https://facilitator.example", fakeFetch);
  const r = await f.verify({
    paymentHeader: encode(basePayload()),
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /HTTP 502/);
});

test("HttpFacilitator handles fetch throw", async () => {
  const fakeFetch: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const f = new HttpFacilitator("https://facilitator.example", fakeFetch);
  const r = await f.verify({
    paymentHeader: encode(basePayload()),
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unreachable/);
});

test("HttpFacilitator does local-first checks before hitting facilitator", async () => {
  const calls: number[] = [];
  const fakeFetch: typeof fetch = (async () => {
    calls.push(Date.now());
    return new Response(JSON.stringify({ isValid: true, payer: "0xpayer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const f = new HttpFacilitator("https://facilitator.example", fakeFetch);

  // Wrong network → never hit facilitator
  const r = await f.verify({
    paymentHeader: encode(basePayload({ network: "polygon" })),
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /network mismatch/);
  assert.equal(calls.length, 0);

  // Below required amount → never hit facilitator
  const r2 = await f.verify({
    paymentHeader: encode(basePayload({ value: "1" })),
    payTo: PAY_TO,
    amountUsd: "0.05",
    network: "base-sepolia",
  });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.reason, /below maxAmountRequired/);
  assert.equal(calls.length, 0);
});

test("HttpFacilitator settle posts to /settle and returns transaction hash", async () => {
  const calls: Array<{ url: string }> = [];
  const fakeFetch: typeof fetch = (async (input: unknown) => {
    calls.push({ url: String(input) });
    return new Response(JSON.stringify({ success: true, transaction: "0xdeadbeef" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const f = new HttpFacilitator("https://facilitator.example", fakeFetch);
  const reqs = buildRequirements({
    payTo: PAY_TO,
    network: "base-sepolia",
    amountUsd: "0.05",
    resource: "https://x.example/y",
  });
  const r = await f.settle({ payload: basePayload() as never, requirements: reqs });
  assert.equal(r.success, true);
  assert.equal(r.transaction, "0xdeadbeef");
  assert.match(calls[0].url, /\/settle$/);
});
