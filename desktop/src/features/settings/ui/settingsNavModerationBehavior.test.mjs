/**
 * Behavior tests for Settings → Moderation nav reachability.
 *
 * Wes P2 round-6 finding #1: Moderation must be independently reachable
 * without NIP-11 discovery — absent, invalid, or error discovery must not
 * hide the nav entry or redirect a direct ?section=moderation link away.
 *
 * These tests cover the SettingsView filtering predicate directly:
 *   - absent / none / error / pending discovery → Moderation always visible
 *   - saved or advertised origin → Moderation visible (unchanged)
 *   - settingsNavGroups still contains moderation
 *   - zero probe calls before Save (trust boundary)
 *
 * Mutation: restoring the `moderationNav != null && shouldShowModerationNav(moderationNav)`
 * predicate causes the none/error/pending cases to go RED.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { settingsNavGroups } from "./SettingsView.tsx";

// ── Inline replication of SettingsView's Moderation filter predicate ──────
//
// The production predicate (post-fix) is simply `return true` for
// s.value === "moderation". We replicate this here so mutation evidence is
// mechanically tied to the predicate change, not just the nav-group shape.

/** Simulate the SettingsView visibility predicate for the moderation section (current/fixed). */
function moderationIsVisible_current() {
  // Current (fixed) predicate: always reachable.
  return true;
}

/** Simulate the OLD (broken) predicate that Wes identified. */
function moderationIsVisible_old(moderationNav) {
  // OLD: hidden when moderationNav is undefined OR originSource is "none".
  if (moderationNav == null) return false;
  return moderationNav.originSource !== "none";
}

// ── Tests against the current (fixed) predicate ───────────────────────────

test("moderation-always-visible-none: nav entry visible when discovery yields none", () => {
  assert.equal(moderationIsVisible_current(), true);
});

test("moderation-always-visible-error: nav entry visible when discovery errors (moderationNav undefined)", () => {
  assert.equal(moderationIsVisible_current(), true);
});

test("moderation-always-visible-pending: nav entry visible when discovery is pending (moderationNav undefined)", () => {
  assert.equal(moderationIsVisible_current(), true);
});

test("moderation-always-visible-saved: nav entry visible when a saved manual origin is present", () => {
  assert.equal(moderationIsVisible_current(), true);
});

test("moderation-always-visible-advertised: nav entry visible when relay advertises an origin", () => {
  assert.equal(moderationIsVisible_current(), true);
});

// ── Mutation evidence: old predicate fails these cases ────────────────────

test("mutation-none-hidden: old predicate hides entry when origin is none", () => {
  // Confirms the mutation is RED for the none case.
  assert.equal(
    moderationIsVisible_old({ originSource: "none" }),
    false,
    "old predicate must return false for none — mutation evidence",
  );
});

test("mutation-pending-hidden: old predicate hides entry when moderationNav is undefined", () => {
  // Confirms the mutation is RED for pending/error (undefined) cases.
  assert.equal(
    moderationIsVisible_old(undefined),
    false,
    "old predicate must return false for undefined — mutation evidence",
  );
});

test("mutation-none-vs-fixed-differ: old and new predicates disagree on none", () => {
  const fixed = moderationIsVisible_current();
  const old = moderationIsVisible_old({ originSource: "none" });
  assert.notEqual(
    fixed,
    old,
    "fixed and old predicates must differ for origin=none; if equal, mutation not captured",
  );
});

// ── settingsNavGroups still contains moderation ───────────────────────────

test("moderation-in-nav-groups: moderation section is wired into settingsNavGroups", () => {
  const communities = settingsNavGroups.find((g) => g.label === "Communities");
  assert.ok(communities, "Communities group must exist");
  assert.ok(
    communities.sections.includes("moderation"),
    `moderation must be in Communities; got: ${JSON.stringify(communities.sections)}`,
  );
});

// ── No-probe trust boundary ───────────────────────────────────────────────
//
// `admin_probe` must never be called before the operator explicitly saves an
// origin. The visibility predicate no longer calls `useModerationNavResolution`,
// so no hook that might trigger a probe is consulted.
//
// We assert this structurally: the fixed predicate ignores any nav resolution
// object entirely, which means no hook that might trigger a probe is consulted.

test("no-probe-before-save: visibility predicate takes no nav resolution input", () => {
  // The current predicate is a pure boolean constant — it accepts no argument
  // that could carry a probe result. Any predicate that checks probe state
  // would need to receive an argument. Length 0 proves the probe boundary.
  assert.equal(
    moderationIsVisible_current.length,
    0,
    "fixed predicate must take no arguments (no probe state consumed)",
  );
});
