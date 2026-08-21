import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_MANAGEMENT_REQUEST,
  AGENT_MANAGEMENT_RESULT,
  MAX_PARALLELISM,
  buildAgentManagementResult,
  createInputFromRequest,
  parseAgentManagementRequest,
  requestTargetsEditablePersona,
  resolveAgentTarget,
  updateInputFromRequest,
} from "./agentManagement.ts";

const CHANNEL_ID = "7c07e659-3610-42f4-9a5e-1e9973c09da9";
const PUBKEY = "a".repeat(64);

function createPayload(overrides = {}) {
  return {
    type: AGENT_MANAGEMENT_REQUEST,
    action: "create",
    requestId: "request-1",
    request: {
      channelId: CHANNEL_ID,
      displayName: "Research helper",
      systemPrompt: "Find reliable sources and summarize them.",
    },
    ...overrides,
  };
}

test("parses the minimal create request", () => {
  assert.deepEqual(
    parseAgentManagementRequest(createPayload()),
    createPayload(),
  );
});

test("parses the full create request the CLI can send", () => {
  const payload = createPayload();
  Object.assign(payload.request, {
    runtime: "claude",
    provider: "anthropic",
    model: "claude-opus",
    respondTo: "anyone",
    parallelism: 4,
    avatarUrl: "https://example.com/a.png",
    start: false,
  });
  payload.review = true;
  assert.deepEqual(parseAgentManagementRequest(payload), payload);
});

test("rejects an agent-management request with extra secret-shaped fields", () => {
  const payload = createPayload();
  payload.request.apiKey = "should-not-be-accepted";
  assert.equal(parseAgentManagementRequest(payload), null);

  const env = createPayload();
  env.request.envVars = { OPENAI_API_KEY: "x" };
  assert.equal(parseAgentManagementRequest(env), null);
});

test("rejects out-of-range and mistyped create fields", () => {
  for (const [field, value] of [
    ["respondTo", "allowlist"],
    ["parallelism", 0],
    ["parallelism", MAX_PARALLELISM + 1],
    ["parallelism", "4"],
    ["start", "yes"],
    ["displayName", "x".repeat(121)],
    ["runtime", ""],
  ]) {
    const payload = createPayload();
    payload.request[field] = value;
    assert.equal(parseAgentManagementRequest(payload), null, field);
  }
  assert.equal(
    parseAgentManagementRequest(createPayload({ review: "true" })),
    null,
  );
});

test("a minimal create leaves advanced behavior unset so the form stays collapsed", () => {
  const parsed = parseAgentManagementRequest(createPayload());
  assert.ok(parsed && parsed.action === "create");
  assert.deepEqual(createInputFromRequest(parsed), {
    displayName: "Research helper",
    systemPrompt: "Find reliable sources and summarize them.",
  });
});

test("a full create maps every field onto the persona input", () => {
  const payload = createPayload();
  Object.assign(payload.request, {
    runtime: "claude",
    provider: "anthropic",
    model: "claude-opus",
    respondTo: "anyone",
    parallelism: 4,
    avatarUrl: "https://example.com/a.png",
  });
  const parsed = parseAgentManagementRequest(payload);
  assert.ok(parsed && parsed.action === "create");
  assert.deepEqual(createInputFromRequest(parsed), {
    displayName: "Research helper",
    systemPrompt: "Find reliable sources and summarize them.",
    runtime: "claude",
    provider: "anthropic",
    model: "claude-opus",
    avatarUrl: "https://example.com/a.png",
    behavior: { respondTo: "anyone", parallelism: 4 },
  });
});

test("requires the originating channel for every action", () => {
  for (const action of ["create", "update", "delete"]) {
    const payload = {
      type: AGENT_MANAGEMENT_REQUEST,
      action,
      requestId: "request-2",
      request: {
        displayName: "Review helper",
        agentName: "Review helper",
        systemPrompt: "Review changes concisely.",
      },
    };
    assert.equal(parseAgentManagementRequest(payload), null, action);
  }
});

test("update targets an agent by name or pubkey, never both, never an internal id", () => {
  const base = {
    type: AGENT_MANAGEMENT_REQUEST,
    action: "update",
    requestId: "request-3",
  };
  const byName = {
    ...base,
    request: {
      channelId: CHANNEL_ID,
      agentName: "Review helper",
      systemPrompt: "Review changes concisely.",
    },
  };
  assert.deepEqual(parseAgentManagementRequest(byName), byName);

  const byPubkey = {
    ...base,
    request: {
      channelId: CHANNEL_ID,
      agentPubkey: PUBKEY.toUpperCase(),
      model: "gpt-5",
    },
  };
  assert.deepEqual(parseAgentManagementRequest(byPubkey), {
    ...byPubkey,
    request: { ...byPubkey.request, agentPubkey: PUBKEY },
  });

  assert.equal(
    parseAgentManagementRequest({
      ...base,
      request: {
        channelId: CHANNEL_ID,
        agentName: "Review helper",
        agentPubkey: PUBKEY,
        model: "gpt-5",
      },
    }),
    null,
  );
  assert.equal(
    parseAgentManagementRequest({
      ...base,
      request: { channelId: CHANNEL_ID, personaId: "abc", model: "gpt-5" },
    }),
    null,
  );
  assert.equal(
    parseAgentManagementRequest({
      ...base,
      request: { channelId: CHANNEL_ID, agentPubkey: "not-hex", model: "x" },
    }),
    null,
  );
});

test("an update with nothing to change is rejected", () => {
  assert.equal(
    parseAgentManagementRequest({
      type: AGENT_MANAGEMENT_REQUEST,
      action: "update",
      requestId: "request-4",
      request: { channelId: CHANNEL_ID, agentName: "Review helper" },
    }),
    null,
  );
});

test("delete carries only the channel and a target", () => {
  const payload = {
    type: AGENT_MANAGEMENT_REQUEST,
    action: "delete",
    requestId: "request-5",
    request: { channelId: CHANNEL_ID, agentPubkey: PUBKEY },
  };
  assert.deepEqual(parseAgentManagementRequest(payload), payload);
  assert.equal(
    parseAgentManagementRequest({
      ...payload,
      request: { ...payload.request, systemPrompt: "x" },
    }),
    null,
  );
});

test("unknown actions are ignored", () => {
  assert.equal(
    parseAgentManagementRequest(createPayload({ action: "start" })),
    null,
  );
});

test("allows agents to update only personal, editable profiles", () => {
  assert.equal(
    requestTargetsEditablePersona({ isBuiltIn: false, sourceTeam: null }),
    true,
  );
  assert.equal(
    requestTargetsEditablePersona({ isBuiltIn: true, sourceTeam: null }),
    true,
  );
  assert.equal(
    requestTargetsEditablePersona({ isBuiltIn: false, sourceTeam: "team" }),
    false,
  );
});

test("updateInputFromRequest overlays only the requested fields", () => {
  const current = {
    id: "p1",
    displayName: "Old",
    systemPrompt: "old prompt",
    runtime: "goose",
    model: "m1",
    provider: "pr1",
    namePool: ["a"],
    envVars: { K: "v" },
    behavior: { respondTo: "owner-only", parallelism: 2 },
  };
  const next = updateInputFromRequest(
    {
      type: AGENT_MANAGEMENT_REQUEST,
      action: "update",
      requestId: "r",
      request: {
        channelId: CHANNEL_ID,
        agentName: "Old",
        systemPrompt: "new prompt",
        respondTo: "anyone",
      },
    },
    current,
  );
  assert.deepEqual(next, {
    ...current,
    systemPrompt: "new prompt",
    behavior: { respondTo: "anyone", respondToAllowlist: [], parallelism: 2 },
  });
});

test("resolveAgentTarget matches pubkeys case-insensitively and refuses ambiguous names", () => {
  const agents = [
    { pubkey: PUBKEY, name: "Scout" },
    { pubkey: "b".repeat(64), name: "scout " },
    { pubkey: "c".repeat(64), name: "Solo" },
  ];
  assert.equal(
    resolveAgentTarget(agents, { agentPubkey: PUBKEY.toUpperCase() }).agent,
    agents[0],
  );
  assert.equal(
    resolveAgentTarget(agents, { agentName: "solo" }).agent,
    agents[2],
  );
  assert.equal(resolveAgentTarget(agents, { agentName: "Scout" }).ok, false);
  assert.equal(
    resolveAgentTarget(agents, { agentPubkey: "d".repeat(64) }).ok,
    false,
  );
  assert.equal(resolveAgentTarget(undefined, { agentName: "Solo" }).ok, false);
});

test("buildAgentManagementResult emits the SDK result shape", () => {
  assert.deepEqual(
    buildAgentManagementResult(
      { requestId: "r1", action: "create" },
      "executed",
      { agentPubkey: PUBKEY, agentName: "Scout", personaId: "p1" },
    ),
    {
      type: AGENT_MANAGEMENT_RESULT,
      requestId: "r1",
      action: "create",
      status: "executed",
      agentPubkey: PUBKEY,
      agentName: "Scout",
      personaId: "p1",
    },
  );
});
