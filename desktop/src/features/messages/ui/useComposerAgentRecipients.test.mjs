import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() =>
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  }),
);
afterEach(async () => (await import("@testing-library/react")).cleanup());
after(() => dom.window.close());

test("recipient preview reacts to editor and audience changes without rerendering on ordinary typing", async () => {
  const { act, renderHook } = await import("@testing-library/react");
  const { Editor } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { useComposerAgentRecipients } = await import(
    "./useComposerAgentRecipients.ts"
  );
  const { extractMentionPubkeys } = await import(
    "../lib/extractMentionPubkeys.ts"
  );
  const agentA = "a".repeat(64);
  const agentB = "b".repeat(64);
  const human = "c".repeat(64);
  const candidates = [
    { displayName: "Ada", pubkey: agentA, isMember: true },
    { displayName: "Bea", pubkey: agentB, isMember: true },
    { displayName: "Human", pubkey: human, isMember: true },
  ];
  const editor = new Editor({
    extensions: [StarterKit],
    content: "<p>@Ada hello</p>",
  });
  let serializations = 0;
  let renders = 0;
  const mentions = {
    getDraftMentionRefs: () => [],
    extractMentionPubkeys: (text) =>
      extractMentionPubkeys({
        text,
        selectedMentions: new Map(),
        memberCandidates: candidates,
      }),
    isAgentPubkey: (key) => key === agentA || key === agentB,
    getMentionDisplayName: (key) =>
      candidates.find((candidate) => candidate.pubkey === key)?.displayName,
  };
  const richText = {
    editor,
    getMarkdown: () => {
      serializations += 1;
      return editor.getText();
    },
  };
  const { result, rerender, unmount } = renderHook(
    ({ audience }) => {
      renders += 1;
      return useComposerAgentRecipients({
        audiencePubkeys: audience,
        mentions,
        richText,
      });
    },
    { initialProps: { audience: [] } },
  );
  assert.deepEqual(
    result.current.map(({ pubkey, isAutomatic }) => [pubkey, isAutomatic]),
    [[agentA, false]],
  );
  const beforeTyping = renders;
  act(() => {
    editor.commands.insertContentAt(
      editor.state.doc.content.size - 1,
      " world",
    );
  });
  assert.equal(renders, beforeTyping);
  const beforeSelection = serializations;
  act(() => {
    editor.commands.setTextSelection(1);
  });
  assert.equal(serializations, beforeSelection);
  act(() => {
    editor.commands.setContent("<p>@Ada @Bea @Human</p>");
  });
  assert.deepEqual(
    result.current.map(({ pubkey }) => pubkey),
    [agentA, agentB],
  );
  rerender({ audience: [agentB] });
  assert.equal(
    result.current.find(({ pubkey }) => pubkey === agentB).isAutomatic,
    true,
  );
  act(() => {
    editor.commands.setContent("<p>@Human</p>");
  });
  assert.deepEqual(
    result.current.map(({ pubkey }) => pubkey),
    [agentB],
  );
  rerender({ audience: [] });
  assert.deepEqual(result.current, []);
  unmount();
  editor.destroy();
});
