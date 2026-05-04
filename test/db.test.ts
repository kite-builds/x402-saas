import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaasDb } from "../dist/db.js";

function freshDb(): { db: SaasDb; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "x402-saas-db-"));
  const db = new SaasDb(join(dir, "test.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("createTenant inserts and reads back by id, slug, wallet", () => {
  const { db, cleanup } = freshDb();
  try {
    const t = db.createTenant({
      walletAddress: "0xC504Fd656330A823C3ffcBAB048c05cF45F60Bdf",
      slug: "acme-test",
      network: "base-sepolia",
    });
    assert.equal(t.slug, "acme-test");
    assert.equal(t.walletAddress, "0xc504fd656330a823c3ffcbab048c05cf45f60bdf");
    assert.equal(t.feeBps, 100);
    assert.equal(t.status, "active");

    assert.deepEqual(db.getTenantById(t.id), t);
    assert.deepEqual(db.getTenantBySlug("acme-test"), t);
    assert.deepEqual(db.getTenantByWallet("0xc504fd656330a823c3ffcbab048c05cf45f60bdf"), t);
  } finally {
    cleanup();
  }
});

test("createTenant rejects duplicate slug or wallet", () => {
  const { db, cleanup } = freshDb();
  try {
    db.createTenant({
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      slug: "first",
      network: "base",
    });
    assert.throws(
      () =>
        db.createTenant({
          walletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          slug: "first",
          network: "base",
        }),
      /UNIQUE/i,
    );
    assert.throws(
      () =>
        db.createTenant({
          walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          slug: "second",
          network: "base",
        }),
      /UNIQUE/i,
    );
  } finally {
    cleanup();
  }
});

test("addRoute / routesForTenant / routeForRequest", () => {
  const { db, cleanup } = freshDb();
  try {
    const t = db.createTenant({
      walletAddress: "0x1111111111111111111111111111111111111111",
      slug: "routes-test",
      network: "base",
    });
    db.addRoute({
      tenantId: t.id,
      method: "GET",
      path: "/forecast",
      priceUsd: "0.05",
      backendUrl: "https://upstream.example",
    });
    db.addRoute({
      tenantId: t.id,
      method: "POST",
      path: "/v1/chat/completions",
      priceUsd: "0.10",
      description: "LLM proxy",
      backendUrl: "https://api.openai.com",
    });

    assert.equal(db.routesForTenant(t.id).length, 2);
    const exact = db.routeForRequest(t.id, "POST", "/v1/chat/completions");
    assert.ok(exact);
    assert.equal(exact?.priceUsd, "0.10");
    assert.equal(db.routeForRequest(t.id, "GET", "/missing"), null);
  } finally {
    cleanup();
  }
});

test("recordEvent / recentEvents / tenantMetrics", () => {
  const { db, cleanup } = freshDb();
  try {
    const t = db.createTenant({
      walletAddress: "0x2222222222222222222222222222222222222222",
      slug: "metrics-test",
      network: "base",
    });
    const r = db.addRoute({
      tenantId: t.id,
      method: "GET",
      path: "/x",
      priceUsd: "0.01",
      backendUrl: "https://upstream.example",
    });
    db.recordEvent({
      tenantId: t.id,
      routeId: r.id,
      payer: "0xpayerA",
      status: "paid",
      amountUsd: "0.01",
      txHash: "0xtx1",
      facilitator: "stub",
      latencyMs: 50,
      reason: null,
    });
    db.recordEvent({
      tenantId: t.id,
      routeId: r.id,
      payer: "0xpayerB",
      status: "paid",
      amountUsd: "0.05",
      txHash: "0xtx2",
      facilitator: "stub",
      latencyMs: 60,
      reason: null,
    });
    db.recordEvent({
      tenantId: t.id,
      routeId: r.id,
      payer: null,
      status: "rejected",
      amountUsd: null,
      txHash: null,
      facilitator: null,
      latencyMs: 5,
      reason: "missing_x_payment",
    });

    const m = db.tenantMetrics(t.id);
    assert.equal(m.totalRequests, 3);
    assert.equal(m.paidRequests, 2);
    assert.equal(m.rejectedRequests, 1);
    assert.equal(m.uniquePayers, 2);
    assert.equal(m.totalRevenueUsd, "0.060000");

    const events = db.recentEvents(t.id, 10);
    assert.equal(events.length, 3);
    assert.equal(events[0].status, "rejected");
  } finally {
    cleanup();
  }
});

test("platformMetrics aggregates across tenants and computes 1% fee", () => {
  const { db, cleanup } = freshDb();
  try {
    const a = db.createTenant({
      walletAddress: "0xaaaa000000000000000000000000000000000000",
      slug: "alpha",
      network: "base",
    });
    const b = db.createTenant({
      walletAddress: "0xbbbb000000000000000000000000000000000000",
      slug: "bravo",
      network: "base",
    });
    const ra = db.addRoute({
      tenantId: a.id, method: "GET", path: "/a", priceUsd: "0.10",
      backendUrl: "https://up.a",
    });
    const rb = db.addRoute({
      tenantId: b.id, method: "GET", path: "/b", priceUsd: "0.50",
      backendUrl: "https://up.b",
    });
    // 2 paid on tenant a, 1 paid + 1 rejected on tenant b.
    db.recordEvent({ tenantId: a.id, routeId: ra.id, payer: "0xp1", status: "paid",     amountUsd: "0.10", txHash: "0x1", facilitator: "stub", latencyMs: 1, reason: null });
    db.recordEvent({ tenantId: a.id, routeId: ra.id, payer: "0xp2", status: "paid",     amountUsd: "0.10", txHash: "0x2", facilitator: "stub", latencyMs: 1, reason: null });
    db.recordEvent({ tenantId: b.id, routeId: rb.id, payer: "0xp1", status: "paid",     amountUsd: "0.50", txHash: "0x3", facilitator: "stub", latencyMs: 1, reason: null });
    db.recordEvent({ tenantId: b.id, routeId: rb.id, payer: null,   status: "rejected", amountUsd: null,   txHash: null,  facilitator: null,   latencyMs: 1, reason: "no_pay" });

    const m = db.platformMetrics();
    assert.equal(m.tenantsTotal, 2);
    assert.equal(m.tenantsActive, 2);
    assert.equal(m.routesTotal, 2);
    assert.equal(m.eventsTotal, 4);
    assert.equal(m.eventsPaid, 3);
    assert.equal(m.eventsRejected, 1);
    assert.equal(m.uniquePayers, 2); // 0xp1 paid on both tenants but counts once
    assert.equal(m.routedUsd, "0.700000"); // 0.10 + 0.10 + 0.50
    assert.equal(m.feeUsd,    "0.007000"); // 1% of 0.70
    assert.ok(m.now >= m.since);
  } finally {
    cleanup();
  }
});

test("platformMetrics on empty db returns zeros without crashing", () => {
  const { db, cleanup } = freshDb();
  try {
    const m = db.platformMetrics();
    assert.equal(m.tenantsTotal, 0);
    assert.equal(m.eventsTotal, 0);
    assert.equal(m.routedUsd, "0.000000");
    assert.equal(m.feeUsd, "0.000000");
    assert.equal(m.uniquePayers, 0);
  } finally {
    cleanup();
  }
});
