import assert from "node:assert/strict";
import test from "node:test";

import { toast } from "sonner";
import { runAgentSaveCoordinator } from "./agentSaveCoordinator.ts";

// Capture toast calls by kind. The coordinator and this test import the same
// `toast` object from sonner, so overriding its methods here intercepts the
// calls made inside runAgentSaveCoordinator. Returns a restore fn.
function captureToasts() {
  const captured = [];
  const original = {
    success: toast.success,
    warning: toast.warning,
    error: toast.error,
  };
  for (const kind of ["success", "warning", "error"]) {
    toast[kind] = (message) => {
      captured.push({ kind, message });
    };
  }
  return {
    captured,
    restore() {
      Object.assign(toast, original);
    },
  };
}

// ── Shared fixtures ────────────────────────────────────────────────────────────

function makeDefinition(overrides = {}) {
  return {
    id: "def-1",
    displayName: "Alice",
    avatarUrl: "",
    systemPrompt: "Be helpful.",
    runtime: "goose",
    model: "gpt-4o",
    provider: null,
    isBuiltIn: false,
    isActive: true,
    namePool: [],
    envVars: {},
    respondTo: null,
    respondToAllowlist: [],
    parallelism: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeInstance(overrides = {}) {
  return {
    pubkey: "pk-abc",
    name: "Alice",
    avatarUrl: "",
    systemPrompt: null,
    model: null,
    provider: null,
    envVars: {},
    respondTo: null,
    respondToAllowlist: [],
    parallelism: null,
    autoRestartOnConfigChange: false,
    startOnAppLaunch: false,
    ...overrides,
  };
}

function makePersonaInput(overrides = {}) {
  return {
    id: "def-1",
    displayName: "Alice",
    systemPrompt: "Be helpful.",
    avatarUrl: "",
    runtime: "goose",
    model: "gpt-4o",
    provider: undefined,
    namePool: [],
    envVars: {},
    ...overrides,
  };
}

function makeAgentInput(overrides = {}) {
  return {
    pubkey: "pk-abc",
    ...overrides,
  };
}

/** Build minimal coordinator options. All mutations succeed by default. */
function makeOpts(overrides = {}) {
  const def = makeDefinition();
  const inst = makeInstance();

  const calls = {
    updatePersona: 0,
    updatePersonaAndPublish: 0,
    updateManagedAgent: 0,
    setAutoRestart: 0,
    setStartOnAppLaunch: 0,
    onDone: 0,
    onSavedWhileStopped: 0,
  };

  const opts = {
    ctx: { kind: "instance-with-definition", definition: def, instance: inst },
    personaInput: null,
    agentInput: null,
    policySets: [],
    publishCatalogUpdates: false,
    runtimes: undefined,
    updatePersona: async () => {
      calls.updatePersona++;
    },
    updatePersonaAndPublish: async () => {
      calls.updatePersonaAndPublish++;
      return { publicationStatus: "published" };
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return { agent: inst, profileSyncError: null };
    },
    setAutoRestart: async () => {
      calls.setAutoRestart++;
    },
    setStartOnAppLaunch: async () => {
      calls.setStartOnAppLaunch++;
    },
    refetchStores: async () => ({ persona: def, agent: inst }),
    onDone: () => {
      calls.onDone++;
    },
    onSavedWhileStopped: () => {
      calls.onSavedWhileStopped++;
    },
    _calls: calls,
    ...overrides,
  };

  return opts;
}

// ── Test family 1: write ordering ─────────────────────────────────────────────
//
// Step 1 (definition write) must run before step 2 (instance write), and a
// step-1 error must prevent step 2 from being attempted.

test("test_write_ordering_definition_write_failure_skips_instance_write", async () => {
  const calls = { updatePersona: 0, updateManagedAgent: 0 };

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    updatePersona: async () => {
      calls.updatePersona++;
      throw new Error("Relay offline");
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return { agent: makeInstance(), profileSyncError: null };
    },
    refetchStores: async () => ({ persona: null, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    false,
    "should return false on definition write failure",
  );
  assert.equal(calls.updatePersona, 1, "definition write should be attempted");
  assert.equal(
    calls.updateManagedAgent,
    0,
    "instance write must NOT be attempted when definition write fails",
  );
});

test("test_write_ordering_instance_write_runs_after_definition_write_succeeds", async () => {
  const calls = { updatePersona: 0, updateManagedAgent: 0 };

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    updatePersona: async () => {
      calls.updatePersona++;
    },
    updateManagedAgent: async () => {
      // Must only be called after updatePersona
      assert.equal(
        calls.updatePersona,
        1,
        "definition write must precede instance write",
      );
      calls.updateManagedAgent++;
      return {
        agent: makeInstance({ name: "Alice-renamed" }),
        profileSyncError: null,
      };
    },
    refetchStores: async () => ({
      persona: makeDefinition(),
      agent: makeInstance({ name: "Alice-renamed" }),
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true, "should return true on full success");
  assert.equal(calls.updatePersona, 1, "definition write should be called");
  assert.equal(calls.updateManagedAgent, 1, "instance write should be called");
});

test("test_write_ordering_policy_setters_run_only_after_both_data_writes_succeed", async () => {
  const calls = { updatePersona: 0, updateManagedAgent: 0, setAutoRestart: 0 };
  // The refetchStores must reflect each write as it happens so per-boundary
  // settlement passes and the coordinator can advance through all steps.
  // After I-write the agent has name "Alice-renamed"; after autoRestart the
  // agent also has autoRestartOnConfigChange: true.
  let refetchCount = 0;

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    policySets: [{ type: "autoRestart", pubkey: "pk-abc", value: true }],
    updatePersona: async () => {
      calls.updatePersona++;
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return {
        agent: makeInstance({ name: "Alice-renamed" }),
        profileSyncError: null,
      };
    },
    setAutoRestart: async () => {
      // Must only be called after both data writes
      assert.equal(
        calls.updatePersona,
        1,
        "definition write must precede policy setter",
      );
      assert.equal(
        calls.updateManagedAgent,
        1,
        "instance write must precede policy setter",
      );
      calls.setAutoRestart++;
    },
    refetchStores: async () => {
      refetchCount++;
      // After D-write (refetch 1): persona matches, agent has original name.
      // After I-write (refetch 2): agent now has renamed name.
      // After autoRestart setter (refetch 3 + final): agent also has autoRestart=true.
      const agentName = refetchCount >= 2 ? "Alice-renamed" : "Alice";
      const autoRestart = refetchCount >= 3;
      return {
        persona: makeDefinition(),
        agent: makeInstance({
          name: agentName,
          autoRestartOnConfigChange: autoRestart,
        }),
      };
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true);
  assert.equal(calls.setAutoRestart, 1, "policy setter should be called");
});

// ── Test family 2: local-save / publish failure ───────────────────────────────
//
// A definition write failure should surface as partial failure, reporting what
// did NOT persist. A publish failure (updatePersonaAndPublish throws) should
// also stop the sequence.

test("test_local_save_failure_returns_false_and_calls_settlement", async () => {
  let settlementCalled = false;

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    updatePersona: async () => {
      throw new Error("Disk full");
    },
    refetchStores: async () => {
      settlementCalled = true;
      return { persona: null, agent: null };
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "should return false on local save failure");
  assert.equal(
    settlementCalled,
    true,
    "settlement (refetchStores) must be called even on failure",
  );
});

test("test_publish_failure_returns_false_stops_sequence", async () => {
  const calls = { updateManagedAgent: 0 };

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    publishCatalogUpdates: true,
    updatePersonaAndPublish: async () => {
      throw new Error("Relay rejected");
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return { agent: makeInstance(), profileSyncError: null };
    },
    refetchStores: async () => ({ persona: null, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "should return false on publish failure");
  assert.equal(
    calls.updateManagedAgent,
    0,
    "instance write must not run if publish step failed",
  );
});

// ── Test family 3: observed mismatch ─────────────────────────────────────────
//
// Command success alone does not mean persistence. If the re-fetched observed
// state does not match what was submitted, the coordinator must return false
// and report the mismatch.

test("test_observed_mismatch_returns_false_when_persona_not_in_store_after_write", async () => {
  // updatePersona succeeds but refetchStores returns persona: null
  // (the write never actually persisted — e.g. a race with another write).
  const opts = makeOpts({
    personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
    updatePersona: async () => {},
    // Observed store shows the original name (write lost)
    refetchStores: async () => ({
      persona: makeDefinition({ displayName: "Alice" }),
      agent: null,
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  // The submitted displayName "Alice-renamed" doesn't match observed "Alice"
  assert.equal(
    result,
    false,
    "should return false when observed state doesn't match submission",
  );
  assert.equal(
    opts._calls.onDone,
    0,
    "onDone must NOT be called when observed state doesn't match",
  );
});

test("test_observed_match_calls_onDone_and_returns_true", async () => {
  // Both the write succeeds and the observed state matches.
  const updatedPersona = makeDefinition({ displayName: "Alice-renamed" });

  const opts = makeOpts({
    personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
    updatePersona: async () => {},
    refetchStores: async () => ({ persona: updatedPersona, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "should return true when observed state matches submission",
  );
  assert.equal(opts._calls.onDone, 1, "onDone must be called on full success");
});

test("test_definition_write_throws_but_persisted_is_success", async () => {
  // Observed state is authoritative over the command result: a definition
  // write that threw but whose write landed on disk must NOT be reported as a
  // failed step. The instance write proceeds and onDone is called.
  const updatedPersona = makeDefinition({ displayName: "Alice-renamed" });

  const opts = makeOpts({
    personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
    agentInput: makeAgentInput(),
    updatePersona: async () => {
      throw new Error("Relay timeout after commit");
    },
    refetchStores: async () => ({
      persona: updatedPersona,
      agent: makeInstance(),
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "a thrown-but-persisted definition write must be treated as success",
  );
  assert.equal(
    opts._calls.updateManagedAgent,
    1,
    "instance write must proceed when the definition write persisted",
  );
  assert.equal(
    opts._calls.onDone,
    1,
    "onDone must be called on persisted write",
  );
});

test("test_instance_write_throws_but_persisted_is_success", async () => {
  // Same authority rule for the instance step: a throw whose write persisted
  // is success.
  const updatedInstance = makeInstance({ name: "Alice-renamed" });

  const opts = makeOpts({
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    updateManagedAgent: async () => {
      throw new Error("Relay timeout after commit");
    },
    refetchStores: async () => ({ persona: null, agent: updatedInstance }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "a thrown-but-persisted instance write must be treated as success",
  );
  assert.equal(
    opts._calls.onDone,
    1,
    "onDone must be called on persisted write",
  );
});

test("test_absent_entity_after_refetch_is_not_persisted", async () => {
  // persona: null after refetch means the entity was not found → not persisted.
  const opts = makeOpts({
    personaInput: makePersonaInput(),
    updatePersona: async () => {},
    // Simulate write succeeding at command level but entity not appearing in store
    refetchStores: async () => ({ persona: null, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  // Even though updatePersona didn't throw, the absent observed state means failure.
  assert.equal(
    result,
    false,
    "absent entity after refetch must be treated as not persisted",
  );
});

// ── Test family 4: partial policy failure ─────────────────────────────────────
//
// Multiple policy setters: if the first succeeds and the second fails, the
// coordinator must report the second as failed and return false. Unattempted
// policies (beyond the failing one) must also be reported as failed.

test("test_partial_policy_failure_first_succeeds_second_fails_returns_false", async () => {
  const calls = { setAutoRestart: 0, setStartOnAppLaunch: 0 };

  const inst = makeInstance({
    autoRestartOnConfigChange: false,
    startOnAppLaunch: false,
  });

  // Per-boundary settlement: after the first policy setter (autoRestart) succeeds,
  // refetchStores must return autoRestartOnConfigChange: true for the check to
  // pass and the coordinator to advance to the second setter. The second setter
  // throws, so the second policy is attempted but fails.
  let refetchCount = 0;

  const opts = makeOpts({
    ctx: {
      kind: "instance-with-definition",
      definition: makeDefinition(),
      instance: inst,
    },
    policySets: [
      { type: "autoRestart", pubkey: "pk-abc", value: true },
      { type: "startOnAppLaunch", pubkey: "pk-abc", value: true },
    ],
    setAutoRestart: async () => {
      calls.setAutoRestart++;
    },
    setStartOnAppLaunch: async () => {
      calls.setStartOnAppLaunch++;
      throw new Error("Permission denied");
    },
    refetchStores: async () => {
      refetchCount++;
      // After first policy setter (autoRestart=true) succeeds, reflect it.
      // startOnAppLaunch stays false throughout (second setter throws).
      const autoRestart = refetchCount >= 1 && calls.setAutoRestart > 0;
      return {
        persona: makeDefinition(),
        agent: makeInstance({
          autoRestartOnConfigChange: autoRestart,
          startOnAppLaunch: false,
        }),
      };
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    false,
    "should return false when any policy setter fails",
  );
  assert.equal(calls.setAutoRestart, 1, "first policy should be attempted");
  assert.equal(
    calls.setStartOnAppLaunch,
    1,
    "second policy should be attempted",
  );
  assert.equal(
    opts._calls.onDone,
    0,
    "onDone must not be called on partial policy failure",
  );
});

test("test_early_policy_failure_skips_subsequent_policies", async () => {
  const calls = { setAutoRestart: 0, setStartOnAppLaunch: 0 };

  const inst = makeInstance();

  const opts = makeOpts({
    ctx: {
      kind: "instance-with-definition",
      definition: makeDefinition(),
      instance: inst,
    },
    policySets: [
      { type: "autoRestart", pubkey: "pk-abc", value: true },
      { type: "startOnAppLaunch", pubkey: "pk-abc", value: true },
    ],
    setAutoRestart: async () => {
      calls.setAutoRestart++;
      throw new Error("Store locked");
    },
    setStartOnAppLaunch: async () => {
      calls.setStartOnAppLaunch++;
    },
    refetchStores: async () => ({ persona: makeDefinition(), agent: inst }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    false,
    "should return false when first policy setter fails",
  );
  assert.equal(calls.setAutoRestart, 1, "first policy should be attempted");
  assert.equal(
    calls.setStartOnAppLaunch,
    0,
    "second policy must NOT be attempted after first failure (stop-at-first-failure per spec)",
  );
});

test("test_settlement_always_runs_even_when_no_writes_attempted", async () => {
  // No personaInput, no agentInput, no policySets: nothing to write.
  // Settlement (refetchStores) should still be called for the success path.
  let settlementCalled = false;

  const opts = makeOpts({
    refetchStores: async () => {
      settlementCalled = true;
      return { persona: null, agent: null };
    },
    onDone: () => {},
  });

  await runAgentSaveCoordinator(opts);

  assert.equal(
    settlementCalled,
    true,
    "settlement must always run regardless of writes",
  );
});

// -- CRITICAL-3: per-boundary mismatch tests --
//
// These verify Thufir's two probes: successful harness command whose refetched
// agent retains old harness fields must NOT call onDone; successful auto-restart
// setter whose refetched agent remains false must NOT call onDone.

test("test_harness_command_success_but_observed_mismatch_returns_false", async () => {
  // Thufir probe 1: agentCommand submitted, command returns success, but the
  // refetched agent still has the old command. Must NOT call onDone.
  let doneCalled = false;

  const staleAgent = makeInstance({
    agentCommand: "/old/harness",
    agentCommandOverride: null,
    agentArgs: [],
    acpCommand: "",
  });
  const opts = makeOpts({
    agentInput: { pubkey: "pk-abc", agentCommand: "/new/harness" },
    updateManagedAgent: async () => ({
      agent: staleAgent,
      profileSyncError: null,
    }),
    refetchStores: async () => ({
      persona: null,
      agent: staleAgent, // old command -- mismatch with submitted
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "mismatch must return false");
  assert.equal(
    doneCalled,
    false,
    "onDone must NOT be called on harness mismatch",
  );
});

test("test_auto_restart_success_but_observed_unchanged_returns_false", async () => {
  // Thufir probe 2: autoRestart setter returns success (no throw), but the
  // refetched agent still has the old value (false). Must NOT call onDone.
  let doneCalled = false;

  const unchangedAgent = makeInstance({ autoRestartOnConfigChange: false });
  const opts = makeOpts({
    policySets: [{ type: "autoRestart", pubkey: "pk-abc", value: true }],
    setAutoRestart: async () => {},
    refetchStores: async () => ({
      persona: null,
      agent: unchangedAgent, // still false -- mismatch with submitted true
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "auto-restart mismatch must return false");
  assert.equal(
    doneCalled,
    false,
    "onDone must NOT be called when policy did not persist",
  );
});

test("test_start_on_app_launch_success_and_observed_match_calls_onDone", async () => {
  // Positive case: startOnAppLaunch setter succeeds AND observed state matches.
  let doneCalled = false;

  const updatedAgent = makeInstance({ startOnAppLaunch: true });
  const opts = makeOpts({
    policySets: [{ type: "startOnAppLaunch", pubkey: "pk-abc", value: true }],
    setStartOnAppLaunch: async () => {},
    refetchStores: async () => ({
      persona: null,
      agent: updatedAgent, // matches submitted value
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true, "matching policy must return true");
  assert.equal(doneCalled, true, "onDone must be called on policy success");
});

test("test_definition_write_not_persisted_stops_instance_write", async () => {
  // Per-boundary: if D-write succeeds but observed persona does not match,
  // the coordinator must not advance to the I-write.
  let instanceWriteCalled = false;

  const stalePersona = makeDefinition({
    displayName: "Old Name",
    systemPrompt: "Be helpful.",
  });
  const opts = makeOpts({
    personaInput: {
      id: "def-1",
      displayName: "Updated Name",
      systemPrompt: "Updated prompt.",
      namePool: [],
      envVars: {},
    },
    agentInput: { pubkey: "pk-abc", name: "updated-name" },
    updatePersona: async () => {},
    updateManagedAgent: async () => {
      instanceWriteCalled = true;
      return { agent: makeInstance(), profileSyncError: null };
    },
    refetchStores: async () => ({
      // Persona with OLD displayName = mismatch after D-write.
      persona: stalePersona,
      agent: makeInstance(),
    }),
    onDone: () => {},
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "D-write mismatch must return false");
  assert.equal(
    instanceWriteCalled,
    false,
    "instance write must NOT be attempted when D-write did not persist",
  );
});

// ── Test family 5: thrown-but-persisted policy settlement (Thufir pass-1 CRITICAL) ──
//
// Both Tauri policy setters save the record BEFORE building their returned
// summary, so a post-save summary error yields a thrown-but-persisted write.
// Settlement must observe the store — not the command result — exactly as the
// D/I steps do: a throw whose write landed is success, the sequence continues,
// and onDone fires.

test("test_auto_restart_throws_but_persisted_advances_and_calls_onDone", async () => {
  // autoRestart setter throws, but the refetched agent shows the new value.
  const opts = makeOpts({
    policySets: [{ type: "autoRestart", pubkey: "pk-abc", value: true }],
    setAutoRestart: async () => {
      throw new Error("summary build failed after save");
    },
    refetchStores: async () => ({
      persona: null,
      agent: makeInstance({ autoRestartOnConfigChange: true }),
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "a thrown-but-persisted autoRestart write must be treated as success",
  );
  assert.equal(
    opts._calls.onDone,
    1,
    "onDone must be called when the policy persisted despite the throw",
  );
});

test("test_start_on_app_launch_throws_but_persisted_advances_and_calls_onDone", async () => {
  // startOnAppLaunch setter throws, but the refetched agent shows the new value.
  const opts = makeOpts({
    policySets: [{ type: "startOnAppLaunch", pubkey: "pk-abc", value: true }],
    setStartOnAppLaunch: async () => {
      throw new Error("summary build failed after save");
    },
    refetchStores: async () => ({
      persona: null,
      agent: makeInstance({ startOnAppLaunch: true }),
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "a thrown-but-persisted startOnAppLaunch write must be treated as success",
  );
  assert.equal(
    opts._calls.onDone,
    1,
    "onDone must be called when the policy persisted despite the throw",
  );
});

test("test_thrown_but_persisted_policy_continues_to_later_policy", async () => {
  const calls = { setAutoRestart: 0, setStartOnAppLaunch: 0 };
  // First policy (autoRestart) throws but persists; the coordinator must
  // observe persistence, advance to the second policy, and (with the second
  // also persisting) call onDone. The buggy behavior skipped the second policy.
  const opts = makeOpts({
    policySets: [
      { type: "autoRestart", pubkey: "pk-abc", value: true },
      { type: "startOnAppLaunch", pubkey: "pk-abc", value: true },
    ],
    setAutoRestart: async () => {
      calls.setAutoRestart++;
      throw new Error("summary build failed after save");
    },
    setStartOnAppLaunch: async () => {
      calls.setStartOnAppLaunch++;
    },
    // Both values are observed as persisted throughout — the first setter's
    // write landed before it threw, the second write is clean.
    refetchStores: async () => ({
      persona: null,
      agent: makeInstance({
        autoRestartOnConfigChange: true,
        startOnAppLaunch: true,
      }),
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "a thrown-but-persisted first policy must not block a persisted second policy",
  );
  assert.equal(calls.setAutoRestart, 1, "first policy attempted");
  assert.equal(
    calls.setStartOnAppLaunch,
    1,
    "second policy must be attempted after the first policy persisted despite throwing",
  );
  assert.equal(opts._calls.onDone, 1, "onDone must fire on full persistence");
});

// ── Test family 6: full-replacement behavior-group settlement (Thufir pass-1 IMPORTANT) ──
//
// A submitted behavior group is replace-as-a-unit: the backend clears any
// OMITTED member to null/empty. Settlement must compare every member —
// including omitted ones — against the observed cleared value, so a clear the
// backend failed to apply cannot false-succeed.

test("test_parallelism_clear_not_applied_is_flagged_as_not_persisted", async () => {
  // The user cleared parallelism: the submitted behavior group omits it (the
  // clear signal). The store still shows the OLD value (4) — the clear did not
  // apply. Settlement must treat this as not persisted and return false.
  const opts = makeOpts({
    ctx: {
      kind: "definition-only",
      definition: makeDefinition({ respondTo: "anyone", parallelism: 4 }),
    },
    personaInput: makePersonaInput({
      // Behavior group carries respondTo but omits parallelism → clear it.
      behavior: { respondTo: "anyone" },
    }),
    updatePersona: async () => {},
    refetchStores: async () => ({
      // Clear failed: parallelism is still 4 in the observed store.
      persona: makeDefinition({ respondTo: "anyone", parallelism: 4 }),
      agent: null,
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    false,
    "an unapplied parallelism clear must be flagged as not persisted",
  );
  assert.equal(
    opts._calls.onDone,
    0,
    "onDone must NOT be called when the clear did not apply",
  );
});

test("test_parallelism_clear_applied_settles_as_persisted", async () => {
  // Same clear, but the store now shows parallelism cleared (null). Settlement
  // must treat the omitted member as matching the observed null and succeed.
  const opts = makeOpts({
    ctx: {
      kind: "definition-only",
      definition: makeDefinition({ respondTo: "anyone", parallelism: 4 }),
    },
    personaInput: makePersonaInput({ behavior: { respondTo: "anyone" } }),
    updatePersona: async () => {},
    refetchStores: async () => ({
      persona: makeDefinition({ respondTo: "anyone", parallelism: null }),
      agent: null,
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "an applied parallelism clear (observed null) must settle as persisted",
  );
  assert.equal(
    opts._calls.onDone,
    1,
    "onDone must fire when the clear applied",
  );
});

// ── Test family 7: refetch-rejection verification-unknown (Carl review) ──────
//
// refetchStores() is awaited bare at every settlement boundary. If a
// verification refetch REJECTS after a write may have committed, the rejection
// must never escape: the coordinator returns false (dialog stays open), fires a
// "could not verify" warning — NOT a "write failed" error — and stops
// advancing. Each boundary (definition, instance, policy, final) is covered.

/** A refetchStores whose Nth call (1-based) rejects; earlier/later calls use `ok`. */
function refetchRejectingOnCall(rejectOn, ok) {
  let n = 0;
  return async () => {
    n += 1;
    if (n === rejectOn) throw new Error("Store refetch failed");
    return ok();
  };
}

test("test_refetch_rejection_after_definition_write_reports_unknown_not_failed", async () => {
  const cap = captureToasts();
  try {
    const opts = makeOpts({
      personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
      agentInput: makeAgentInput({ name: "Alice-renamed" }),
      updatePersona: async () => {},
      // First refetch (after the definition write) rejects.
      refetchStores: refetchRejectingOnCall(1, () => ({
        persona: makeDefinition({ displayName: "Alice-renamed" }),
        agent: makeInstance({ name: "Alice-renamed" }),
      })),
    });

    const result = await runAgentSaveCoordinator(opts);

    assert.equal(result, false, "refetch rejection must return false");
    assert.equal(
      opts._calls.onDone,
      0,
      "onDone must NOT fire when persistence could not be verified",
    );
    assert.equal(
      opts._calls.updateManagedAgent,
      0,
      "must stop advancing to the instance write after a refetch rejection",
    );
    const warnings = cap.captured.filter((c) => c.kind === "warning");
    assert.equal(warnings.length, 1, "exactly one warning toast");
    assert.match(
      warnings[0].message,
      /could not verify/i,
      "toast must say persistence could not be verified",
    );
    assert.equal(
      cap.captured.some((c) => c.kind === "error"),
      false,
      "must NOT claim the write failed",
    );
  } finally {
    cap.restore();
  }
});

test("test_refetch_rejection_after_instance_write_reports_unknown", async () => {
  const cap = captureToasts();
  try {
    const opts = makeOpts({
      agentInput: makeAgentInput({ name: "Alice-renamed" }),
      updateManagedAgent: async () => ({
        agent: makeInstance({ name: "Alice-renamed" }),
        profileSyncError: null,
      }),
      // Only the instance write is present, so its settlement is the first
      // refetch call.
      refetchStores: refetchRejectingOnCall(1, () => ({
        persona: null,
        agent: makeInstance({ name: "Alice-renamed" }),
      })),
    });

    const result = await runAgentSaveCoordinator(opts);

    assert.equal(result, false, "refetch rejection must return false");
    assert.equal(opts._calls.onDone, 0, "onDone must NOT fire");
    const warnings = cap.captured.filter((c) => c.kind === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /could not verify/i);
  } finally {
    cap.restore();
  }
});

test("test_refetch_rejection_after_policy_setter_reports_unknown", async () => {
  const cap = captureToasts();
  try {
    const opts = makeOpts({
      policySets: [{ type: "autoRestart", pubkey: "pk-abc", value: true }],
      setAutoRestart: async () => {},
      // The policy setter's settlement is the first refetch call.
      refetchStores: refetchRejectingOnCall(1, () => ({
        persona: null,
        agent: makeInstance({ autoRestartOnConfigChange: true }),
      })),
    });

    const result = await runAgentSaveCoordinator(opts);

    assert.equal(result, false, "refetch rejection must return false");
    assert.equal(opts._calls.onDone, 0, "onDone must NOT fire");
    const warnings = cap.captured.filter((c) => c.kind === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /could not verify/i);
  } finally {
    cap.restore();
  }
});

test("test_refetch_rejection_at_final_settlement_reports_unknown", async () => {
  const cap = captureToasts();
  try {
    // No writes: the only refetch is the final settlement. Its rejection must
    // still be contained and reported as unverified.
    const opts = makeOpts({
      refetchStores: refetchRejectingOnCall(1, () => ({
        persona: null,
        agent: null,
      })),
    });

    const result = await runAgentSaveCoordinator(opts);

    assert.equal(result, false, "final-settlement rejection must return false");
    assert.equal(opts._calls.onDone, 0, "onDone must NOT fire");
    const warnings = cap.captured.filter((c) => c.kind === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /could not verify/i);
  } finally {
    cap.restore();
  }
});

test("test_mutation_throws_then_refetch_rejects_reports_unknown_not_failed", async () => {
  // Carl's named case: a write throws AND the verification refetch then rejects.
  // The mutation may have committed on disk, so the coordinator must report
  // verification-unknown — never assert the write failed — and keep the dialog
  // open.
  const cap = captureToasts();
  try {
    const opts = makeOpts({
      personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
      updatePersona: async () => {
        throw new Error("Relay timeout after commit");
      },
      refetchStores: refetchRejectingOnCall(1, () => ({
        persona: null,
        agent: null,
      })),
    });

    const result = await runAgentSaveCoordinator(opts);

    assert.equal(result, false, "must return false — dialog stays open");
    assert.equal(opts._calls.onDone, 0, "onDone must NOT fire");
    const warnings = cap.captured.filter((c) => c.kind === "warning");
    assert.equal(
      warnings.length,
      1,
      "exactly one verification-unknown warning",
    );
    assert.match(warnings[0].message, /could not verify/i);
    assert.equal(
      cap.captured.some(
        (c) => c.kind === "error" || /failed/i.test(String(c.message)),
      ),
      false,
      "must NOT claim the write failed when it may have committed",
    );
  } finally {
    cap.restore();
  }
});

// ── Test family 8: concurrent-edit drift guard (P1-2) ────────────────────────
//
// A definition write is built from the form baseline captured at seed time. If
// another writer revised the definition while the form was open, the latest ctx
// `updatedAt` differs from the seed-time value. Submitting the stale
// full-replacement input would clobber the newer writer's values, so the
// coordinator must abort BEFORE any write — nothing persisted, dialog stays
// open (returns false), and the toast tells the user to reopen.

test("test_definition_drift_aborts_before_any_write", async () => {
  const cap = captureToasts();
  try {
    const opts = makeOpts({
      ctx: {
        kind: "definition-only",
        // Latest ctx definition was revised (updatedAt advanced).
        definition: makeDefinition({ updatedAt: "2025-06-01T00:00:00Z" }),
      },
      personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
      // Form was seeded against the OLD revision.
      expectedDefinitionUpdatedAt: "2025-01-01T00:00:00Z",
    });

    const result = await runAgentSaveCoordinator(opts);

    assert.equal(
      result,
      false,
      "drift must abort the save (dialog stays open)",
    );
    assert.equal(
      opts._calls.updatePersona,
      0,
      "no definition write may be attempted on drift",
    );
    assert.equal(opts._calls.onDone, 0, "onDone must NOT fire on drift abort");
    const errors = cap.captured.filter((c) => c.kind === "error");
    assert.equal(errors.length, 1, "exactly one error toast");
    assert.match(
      errors[0].message,
      /changed while you were editing/i,
      "toast must tell the user the template changed — reopen",
    );
  } finally {
    cap.restore();
  }
});

test("test_no_drift_when_updatedAt_matches_proceeds_with_write", async () => {
  const updated = makeDefinition({
    displayName: "Alice-renamed",
    updatedAt: "2025-01-01T00:00:00Z",
  });
  const opts = makeOpts({
    ctx: {
      kind: "definition-only",
      definition: makeDefinition({ updatedAt: "2025-01-01T00:00:00Z" }),
    },
    personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
    expectedDefinitionUpdatedAt: "2025-01-01T00:00:00Z",
    refetchStores: async () => ({ persona: updated, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true, "matching updatedAt must not block the write");
  assert.equal(opts._calls.updatePersona, 1, "definition write proceeds");
  assert.equal(opts._calls.onDone, 1, "onDone fires on success");
});

test("test_instance_only_save_skips_drift_guard", async () => {
  // Instance-only saves emit no personaInput; the guard must never fire even
  // when no expectedDefinitionUpdatedAt is supplied.
  const updated = makeInstance({ name: "Alice-renamed" });
  const opts = makeOpts({
    ctx: { kind: "instance-only", instance: makeInstance() },
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    updateManagedAgent: async () => ({
      agent: updated,
      profileSyncError: null,
    }),
    refetchStores: async () => ({ persona: null, agent: updated }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true, "instance-only save is unaffected by the guard");
  assert.equal(opts._calls.onDone, 1);
});

test("test_drift_guard_inert_when_no_expected_updatedAt_supplied", async () => {
  // A personaInput with no expectedDefinitionUpdatedAt (null) must not abort —
  // the guard is opt-in and skips when the seed-time value is absent.
  const updated = makeDefinition({ displayName: "Alice-renamed" });
  const opts = makeOpts({
    ctx: { kind: "definition-only", definition: makeDefinition() },
    personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
    expectedDefinitionUpdatedAt: null,
    refetchStores: async () => ({ persona: updated, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true, "null expected updatedAt skips the guard");
  assert.equal(opts._calls.updatePersona, 1);
});

// ── Test family 9: success toast names the observed (persisted) agent (P2) ───
//
// `latestAgent` only advances on a NON-throwing updateManagedAgent. A rename
// that commits to disk but whose command throws afterward leaves `latestAgent`
// at the pre-save instance, so the success toast must read the name from the
// observed refetch — not from `latestAgent` — or a committed Alice→Bob rename
// falsely reports "Alice saved."

test("test_success_toast_uses_observed_name_on_thrown_but_persisted_rename", async () => {
  const cap = captureToasts();
  try {
    const opts = makeOpts({
      ctx: {
        kind: "instance-only",
        instance: makeInstance({ name: "Alice" }),
      },
      agentInput: makeAgentInput({ name: "Bob" }),
      // The rename commits to disk, but the command throws after commit, so
      // `latestAgent` is never reassigned and stays at the pre-save "Alice".
      updateManagedAgent: async () => {
        throw new Error("summary build failed after commit");
      },
      // The final refetch observes the persisted rename.
      refetchStores: async () => ({
        persona: null,
        agent: makeInstance({ name: "Bob" }),
      }),
    });

    const result = await runAgentSaveCoordinator(opts);

    assert.equal(
      result,
      true,
      "a thrown-but-persisted write is a full success (observed state matches)",
    );
    const successes = cap.captured.filter((c) => c.kind === "success");
    assert.equal(successes.length, 1, "exactly one success toast");
    assert.match(
      successes[0].message,
      /^Bob saved\./,
      "toast must name the observed (persisted) rename, not the stale pre-save name",
    );
    assert.doesNotMatch(
      successes[0].message,
      /Alice/,
      "toast must not report the stale pre-save name",
    );
  } finally {
    cap.restore();
  }
});
