import assert from "node:assert/strict";
import test from "node:test";

import { toast } from "sonner";
import { resolveLatestPersonaToEdit } from "./usePersonaActions.ts";
import { runAgentSaveCoordinator } from "./agentSaveCoordinator.ts";

// ── P1-2 seam: Agents-library edit route must rebind ctx to the latest persona ─
//
// Thufir's IMPORTANT finding: the drift guard lives in the coordinator, but on
// the Agents-library route `ctx.definition` was fed the open-time snapshot, so
// a same-ID refresh never reached the guard and the clobber stayed reachable.
// `resolveLatestPersonaToEdit` closes that seam by re-deriving the live entity
// by ID. These tests exercise the REAL rebind wired into the REAL coordinator:
// reverting the rebind (returning the stored snapshot) makes the newer
// `updatedAt` invisible, the guard sees equality, and the write proceeds —
// which fails the abort assertions below.

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

function makePersonaInput(overrides = {}) {
  return {
    id: "def-1",
    displayName: "Alice-edited",
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

function captureToasts() {
  const captured = [];
  const original = {
    success: toast.success,
    warning: toast.warning,
    error: toast.error,
  };
  for (const kind of ["success", "warning", "error"]) {
    toast[kind] = (message) => captured.push({ kind, message });
  }
  return { captured, restore: () => Object.assign(toast, original) };
}

test("test_resolve_latest_persona_rebinds_to_refreshed_entity_by_id", () => {
  const snapshot = makeDefinition({ updatedAt: "2025-01-01T00:00:00Z" });
  const refreshed = makeDefinition({
    updatedAt: "2025-06-01T00:00:00Z",
    systemPrompt: "Concurrently revised.",
  });

  const resolved = resolveLatestPersonaToEdit(snapshot, [refreshed]);
  assert.equal(
    resolved.updatedAt,
    "2025-06-01T00:00:00Z",
    "must rebind to the live entity so ctx advances with the store",
  );
});

test("test_resolve_latest_persona_falls_back_to_snapshot_when_deleted", () => {
  const snapshot = makeDefinition();
  // Persona vanished from query data (deleted while editing).
  assert.equal(
    resolveLatestPersonaToEdit(snapshot, []),
    snapshot,
    "must fall back to the stored snapshot when the id is gone",
  );
  assert.equal(resolveLatestPersonaToEdit(null, [makeDefinition()]), null);
});

test("test_agents_route_concurrent_definition_edit_aborts_before_any_write", async () => {
  // The full seam: user opens Alice from the Agents library (snapshot at T0,
  // captured as the seed-time updatedAt). A concurrent writer revises the same
  // definition to T1; personasQuery refreshes. The dialog rebinds ctx via
  // resolveLatestPersonaToEdit, then the user submits a definition edit.
  const cap = captureToasts();
  try {
    const snapshot = makeDefinition({ updatedAt: "2025-01-01T00:00:00Z" });
    const seededUpdatedAt = snapshot.updatedAt; // captured at seed time

    const refreshed = makeDefinition({ updatedAt: "2025-06-01T00:00:00Z" });
    const ctxDefinition = resolveLatestPersonaToEdit(snapshot, [refreshed]);

    let definitionWrites = 0;
    const result = await runAgentSaveCoordinator({
      ctx: { kind: "definition-only", definition: ctxDefinition },
      personaInput: makePersonaInput(),
      agentInput: null,
      policySets: [],
      expectedDefinitionUpdatedAt: seededUpdatedAt,
      updatePersona: async () => {
        definitionWrites++;
      },
      updatePersonaAndPublish: async () => {
        definitionWrites++;
        return { publicationStatus: "published" };
      },
      updateManagedAgent: async () => ({ agent: null, profileSyncError: null }),
      setAutoRestart: async () => {},
      setStartOnAppLaunch: async () => {},
      refetchStores: async () => ({ persona: refreshed, agent: null }),
      onDone: () => {},
    });

    assert.equal(
      result,
      false,
      "drift must abort the save (dialog stays open)",
    );
    assert.equal(
      definitionWrites,
      0,
      "ZERO definition writes when ctx rebinds to a newer revision than the seed",
    );
    const errors = cap.captured.filter((c) => c.kind === "error");
    assert.equal(errors.length, 1, "one concurrent-edit error toast");
    assert.match(
      errors[0].message,
      /changed while you were editing/i,
      "must surface concurrent-edit messaging",
    );
  } finally {
    cap.restore();
  }
});

test("test_agents_route_no_concurrent_edit_proceeds_to_write", async () => {
  // No concurrent revision: the refreshed entity matches the seed revision, so
  // the guard does not fire and the definition write proceeds.
  const cap = captureToasts();
  try {
    const snapshot = makeDefinition({ updatedAt: "2025-01-01T00:00:00Z" });
    const ctxDefinition = resolveLatestPersonaToEdit(snapshot, [snapshot]);

    let definitionWrites = 0;
    const result = await runAgentSaveCoordinator({
      ctx: { kind: "definition-only", definition: ctxDefinition },
      personaInput: makePersonaInput({ displayName: "Alice-edited" }),
      agentInput: null,
      policySets: [],
      expectedDefinitionUpdatedAt: snapshot.updatedAt,
      updatePersona: async () => {
        definitionWrites++;
      },
      updatePersonaAndPublish: async () => {
        definitionWrites++;
        return { publicationStatus: "published" };
      },
      updateManagedAgent: async () => ({ agent: null, profileSyncError: null }),
      setAutoRestart: async () => {},
      setStartOnAppLaunch: async () => {},
      refetchStores: async () => ({
        persona: makeDefinition({ displayName: "Alice-edited" }),
        agent: null,
      }),
      onDone: () => {},
    });

    assert.equal(result, true, "no drift → save succeeds");
    assert.equal(
      definitionWrites,
      1,
      "definition write proceeds when no concurrent revision",
    );
  } finally {
    cap.restore();
  }
});
