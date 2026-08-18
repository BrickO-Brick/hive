import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const specs = fs
  .readdirSync(path.join(projectRoot, "tests/e2e"))
  .filter((name) => /\.(spec|perf)\.ts$/.test(name));
const exempt = new Set(["agents-everywhere.live.spec.ts"]);
const violations = [];
for (const name of specs) {
  if (exempt.has(name)) continue;
  const source = fs.readFileSync(
    path.join(projectRoot, "tests/e2e", name),
    "utf8",
  );
  if (!source.includes('from "../helpers/test"')) continue;
  if (!/await\s+bootstrapE2ePage\(/.test(source)) violations.push(name);
}
if (violations.length) {
  console.error(
    `E2E specs must register bootstrapE2ePage after their setup:\n${violations.join("\n")}`,
  );
  process.exit(1);
}
