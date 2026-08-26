import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveEnabled } from "./resolveEnabled.ts";

describe("resolveEnabled (preview-only)", () => {
  const workflows = {
    id: "workflows",
    name: "Workflows",
    description: "",
  };

  it("returns false by default (no override)", () => {
    assert.equal(resolveEnabled(workflows, {}, true), false);
  });

  it("returns true when user opts in", () => {
    assert.equal(resolveEnabled(workflows, { workflows: true }, true), true);
  });

  it("uses an enabled manifest default when no override exists", () => {
    assert.equal(
      resolveEnabled(
        { ...workflows, id: "defaultOnFeature", defaultEnabled: true },
        {},
        true,
      ),
      true,
    );
  });

  it("lets an explicit opt-out override an enabled default", () => {
    assert.equal(
      resolveEnabled(
        { ...workflows, id: "defaultOnFeature", defaultEnabled: true },
        { defaultOnFeature: false },
        true,
      ),
      false,
    );
  });

  it("returns false when user explicitly opts out", () => {
    assert.equal(resolveEnabled(workflows, { workflows: false }, true), false);
  });

  it("ignores overrides for unrelated ids", () => {
    assert.equal(resolveEnabled(workflows, { pulse: true }, true), false);
  });

  it("requires both build availability and a user opt-in", () => {
    const cases = [
      { buildAvailable: false, optedIn: false, expected: false },
      { buildAvailable: false, optedIn: true, expected: false },
      { buildAvailable: true, optedIn: false, expected: false },
      { buildAvailable: true, optedIn: true, expected: true },
    ];

    for (const { buildAvailable, optedIn, expected } of cases) {
      assert.equal(
        resolveEnabled(
          { ...workflows, id: "bestie" },
          { bestie: optedIn },
          buildAvailable,
        ),
        expected,
      );
    }
  });

  it("fails closed when a JavaScript caller omits build availability", () => {
    assert.equal(
      resolveEnabled({ ...workflows, id: "bestie" }, { bestie: true }),
      false,
    );
  });
});
