#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { loadVerifiedFixture } from "./validation.mjs";

const requireFromNostrTools = createRequire(
  import.meta.resolve("nostr-tools/pure"),
);
const { schnorr } = requireFromNostrTools("@noble/curves/secp256k1.js");
const TOOL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function materializeFixture(fixture) {
  const contract = fixture.materialization;
  const secretKey = Buffer.from(contract.signerPrivateKeyHex, "hex");
  const publicKey = getPublicKey(secretKey);
  const referenceTime = Date.parse(contract.referenceTime) / 1000;
  if (!Number.isInteger(referenceTime)) {
    throw new Error(
      "Fixture referenceTime must resolve to whole epoch seconds",
    );
  }

  const events = [];
  let ordinal = 0;
  for (const channel of fixture.channels) {
    for (
      let channelOrdinal = 0;
      channelOrdinal < channel.messageCount;
      channelOrdinal += 1
    ) {
      const createdAt = referenceTime + ordinal * contract.createdAtStepSeconds;
      const tags = [
        ["h", channel.id],
        ["fixture", fixture.fixtureId],
        ["ordinal", String(ordinal)],
      ];
      const content = `fixture:${channel.contentProfile}:${contract.seedHex}:${ordinal}`;
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            0,
            publicKey,
            createdAt,
            contract.eventKind,
            tags,
            content,
          ]),
        )
        .digest("hex");
      const sig = Buffer.from(
        schnorr.sign(Buffer.from(id, "hex"), secretKey, new Uint8Array(32)),
      ).toString("hex");
      const event = {
        id,
        pubkey: publicKey,
        created_at: createdAt,
        kind: contract.eventKind,
        tags,
        content,
        sig,
      };
      if (!verifyEvent(event)) {
        throw new Error(
          `Materialized event ${ordinal} failed signature verification`,
        );
      }
      events.push(event);
      ordinal += 1;
    }
  }
  return events.sort(
    (left, right) =>
      left.created_at - right.created_at || left.id.localeCompare(right.id),
  );
}

export function serializeMaterializedEvents(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function main() {
  const [
    outputPath,
    manifestPath = path.join(TOOL_ROOT, "fixture-manifest.json"),
  ] = process.argv.slice(2);
  if (!outputPath) {
    console.error(
      "Usage: node tests/wkwebview/tooling/materialize-fixture.mjs <events.jsonl> [fixture-manifest.json]",
    );
    process.exitCode = 1;
    return;
  }
  const { fixture } = await loadVerifiedFixture(
    manifestPath,
    "buzz-wkwebview-acceptance",
  );
  const bytes = serializeMaterializedEvents(materializeFixture(fixture));
  await writeFile(outputPath, bytes, { flag: "wx" });
  console.log(
    JSON.stringify({
      path: path.resolve(outputPath),
      events: fixture.channels.reduce(
        (total, channel) => total + channel.messageCount,
        0,
      ),
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
