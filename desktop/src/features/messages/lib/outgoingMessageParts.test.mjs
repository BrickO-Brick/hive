import assert from "node:assert/strict";
import test from "node:test";

import { buildOutgoingMessageParts } from "./outgoingMessageParts.ts";

const image = {
  filename: "photo.png",
  sha256: "a".repeat(64),
  size: 123,
  type: "image/png",
  uploaded: 1,
  url: "https://relay.example/media/photo.png",
};

test("mixed submissions put one media event before the text event", () => {
  const emojiTag = ["emoji", "ship", "https://relay.example/ship.png"];
  const parts = buildOutgoingMessageParts({
    body: "hello :ship:",
    media: [image, { ...image, filename: "second.png", url: `${image.url}?2` }],
    nowSeconds: 100,
    textTags: [emojiTag],
  });

  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, "media");
  assert.equal(parts[0].createdAt, 99);
  assert.match(parts[0].content, /photo\.png/);
  assert.match(parts[0].content, /photo\.png\?2/);
  assert.equal(parts[0].outgoingTags?.length, 2);
  assert.deepEqual(parts[1], {
    content: "hello :ship:",
    kind: "text",
    outgoingTags: [emojiTag],
  });
});

test("attachment-only submissions remain one media event", () => {
  const parts = buildOutgoingMessageParts({
    body: "",
    media: [image],
    nowSeconds: 100,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, "media");
  assert.equal(parts[0].createdAt, undefined);
});

test("text-only submissions remain one text event", () => {
  assert.deepEqual(buildOutgoingMessageParts({ body: "hello", media: [] }), [
    { content: "hello", kind: "text", outgoingTags: undefined },
  ]);
});
