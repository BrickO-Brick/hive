import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGitHubRepository,
  groupClassifiedGitHubRepositories,
} from "./githubRepositoryClassification.ts";

function repository(name, description = "", language = null) {
  return {
    owner: "BrickO-Brick",
    name,
    description,
    url: `https://github.com/BrickO-Brick/${name}`,
    cloneUrl: `https://github.com/BrickO-Brick/${name}.git`,
    defaultBranch: "main",
    language,
    archived: false,
    private: true,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

test("categorizes BrickO repository families from inspectable metadata", () => {
  assert.equal(
    classifyGitHubRepository(repository("hive")).category.id,
    "collaboration",
  );
  assert.equal(
    classifyGitHubRepository(repository("mantul-module-sdk")).category.id,
    "mantul-platform",
  );
  assert.equal(
    classifyGitHubRepository(repository("BrickR")).category.id,
    "security-governance",
  );
  assert.equal(
    classifyGitHubRepository(repository("wiki-onebrick")).category.id,
    "knowledge",
  );
  assert.equal(
    classifyGitHubRepository(repository("ClickHouse")).category.id,
    "data-intelligence",
  );
  assert.equal(
    classifyGitHubRepository(repository("onebrick-stack")).category.id,
    "platform-operations",
  );
  assert.equal(
    classifyGitHubRepository(repository("client-be")).category.id,
    "customer-products",
  );
});

test("keeps uncertain repositories explicit for owner review", () => {
  const classified = classifyGitHubRepository(repository("new-service"));
  assert.equal(classified.category.id, "uncategorized");
  assert.deepEqual(classified.signals, []);
});

test("groups repositories in stable catalog order", () => {
  const groups = groupClassifiedGitHubRepositories([
    repository("new-service"),
    repository("hive"),
    repository("BrickR"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.category.id),
    ["collaboration", "security-governance", "uncategorized"],
  );
});

test("the current BrickO-Brick catalog receives an initial category", () => {
  const names = [
    "bpjs",
    "BrickR",
    "callback-test",
    "ClickHouse",
    "client",
    "client-be",
    "client-fe",
    "cs",
    "docs-onebrick",
    "email-engine",
    "ETL",
    "frontend-brick-website",
    "hive",
    "knowledge",
    "mantap-n8n-automation",
    "mantul",
    "mantul-be",
    "mantul-fe",
    "mantul-module-ai-ops-rpg",
    "mantul-module-ai-ops-workshop",
    "mantul-module-business-insight",
    "mantul-module-contracts",
    "mantul-module-financial-command",
    "mantul-module-northstar-metric",
    "mantul-module-platform-command",
    "mantul-module-platform-command-automation",
    "mantul-module-provider-reliability",
    "mantul-module-registry",
    "mantul-module-sdk",
    "mantul-module-template",
    "mantul-wa",
    "onebrick-grc",
    "onebrick-logs",
    "onebrick-stack",
    "readme-docs",
    "wiki-onebrick",
  ];
  assert.equal(names.length, 36);
  assert.deepEqual(
    names
      .map((name) => classifyGitHubRepository(repository(name)))
      .filter((candidate) => candidate.category.id === "uncategorized")
      .map((candidate) => candidate.name),
    [],
  );
});
