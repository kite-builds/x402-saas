import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSlug, validateSlug } from "../dist/slug.js";

test("deriveSlug produces a valid 3-30 char slug", () => {
  const s = deriveSlug("0xC504Fd656330A823C3ffcBAB048c05cF45F60Bdf");
  // expected: t-c504fd65-XXXX
  assert.match(s, /^t-c504fd65-[0-9a-f]{4}$/);
  assert.ok(s.length >= 3 && s.length <= 30, `slug length ${s.length}`);
});

test("deriveSlug is unique across calls (basically)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const s = deriveSlug("0xC504Fd656330A823C3ffcBAB048c05cF45F60Bdf");
    seen.add(s);
  }
  assert.ok(seen.size > 90, `expected ~100 unique slugs, got ${seen.size}`);
});

test("validateSlug accepts valid slugs", () => {
  validateSlug("acme");
  validateSlug("a1b2c3");
  validateSlug("foo-bar");
  validateSlug("x".repeat(30));
});

test("validateSlug rejects invalid slugs", () => {
  assert.throws(() => validateSlug(""), /invalid slug/);
  assert.throws(() => validateSlug("ab"), /invalid slug/); // too short
  assert.throws(() => validateSlug("Foo"), /invalid slug/); // uppercase
  assert.throws(() => validateSlug("-foo"), /invalid slug/); // leading dash
  assert.throws(() => validateSlug("foo bar"), /invalid slug/); // space
  assert.throws(() => validateSlug("x".repeat(31)), /invalid slug/); // too long
  assert.throws(() => validateSlug("foo.bar"), /invalid slug/); // dot
});

test("validateSlug rejects reserved slugs", () => {
  for (const r of ["www", "api", "admin", "kite", "x402", "facilitator", "dashboard"]) {
    assert.throws(() => validateSlug(r), /reserved/);
  }
});
