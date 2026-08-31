(() => {
  const PROTOCOL_VERSION = 1;
  const INTERACTIVE_SELECTOR =
    "a,button,input,label,select,textarea,video[controls],[role='button'],[data-no-drag]";
  const runtime = window.buzzCanvas;
  const root = document.getElementById("canvas-root");
  const widgetModules = Object.values(window.buzzCanvasWidgets || {});
  const widgetRenderers = Object.assign(
    {},
    ...widgetModules.map((module) => module.renderers || {}),
  );
  const companionRenderers = Object.assign(
    {},
    ...widgetModules.map((module) => module.companions || {}),
  );

  if (!root) throw new Error("Canvas shell is missing #canvas-root");
  if (
    !runtime ||
    runtime.protocolVersion !== PROTOCOL_VERSION ||
    !runtime.port
  ) {
    throw new Error("Canvas shell did not provide a compatible MessagePort");
  }

  const state = {
    activeWidget: null,
    canvasId: null,
    dashboard: null,
    data: null,
    loadId: null,
    mode: "preview",
    nonce: null,
    positions: new Map(),
    project: null,
    snapshots: null,
    translation: { x: 24, y: 24 },
  };

  const port = runtime.port;
  port.addEventListener("message", onHostMessage);
  port.start();

  function onHostMessage(event) {
    const message = event.data;
    if (!message || message.protocolVersion !== PROTOCOL_VERSION) return;
    if (message.type === "host.init") initialize(message);
    if (message.type === "host.mode" && matchesSession(message)) {
      setMode(message.mode);
    }
    if (message.type === "host.dataChanged" && matchesSession(message)) {
      state.snapshots = message.snapshots || {};
      renderSnapshotWidgets();
    }
    if (message.type === "host.widgetDataChanged" && matchesSession(message)) {
      applyWidgetDataUpdate(message.widgetId, message.data);
    }
  }

  function matchesSession(message) {
    return message.loadId === state.loadId && message.nonce === state.nonce;
  }

  function initialize(message) {
    if (!isInitMessage(message)) return;
    state.canvasId = message.canvasId;
    state.data = message.data;
    state.loadId = message.loadId;
    state.nonce = message.nonce;
    state.project = message.project;
    state.snapshots = message.snapshots || null;
    state.mode = normalizeMode(message.mode);
    state.dashboard = selectDashboard(message.data, message.project);
    state.translation = { x: 24, y: 24 };
    state.positions.clear();
    for (const widget of state.dashboard.widgets) {
      state.positions.set(widget.id, { ...widget.position });
    }
    renderCanvas();
    port.postMessage({
      type: "canvas.rendered",
      protocolVersion: PROTOCOL_VERSION,
      loadId: state.loadId,
      nonce: state.nonce,
      dashboard: state.dashboard.id,
    });
  }

  function isInitMessage(message) {
    if (message.type !== "host.init" || !message.loadId || !message.nonce) {
      return false;
    }
    if (!message.project || typeof message.project.name !== "string") {
      return false;
    }
    return Boolean(message.data?.dashboards);
  }

  function normalizeMode(mode) {
    return mode === "full" ? "full" : "preview";
  }

  function normalizeName(name) {
    return String(name || "")
      .trim()
      .replace(/^#/, "")
      .toLowerCase();
  }

  function selectDashboard(data, project) {
    const names = [project.name, project.displayName, ...(project.names || [])];
    let dashboardId = data.defaultDashboard;
    for (const name of names) {
      const match = data.selectors[normalizeName(name)];
      if (match) {
        dashboardId = match;
        break;
      }
    }
    const dashboard = data.dashboards[dashboardId] || data.dashboards.dev;
    return { ...dashboard, id: dashboardId };
  }

  function setMode(mode) {
    state.mode = normalizeMode(mode);
    const canvas = root.querySelector("[data-testid='project-widget-canvas']");
    if (canvas) canvas.dataset.canvasMode = state.mode;
  }

  function element(tag, className, attributes) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes || {})) {
      if (value === undefined || value === null) continue;
      if (name === "text") node.textContent = String(value);
      else if (name === "testId") node.dataset.testid = String(value);
      else if (name === "ariaLabel")
        node.setAttribute("aria-label", String(value));
      else node.setAttribute(name, String(value));
    }
    return node;
  }

  function icon(glyph, tone) {
    return element("span", `icon ${tone || ""}`, {
      "aria-hidden": "true",
      text: glyph,
    });
  }

  function resolveAsset(path) {
    try {
      return new URL(path, window.buzzCanvas.packageBaseUrl).href;
    } catch (_error) {
      return path;
    }
  }

  function renderCanvas() {
    root.replaceChildren();
    const canvas = element("section", `canvas tone-${state.dashboard.tone}`, {
      ariaLabel: "Project widget canvas",
      testId: "project-widget-canvas",
    });
    canvas.dataset.canvasMode = state.mode;
    updateTranslationData(canvas);
    canvas.addEventListener("pointerdown", startCanvasPan);

    const world = element("div", "canvas-world", {
      testId: "project-widget-canvas-world",
    });
    updateWorldTransform(world);
    for (const widget of state.dashboard.widgets) {
      world.append(renderWidgetGroup(widget));
    }
    canvas.append(world, renderResetButton());
    root.append(canvas, renderDialogLayer());
  }

  function renderWidgetGroup(widget) {
    const position = state.positions.get(widget.id);
    const group = element("div", "widget-group");
    group.dataset.widgetId = widget.id;
    group.style.width = `${widget.size.width}px`;
    group.style.height = `${widget.size.height}px`;
    moveWidgetGroup(group, position);

    const article = element("article", "widget", {
      ariaLabel: `${widget.title} widget`,
      testId: `project-canvas-widget-${widget.id}`,
      tabindex: "0",
    });
    article.setAttribute("aria-roledescription", "movable widget");
    article.dataset.worldX = String(position.x);
    article.dataset.worldY = String(position.y);
    article.addEventListener("pointerdown", (event) =>
      startWidgetDrag(event, widget),
    );
    article.addEventListener("keydown", (event) => nudgeWidget(event, widget));
    if (!widget.hideHeader) article.append(renderWidgetHeader(widget));
    article.append(renderWidgetContent(widget));
    group.append(article);

    const companion = renderCompanion(widget);
    if (companion) group.append(companion);
    return group;
  }

  function renderWidgetHeader(widget) {
    const header = element("header", "widget-header", {
      testId: `project-canvas-widget-${widget.id}-header`,
    });
    header.append(
      icon(widgetIcon(widget.type)),
      element("h2", "", { text: widget.title }),
    );
    return header;
  }

  function widgetIcon(type) {
    return (
      {
        activeChannels: "#",
        choreBoard: "✓",
        clientTime: "◷",
        meetings: "□",
        reviews: "↗",
      }[type] || "•"
    );
  }

  function renderWidgetContent(widget) {
    const renderer = widgetRenderers[widget.type];
    const content = element("div", "widget-content");
    if (renderer)
      content.append(renderWith(renderer, resolveWidgetData(widget)));
    else
      content.append(
        element("p", "empty-state", { text: "Widget unavailable" }),
      );
    return content;
  }

  function renderWith(renderer, data) {
    if (typeof renderer === "function") return renderer(data, widgetApi);
    if (renderer && typeof renderer.render === "function") {
      return renderer.render(data, widgetApi);
    }
    return element("p", "empty-state", { text: "Widget unavailable" });
  }

  function applyWidgetDataUpdate(widgetId, data) {
    const nextDashboard = selectDashboard(data, state.project);
    const currentWidget = state.dashboard.widgets.find(
      (widget) => widget.id === widgetId,
    );
    const nextWidget = nextDashboard.widgets.find(
      (widget) => widget.id === widgetId,
    );
    if (!currentWidget || !nextWidget) return;
    const group = [...root.querySelectorAll("[data-widget-id]")].find(
      (candidate) => candidate.dataset.widgetId === widgetId,
    );
    const content = group?.querySelector(".widget-content");
    if (!content) return;

    const previousData = resolveWidgetData(currentWidget);
    state.data = data;
    currentWidget.data = nextWidget.data;
    const nextData = resolveWidgetData(currentWidget);
    const renderer = widgetRenderers[currentWidget.type];
    if (
      renderer &&
      typeof renderer === "object" &&
      typeof renderer.update === "function"
    ) {
      const current = content.firstElementChild;
      const updated = renderer.update(
        current,
        nextData,
        previousData,
        widgetApi,
      );
      if (updated && updated !== current) content.replaceChildren(updated);
      return;
    }
    content.replaceChildren(renderWith(renderer, nextData));
  }

  function resolveWidgetData(widget) {
    if (widget.type === "activeChannels") {
      return resolveSnapshotWidgetData(
        "channels",
        widget.data,
        normalizeChannels,
      );
    }
    if (widget.type === "reviews") {
      return resolveSnapshotWidgetData(
        "reviews",
        widget.data,
        normalizeReviews,
      );
    }
    return widget.data;
  }

  function renderSnapshotWidgets() {
    const snapshotTypes = new Set(["activeChannels", "reviews"]);
    for (const widget of state.dashboard.widgets) {
      if (!snapshotTypes.has(widget.type)) continue;
      const group = [...root.querySelectorAll("[data-widget-id]")].find(
        (candidate) => candidate.dataset.widgetId === widget.id,
      );
      const content = group?.querySelector(".widget-content");
      if (content) content.replaceChildren(renderWidgetContent(widget));
    }
  }

  function resolveSnapshotWidgetData(key, fixture, normalize) {
    if (!state.snapshots || !Object.hasOwn(state.snapshots, key)) {
      return { ...fixture, snapshotState: "unavailable", [key]: [] };
    }
    const snapshot = state.snapshots[key];
    if (!snapshot || snapshot.status === "loading") {
      return { ...fixture, snapshotState: "loading", [key]: [] };
    }
    if (snapshot.status === "error") {
      return { ...fixture, snapshotState: "error", [key]: [] };
    }
    const rows = Array.isArray(snapshot.data) ? snapshot.data : [];
    return {
      ...fixture,
      snapshotState: rows.length ? "ready" : "empty",
      [key]: normalize(rows),
    };
  }

  function normalizeChannels(channels) {
    return channels.map((channel) => {
      const updates = Array.isArray(channel.updates)
        ? channel.updates.slice(0, 3).map(String)
        : [
            channel.topic || channel.description,
            formatLastActivity(channel.lastMessageAt),
            channel.memberCount ? `${channel.memberCount} members` : null,
          ]
            .filter(Boolean)
            .map(String);
      const people = Array.isArray(channel.people)
        ? channel.people
            .filter((person) => person?.pubkey)
            .slice(0, 5)
            .map((person) => ({
              id: person.pubkey,
              inlinePerson: person,
            }))
        : [];
      return {
        name: channel.name || channel.displayName || "channel",
        people,
        updates: updates.length ? updates : ["No recent updates"],
      };
    });
  }

  function formatLastActivity(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return `Last activity ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date)}`;
  }

  function normalizeReviews(reviews) {
    return reviews.map((review, index) => ({
      agentName: review.agentName || null,
      agentPubkey: review.agentPubkey || null,
      avatarId: review.avatarId || (index % 2 === 0 ? 14 : 19),
      branch: review.branch || review.ref || "review",
      displayId:
        review.displayId || (review.number ? `PR #${review.number}` : "Review"),
      gloopie:
        index % 2 === 0 ? "assets/gloopies-14.webm" : "assets/gloopies-19.webm",
      poster:
        index % 2 === 0 ? "assets/gloopies-14.png" : "assets/gloopies-19.png",
      status: [
        "Approved",
        "Changes requested",
        "Requested",
        "Reviewing",
      ].includes(review.status)
        ? review.status
        : "Requested",
      title: review.title || "Review awaiting response",
    }));
  }

  function renderCompanion(widget) {
    const renderer = companionRenderers[widget.type];
    return renderer ? renderer(widget, widgetApi) : null;
  }

  function startCanvasPan(event) {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    const canvas = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY };
    const origin = { ...state.translation };
    canvas.classList.add("dragging");
    trackPointer(
      event,
      (point) => {
        state.translation = {
          x: origin.x + point.x - start.x,
          y: origin.y + point.y - start.y,
        };
        updateTranslationData(canvas);
        updateWorldTransform(canvas.querySelector(".canvas-world"));
      },
      () => canvas.classList.remove("dragging"),
    );
  }

  function startWidgetDrag(event, widget) {
    if (event.button !== 0 || event.target.closest(INTERACTIVE_SELECTOR))
      return;
    event.preventDefault();
    event.stopPropagation();
    const article = event.currentTarget;
    const group = article.parentElement;
    const start = { x: event.clientX, y: event.clientY };
    const origin = { ...state.positions.get(widget.id) };
    state.activeWidget = widget.id;
    group.classList.add("active", "dragging");
    trackPointer(
      event,
      (point) => {
        const next = {
          x: origin.x + point.x - start.x,
          y: origin.y + point.y - start.y,
        };
        state.positions.set(widget.id, next);
        moveWidgetGroup(group, next);
        article.dataset.worldX = String(Math.round(next.x));
        article.dataset.worldY = String(Math.round(next.y));
      },
      () => {
        const snapped = snapPoint(state.positions.get(widget.id));
        state.positions.set(widget.id, snapped);
        moveWidgetGroup(group, snapped);
        article.dataset.worldX = String(snapped.x);
        article.dataset.worldY = String(snapped.y);
        group.classList.remove("dragging");
      },
    );
  }

  function trackPointer(event, onMove, onEnd) {
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    target.setPointerCapture(pointerId);
    const move = (nextEvent) => {
      if (nextEvent.pointerId === pointerId) onMove(nextEvent);
    };
    const end = (nextEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (target.hasPointerCapture(pointerId))
        target.releasePointerCapture(pointerId);
      onEnd(nextEvent);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function nudgeWidget(event, widget) {
    if (event.target !== event.currentTarget) return;
    const amount = event.shiftKey ? 48 : 24;
    const delta = {
      ArrowDown: { x: 0, y: amount },
      ArrowLeft: { x: -amount, y: 0 },
      ArrowRight: { x: amount, y: 0 },
      ArrowUp: { x: 0, y: -amount },
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    const current = state.positions.get(widget.id);
    const next = snapPoint({ x: current.x + delta.x, y: current.y + delta.y });
    state.positions.set(widget.id, next);
    const group = event.currentTarget.parentElement;
    moveWidgetGroup(group, next);
    event.currentTarget.dataset.worldX = String(next.x);
    event.currentTarget.dataset.worldY = String(next.y);
  }

  function snapPoint(point) {
    return {
      x: Math.round(point.x / 24) * 24,
      y: Math.round(point.y / 24) * 24,
    };
  }

  function moveWidgetGroup(group, position) {
    group.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  function updateWorldTransform(world) {
    world.style.transform = `translate3d(${state.translation.x}px, ${state.translation.y}px, 0)`;
  }

  function updateTranslationData(canvas) {
    canvas.dataset.panX = String(Math.round(state.translation.x));
    canvas.dataset.panY = String(Math.round(state.translation.y));
    canvas.dataset.projectDashboard = state.dashboard ? state.dashboard.id : "";
  }

  function renderResetButton() {
    const button = element("button", "reset-button", {
      ariaLabel: "Reset canvas position",
      testId: "project-widget-canvas-reset",
      title: "Reset canvas position",
      type: "button",
    });
    button.append(icon("⌖"));
    button.addEventListener("click", () => {
      state.translation = { x: 24, y: 24 };
      const canvas = root.querySelector(
        "[data-testid='project-widget-canvas']",
      );
      updateTranslationData(canvas);
      updateWorldTransform(canvas.querySelector(".canvas-world"));
    });
    return button;
  }

  function renderDialogLayer() {
    return element("div", "dialog-layer", { testId: "canvas-dialog-layer" });
  }

  function showDialog(title, body, testId) {
    const layer = root.querySelector(".dialog-layer");
    const backdrop = element("div", "dialog-backdrop");
    const dialog = element("section", "dialog", { testId });
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.append(element("h2", "dialog-title", { text: title }), body);
    const close = element("button", "dialog-close", {
      ariaLabel: "Close",
      text: "×",
      type: "button",
    });
    close.addEventListener("click", () => layer.replaceChildren());
    dialog.prepend(close);
    backdrop.append(dialog);
    layer.replaceChildren(backdrop);
    close.focus();
  }

  const widgetApi = Object.freeze({
    element,
    icon,
    resolveAsset,
    showDialog,
    state: () => state,
  });
})();
