import assert from "node:assert/strict";
import test from "node:test";

import { getShortestUniquePathLabels } from "./parseDiff.ts";

test("uses filenames when diff paths have distinct basenames", () => {
  assert.deepEqual(
    getShortestUniquePathLabels([
      "desktop/src/features/channels/ui/ChannelPane.tsx",
      "desktop/src/features/messages/ui/MessageTimeline.tsx",
    ]),
    ["ChannelPane.tsx", "MessageTimeline.tsx"],
  );
});

test("adds only enough parent directories to disambiguate duplicate names", () => {
  assert.deepEqual(
    getShortestUniquePathLabels([
      "desktop/src/features/channels/ui/index.ts",
      "desktop/src/features/messages/ui/index.ts",
      "desktop/src/features/messages/lib/parseDiff.ts",
    ]),
    ["channels/ui/index.ts", "messages/ui/index.ts", "parseDiff.ts"],
  );
});

test("expands the longer path when one path is another path's suffix", () => {
  assert.deepEqual(
    getShortestUniquePathLabels(["src/shared/index.ts", "shared/index.ts"]),
    ["src/shared/index.ts", "shared/index.ts"],
  );
});
