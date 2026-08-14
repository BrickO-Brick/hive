import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listSidebarProjects,
  selectedProjectRouteId,
} from "./listSidebarProjects.ts";

const OWNER = "a".repeat(64);
const VIEWER = "b".repeat(64);

function makeProject(overrides = {}) {
  return {
    createdAt: 0,
    description: "",
    dtag: "sprout",
    id: `30621:${OWNER}:sprout`,
    name: "sprout",
    owner: OWNER,
    primaryRepositoryAddress: null,
    projectAddress: `30621:${OWNER}:sprout`,
    projectChannelId: null,
    repositories: [],
    repositoryAddresses: [],
    status: "open",
    ...overrides,
  };
}

test("selectedProjectRouteId reads the project id from the detail route", () => {
  assert.equal(selectedProjectRouteId("/projects"), undefined);
  assert.equal(selectedProjectRouteId("/projects/"), undefined);
  assert.equal(selectedProjectRouteId("/agents"), undefined);
  assert.equal(
    selectedProjectRouteId("/projects/30621:abc:sprout"),
    "30621:abc:sprout",
  );
  assert.equal(
    selectedProjectRouteId("/projects/30621%3Aabc%3Asprout"),
    "30621:abc:sprout",
  );
});

test("listSidebarProjects keeps owned and contributed projects for Mine", () => {
  const owned = makeProject({
    dtag: "owned",
    id: `30621:${VIEWER}:owned`,
    name: "Owned",
    owner: VIEWER,
    projectAddress: `30621:${VIEWER}:owned`,
  });
  const contributed = makeProject({
    dtag: "contrib",
    id: `30621:${OWNER}:contrib`,
    name: "Contrib",
    projectAddress: `30621:${OWNER}:contrib`,
    repositories: [
      {
        channelId: null,
        cloneUrls: [],
        contributors: [VIEWER],
        createdAt: 0,
        defaultBranch: "main",
        dtag: "repo",
        id: `${OWNER}:repo`,
        name: "repo",
        owner: OWNER,
        repoAddress: `30617:${OWNER}:repo`,
      },
    ],
  });
  const other = makeProject({ name: "Other" });

  const listed = listSidebarProjects({
    currentPubkey: VIEWER,
    filter: "mine",
    projects: [other, contributed, owned],
    sort: "name",
  });
  assert.deepEqual(
    listed.map((project) => project.name),
    ["Contrib", "Owned"],
  );
});

test("listSidebarProjects owned filter hides contributed projects", () => {
  const owned = makeProject({
    dtag: "owned",
    id: `30621:${VIEWER}:owned`,
    name: "Owned",
    owner: VIEWER,
    projectAddress: `30621:${VIEWER}:owned`,
  });
  const contributed = makeProject({
    dtag: "contrib",
    id: `30621:${OWNER}:contrib`,
    name: "Contrib",
    projectAddress: `30621:${OWNER}:contrib`,
    repositories: [
      {
        channelId: null,
        cloneUrls: [],
        contributors: [VIEWER],
        createdAt: 0,
        defaultBranch: "main",
        dtag: "repo",
        id: `${OWNER}:repo`,
        name: "repo",
        owner: OWNER,
        repoAddress: `30617:${OWNER}:repo`,
      },
    ],
  });

  const listed = listSidebarProjects({
    currentPubkey: VIEWER,
    filter: "owned",
    projects: [contributed, owned],
    sort: "name",
  });
  assert.deepEqual(
    listed.map((project) => project.name),
    ["Owned"],
  );
});

test("listSidebarProjects newest sort orders by createdAt then name", () => {
  const older = makeProject({
    createdAt: 10,
    dtag: "older",
    id: `30621:${VIEWER}:older`,
    name: "Alpha",
    owner: VIEWER,
    projectAddress: `30621:${VIEWER}:older`,
  });
  const newer = makeProject({
    createdAt: 20,
    dtag: "newer",
    id: `30621:${VIEWER}:newer`,
    name: "Zebra",
    owner: VIEWER,
    projectAddress: `30621:${VIEWER}:newer`,
  });

  const listed = listSidebarProjects({
    currentPubkey: VIEWER,
    filter: "mine",
    projects: [older, newer],
    sort: "created",
  });
  assert.deepEqual(
    listed.map((project) => project.name),
    ["Zebra", "Alpha"],
  );
});
