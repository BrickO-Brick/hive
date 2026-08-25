import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceProjectChannelRequestQueue,
  createProjectChannelRequestQueue,
  enqueueProjectChannelRequest,
} from "./projectChannelRequestQueue.ts";

function candidate(requestId) {
  return {
    agentPubkey: `agent-${requestId}`,
    request: { requestId },
  };
}

test("accepted requests advance in order while duplicate active requests stay suppressed", () => {
  const queue = createProjectChannelRequestQueue();
  const first = candidate("request-a");
  const second = candidate("request-b");

  assert.equal(enqueueProjectChannelRequest(queue, first), first);
  assert.equal(enqueueProjectChannelRequest(queue, second), null);
  assert.equal(enqueueProjectChannelRequest(queue, first), null);
  assert.equal(advanceProjectChannelRequestQueue(queue), second);
  assert.equal(enqueueProjectChannelRequest(queue, first), null);
  assert.equal(advanceProjectChannelRequestQueue(queue), null);
});
