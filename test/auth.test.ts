import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  makeChallenge,
  challengeToMessage,
  verifyChallengeSignature,
} from "../dist/auth.js";

test("makeChallenge / challengeToMessage / verify signed by correct wallet", async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const challenge = makeChallenge(acct.address, "kite.test");
  assert.equal(challenge.walletAddress, acct.address.toLowerCase());

  const msg = challengeToMessage(challenge);
  assert.match(msg, /Sign in/);

  const sig = await acct.signMessage({ message: msg });
  const result = await verifyChallengeSignature(challenge, sig);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.address, acct.address.toLowerCase());
  }
});

test("verify rejects expired challenge", async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const challenge = makeChallenge(acct.address, "kite.test");
  challenge.expiresAt = Date.now() - 1;
  const sig = await acct.signMessage({ message: challengeToMessage(challenge) });
  const result = await verifyChallengeSignature(challenge, sig);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /expired/);
  }
});

test("verify rejects signature from different wallet", async () => {
  const aliceAcct = privateKeyToAccount(generatePrivateKey());
  const malloryAcct = privateKeyToAccount(generatePrivateKey());

  const challenge = makeChallenge(aliceAcct.address, "kite.test");
  const malloryMsg = challengeToMessage(challenge);
  const malloryBadSig = await malloryAcct.signMessage({ message: malloryMsg });

  const result = await verifyChallengeSignature(challenge, malloryBadSig);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /does not match/);
  }
});

test("makeChallenge throws on invalid address", () => {
  assert.throws(() => makeChallenge("not-an-address", "kite.test"), /invalid wallet/);
});
