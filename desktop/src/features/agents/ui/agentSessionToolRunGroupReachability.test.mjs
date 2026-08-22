import assert from "node:assert/strict";
import test from "node:test";

import { buildTranscript } from "./agentSessionTranscript.ts";
import { buildTranscriptDisplayBlocks } from "./agentSessionTranscriptGrouping.ts";
import { getToolRunGroupKey } from "./agentSessionToolRunGroupKey.ts";
import { collectToolRunArtifacts } from "./agentSessionToolRunPartition.ts";
import { getToolRunGroupStatus } from "./agentSessionToolRunStatus.ts";
import { initialToolRunGroupViewState } from "./agentSessionToolRunViewState.ts";
import {
  readToolRunGroupViewState,
  resetAgentSessionToolRunViewState,
  writeToolRunGroupViewState,
} from "./agentSessionToolRunViewStore.ts";

/**
 * The group-presentation units (status, partition, artifacts, view state) are
 * each unit-tested against hand-built `TranscriptItem` fixtures. Those tests
 * cannot say whether the states they describe are ever produced by real
 * observer frames — grouping eligibility is decided in
 * `agentSessionTranscriptGrouping`, several layers away from the fixtures.
 *
 * So these tests drive the REAL pipeline (`buildTranscript` →
 * `buildTranscriptDisplayBlocks`) from ACP session/update frames and assert
 * what a reader can actually end up looking at: where a failure lands, whether
 * artifact chips have anything to show, and whether a group's durable key
 * really holds still across re-derivation.
 */

const baseEvent = {
  seq: 1,
  timestamp: "2026-06-18T00:00:00Z",
  kind: "acp_read",
  agentIndex: 0,
  channelId: "11111111-1111-1111-1111-111111111111",
  sessionId: "sess-1",
  turnId: "turn-1",
};

function frame(seq, update) {
  return {
    ...baseEvent,
    seq,
    payload: {
      method: "session/update",
      params: { sessionId: baseEvent.sessionId, update },
    },
  };
}

function readFile(seq, toolCallId, path, overrides = {}) {
  return frame(seq, {
    sessionUpdate: "tool_call",
    toolCallId,
    status: "completed",
    title: "read_file",
    kind: "read_file",
    rawInput: { path },
    rawOutput: "contents",
    ...overrides,
  });
}

function shell(seq, toolCallId, command, overrides = {}) {
  return frame(seq, {
    sessionUpdate: "tool_call",
    toolCallId,
    status: "completed",
    title: "shell",
    kind: "shell",
    rawInput: { command },
    rawOutput: "ok",
    ...overrides,
  });
}

function editFile(seq, toolCallId, path, overrides = {}) {
  return frame(seq, {
    sessionUpdate: "tool_call",
    toolCallId,
    status: "completed",
    title: "str_replace",
    kind: "edit",
    rawInput: { path, old_str: "a", new_str: "b" },
    rawOutput: "edited",
    ...overrides,
  });
}

/** Every turn segment as `"item:<id>"` or `"summary:<status>:<ids>"`. */
function describeSegments(events) {
  const blocks = buildTranscriptDisplayBlocks(buildTranscript(events));
  const described = [];
  for (const block of blocks) {
    if (block.kind !== "turn") continue;
    for (const segment of block.segments) {
      if (segment.kind === "item") {
        described.push(`item:${segment.item.id}`);
        continue;
      }
      if (segment.kind !== "summary") continue;
      const { summary } = segment;
      described.push(
        `summary:${getToolRunGroupStatus(summary.items)}:${summary.items
          .map((item) => item.id)
          .join(",")}`,
      );
    }
  }
  return described;
}

function summaries(events) {
  const blocks = buildTranscriptDisplayBlocks(buildTranscript(events));
  const collected = [];
  const walk = (summary) => {
    collected.push(summary);
    for (const child of summary.segments ?? []) {
      if (child.kind === "summary") walk(child.summary);
    }
  };
  for (const block of blocks) {
    if (block.kind !== "turn") continue;
    for (const segment of block.segments) {
      if (segment.kind === "summary") walk(segment.summary);
    }
  }
  return collected;
}

// --- failure placement ------------------------------------------------------

test("a failed tool call is never folded inside a group summary", () => {
  // isGroupingEligible rejects `isError` items, so a failure breaks the run and
  // lands as its own segment. That — not the group's aggregate badge — is what
  // actually keeps a failure visible in a collapsed transcript, and it is the
  // invariant a future grouping change must not quietly drop.
  const events = [
    readFile(1, "read-a", "src/a.ts"),
    frame(2, {
      sessionUpdate: "tool_call",
      toolCallId: "boom",
      status: "failed",
      title: "shell",
      kind: "shell",
      rawInput: { command: "pnpm build" },
      rawOutput: "exit 1",
    }),
    readFile(3, "read-b", "src/b.ts"),
    readFile(4, "read-c", "src/c.ts"),
  ];

  const described = describeSegments(events);
  const failedSegment = described.find((entry) => entry.includes("boom"));
  assert.ok(failedSegment, `no segment mentioned the failure: ${described}`);
  assert.ok(
    failedSegment.startsWith("item:"),
    `the failure must be its own row, got ${failedSegment}`,
  );

  for (const summary of summaries(events)) {
    assert.equal(
      summary.items.some((item) => item.id.includes("boom")),
      false,
      `summary ${summary.id} absorbed the failed call`,
    );
    assert.equal(
      getToolRunGroupStatus(summary.items),
      "completed",
      `summary ${summary.id} should hold only clean work`,
    );
  }
});

test("a call that fails on a later update is ejected from the group it was in", () => {
  // The interesting case is a call that groups cleanly while executing and only
  // fails later: re-derivation must move it out rather than leave a failure
  // hidden behind a collapsed "Ran 3 commands".
  const executing = [
    shell(1, "cmd-a", "pnpm lint", { status: "executing", rawOutput: "" }),
    shell(2, "cmd-b", "pnpm test", { status: "executing", rawOutput: "" }),
    shell(3, "cmd-c", "pnpm build", { status: "executing", rawOutput: "" }),
  ];

  const grouped = summaries(executing);
  assert.equal(
    grouped.length,
    1,
    "three executing shells group while in-flight",
  );
  assert.equal(getToolRunGroupStatus(grouped[0].items), "executing");

  const settled = [
    ...executing,
    frame(4, {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-a",
      status: "completed",
      rawOutput: "ok",
    }),
    frame(5, {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-b",
      status: "failed",
      rawOutput: "1 failing",
    }),
    frame(6, {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-c",
      status: "completed",
      rawOutput: "ok",
    }),
  ];

  for (const summary of summaries(settled)) {
    assert.equal(
      summary.items.some((item) => item.id.includes("cmd-b")),
      false,
      `summary ${summary.id} kept the now-failed call`,
    );
  }
  const described = describeSegments(settled);
  assert.ok(
    described.some(
      (entry) => entry.startsWith("item:") && entry.includes("cmd-b"),
    ),
    `the failed call must surface as its own row: ${described}`,
  );
});

test("in-flight work does reach the group aggregate", () => {
  // Guards the two assertions above against a false pass: if grouping stopped
  // producing summaries at all, "no summary contains a failure" would be
  // vacuously true. A running burst must still aggregate as running.
  const events = [
    readFile(1, "read-a", "src/a.ts", { status: "executing", rawOutput: "" }),
    readFile(2, "read-b", "src/b.ts", { status: "executing", rawOutput: "" }),
    readFile(3, "read-c", "src/c.ts", { status: "pending", rawOutput: "" }),
  ];

  const grouped = summaries(events);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].items.length, 3);
  assert.equal(getToolRunGroupStatus(grouped[0].items), "executing");
});

// --- artifacts --------------------------------------------------------------

test("artifact chips are derivable from the args real frames carry", () => {
  // collectToolRunArtifacts reads `path`/`file_path`/`filePath` off item args.
  // Its unit test supplies those directly; this pins that ACP `rawInput`
  // actually survives into that shape, so the chips outside the collapsed body
  // are not empty in practice.
  const events = [
    readFile(1, "read-a", "src/kept.ts"),
    readFile(2, "read-b", "src/also.ts"),
    editFile(3, "edit-a", "src/kept.ts"),
    editFile(4, "edit-b", "src/new.ts"),
  ];

  const items = buildTranscript(events).filter((item) => item.type === "tool");
  const artifacts = collectToolRunArtifacts(items);
  const byPath = new Map(
    artifacts.map((artifact) => [artifact.path, artifact.kind]),
  );

  assert.deepEqual(
    [...byPath.entries()].sort(),
    [
      ["src/also.ts", "read"],
      ["src/kept.ts", "edit"],
      ["src/new.ts", "edit"],
    ],
    "an edit outranks a read of the same path",
  );
  assert.deepEqual(artifacts.map((artifact) => artifact.filename).sort(), [
    "also.ts",
    "kept.ts",
    "new.ts",
  ]);
});

// --- durable group identity -------------------------------------------------

/** Group keys for each top-level summary a real frame sequence produces. */
function summaryKeys(events) {
  return summaries(events).map((summary) => getToolRunGroupKey(summary));
}

test("the group key survives a group growing by appended live calls", () => {
  // The stated reason for keying on the first leaf rather than the summary id:
  // a burst that absorbs more calls must not churn. Driven through the real
  // pipeline so the guarantee is about actual re-derivation, not fixture shape.
  const two = [
    readFile(1, "read-a", "src/a.ts", { status: "executing", rawOutput: "" }),
    readFile(2, "read-b", "src/b.ts", { status: "executing", rawOutput: "" }),
  ];
  const three = [
    ...two,
    readFile(3, "read-c", "src/c.ts", { status: "executing", rawOutput: "" }),
  ];

  assert.deepEqual(summaryKeys(two), summaryKeys(three));
});

test("the group key survives the same-kind to mixed transition", () => {
  const sameKind = [
    readFile(1, "read-a", "src/a.ts", { status: "executing", rawOutput: "" }),
    readFile(2, "read-b", "src/b.ts", { status: "executing", rawOutput: "" }),
    readFile(3, "read-c", "src/c.ts", { status: "executing", rawOutput: "" }),
  ];
  const mixed = [
    ...sameKind,
    editFile(4, "edit-a", "src/a.ts", { status: "executing", rawOutput: "" }),
  ];

  const before = summaryKeys(sameKind);
  const after = summaryKeys(mixed);
  assert.equal(before.length, 1);
  assert.ok(
    after.includes(before[0]),
    `key ${before[0]} vanished after the burst went mixed: ${after}`,
  );
});

test("KNOWN GAP: ejecting a group's FIRST leaf churns the key and drops reader state", () => {
  // The first leaf is only stable while it stays in the group. When the first
  // call is the one that fails, `isGroupingEligible` ejects it, the next leaf
  // becomes first, and `group:<turn>:<first leaf>` changes — so
  // `useToolRunGroupViewState` finds nothing in the store under the new key and
  // remounts at mount-policy default, discarding the reader's choice.
  //
  // This pins observed behavior, not desired behavior: the commit message
  // claims expansion "must survive the remount that re-grouping causes", and
  // for a first-leaf ejection it does not. If the key is later made durable
  // against this case (e.g. keyed on the group's min leaf id, or state migrated
  // on eject), this test SHOULD fail and be replaced with the durable
  // assertion.
  const running = [
    shell(1, "cmd-a", "pnpm lint", { status: "executing", rawOutput: "" }),
    shell(2, "cmd-b", "pnpm test", { status: "executing", rawOutput: "" }),
    shell(3, "cmd-c", "pnpm build", { status: "executing", rawOutput: "" }),
  ];
  const firstLeafFailed = [
    ...running,
    frame(4, {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-a",
      status: "failed",
      rawOutput: "boom",
    }),
  ];

  const [keyBefore] = summaryKeys(running);
  const keysAfter = summaryKeys(firstLeafFailed);
  assert.equal(
    keyBefore,
    "group:turn-1:tool:11111111-1111-1111-1111-111111111111:cmd-a",
  );
  assert.equal(keysAfter.length, 1, "the surviving calls still group together");
  assert.notEqual(
    keysAfter[0],
    keyBefore,
    "documented gap: the key is expected to churn here today",
  );

  // And the churn is what actually costs the reader their choice.
  resetAgentSessionToolRunViewState();
  try {
    const readerClosedIt = {
      ...initialToolRunGroupViewState("executing"),
      expanded: false,
      userInteracted: true,
    };
    writeToolRunGroupViewState(keyBefore, readerClosedIt);

    // Positive control: the store does remember state under the key it was
    // written to, so the assertion below is about key churn and not about a
    // no-op write.
    assert.deepEqual(readToolRunGroupViewState(keyBefore), readerClosedIt);

    assert.equal(
      readToolRunGroupViewState(keysAfter[0]),
      undefined,
      "no remembered state is found under the churned key",
    );
    // So the group re-mounts at policy default (open, untouched) instead of the
    // collapsed-by-the-reader state stored a moment earlier.
    assert.deepEqual(
      readToolRunGroupViewState(keysAfter[0]) ??
        initialToolRunGroupViewState("executing"),
      {
        expanded: true,
        userInteracted: false,
        showInternalSteps: false,
        expandedItemIds: [],
      },
    );
  } finally {
    resetAgentSessionToolRunViewState();
  }
});
