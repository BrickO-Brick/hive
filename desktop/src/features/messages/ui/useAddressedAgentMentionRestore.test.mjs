import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
let nextFrame = 0;
let frames = new Map();

function flushFrames() {
  const queuedFrames = frames;
  frames = new Map();
  for (const callback of queuedFrames.values()) callback(0);
}

before(() => {
  Object.assign(globalThis, {
    cancelAnimationFrame: (frame) => frames.delete(frame),
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    },
    window: dom.window,
  });
});

beforeEach(async () => {
  const { resetPersistentAgentAudienceStore } = await import(
    "@/features/messages/lib/persistentAgentAudience.ts"
  );
  resetPersistentAgentAudienceStore();
  frames = new Map();
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  frames = new Map();
});

after(() => dom.window.close());

async function renderRestoreHook(initialProps) {
  const { renderHook } = await import("@testing-library/react");
  const { useAddressedAgentMentionRestore } = await import(
    "./useAddressedAgentMentionRestore.ts"
  );
  return renderHook((props) => useAddressedAgentMentionRestore(props), {
    initialProps,
  });
}

test("does not restore the cleared composer after a scope transition", async () => {
  const { act } = await import("@testing-library/react");
  const rootScope = "owner:channel:channel";
  const threadScope = "owner:channel:thread";
  const restored = [];
  const { result, rerender } = await renderRestoreHook({
    audienceScope: rootScope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "@Agent ";
  };
  const capturedClear = result.current.onAddressedAgentsComposerCleared;

  act(() => {
    rerender({
      audienceScope: threadScope,
      channelId: "channel",
      enabled: true,
    });
  });
  const restoredText = capturedClear([AGENT_A]);

  assert.equal(restoredText, "");
  assert.deepEqual(restored, []);
});

test("does not restore the cleared composer after leaving and returning to its scope", async () => {
  const { act } = await import("@testing-library/react");
  const rootScope = "owner:channel:channel";
  const threadScope = "owner:channel:thread";
  const restored = [];
  const { result, rerender } = await renderRestoreHook({
    audienceScope: rootScope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "@Agent ";
  };
  const capturedClear = result.current.onAddressedAgentsComposerCleared;

  act(() => {
    rerender({
      audienceScope: threadScope,
      channelId: "channel",
      enabled: true,
    });
  });
  act(() => {
    rerender({
      audienceScope: rootScope,
      channelId: "channel",
      enabled: true,
    });
  });
  const restoredText = capturedClear([AGENT_A]);

  assert.equal(restoredText, "");
  assert.deepEqual(restored, []);
});

test("does not restore the cleared composer after unmount", async () => {
  const { act } = await import("@testing-library/react");
  const scope = "owner:channel:channel";
  const restored = [];
  const { result, unmount } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "@Agent ";
  };
  const capturedClear = result.current.onAddressedAgentsComposerCleared;

  act(() => unmount());
  const restoredText = capturedClear([AGENT_A]);

  assert.equal(restoredText, "");
  assert.deepEqual(restored, []);
});

test("restores the cleared composer when its audience is current", async () => {
  const scope = "owner:channel:channel";
  const { setPersistentAgentAudience } = await import(
    "@/features/messages/lib/persistentAgentAudience.ts"
  );
  setPersistentAgentAudience(scope, [AGENT_A]);
  const restored = [];
  const { result } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "@Agent A ";
  };

  const restoredText = result.current.onAddressedAgentsComposerCleared([
    AGENT_A,
  ]);

  assert.equal(restoredText, "@Agent A ");
  assert.deepEqual(restored, [[[AGENT_A]]]);
});

test("clearing after same-tick removal restores only remaining agents", async () => {
  const { act } = await import("@testing-library/react");
  const scope = "owner:channel:channel";
  const { excludePersistentAgentAudienceMember, setPersistentAgentAudience } =
    await import("@/features/messages/lib/persistentAgentAudience.ts");
  setPersistentAgentAudience(scope, [AGENT_A, AGENT_B]);
  const restored = [];
  const { result } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "@Agent B ";
  };
  const capturedClear = result.current.onAddressedAgentsComposerCleared;

  let restoredText;
  act(() => {
    excludePersistentAgentAudienceMember(scope, AGENT_A);
    restoredText = capturedClear([AGENT_A, AGENT_B]);
  });

  assert.equal(restoredText, "@Agent B ");
  assert.deepEqual(restored, [[[AGENT_B]]]);
});

test("restores a successful send when its audience is still current", async () => {
  const { act } = await import("@testing-library/react");
  const scope = "owner:channel:channel";
  const { setPersistentAgentAudience } = await import(
    "@/features/messages/lib/persistentAgentAudience.ts"
  );
  setPersistentAgentAudience(scope, [AGENT_A]);
  const restored = [];
  const { result } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "";
  };

  act(() => {
    result.current.onAddressedAgentsSendSucceeded([AGENT_A], [AGENT_A]);
    flushFrames();
  });

  assert.deepEqual(restored, [[[AGENT_A]]]);
});

test("does not restore after a same-tick audience removal", async () => {
  const { act } = await import("@testing-library/react");
  const scope = "owner:channel:channel";
  const { excludePersistentAgentAudienceMember, setPersistentAgentAudience } =
    await import("@/features/messages/lib/persistentAgentAudience.ts");
  setPersistentAgentAudience(scope, [AGENT_A]);
  const restored = [];
  const { result } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "";
  };

  act(() => {
    result.current.onAddressedAgentsSendSucceeded([AGENT_A], [AGENT_A]);
    excludePersistentAgentAudienceMember(scope, AGENT_A);
    flushFrames();
  });

  assert.deepEqual(restored, []);
});

test("does not restore when success is invoked after removal", async () => {
  const { act } = await import("@testing-library/react");
  const scope = "owner:channel:channel";
  const { excludePersistentAgentAudienceMember, setPersistentAgentAudience } =
    await import("@/features/messages/lib/persistentAgentAudience.ts");
  setPersistentAgentAudience(scope, [AGENT_A]);
  const restored = [];
  const { result, rerender } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "";
  };
  const capturedSuccess = result.current.onAddressedAgentsSendSucceeded;

  act(() => {
    excludePersistentAgentAudienceMember(scope, AGENT_A);
    rerender({
      audienceScope: scope,
      channelId: "channel",
      enabled: true,
    });
    capturedSuccess([AGENT_A], [AGENT_A]);
    flushFrames();
  });

  assert.deepEqual(restored, []);
});

test("does not restore after automatic mentions are turned off", async () => {
  const { act } = await import("@testing-library/react");
  const scope = "owner:channel:channel";
  const { setPersistentAgentAudience } = await import(
    "@/features/messages/lib/persistentAgentAudience.ts"
  );
  setPersistentAgentAudience(scope, [AGENT_A]);
  const restored = [];
  const { result, rerender } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "";
  };

  act(() => {
    result.current.onAddressedAgentsSendSucceeded([AGENT_A], [AGENT_A]);
  });
  act(() => {
    rerender({
      audienceScope: scope,
      channelId: "channel",
      enabled: false,
    });
  });
  act(() => {
    flushFrames();
  });

  assert.deepEqual(restored, []);
});

test("does not restore after the composer unmounts", async () => {
  const { act } = await import("@testing-library/react");
  const scope = "owner:channel:channel";
  const { setPersistentAgentAudience } = await import(
    "@/features/messages/lib/persistentAgentAudience.ts"
  );
  setPersistentAgentAudience(scope, [AGENT_A]);
  const restored = [];
  const { result, unmount } = await renderRestoreHook({
    audienceScope: scope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "";
  };

  const capturedSuccess = result.current.onAddressedAgentsSendSucceeded;
  act(() => {
    capturedSuccess([AGENT_A], [AGENT_A]);
    unmount();
    capturedSuccess([AGENT_A], [AGENT_A]);
    flushFrames();
  });

  assert.deepEqual(restored, []);
});

test("does not restore after leaving and returning to the same scope", async () => {
  const { act } = await import("@testing-library/react");
  const rootScope = "owner:channel:channel";
  const threadScope = "owner:channel:thread";
  const { setPersistentAgentAudience } = await import(
    "@/features/messages/lib/persistentAgentAudience.ts"
  );
  setPersistentAgentAudience(rootScope, [AGENT_A]);
  setPersistentAgentAudience(threadScope, [AGENT_B]);
  const restored = [];
  const { result, rerender } = await renderRestoreHook({
    audienceScope: rootScope,
    channelId: "channel",
    enabled: true,
  });
  result.current.restoreAddressedAgentMentionsRef.current = (...args) => {
    restored.push(args);
    return "";
  };

  act(() => {
    result.current.onAddressedAgentsSendSucceeded([AGENT_A], [AGENT_A]);
  });
  act(() => {
    rerender({
      audienceScope: threadScope,
      channelId: "channel",
      enabled: true,
    });
  });
  act(() => {
    rerender({
      audienceScope: rootScope,
      channelId: "channel",
      enabled: true,
    });
    flushFrames();
  });

  assert.deepEqual(restored, []);
});
