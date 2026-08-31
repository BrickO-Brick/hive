import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient } from "@tanstack/react-query";

import { expireUserStatusQueries, userStatusQueryKey } from "./hooks.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function status(expiresAt) {
  return {
    text: "Busy",
    emoji: "🔴",
    updatedAt: 1,
    expiresAt,
  };
}

test("expires due statuses in every cached lookup without relay traffic", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(userStatusQueryKey([ALICE]), {
    [ALICE]: status(100),
  });
  queryClient.setQueryData(userStatusQueryKey([ALICE, BOB]), {
    [ALICE]: status(100),
    [BOB]: status(101),
  });

  assert.equal(expireUserStatusQueries(queryClient, 99), false);
  assert.equal(expireUserStatusQueries(queryClient, 100), true);
  assert.deepEqual(queryClient.getQueryData(userStatusQueryKey([ALICE])), {
    [ALICE]: null,
  });
  assert.deepEqual(queryClient.getQueryData(userStatusQueryKey([ALICE, BOB])), {
    [ALICE]: null,
    [BOB]: status(101),
  });
});

test("an ordinary cache update settles without an expiration write loop", () => {
  const queryClient = new QueryClient();
  let statusUpdates = 0;
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== "user-status") {
      return;
    }
    statusUpdates += 1;
    if (statusUpdates < 5) {
      expireUserStatusQueries(queryClient, 99);
    }
  });

  queryClient.setQueryData(userStatusQueryKey([ALICE]), {
    [ALICE]: status(100),
  });
  unsubscribe();

  assert.equal(statusUpdates, 1);
});
