import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_COMMUNITY_THEME,
  cacheAndApplyCommunityTheme,
  clearCommunityThemeOutbox,
  communityThemeAppearanceFallback,
  communityThemeApplyExpectation,
  communityThemeOutboxKey,
  communityThemePersistenceAction,
  communityThemeScopeFallback,
  communityThemeStorageKey,
  hasMigratedCommunityTheme,
  hasMigratedCommunityThemeAppearance,
  markCommunityThemeAppearanceMigrated,
  markCommunityThemeMigrated,
  parseCommunityThemePreference,
  readCommunityThemeOutbox,
  readCommunityThemePreference,
  sameCommunityThemePreference,
  writeCommunityThemeOutbox,
  writeCommunityThemePreference,
} from "./communityThemePreference.ts";
import { GLASS_OPACITY_MAX, GLASS_OPACITY_MIN } from "./ThemeProvider.tsx";

function localStorageStub() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("parses only the versioned stable appearance contract", () => {
  const valid = {
    version: 1,
    theme: "houston",
    accent: "#a855f7",
    followSystem: false,
    glassBackground: true,
    glassOpacity: 47,
    prominentActiveTab: false,
  };
  assert.deepEqual(parseCommunityThemePreference(valid), valid);
  assert.equal(parseCommunityThemePreference({ ...valid, version: 2 }), null);
  assert.equal(
    parseCommunityThemePreference({ ...valid, theme: "future-theme" }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, accent: "url(image)" }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, followSystem: "false" }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, glassBackground: "true" }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, glassOpacity: 29 }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, prominentActiveTab: 1 }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, glassBackground: null }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, glassOpacity: null }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, prominentActiveTab: null }),
    null,
  );
});

test("older theme records inherit the pre-migration appearance controls", () => {
  const legacy = {
    version: 1,
    theme: "houston",
    accent: "#a855f7",
    followSystem: false,
  };
  const fallback = {
    ...DEFAULT_COMMUNITY_THEME,
    glassBackground: true,
    glassOpacity: 42,
    prominentActiveTab: false,
  };

  assert.deepEqual(parseCommunityThemePreference(legacy, fallback), {
    ...legacy,
    glassBackground: true,
    glassOpacity: 42,
    prominentActiveTab: false,
  });
});

test("completed appearance migration uses stable defaults", () => {
  const priorCommunity = {
    ...DEFAULT_COMMUNITY_THEME,
    glassBackground: true,
    glassOpacity: 42,
    prominentActiveTab: true,
  };
  const olderRecord = {
    version: 1,
    theme: "houston",
    accent: "#a855f7",
    followSystem: false,
  };

  assert.deepEqual(
    parseCommunityThemePreference(
      olderRecord,
      communityThemeAppearanceFallback(true, priorCommunity),
    ),
    { ...DEFAULT_COMMUNITY_THEME, ...olderRecord },
  );
});

test("appearance widening is independent from community scoping", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const inherited = {
    ...DEFAULT_COMMUNITY_THEME,
    glassBackground: true,
    glassOpacity: 80,
    prominentActiveTab: true,
  };
  const legacy = {
    version: 1,
    theme: "houston",
    accent: "#a855f7",
    followSystem: false,
  };
  window.localStorage.setItem(
    communityThemeStorageKey("alice", "wss://relay.example"),
    JSON.stringify(legacy),
  );

  markCommunityThemeMigrated("alice");
  assert.equal(hasMigratedCommunityTheme("alice"), true);
  assert.equal(hasMigratedCommunityThemeAppearance("alice"), false);
  assert.deepEqual(
    readCommunityThemePreference(
      "alice",
      "wss://relay.example",
      communityThemeAppearanceFallback(
        hasMigratedCommunityThemeAppearance("alice"),
        inherited,
      ),
    ),
    {
      ...legacy,
      glassBackground: true,
      glassOpacity: 80,
      prominentActiveTab: true,
    },
  );

  markCommunityThemeAppearanceMigrated("alice");
  assert.equal(hasMigratedCommunityThemeAppearance("alice"), true);
  assert.deepEqual(
    communityThemeAppearanceFallback(
      hasMigratedCommunityThemeAppearance("alice"),
      inherited,
    ),
    DEFAULT_COMMUNITY_THEME,
  );
});

test("desktop appearance limits match the shared wire contract", () => {
  const contract = JSON.parse(
    readFileSync(
      new URL("../../../../schema/community-theme-v1.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(
    DEFAULT_COMMUNITY_THEME.glassBackground,
    contract.properties.glassBackground.default,
  );
  assert.equal(
    DEFAULT_COMMUNITY_THEME.glassOpacity,
    contract.properties.glassOpacity.default,
  );
  assert.equal(GLASS_OPACITY_MIN, contract.properties.glassOpacity.minimum);
  assert.equal(GLASS_OPACITY_MAX, contract.properties.glassOpacity.maximum);
  assert.equal(
    DEFAULT_COMMUNITY_THEME.prominentActiveTab,
    contract.properties.prominentActiveTab.default,
  );
});

test("appearance equality includes glass and prominent-tab choices", () => {
  assert.equal(
    sameCommunityThemePreference(DEFAULT_COMMUNITY_THEME, {
      ...DEFAULT_COMMUNITY_THEME,
      glassOpacity: DEFAULT_COMMUNITY_THEME.glassOpacity + 1,
    }),
    false,
  );
  assert.equal(
    sameCommunityThemePreference(DEFAULT_COMMUNITY_THEME, {
      ...DEFAULT_COMMUNITY_THEME,
      glassBackground: !DEFAULT_COMMUNITY_THEME.glassBackground,
    }),
    false,
  );
  assert.equal(
    sameCommunityThemePreference(DEFAULT_COMMUNITY_THEME, {
      ...DEFAULT_COMMUNITY_THEME,
      prominentActiveTab: !DEFAULT_COMMUNITY_THEME.prominentActiveTab,
    }),
    false,
  );
});

test("local preferences are isolated by pubkey and normalized relay", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const aliceA = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "houston",
    followSystem: false,
  };
  const aliceB = { ...DEFAULT_COMMUNITY_THEME, theme: "catppuccin-latte" };
  const bobA = { ...DEFAULT_COMMUNITY_THEME, accent: "#ef4444" };
  assert.equal(
    writeCommunityThemePreference("alice", "WSS://A.EXAMPLE/", aliceA),
    true,
  );
  assert.equal(
    writeCommunityThemePreference("alice", "wss://b.example", aliceB),
    true,
  );
  assert.equal(
    writeCommunityThemePreference("bob", "wss://a.example", bobA),
    true,
  );
  assert.deepEqual(
    readCommunityThemePreference("alice", "wss://a.example"),
    aliceA,
  );
  assert.deepEqual(
    readCommunityThemePreference("alice", "wss://b.example/"),
    aliceB,
  );
  assert.deepEqual(
    readCommunityThemePreference("bob", "wss://a.example"),
    bobA,
  );
  assert.notEqual(
    communityThemeStorageKey("alice", "wss://a.example"),
    communityThemeStorageKey("alice", "wss://b.example"),
  );
});

test("dirty outbox survives restart and clears only its exact revision", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const first = { ...DEFAULT_COMMUNITY_THEME, theme: "houston" };
  const second = { ...DEFAULT_COMMUNITY_THEME, accent: "#ef4444" };

  assert.equal(
    writeCommunityThemeOutbox("alice", "WSS://A.EXAMPLE/", first),
    true,
  );
  assert.deepEqual(readCommunityThemeOutbox("alice", "wss://a.example"), first);
  writeCommunityThemeOutbox("alice", "wss://a.example", second);
  clearCommunityThemeOutbox("alice", "wss://a.example", first);
  assert.deepEqual(
    readCommunityThemeOutbox("alice", "wss://a.example"),
    second,
  );
  clearCommunityThemeOutbox("alice", "wss://a.example", second);
  assert.equal(readCommunityThemeOutbox("alice", "wss://a.example"), null);
  assert.notEqual(
    communityThemeOutboxKey("alice", "wss://a.example"),
    communityThemeStorageKey("alice", "wss://a.example"),
  );
});

test("malformed local data returns null so switching can apply the safe default", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const key = communityThemeStorageKey("alice", "wss://broken.example");
  window.localStorage.setItem(
    key,
    JSON.stringify({ version: 1, theme: "missing" }),
  );
  assert.equal(
    readCommunityThemePreference("alice", "wss://broken.example"),
    null,
  );
  window.localStorage.setItem(key, "{");
  assert.equal(
    readCommunityThemePreference("alice", "wss://broken.example"),
    null,
  );
});

test("remote preference still applies when its local cache write fails", () => {
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    },
  };
  let applied = null;
  cacheAndApplyCommunityTheme(
    "alice",
    "wss://a.example",
    DEFAULT_COMMUNITY_THEME,
    (preference) => {
      applied = preference;
    },
  );
  assert.deepEqual(applied, DEFAULT_COMMUNITY_THEME);
});

test("already-applied relay state leaves the next user edit publishable", () => {
  const applied = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "catppuccin-latte",
    followSystem: false,
  };

  assert.equal(communityThemeApplyExpectation(applied, applied), null);
  assert.deepEqual(
    communityThemeApplyExpectation(applied, DEFAULT_COMMUNITY_THEME),
    applied,
  );
});

test("no-op initialization remains programmatic", () => {
  const expectation = communityThemeApplyExpectation(
    DEFAULT_COMMUNITY_THEME,
    DEFAULT_COMMUNITY_THEME,
    true,
  );

  assert.equal(
    communityThemePersistenceAction(expectation, DEFAULT_COMMUNITY_THEME),
    "acknowledge",
  );
});

test("confirmed first-community migration isolates later empty scopes", () => {
  const inherited = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "dracula",
    followSystem: false,
  };

  assert.deepEqual(communityThemeScopeFallback(false, inherited), inherited);
  assert.deepEqual(
    communityThemeScopeFallback(true, inherited),
    DEFAULT_COMMUNITY_THEME,
  );
});

test("community switch defers stale outgoing appearance persistence", () => {
  const outgoing = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "houston",
    followSystem: false,
  };
  const incoming = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "catppuccin-latte",
  };

  assert.equal(communityThemePersistenceAction(incoming, outgoing), "defer");
  assert.equal(
    communityThemePersistenceAction(incoming, incoming),
    "acknowledge",
  );
  assert.equal(communityThemePersistenceAction(null, incoming), "persist");
});
