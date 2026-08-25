import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { policy as desktopPolicy } from "../desktop/scripts/check-file-sizes.mjs";
import { policy as mobilePolicy } from "../mobile/scripts/check-file-sizes.mjs";
import { policy as webPolicy } from "../web/scripts/check-file-sizes.mjs";
import {
  allowedLineCount,
  countLines,
  evaluateFileSize,
  parseChangedFiles,
  resolveBaseRef,
} from "./check-file-sizes-core.mjs";

function git(repo, ...args) {
  // These fixture repositories inherit both hook configuration and Git's
  // repository-local environment when this test runs from pre-push. Isolate
  // them completely so fixture commits cannot recurse into the real checkout.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: "utf8",
    env,
  }).trim();
}

test("local base resolution uses the branch merge-base and fails without origin/main", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "file-size-base-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "commit", "--allow-empty", "-m", "base");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "fetch", "origin", "main:refs/remotes/origin/main");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "feature");
  git(repo, "commit", "--allow-empty", "-m", "first branch commit");
  git(repo, "commit", "--allow-empty", "-m", "second branch commit");

  assert.equal(resolveBaseRef(repo, {}), base);
  git(repo, "update-ref", "-d", "refs/remotes/origin/main");
  assert.throws(
    () => resolveBaseRef(repo, {}),
    /Fetch origin\/main or set CHECK_FILE_SIZES_BASE/,
  );
});

test("counts empty, LF, and CRLF content with the existing semantics", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one\n"), 2);
  assert.equal(countLines("one\r\ntwo"), 2);
});

test("surface entrypoints expose the exact ordered production policies", () => {
  const policies = [
    [
      desktopPolicy,
      [
        ["src-tauri/src", [".rs"], 1500],
        ["src-tauri/crates", [".rs"], 1500],
        ["src/app", [".ts", ".tsx"], 1200],
        ["src/features", [".ts", ".tsx"], 1200],
        ["src/shared/api", [".ts", ".tsx"], 1200],
        ["src/shared/context", [".ts", ".tsx"], 1200],
        ["src/shared/lib", [".ts", ".tsx"], 1200],
        ["src/shared/ui", [".ts", ".tsx"], 1200],
        ["src/shared/styles", [".css"], 1200],
      ],
    ],
    [mobilePolicy, [["lib", [".dart"], 1200]]],
    [
      webPolicy,
      [
        ["src/app", [".ts", ".tsx"], 1000],
        ["src/features", [".ts", ".tsx"], 1000],
        ["src/shared/api", [".ts", ".tsx"], 1000],
      ],
    ],
  ];

  for (const [policy, expectedRules] of policies) {
    const actualRules = policy.rules.map((rule) => [
      rule.root,
      [...rule.extensions],
      rule.maxLines,
    ]);
    assert.deepEqual(
      actualRules,
      expectedRules,
      `${policy.label} production rules`,
    );

    for (const rule of policy.rules) {
      assert.equal(
        evaluateFileSize({
          baseLines: null,
          candidateLines: rule.maxLines,
          maxLines: rule.maxLines,
        }).violates,
        false,
        `${policy.label} ${rule.root} should allow the ceiling`,
      );
      assert.equal(
        evaluateFileSize({
          baseLines: null,
          candidateLines: rule.maxLines + 1,
          maxLines: rule.maxLines,
        }).violates,
        true,
        `${policy.label} ${rule.root} should reject ceiling + 1`,
      );
    }
  }
});

test("new files use the configured ceiling", () => {
  assert.equal(allowedLineCount(null, 1000), 1000);
  assert.deepEqual(
    evaluateFileSize({ baseLines: null, candidateLines: 1000, maxLines: 1000 }),
    {
      limit: 1000,
      violates: false,
    },
  );
  assert.equal(
    evaluateFileSize({ baseLines: null, candidateLines: 1001, maxLines: 1000 })
      .violates,
    true,
  );
});

test("a compliant file may not cross the ceiling", () => {
  assert.equal(
    evaluateFileSize({ baseLines: 996, candidateLines: 1000, maxLines: 1000 })
      .violates,
    false,
  );
  assert.equal(
    evaluateFileSize({ baseLines: 996, candidateLines: 1003, maxLines: 1000 })
      .violates,
    true,
  );
});

test("parses modifications, deletions, and renames from Git's NUL format", () => {
  assert.deepEqual(
    parseChangedFiles(
      "M\0desktop/src/a.ts\0D\0desktop/src/b.ts\0R100\0desktop/src/old.ts\0desktop/src/new.ts\0",
    ),
    [
      { status: "M", path: "desktop/src/a.ts" },
      { status: "D", path: "desktop/src/b.ts" },
      {
        status: "R",
        oldPath: "desktop/src/old.ts",
        path: "desktop/src/new.ts",
      },
    ],
  );
});

test("an inherited oversized file may hold or shrink but not grow", () => {
  assert.equal(allowedLineCount(1026, 1000), 1026);
  assert.equal(
    evaluateFileSize({ baseLines: 1026, candidateLines: 1026, maxLines: 1000 })
      .violates,
    false,
  );
  assert.equal(
    evaluateFileSize({ baseLines: 1026, candidateLines: 1001, maxLines: 1000 })
      .violates,
    false,
  );
  assert.equal(
    evaluateFileSize({ baseLines: 1026, candidateLines: 1027, maxLines: 1000 })
      .violates,
    true,
  );
});
