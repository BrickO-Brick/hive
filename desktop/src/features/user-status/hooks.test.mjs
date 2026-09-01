import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchUserStatusLookup,
  USER_STATUS_AUTHOR_CHUNK_SIZE,
} from "./hooks.ts";

function statusEvent(pubkey, createdAt = 1) {
  return {
    id: `${pubkey}-${createdAt}`,
    kind: 30315,
    pubkey,
    content: `Status ${pubkey}`,
    tags: [
      ["d", "general"],
      ["emoji", "💬"],
    ],
    created_at: createdAt,
    sig: "",
  };
}

test("fetches every current status when the author set exceeds one relay page", async () => {
  const pubkeys = Array.from(
    { length: USER_STATUS_AUTHOR_CHUNK_SIZE + 7 },
    (_, index) => index.toString(16).padStart(64, "0"),
  );
  const filters = [];
  const lookup = await fetchUserStatusLookup(pubkeys, async (filter) => {
    filters.push(filter);
    return filter.authors.map((pubkey) => statusEvent(pubkey));
  });

  assert.equal(filters.length, 2);
  assert.equal(filters[0].authors.length, USER_STATUS_AUTHOR_CHUNK_SIZE);
  assert.equal(filters[1].authors.length, 7);
  assert.equal(Object.keys(lookup).length, pubkeys.length);
  for (const pubkey of pubkeys) {
    assert.equal(lookup[pubkey]?.text, `Status ${pubkey}`);
  }
});
