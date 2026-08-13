import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { finalizeEvent } from "nostr-tools/pure";

import { relayClient } from "@/shared/api/relayClient";
import {
  canonicalJson,
  parseSectionWorkspaceProjection,
  parseStrictJson,
  projectionRevisionAction,
  SectionWorkspaceSyncManager,
} from "./sectionWorkspace.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../../docs/nips/NIP-SW.fixtures.json", import.meta.url),
    "utf8",
  ),
);
const OWNER_BYTES = new Uint8Array(32).fill(1);
const OWNER =
  "1111111111111111111111111111111111111111111111111111111111111111";
const RELAY = "wss://Relay.Example/";
const PROJECTION_EVENT = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pubkey: "9999999999999999999999999999999999999999999999999999999999999999",
  created_at: 1,
  kind: 30623,
  tags: [
    ["d", OWNER],
    ["p", OWNER],
  ],
  content: "",
  sig: "signature",
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

function installWindow(storage, invoke) {
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: storage,
    __TAURI_INTERNALS__: { invoke },
    setTimeout,
    clearTimeout,
  };
  return () => {
    globalThis.window = previous;
  };
}

function installRelayStubs({ fetchEvents, publishEvent, subscribeLive }) {
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    publishEvent: relayClient.publishEvent,
    subscribeLive: relayClient.subscribeLive,
  };
  relayClient.fetchEvents = fetchEvents;
  relayClient.publishEvent = publishEvent;
  relayClient.subscribeLive = subscribeLive;
  return () => Object.assign(relayClient, originals);
}

function makeProjectionEvent(
  projection = fixture.projection_cases[0].projection,
) {
  const template = {
    ...PROJECTION_EVENT,
    pubkey: OWNER,
    tags: [
      ["d", OWNER],
      ["p", OWNER],
    ],
    content: JSON.stringify(projection),
  };
  const signed = finalizeEvent(template, OWNER_BYTES);
  return {
    ...template,
    ...signed,
    tags: template.tags,
    content: template.content,
  };
}

test("section workspace consumes every shared projection fixture revision case", () => {
  const accepted = parseSectionWorkspaceProjection(
    fixture.projection_cases[0].projection,
  );
  assert.equal(accepted.sections.length, 2);
  assert.equal(accepted.assignments.length, 1);
  for (const item of fixture.projection_cases) {
    assert.equal(
      projectionRevisionAction(
        item.previous_revision ?? null,
        item.projection.revision,
      ),
      item.expect,
      item.name,
    );
  }
});

test("section workspace rejects unknown fields, unsupported versions, duplicate IDs, and malformed JSON", () => {
  const valid = structuredClone(fixture.projection_cases[0].projection);
  assert.throws(() =>
    parseSectionWorkspaceProjection({ ...valid, extra: true }),
  );
  assert.throws(() =>
    parseSectionWorkspaceProjection({ ...valid, version: 2 }),
  );
  const duplicate = structuredClone(valid);
  duplicate.sections[1].id = duplicate.sections[0].id;
  assert.throws(() => parseSectionWorkspaceProjection(duplicate));
  assert.throws(() => parseStrictJson('{"version":1,"version":1}'));
});

test("section workspace canonicalization matches the frozen legacy hash vector", () => {
  const vector = fixture.canonicalization.legacy_plaintext;
  const canonical = canonicalJson(vector.input);
  assert.equal(canonical, vector.canonical);
  assert.equal(
    createHash("sha256").update(canonical).digest("hex"),
    vector.sha256,
  );
});

test("projection is decrypted, cached by normalized relay, and rendered during outage", async () => {
  const storage = memoryStorage();
  let fetchCount = 0;
  const restoreRelay = installRelayStubs({
    fetchEvents: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? [makeProjectionEvent()]
        : Promise.reject(new Error("offline"));
    },
    publishEvent: async () => {},
    subscribeLive: async () => async () => {},
  });
  const restoreWindow = installWindow(storage, async (command, args) => {
    if (command === "nip44_decrypt_from_self") return "workspace-key";
    if (command === "decrypt_workspace_metadata") {
      if (args.envelope === "ciphertext-alpha") return "Alpha";
      if (args.envelope === "ciphertext-beta") return "Beta";
      if (args.envelope === "ciphertext-icon") return "folder";
    }
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const manager = new SectionWorkspaceSyncManager(OWNER, RELAY);
    const first = await manager.bootstrap(async () => null);
    assert.deepEqual(first, {
      version: 1,
      sections: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alpha", order: 0 },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: "Beta",
          icon: "folder",
          order: 1,
        },
      ],
      assignments: {
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc":
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    assert.ok(manager.isCanonical());

    const cached = new SectionWorkspaceSyncManager(OWNER, RELAY);
    assert.deepEqual(cached.getCachedStore(), first);
    const offline = await cached.bootstrap(async () => null);
    assert.deepEqual(offline, first);
  } finally {
    restoreWindow();
    restoreRelay();
  }
});

test("migration stores one canonical command and replays exact bytes after a failed publish", async () => {
  const storage = memoryStorage();
  const legacyStore = {
    version: 1,
    sections: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Alpha",
        icon: "folder",
        order: 0,
      },
    ],
    assignments: {
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc":
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  };
  const legacyPlaintext = JSON.stringify({
    version: 1,
    sections: legacyStore.sections,
    assignments: legacyStore.assignments,
  });
  const legacyEvent = {
    ...PROJECTION_EVENT,
    id: "2222222222222222222222222222222222222222222222222222222222222222",
    pubkey: OWNER,
    kind: 30078,
    content: "legacy-ciphertext",
    tags: [["d", "channel-sections"]],
  };
  const published = [];
  let shouldFail = true;
  const restoreRelay = installRelayStubs({
    fetchEvents: async () => [],
    publishEvent: async (event) => {
      published.push(event);
      if (shouldFail) {
        shouldFail = false;
        throw new Error("offline");
      }
      return event;
    },
    subscribeLive: async () => async () => {},
  });
  const restoreWindow = installWindow(storage, async (command, args) => {
    if (command === "generate_workspace_key")
      return "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    if (command === "encrypt_workspace_metadata")
      return `aes256gcm:${args.aad}:ciphertext`;
    if (command === "nip44_encrypt_to_self") return "nip44-owner-envelope";
    if (command === "sign_event")
      return JSON.stringify({
        ...legacyEvent,
        id: `event-${published.length}`,
        kind: args.kind,
        content: args.content,
        tags: args.tags,
      });
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const manager = new SectionWorkspaceSyncManager(OWNER, RELAY);
    await manager.bootstrap(async () => ({
      event: legacyEvent,
      plaintext: legacyPlaintext,
      store: legacyStore,
    }));
    assert.equal(published.length, 1);
    assert.ok(manager.isCanonical());
    const firstCommand = published[0].content;
    const firstTags = published[0].tags;

    const retryManager = new SectionWorkspaceSyncManager(OWNER, RELAY);
    await retryManager.bootstrap(async () => {
      throw new Error(
        "legacy retrieval must not be used after migration starts",
      );
    });
    assert.equal(published.length, 2);
    assert.equal(published[1].content, firstCommand);
    assert.deepEqual(published[1].tags, firstTags);
  } finally {
    restoreWindow();
    restoreRelay();
  }
});
