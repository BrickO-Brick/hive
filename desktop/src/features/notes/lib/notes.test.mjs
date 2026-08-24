import assert from "node:assert/strict";
import test from "node:test";

import {
  longFormNoteCoordinate,
  noteDisplayTimestamp,
  plainTextExcerpt,
} from "./notes.ts";

const note = {
  coordinate: "30023:abc:release",
  id: "event",
  pubkey: "abc",
  slug: "release",
  title: "Release",
  summary: null,
  topics: [],
  publishedAt: 20,
  updatedAt: null,
  createdAt: 10,
  content: "# Hello **world** [link](https://example.com)",
};

test("coordinate normalizes author casing without changing slug", () => {
  assert.equal(
    longFormNoteCoordinate(" ABC ", "Release-V1"),
    "30023:abc:Release-V1",
  );
});

test("excerpt strips common markdown syntax", () => {
  assert.equal(plainTextExcerpt(note), "Hello world link");
});

test("display timestamp prefers updated, then published, then created", () => {
  assert.equal(noteDisplayTimestamp(note), 20);
  assert.equal(noteDisplayTimestamp({ ...note, updatedAt: 30 }), 30);
  assert.equal(noteDisplayTimestamp({ ...note, publishedAt: null }), 10);
});
