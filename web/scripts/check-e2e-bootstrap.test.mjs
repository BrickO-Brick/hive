import assert from "node:assert/strict";
import test from "node:test";

const projects = [
  ["desktop", "../scripts/check-e2e-bootstrap.mjs"],
  ["web", "../scripts/check-e2e-bootstrap.mjs"],
];

const validDirect = `
  import { test, bootstrapE2ePage } from "../helpers/test";
  test("uses bootstrap", async ({ page }) => { await bootstrapE2ePage(page); });
`;
const validBeforeEach = `
  import { test, bootstrapE2ePage } from "../helpers/test";
  test.beforeEach(async ({ page }) => { await bootstrapE2ePage(page); });
  test("uses registered hook", async ({ page }) => { await page.title(); });
`;
const validBeforeNavigate = `
  import { test, bootstrapE2ePage } from "../helpers/test";
  test("draft seed", async ({ page }) => {
    await bootstrapE2ePage(page, { beforeNavigate: async () => page.addInitScript(() => {}) });
  });
`;

for (const [project, checkerPath] of projects) {
  const { checkSource } = await import(checkerPath);
  test(`${project}: accepts direct, hook, and beforeNavigate bootstrap patterns`, () => {
    for (const source of [validDirect, validBeforeEach, validBeforeNavigate]) {
      assert.equal(checkSource(source), undefined);
    }
  });

  for (const [name, source] of [
    [
      ".ts helper suffix",
      `import { test, bootstrapE2ePage } from "../helpers/test.ts"; test("x", async () => {});`,
    ],
    [
      "import alias",
      `import { test as e2eTest, bootstrapE2ePage } from "../helpers/test"; e2eTest("x", async () => { await bootstrapE2ePage(); });`,
    ],
    [
      "re-export",
      `import { test, bootstrapE2ePage } from "./reexport"; test("x", async () => { await bootstrapE2ePage(); });`,
    ],
    [
      "dynamic import",
      `const { test, bootstrapE2ePage } = await import("../helpers/test"); test("x", async () => { await bootstrapE2ePage(); });`,
    ],
    [
      "dead-code call",
      `import { test, bootstrapE2ePage } from "../helpers/test"; async function never(page) { await bootstrapE2ePage(page); } test("x", async () => {});`,
    ],
    [
      "comment",
      `import { test, bootstrapE2ePage } from "../helpers/test"; // await bootstrapE2ePage(page)\ntest("x", async () => {});`,
    ],
    [
      "string",
      `import { test, bootstrapE2ePage } from "../helpers/test"; const hint = "await bootstrapE2ePage(page)"; test("x", async () => {});`,
    ],
  ]) {
    test(`${project}: rejects ${name}`, () => {
      assert.notEqual(checkSource(source), undefined);
    });
  }
}
