import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SaasDb } from "../dist/db.js";
import { dataPlaneRouter, parseSlugFromHost } from "../dist/data-plane.js";

interface RunningPlane {
  url: string;
  db: SaasDb;
  upstreamHits: Array<{ url: string; method: string; body: string }>;
  upstreamPayload: { status: number; body: string; contentType: string };
  close(): Promise<void>;
}

async function startPlane(): Promise<RunningPlane> {
  const dir = mkdtempSync(join(tmpdir(), "x402-saas-dp-"));
  const db = new SaasDb(join(dir, "test.db"));

  const upstreamHits: Array<{ url: string; method: string; body: string }> = [];
  const upstreamPayload = {
    status: 200,
    body: JSON.stringify({ ok: true, value: "pong" }),
    contentType: "application/json",
  };
  const fakeFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    upstreamHits.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? String(init.body) : "",
    });
    return new Response(upstreamPayload.body, {
      status: upstreamPayload.status,
      headers: { "content-type": upstreamPayload.contentType },
    });
  }) as typeof fetch;

  const app = express();
  app.use(
    dataPlaneRouter({
      db,
      domain: "kite.test",
      enforceHostMatch: false,
      fetchImpl: fakeFetch,
      feeWallet: "0xfee0000000000000000000000000000000000000",
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    db,
    upstreamHits,
    upstreamPayload,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }),
  };
}

test("parseSlugFromHost extracts slug from <slug>.<domain>", () => {
  assert.equal(parseSlugFromHost("acme.kite.test", "kite.test", true), "acme");
  assert.equal(parseSlugFromHost("acme.kite.test:3000", "kite.test", true), "acme");
  assert.equal(parseSlugFromHost("kite.test", "kite.test", true), null);
  assert.equal(parseSlugFromHost("nested.acme.kite.test", "kite.test", true), null);
  assert.equal(parseSlugFromHost("acme.localhost", "kite.test", false), "acme");
});

test("missing X-PAYMENT returns 402 with payment requirements", async () => {
  const p = await startPlane();
  try {
    p.db.createTenant({
      walletAddress: "0x1111111111111111111111111111111111111111",
      slug: "acme",
      network: "base-sepolia",
    });
    p.db.addRoute({
      tenantId: p.db.getTenantBySlug("acme")!.id,
      method: "GET",
      path: "/forecast",
      priceUsd: "0.05",
      backendUrl: "https://upstream.example",
    });

    const res = await fetch(`${p.url}/forecast`, { headers: { "x-slug-override": "acme" } });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; accepts: Array<{ payTo: string }> };
    assert.equal(body.error, "payment_required");
    assert.equal(body.accepts[0].payTo, "0x1111111111111111111111111111111111111111");
    assert.equal(p.upstreamHits.length, 0);
  } finally {
    await p.close();
  }
});

test("valid X-PAYMENT proxies to upstream and records paid event", async () => {
  const p = await startPlane();
  try {
    const t = p.db.createTenant({
      walletAddress: "0x1111111111111111111111111111111111111111",
      slug: "acme",
      network: "base-sepolia",
    });
    p.db.addRoute({
      tenantId: t.id,
      method: "GET",
      path: "/forecast",
      priceUsd: "0.05",
      backendUrl: "https://upstream.example",
    });

    const res = await fetch(`${p.url}/forecast`, {
      headers: { "x-slug-override": "acme", "x-payment": "stub:0xpayer123" },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; value: string };
    assert.equal(json.value, "pong");
    assert.equal(p.upstreamHits.length, 1);
    assert.match(p.upstreamHits[0].url, /upstream\.example\/forecast/);

    const events = p.db.recentEvents(t.id, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "paid");
    assert.equal(events[0].payer, "0xpayer123");
    assert.equal(events[0].amountUsd, "0.05");
  } finally {
    await p.close();
  }
});

test("unknown route returns 404 + records error event", async () => {
  const p = await startPlane();
  try {
    const t = p.db.createTenant({
      walletAddress: "0x2222222222222222222222222222222222222222",
      slug: "acme2",
      network: "base-sepolia",
    });
    p.db.addRoute({
      tenantId: t.id,
      method: "GET",
      path: "/known",
      priceUsd: "0.05",
      backendUrl: "https://upstream.example",
    });

    const res = await fetch(`${p.url}/unknown`, {
      headers: { "x-slug-override": "acme2", "x-payment": "stub:0xanyone" },
    });
    assert.equal(res.status, 404);
    const events = p.db.recentEvents(t.id, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "error");
    assert.equal(events[0].reason, "route_not_found");
  } finally {
    await p.close();
  }
});

test("paused tenant is rejected with 503", async () => {
  const p = await startPlane();
  try {
    const t = p.db.createTenant({
      walletAddress: "0x3333333333333333333333333333333333333333",
      slug: "paused",
      network: "base-sepolia",
    });
    p.db.setTenantStatus(t.id, "paused");
    p.db.addRoute({
      tenantId: t.id,
      method: "GET",
      path: "/x",
      priceUsd: "0.05",
      backendUrl: "https://upstream.example",
    });

    const res = await fetch(`${p.url}/x`, {
      headers: { "x-slug-override": "paused", "x-payment": "stub:0xanyone" },
    });
    assert.equal(res.status, 503);
  } finally {
    await p.close();
  }
});

test("__x402/health and __x402/metrics endpoints work scoped to tenant", async () => {
  const p = await startPlane();
  try {
    const t = p.db.createTenant({
      walletAddress: "0x4444444444444444444444444444444444444444",
      slug: "stats",
      network: "base-sepolia",
    });
    const r = p.db.addRoute({
      tenantId: t.id,
      method: "GET",
      path: "/y",
      priceUsd: "0.01",
      backendUrl: "https://upstream.example",
    });
    p.db.recordEvent({
      tenantId: t.id,
      routeId: r.id,
      payer: "0xX",
      status: "paid",
      amountUsd: "0.01",
      txHash: "0xtx",
      facilitator: "stub",
      latencyMs: 100,
      reason: null,
    });

    const health = await fetch(`${p.url}/__x402/health`, {
      headers: { "x-slug-override": "stats" },
    });
    assert.equal(health.status, 200);

    const metricsRes = await fetch(`${p.url}/__x402/metrics`, {
      headers: { "x-slug-override": "stats" },
    });
    assert.equal(metricsRes.status, 200);
    const metrics = (await metricsRes.json()) as { paidRequests: number };
    assert.equal(metrics.paidRequests, 1);
  } finally {
    await p.close();
  }
});
