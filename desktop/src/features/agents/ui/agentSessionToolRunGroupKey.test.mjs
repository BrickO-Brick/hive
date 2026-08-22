import assert from "node:assert/strict";
import test from "node:test";

import { getToolRunGroupKey } from "./agentSessionToolRunGroupKey.ts";

const timestamp = "2026-06-14T22:20:23.000Z";

function tool(id, turnId = "turn-1") {
  return {
    id,
    type: "tool",
    renderClass: "shell",
    descriptor: { renderClass: "shell", label: "Ran command", preview: null },
    title: "Ran command",
    toolName: "shell",
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "",
    isError: false,
    timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    turnId,
  };
}

test("the key is derived from turn and first leaf, not the batch id", () => {
  const items = [tool("tool:ch1:call-1"), tool("tool:ch1:call-2")];
  assert.equal(
    getToolRunGroupKey({ id: "summary:shell:tool:ch1:call-1", items }),
    "group:turn-1:tool:ch1:call-1",
  );
});

test("the key survives the same-kind to mixed transition", () => {
  const items = [tool("tool:ch1:call-1"), tool("tool:ch1:call-2")];
  const sameKind = getToolRunGroupKey({
    id: "summary:shell:tool:ch1:call-1",
    items,
  });
  const mixed = getToolRunGroupKey({
    id: "summary:mixed:tool:ch1:call-1",
    items: [...items, tool("tool:ch1:call-3")],
  });
  assert.equal(sameKind, mixed);
});

test("appending live calls to a growing group does not churn the key", () => {
  const first = tool("tool:ch1:call-1");
  const growing = getToolRunGroupKey({ id: "summary:mixed:x", items: [first] });
  const grown = getToolRunGroupKey({
    id: "summary:mixed:x",
    items: [first, tool("tool:ch1:call-2"), tool("tool:ch1:call-3")],
  });
  assert.equal(growing, grown);
});

test("two turns doing identical work never collide", () => {
  const a = getToolRunGroupKey({
    id: "summary:shell:a",
    items: [tool("tool:ch1:call-1", "turn-1")],
  });
  const b = getToolRunGroupKey({
    id: "summary:shell:a",
    items: [tool("tool:ch1:call-1", "turn-2")],
  });
  assert.notEqual(a, b);
});

test("a group without turn identity still keys off its first leaf", () => {
  assert.equal(
    getToolRunGroupKey({
      id: "summary:shell:x",
      items: [tool("tool:ch1:call-9", null)],
    }),
    "group:no-turn:tool:ch1:call-9",
  );
});

test("distinct groups in one turn get distinct keys", () => {
  const a = getToolRunGroupKey({
    id: "summary:shell:a",
    items: [tool("tool:ch1:call-1")],
  });
  const b = getToolRunGroupKey({
    id: "summary:shell:b",
    items: [tool("tool:ch1:call-7")],
  });
  assert.notEqual(a, b);
});

test("an empty group falls back to its batch id rather than colliding", () => {
  const a = getToolRunGroupKey({ id: "summary:mixed:a", items: [] });
  const b = getToolRunGroupKey({ id: "summary:mixed:b", items: [] });
  assert.notEqual(a, b);
});
