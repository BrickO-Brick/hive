import assert from "node:assert/strict";
import test from "node:test";

const layout = await import("./messageBubbleLayout.ts");

test("lets long bubbles use more of wide conversations", () => {
  assert.equal(
    layout.MESSAGE_BUBBLE_MAX_WIDTH_CLASSES,
    "max-w-[min(72%,48rem)]",
  );
});

test("uses full radii for a standalone left-aligned bubble", () => {
  assert.equal(
    layout.getMessageBubbleLayout(false, false).radiusClass,
    "rounded-r-2xl rounded-tl-2xl rounded-bl-2xl",
  );
});

test("joins grouped left-aligned bubbles on their left edge", () => {
  assert.equal(
    layout.getMessageBubbleLayout(false, true).radiusClass,
    "rounded-r-2xl rounded-tl-2xl rounded-bl-md",
  );
  assert.equal(
    layout.getMessageBubbleLayout(true, false).radiusClass,
    "rounded-r-2xl rounded-tl-md rounded-bl-2xl",
  );
});

test("mirrors grouped bubble corners when own messages align right", () => {
  assert.equal(
    layout.getMessageBubbleLayout(false, true, "right").radiusClass,
    "rounded-l-2xl rounded-tr-2xl rounded-br-md",
  );
  assert.equal(
    layout.getMessageBubbleLayout(true, false, "right").radiusClass,
    "rounded-l-2xl rounded-tr-md rounded-br-2xl",
  );
});
