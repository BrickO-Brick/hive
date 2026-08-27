import assert from "node:assert/strict";
import test from "node:test";

import { collectionMessageLabel } from "./messageLabel.ts";

test("collection message labels flatten multiline thread roots", () => {
  const label = collectionMessageLabel(
    "First line\nSecond line\r\nThird line\u0000",
    "Author",
  );

  assert.equal(label, "First line Second line Third line");
  assert.equal(
    [...label].some((character) => /\p{Cc}/u.test(character)),
    false,
  );
});

test("collection message labels use a safe author fallback and stay bounded", () => {
  const label = collectionMessageLabel("\n\r", `Agent\n${"x".repeat(200)}`);

  assert.equal(Array.from(label).length, 120);
  assert.equal(label.startsWith("Agent x"), true);
});
