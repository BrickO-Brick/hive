// Host-owned Project Canvas SDK. Served from /__buzz/sdk.js and loaded before
// every package script, so packages can rely on `window.buzzCanvas.sdk`.
//
// The SDK never starts the MessagePort: the package entry (canvas.js) owns
// starting it, and listeners registered before the port starts lose nothing.
// RPC calls issued before host.init arrives are queued and flushed with the
// session envelope once the host binds the load.
(() => {
  const PROTOCOL_VERSION = 1;
  const runtime = window.buzzCanvas;
  if (
    !runtime ||
    runtime.protocolVersion !== PROTOCOL_VERSION ||
    !runtime.port ||
    !runtime.sdk
  ) {
    return;
  }
  const port = runtime.port;
  const session = {
    capabilities: [],
    loadId: null,
    nonce: null,
    ready: false,
  };
  let requestCounter = 0;
  const pending = new Map();
  const subscriptions = new Map();
  const queued = [];

  function nextId(prefix) {
    requestCounter += 1;
    return `${prefix}-${requestCounter}`;
  }

  function envelope() {
    return {
      loadId: session.loadId,
      nonce: session.nonce,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  function send(message) {
    if (session.ready) port.postMessage(Object.assign(envelope(), message));
    else queued.push(message);
  }

  function rpcFailure(error) {
    const failure = new Error(
      error && typeof error.message === "string"
        ? error.message
        : "Canvas request failed",
    );
    failure.code =
      error && typeof error.code === "string" ? error.code : "failed";
    return failure;
  }

  function settle(id, message) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (message.error) entry.reject(rpcFailure(message.error));
    else
      entry.resolve(
        message.result !== undefined ? message.result : { ok: true },
      );
  }

  port.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.protocolVersion !== PROTOCOL_VERSION) return;
    if (message.type === "host.init") {
      if (session.ready) return;
      session.ready = true;
      session.loadId = message.loadId;
      session.nonce = message.nonce;
      session.capabilities = Array.isArray(message.capabilities)
        ? message.capabilities.slice()
        : [];
      for (const queuedMessage of queued.splice(0)) {
        port.postMessage(Object.assign(envelope(), queuedMessage));
      }
      return;
    }
    if (message.loadId !== session.loadId || message.nonce !== session.nonce) {
      return;
    }
    if (message.type === "host.queryResult") settle(message.queryId, message);
    else if (message.type === "host.commandResult") {
      settle(message.commandId, message);
    } else if (message.type === "host.openResult") {
      settle(message.openId, message);
    } else if (message.type === "host.subscriptionUpdate") {
      const subscription = subscriptions.get(message.subscriptionId);
      if (subscription) subscription(message.result);
    } else if (message.type === "host.subscriptionEnded") {
      const subscription = subscriptions.get(message.subscriptionId);
      subscriptions.delete(message.subscriptionId);
      if (subscription && message.error) {
        subscription({ data: null, error: message.error, status: "error" });
      }
    }
  });

  function request(prefix, build) {
    return new Promise((resolve, reject) => {
      const id = nextId(prefix);
      pending.set(id, { reject, resolve });
      send(build(id));
    });
  }

  const data = Object.freeze({
    query(name, params) {
      return request("q", (queryId) => ({
        query: { name, params: params || {} },
        queryId,
        type: "canvas.query",
      }));
    },
    liveQuery(name, params, onUpdate) {
      const subscriptionId = nextId("s");
      subscriptions.set(subscriptionId, onUpdate);
      send({
        query: { name, params: params || {} },
        subscriptionId,
        type: "canvas.subscribe",
      });
      return () => {
        if (!subscriptions.delete(subscriptionId)) return;
        send({ subscriptionId, type: "canvas.unsubscribe" });
      };
    },
    command(name, params) {
      return request("c", (commandId) => ({
        command: { name, params: params || {} },
        commandId,
        type: "canvas.command",
      }));
    },
  });

  const app = Object.freeze({
    open(target) {
      return request("o", (openId) => ({
        openId,
        target,
        type: "canvas.open",
      }));
    },
  });

  // --- Standard components -------------------------------------------------
  // Identity semantics mirror the app's UserAvatar: same initials derivation
  // and the same 7-tone hash, so a person renders identically inside and
  // outside the canvas.

  function initialsFor(name) {
    return String(name || "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .split(/\s+/)
      .map((part) => part[0] || "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  function toneFor(name) {
    let hash = 0;
    for (const character of String(name || "")
      .trim()
      .toLowerCase()) {
      hash = (hash * 31 + (character.codePointAt(0) || 0)) >>> 0;
    }
    return hash % 7;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function avatar(props) {
    const options = props || {};
    const name = String(options.name || "");
    const size = ["xs", "sm", "md"].includes(options.size)
      ? options.size
      : "md";
    const node = el("span", "buzz-avatar");
    node.dataset.buzzComponent = "avatar";
    node.dataset.size = size;
    node.dataset.shape = options.agent ? "squircle" : "circle";
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", name || "Unknown person");
    const avatarUrl =
      typeof options.avatarUrl === "string" &&
      options.avatarUrl.startsWith("data:image/")
        ? options.avatarUrl
        : null;
    if (avatarUrl) {
      const image = el("img", "buzz-avatar-image");
      image.src = avatarUrl;
      image.alt = "";
      node.append(image);
    } else {
      node.dataset.tone = String(toneFor(name));
      node.append(el("span", "buzz-avatar-fallback", initialsFor(name) || "?"));
    }
    return node;
  }

  function openable(row, target, onOpen) {
    const handler =
      typeof onOpen === "function"
        ? onOpen
        : target
          ? () => {
              app.open(target).catch(() => {});
            }
          : null;
    if (!handler) return row;
    const button = el("button", row.className);
    button.type = "button";
    for (const [key, value] of Object.entries(row.dataset)) {
      button.dataset[key] = value;
    }
    button.append(...row.childNodes);
    button.addEventListener("click", handler);
    return button;
  }

  function reviewRow(props) {
    const options = props || {};
    const review = options.review || {};
    const row = el("div", "buzz-review-row");
    row.dataset.buzzComponent = "review-row";
    const summary = el("span", "buzz-review-summary");
    summary.append(
      el("span", "buzz-review-id", review.displayId || ""),
      el("strong", "buzz-review-title", review.title || "Untitled review"),
    );
    if (review.branch) {
      summary.append(el("code", "buzz-review-branch", review.branch));
    }
    const status = String(review.status || "Open");
    const pill = el("span", "buzz-status-pill", status);
    pill.dataset.status = status.toLowerCase().replaceAll(" ", "-");
    const trailing = el("span", "buzz-review-status");
    if (review.authorName) {
      trailing.append(
        avatar({
          agent: Boolean(review.authorIsAgent),
          avatarUrl: review.authorAvatarUrl || null,
          name: review.authorName,
          size: "xs",
        }),
      );
    }
    trailing.append(pill);
    row.append(summary, trailing);
    return openable(
      row,
      review.id ? { id: review.id, type: "review" } : null,
      options.onOpen,
    );
  }

  function channelRow(props) {
    const options = props || {};
    const channel = options.channel || {};
    const row = el("div", "buzz-channel-row");
    row.dataset.buzzComponent = "channel-row";
    const details = el("span", "buzz-channel-details");
    details.append(
      el("strong", "buzz-channel-name", `# ${channel.name || "channel"}`),
    );
    const meta = channel.topic || channel.description || "";
    if (meta) details.append(el("span", "buzz-channel-meta", meta));
    row.append(details);
    const people = Array.isArray(channel.people)
      ? channel.people.slice(0, 5)
      : [];
    if (people.length > 0) {
      const cluster = el("span", "buzz-channel-people");
      for (const person of people) {
        cluster.append(
          avatar({
            agent: Boolean(person.isAgent),
            avatarUrl: person.avatarDataUrl || null,
            name: person.displayName || person.pubkey || "",
            size: "xs",
          }),
        );
      }
      row.append(cluster);
    }
    return openable(
      row,
      channel.id ? { id: channel.id, type: "channel" } : null,
      options.onOpen,
    );
  }

  Object.assign(runtime.sdk, {
    app,
    capabilities: () => session.capabilities.slice(),
    data,
    ui: Object.freeze({ avatar, channelRow, reviewRow }),
    version: 1,
  });
  Object.freeze(runtime.sdk);
})();
