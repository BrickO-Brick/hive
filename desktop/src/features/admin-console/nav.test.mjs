/**
 * Unit tests for the Settings → Moderation nav visibility gate.
 *
 * The gate decides whether ordinary members ever see the Moderation entry.
 * Its load-bearing rule after the advertised-origin hardening: any resolved
 * origin — saved manual OR relay-advertised — shows the entry; only the
 * absence of any origin hides it. The advertised origin is deliberately NOT
 * probed to decide visibility (probing untrusted relay-advertised input would
 * leak a signed NIP-98 credential to an attacker-chosen destination), so the
 * gate no longer consumes a probe outcome at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowModerationNav } from "./nav.ts";

test("no-origin-hides-entry: neither advertised nor saved → hidden", () => {
  assert.equal(shouldShowModerationNav({ originSource: "none" }), false);
});

test("saved-origin-shows-entry: a saved manual origin is always visible", () => {
  assert.equal(shouldShowModerationNav({ originSource: "saved" }), true);
});

test("advertised-origin-shows-entry: an advertised origin is visible without probing", () => {
  // The entry shows so the operator can open Moderation and confirm the
  // pre-filled origin; nothing contacts the advertised origin until Save.
  assert.equal(shouldShowModerationNav({ originSource: "advertised" }), true);
});
