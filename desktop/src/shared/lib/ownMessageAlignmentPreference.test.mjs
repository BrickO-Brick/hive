import assert from "node:assert/strict";
import test from "node:test";

const values = new Map();
const attributes = new Map();

globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};
globalThis.document = {
  documentElement: {
    setAttribute: (name, value) => attributes.set(name, value),
  },
};

const preference = await import("./ownMessageAlignmentPreference.ts");

test("defaults invalid and missing own-message alignments to left", () => {
  assert.equal(preference.parseOwnMessageAlignment(null), "left");
  assert.equal(preference.parseOwnMessageAlignment("center"), "left");
  assert.equal(preference.parseOwnMessageAlignment("left"), "left");
  assert.equal(preference.parseOwnMessageAlignment("right"), "right");
});

test("persists and applies the selected own-message alignment", () => {
  preference.setOwnMessageAlignment("right");
  assert.equal(preference.getOwnMessageAlignment(), "right");
  assert.equal(preference.getSavedOwnMessageAlignment(), "right");
  assert.equal(
    values.get(preference.OWN_MESSAGE_ALIGNMENT_STORAGE_KEY),
    "right",
  );
  assert.equal(attributes.get("data-own-message-alignment"), "right");
});

test("previews an alignment without changing the saved preference", () => {
  preference.setOwnMessageAlignment("left");
  preference.previewOwnMessageAlignment("right");
  assert.equal(preference.getOwnMessageAlignment(), "right");
  assert.equal(preference.getSavedOwnMessageAlignment(), "left");
  assert.equal(
    values.get(preference.OWN_MESSAGE_ALIGNMENT_STORAGE_KEY),
    "left",
  );
  assert.equal(attributes.get("data-own-message-alignment"), "right");

  preference.previewOwnMessageAlignment(null);
  assert.equal(preference.getOwnMessageAlignment(), "left");
  assert.equal(attributes.get("data-own-message-alignment"), "left");
});

test("initializes from the persisted own-message alignment", () => {
  values.set(preference.OWN_MESSAGE_ALIGNMENT_STORAGE_KEY, "right");
  preference.initializeOwnMessageAlignmentPreference();
  assert.equal(preference.getOwnMessageAlignment(), "right");
  assert.equal(preference.getSavedOwnMessageAlignment(), "right");
});
