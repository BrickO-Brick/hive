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

test("mixed link submissions put the link preview before remaining text", () => {
  const previewTag = [
    "link-preview",
    "snapshot",
    "1",
    "https://example.com/launch",
  ];
  const emojiTag = ["emoji", "ship", "https://relay.example/ship.png"];
  const parts = buildOutgoingMessageParts({
    body: "Launch notes https://example.com/launch are ready :ship:",
    media: [],
    nowSeconds: 100,
    textTags: [previewTag, emojiTag],
  });

  assert.deepEqual(parts, [
    {
      content: "https://example.com/launch",
      createdAt: 99,
      kind: "link",
      outgoingTags: [previewTag],
    },
    {
      content: "Launch notes are ready :ship:",
      kind: "text",
      outgoingTags: [emojiTag],
    },
  ]);
});

test("attachment, link, and prose events keep media-first ordering", () => {
  const parts = buildOutgoingMessageParts({
    body: "Context for https://example.com/launch",
    media: [image],
    nowSeconds: 100,
  });

  assert.equal(parts.length, 3);
  assert.equal(parts[0].kind, "media");
  assert.equal(parts[0].createdAt, 98);
  assert.equal(parts[1].kind, "link");
  assert.equal(parts[1].createdAt, 99);
  assert.equal(parts[2].kind, "text");
  assert.equal(parts[2].createdAt, undefined);
});

test("link-only submissions remain one link event", () => {
  assert.deepEqual(
    buildOutgoingMessageParts({
      body: "https://example.com/launch",
      media: [],
      nowSeconds: 100,
    }),
    [
      {
        content: "https://example.com/launch",
        kind: "link",
        outgoingTags: undefined,
      },
    ],
  );
});

test("markdown link labels remain readable in the prose event", () => {
  assert.deepEqual(
    buildOutgoingMessageParts({
      body: "Please review [the launch plan](https://example.com/launch).",
      media: [],
      nowSeconds: 100,
    }),
    [
      {
        content: "https://example.com/launch",
        createdAt: 99,
        kind: "link",
        outgoingTags: undefined,
      },
      {
        content: "Please review the launch plan.",
        kind: "text",
        outgoingTags: undefined,
      },
    ],
  );
});
