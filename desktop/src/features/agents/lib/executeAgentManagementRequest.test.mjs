import assert from "node:assert/strict";
import test from "node:test";

import {
  executeAgentManagementRequest,
  originRejection,
} from "./executeAgentManagementRequest.ts";

const CHANNEL_ID = "7c07e659-3610-42f4-9a5e-1e9973c09da9";
const REQUESTER = "f".repeat(64);
const TARGET = "a".repeat(64);

function managedAgent(overrides = {}) {
  return {
    pubkey: TARGET,
    name: "Scout",
    personaId: null,
    runtime: null,
    relayUrl: "ws://localhost:3000",
    acpCommand: "buzz-acp",
    agentCommand: "goose",
    agentCommandOverride: null,
    agentArgs: [],
    mcpCommand: "",
    turnTimeoutSeconds: 320,
    idleTimeoutSeconds: null,
    maxTurnDurationSeconds: null,
    parallelism: 1,
    systemPrompt: "old prompt",
    avatarUrl: null,
    model: null,
    modelSource: null,
    provider: null,
    personaOutOfDate: false,
    personaOrphaned: false,
    needsRestart: false,
    envVars: {},
    respondTo: "owner-only",
    respondToAllowlist: [],
    status: "running",
    pid: 1,
    backend: { type: "local" },
    backendAgentId: null,
    startOnAppLaunch: true,
    autoRestart: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastStartedAt: null,
    ...overrides,
  };
}

function persona(overrides = {}) {
  return {
    id: "persona-1",
    displayName: "Scout",
    avatarUrl: null,
    systemPrompt: "old prompt",
    runtime: "goose",
    model: null,
    provider: null,
    namePool: [],
    isBuiltIn: false,
    isActive: true,
    shared: false,
    sourceTeam: null,
    envVars: {},
    respondTo: null,
    respondToAllowlist: [],
    parallelism: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const goose = {
  id: "goose",
  label: "Goose",
  availability: "available",
  command: "goose",
  binaryPath: "/usr/bin/goose",
  defaultArgs: [],
  mcpCommand: "",
  avatarUrl: null,
};

function channel(memberPubkeys = [REQUESTER]) {
  return {
    id: CHANNEL_ID,
    name: "work",
    isMember: true,
    memberPubkeys,
  };
}

function deps(overrides = {}) {
  const calls = [];
  const record =
    (name) =>
    async (...args) => {
      calls.push([name, ...args]);
      return overrides[name] ? overrides[name](...args) : undefined;
    };
  return {
    calls,
    deps: {
      agents: overrides.agents ?? [managedAgent()],
      personas: overrides.personas ?? [],
      channels: overrides.channels ?? [channel()],
      relayAgents: overrides.relayAgents ?? [],
      preferredRuntimeId: null,
      availableRuntimes: async () => overrides.runtimes ?? [goose],
      resolveAvatarUrl: async (avatarUrl) => avatarUrl,
      createPersona: record("createPersona"),
      createManagedAgent: record("createManagedAgent"),
      updatePersona: record("updatePersona"),
      updateManagedAgent: record("updateManagedAgent"),
      deleteManagedAgent: record("deleteManagedAgent"),
      attachToChannel: record("attachToChannel"),
      removeFromChannel: record("removeFromChannel"),
    },
  };
}

function request(action, fields) {
  return {
    type: "agent_management_request",
    action,
    requestId: `req-${action}`,
    request: { channelId: CHANNEL_ID, ...fields },
  };
}

test("originRejection refuses channels the requester is not in", () => {
  assert.equal(originRejection([channel()], REQUESTER, CHANNEL_ID), null);
  assert.ok(
    originRejection([channel(["b".repeat(64)])], REQUESTER, CHANNEL_ID),
  );
  assert.ok(originRejection([], REQUESTER, CHANNEL_ID));
  assert.ok(
    originRejection([{ ...channel(), isMember: false }], REQUESTER, CHANNEL_ID),
  );
});

test("every action is refused when the origin channel is not shared", async () => {
  const { deps: d, calls } = deps({ channels: [channel(["b".repeat(64)])] });
  for (const req of [
    request("create", { displayName: "X", systemPrompt: "y" }),
    request("update", { agentPubkey: TARGET, model: "m" }),
    request("delete", { agentPubkey: TARGET }),
  ]) {
    const result = await executeAgentManagementRequest(req, REQUESTER, d);
    assert.equal(result.status, "rejected");
    assert.equal(result.requestId, req.requestId);
    assert.equal(result.action, req.action);
  }
  assert.deepEqual(calls, []);
});

test("create builds the definition, starts it, joins the channel, and reports the pubkey", async () => {
  const created = managedAgent({ pubkey: "c".repeat(64), name: "Helper" });
  const { deps: d, calls } = deps({
    createPersona: (input) => persona({ id: "p-new", ...input }),
    createManagedAgent: () => ({
      agent: created,
      privateKeyNsec: "",
      profileSyncError: null,
      spawnError: null,
    }),
  });
  const result = await executeAgentManagementRequest(
    request("create", {
      displayName: "Helper",
      systemPrompt: "Help.",
      respondTo: "anyone",
      parallelism: 3,
    }),
    REQUESTER,
    d,
  );
  assert.deepEqual(result, {
    type: "agent_management_result",
    requestId: "req-create",
    action: "create",
    status: "executed",
    agentPubkey: "c".repeat(64),
    agentName: "Helper",
    personaId: "p-new",
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    ["createPersona", "createManagedAgent", "attachToChannel"],
  );
  assert.deepEqual(calls[0][1].behavior, {
    respondTo: "anyone",
    parallelism: 3,
  });
  assert.equal(calls[1][1].personaId, "p-new");
  assert.equal(calls[1][1].agentCommand, "goose");
  assert.equal(calls[2][1], CHANNEL_ID);
  assert.equal(calls[2][2], created);
});

test("create with start=false saves the definition only", async () => {
  const { deps: d, calls } = deps({
    createPersona: (input) => persona({ id: "p-new", ...input }),
  });
  const result = await executeAgentManagementRequest(
    request("create", {
      displayName: "Helper",
      systemPrompt: "Help.",
      start: false,
    }),
    REQUESTER,
    d,
  );
  assert.equal(result.status, "executed");
  assert.equal(result.personaId, "p-new");
  assert.equal(result.agentPubkey, undefined);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["createPersona"],
  );
});

test("create rejects an unavailable runtime before touching anything", async () => {
  const { deps: d, calls } = deps();
  const result = await executeAgentManagementRequest(
    request("create", {
      displayName: "H",
      systemPrompt: "x",
      runtime: "claude",
    }),
    REQUESTER,
    d,
  );
  assert.equal(result.status, "rejected");
  assert.match(result.error, /claude/);
  assert.deepEqual(calls, []);
});

test("create reports a spawn error as failed but still names what was made", async () => {
  const { deps: d } = deps({
    createPersona: (input) => persona({ id: "p-new", ...input }),
    createManagedAgent: () => ({
      agent: managedAgent({ pubkey: "c".repeat(64), name: "Helper" }),
      privateKeyNsec: "",
      profileSyncError: null,
      spawnError: "binary missing",
    }),
  });
  const result = await executeAgentManagementRequest(
    request("create", { displayName: "Helper", systemPrompt: "Help." }),
    REQUESTER,
    d,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.agentPubkey, "c".repeat(64));
  assert.match(result.error, /binary missing/);
});

test("update on a persona-linked agent edits the definition and syncs the instance", async () => {
  const linked = managedAgent({ personaId: "persona-1" });
  const { deps: d, calls } = deps({
    agents: [linked],
    personas: [persona()],
    updatePersona: (input) => persona({ ...input }),
    updateManagedAgent: (input) => ({
      agent: { ...linked, ...input },
      profileSyncError: null,
    }),
  });
  const result = await executeAgentManagementRequest(
    request("update", { agentName: "scout", systemPrompt: "new prompt" }),
    REQUESTER,
    d,
  );
  assert.equal(result.status, "executed");
  assert.equal(result.agentPubkey, TARGET);
  assert.equal(result.personaId, "persona-1");
  assert.equal(calls[0][0], "updatePersona");
  assert.equal(calls[0][1].id, "persona-1");
  assert.equal(calls[0][1].systemPrompt, "new prompt");
  assert.equal(calls[0][1].displayName, "Scout");
  assert.equal(calls[1][0], "updateManagedAgent");
  assert.equal(calls[1][1].systemPrompt, "new prompt");
});

test("update on a definition-less agent patches the instance directly", async () => {
  const { deps: d, calls } = deps({
    updateManagedAgent: (input) => ({
      agent: managedAgent({ name: input.name ?? "Scout" }),
      profileSyncError: null,
    }),
  });
  const result = await executeAgentManagementRequest(
    request("update", {
      agentPubkey: TARGET,
      displayName: "Scout 2",
      respondTo: "anyone",
    }),
    REQUESTER,
    d,
  );
  assert.equal(result.status, "executed");
  assert.equal(result.agentName, "Scout 2");
  assert.deepEqual(calls[0][1], {
    pubkey: TARGET,
    name: "Scout 2",
    respondTo: "anyone",
    respondToAllowlist: [],
  });
});

test("update refuses ambiguous names, unknown targets, and team agents", async () => {
  const ambiguous = deps({
    agents: [managedAgent(), managedAgent({ pubkey: "b".repeat(64) })],
  });
  let result = await executeAgentManagementRequest(
    request("update", { agentName: "Scout", model: "m" }),
    REQUESTER,
    ambiguous.deps,
  );
  assert.equal(result.status, "rejected");
  assert.match(result.error, /pubkey/);

  const unknown = deps();
  result = await executeAgentManagementRequest(
    request("update", { agentPubkey: "9".repeat(64), model: "m" }),
    REQUESTER,
    unknown.deps,
  );
  assert.equal(result.status, "rejected");

  const team = deps({
    agents: [managedAgent({ personaId: "persona-1" })],
    personas: [persona({ sourceTeam: "team-x" })],
  });
  result = await executeAgentManagementRequest(
    request("update", { agentPubkey: TARGET, model: "m" }),
    REQUESTER,
    team.deps,
  );
  assert.equal(result.status, "rejected");
  assert.match(result.error, /team/i);
  assert.deepEqual(team.calls, []);
});

test("delete removes the agent and its channel memberships", async () => {
  const { deps: d, calls } = deps({
    relayAgents: [
      {
        pubkey: TARGET,
        ownerPubkey: null,
        name: "Scout",
        agentType: "",
        channels: ["work", "other"],
        channelIds: [CHANNEL_ID, "other-id"],
        capabilities: [],
        status: "online",
        respondTo: null,
        respondToAllowlist: [],
      },
    ],
  });
  const result = await executeAgentManagementRequest(
    request("delete", { agentName: "Scout" }),
    REQUESTER,
    d,
  );
  assert.deepEqual(result, {
    type: "agent_management_result",
    requestId: "req-delete",
    action: "delete",
    status: "executed",
    agentPubkey: TARGET,
    agentName: "Scout",
  });
  assert.deepEqual(calls, [
    ["deleteManagedAgent", { pubkey: TARGET, forceRemoteDelete: undefined }],
    ["removeFromChannel", CHANNEL_ID, TARGET],
    ["removeFromChannel", "other-id", TARGET],
  ]);
});

test("an agent cannot delete itself", async () => {
  const { deps: d, calls } = deps({
    agents: [managedAgent({ pubkey: REQUESTER, name: "Me" })],
  });
  const result = await executeAgentManagementRequest(
    request("delete", { agentPubkey: REQUESTER }),
    REQUESTER,
    d,
  );
  assert.equal(result.status, "rejected");
  assert.match(result.error, /itself/);
  assert.deepEqual(calls, []);
});

test("thrown mutation errors become failed results, never exceptions", async () => {
  const { deps: d } = deps({
    deleteManagedAgent: () => {
      throw new Error("disk on fire");
    },
  });
  const result = await executeAgentManagementRequest(
    request("delete", { agentPubkey: TARGET }),
    REQUESTER,
    d,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error, "disk on fire");
});
