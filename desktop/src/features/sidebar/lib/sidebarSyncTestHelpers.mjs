// Shared helpers for sidebar sync manager tests.

export function makeFakeWindow() {
  const storage = new Map();
  const ls = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i) => [...storage.keys()][i] ?? null,
  };
  let timerCallback = null;
  let nextTimerId = 100;
  return {
    localStorage: ls,
    setTimeout: (fn, _ms) => {
      timerCallback = fn;
      return nextTimerId++;
    },
    clearTimeout: (_id) => {
      timerCallback = null;
    },
    _fireTimer: () => {
      if (timerCallback) {
        const fn = timerCallback;
        timerCallback = null;
        fn();
      }
    },
    _hasTimer: () => timerCallback !== null,
  };
}

export function installFakeWindow(fw) {
  if (typeof globalThis.window === "undefined") globalThis.window = {};
  const origLs = globalThis.window.localStorage;
  const origSt = globalThis.window.setTimeout;
  const origCt = globalThis.window.clearTimeout;
  globalThis.window.localStorage = fw.localStorage;
  globalThis.window.setTimeout = fw.setTimeout;
  globalThis.window.clearTimeout = fw.clearTimeout;
  return () => {
    if (origLs !== undefined) globalThis.window.localStorage = origLs;
    if (origSt !== undefined) globalThis.window.setTimeout = origSt;
    if (origCt !== undefined) globalThis.window.clearTimeout = origCt;
  };
}

// A faithful crypto seam for merge-lane retention-confirmation tests: encrypt
// maps each plaintext to a unique ciphertext, decrypt recovers it, and
// sign_event stamps the manager's `pubkey` and echoes the ciphertext as
// `content`. A published event therefore round-trips through a later fetch —
// modelling the relay retaining our own write so the post-publish subsumption
// check can read it back. `pubkey` must equal the manager's pubkey so the
// `events[0].pubkey === this.pubkey` guard passes.
export function installEchoTauri(pubkey) {
  const orig = globalThis.window?.__TAURI_INTERNALS__;
  if (typeof globalThis.window === "undefined") globalThis.window = {};
  const cipherToPlain = new Map();
  let seq = 0;
  let captured = null;
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_encrypt_to_self") {
        captured = args?.plaintext ?? null;
        const ct = `ct-${seq++}`;
        cipherToPlain.set(ct, args?.plaintext ?? "");
        return Promise.resolve(ct);
      }
      if (cmd === "nip44_decrypt_from_self") {
        const pt = cipherToPlain.get(args?.ciphertext);
        if (pt === undefined)
          return Promise.reject(new Error("decrypt failed"));
        return Promise.resolve(pt);
      }
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: `evt-${seq}`,
            pubkey,
            content: args?.content ?? "",
            created_at: args?.createdAt ?? 0,
            kind: args?.kind ?? 0,
            tags: args?.tags ?? [],
            sig: "s",
          }),
        );
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    },
  };
  return {
    restore: () => {
      if (orig !== undefined) globalThis.window.__TAURI_INTERNALS__ = orig;
      else delete globalThis.window.__TAURI_INTERNALS__;
    },
    capturedPlaintext: () => captured,
    // Mint a decryptable relay event for an arbitrary store payload — models a
    // peer window's retained head. Registers its ciphertext in the same map the
    // decrypt path reads, so the manager decrypts it back to `store`.
    // Pass an explicit `id` when the test needs a specific event id (e.g. to
    // guarantee the peer id is lexicographically lower than our attempt id for
    // same-second LWW collision tests).
    mintHead: (store, createdAt = 0, id = null) => {
      const ct = `ct-peer-${seq++}`;
      cipherToPlain.set(ct, JSON.stringify(store));
      return {
        id: id ?? `peer-${seq}`,
        pubkey,
        content: ct,
        created_at: createdAt,
        kind: 0,
        tags: [],
        sig: "s",
      };
    },
  };
}

export function installTauriMock(goodCipherPayload) {
  const orig = globalThis.window?.__TAURI_INTERNALS__;
  if (typeof globalThis.window === "undefined") globalThis.window = {};
  let captured = null;
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") {
        if (args?.ciphertext === "bad-cipher")
          return Promise.reject(new Error("decrypt failed"));
        return Promise.resolve(goodCipherPayload);
      }
      if (cmd === "nip44_encrypt_to_self") {
        captured = args?.plaintext ?? null;
        return Promise.resolve("ct");
      }
      if (cmd === "sign_event")
        return Promise.resolve(
          JSON.stringify({
            id: "eid",
            pubkey: "pk-lww",
            content: "ct",
            created_at: args?.createdAt ?? 0,
            kind: args?.kind ?? 0,
            tags: args?.tags ?? [],
            sig: "s",
          }),
        );
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    },
  };
  return {
    restore: () => {
      if (orig !== undefined) globalThis.window.__TAURI_INTERNALS__ = orig;
      else delete globalThis.window.__TAURI_INTERNALS__;
    },
    capturedPlaintext: () => captured,
  };
}
