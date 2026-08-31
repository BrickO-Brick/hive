import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

async function openStarterProject(page: Page) {
  const projectRow = page.getByTestId("sidebar-project-buzz");
  if ((await projectRow.count()) === 0) {
    await page.getByTestId("sidebar-projects-section-label").hover();
    await page.getByTestId("sidebar-projects-create").click();
    await page.getByTestId("project-browser-result-buzz").click();
  }
  await projectRow.click();
}

async function expectCanvasReady(page: Page) {
  const iframe = page.getByTestId("project-canvas-frame");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("allow", "autoplay");
  await expect(iframe).toHaveAttribute("data-canvas-connected", "true");
  await expect(iframe).toHaveAttribute("data-canvas-rendered", "true");
  const root = page
    .frameLocator('[data-testid="project-canvas-frame"]')
    .locator("#canvas-root");
  await expect(root).toHaveAttribute("data-canvas-ready", "true");
  await expect(root).toHaveText("buzz");
  return { iframe, root };
}

test("project canvas uses one sandboxed frame across preview and full modes", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");

  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("project-canvas-surface")).toHaveCount(0);

  await openStarterProject(page);
  await expect(page.getByTestId("project-channel-home")).toBeVisible();
  const surface = page.getByTestId("project-canvas-surface");
  await expect(surface).toHaveAttribute("data-canvas-mode", "preview");
  await expect(page.getByTestId("project-canvas-show-full")).toBeVisible();
  await expect(page.getByTestId("channel-composer-overlay")).toBeVisible();

  const { iframe, root } = await expectCanvasReady(page);
  const initialSource = await iframe.getAttribute("src");
  expect(initialSource).toMatch(/^data:text\/html/);
  await expect(root).toHaveAttribute("data-parent-dom", "blocked");
  await expect(root).toHaveAttribute("data-tauri-ipc", "blocked");
  await expect(root).toHaveAttribute("data-popup", "blocked");
  await expect(root).toHaveAttribute("data-network", "blocked");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "commit_project_canvas_package",
          ).length,
      ),
    )
    .toBe(1);

  await page.getByTestId("project-canvas-open-source").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window.__BUZZ_E2E_COMMANDS__ ?? []).includes(
          "open_project_canvas_source",
        ),
      ),
    )
    .toBe(true);

  await page.getByTestId("project-canvas-show-full").click();
  await expect(surface).toHaveAttribute("data-canvas-mode", "full");
  await expect(page.getByTestId("project-channel-tab-canvas")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByTestId("project-canvas-preview-boundary"),
  ).toBeVisible();
  await expect(page.getByTestId("channel-composer-overlay")).toBeHidden();
  await expect(iframe).toHaveAttribute("src", initialSource ?? "");
  await expect(root).toHaveAttribute("data-canvas-mode", "full");

  await page.getByTestId("chat-title-tab").click();
  await expect(surface).toHaveAttribute("data-canvas-mode", "preview");
  await expect(root).toHaveAttribute("data-canvas-mode", "preview");
  await expect(page.getByTestId("channel-composer-overlay")).toBeVisible();

  const loadCommands = await page.evaluate(
    () =>
      (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
        (command) => command === "get_project_canvas_package",
      ).length,
  );
  expect(loadCommands).toBe(1);

  const releasesBeforeHiddenTab = await page.evaluate(
    () =>
      (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
        (command) => command === "release_project_canvas_package",
      ).length,
  );
  await page.getByTestId("project-channel-tab-channels").click();
  await expect(page.getByTestId("project-canvas-frame")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "release_project_canvas_package",
          ).length,
      ),
    )
    .toBeGreaterThan(releasesBeforeHiddenTab);

  await page.getByTestId("chat-title-tab").click();
  await expectCanvasReady(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "get_project_canvas_package",
          ).length,
      ),
    )
    .toBe(2);
});

test("Reload activates a new package revision and releases the old handle", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await openStarterProject(page);
  const { iframe } = await expectCanvasReady(page);
  const initialSource = await iframe.getAttribute("src");

  await page.getByTestId("project-canvas-reload").click();
  await expect.poll(() => iframe.getAttribute("src")).not.toBe(initialSource);
  await expectCanvasReady(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "activate_project_canvas_package",
          ).length,
      ),
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "release_project_canvas_package",
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(1);
});

test("agent notifications update data in place and reload presentation", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await openStarterProject(page);
  const { iframe, root } = await expectCanvasReady(page);
  const initialSource = await iframe.getAttribute("src");
  const request = await page.evaluate(() => {
    const entry = (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).find(
      (candidate) => candidate.command === "get_project_canvas_package",
    );
    return (entry?.payload as { request?: unknown } | undefined)?.request;
  });
  expect(request).toBeTruthy();

  await page.evaluate(async (binding) => {
    window.__BUZZ_E2E_SET_PROJECT_CANVAS_UPDATE__?.("data");
    await window.__BUZZ_E2E_EMIT_TAURI_EVENT__?.(
      "project-canvas-source-updated",
      binding,
    );
  }, request);
  await expect(root).toHaveAttribute("data-canvas-widget-data-changed", "true");
  await expect(root).toHaveAttribute("data-canvas-widget-id", "e2e-widget");
  await expect(root).toHaveAttribute("data-canvas-widget-version", "2");
  await expect(iframe).toHaveAttribute("src", initialSource ?? "");

  await page.evaluate(async (binding) => {
    window.__BUZZ_E2E_SET_PROJECT_CANVAS_UPDATE__?.("presentation");
    await window.__BUZZ_E2E_EMIT_TAURI_EVENT__?.(
      "project-canvas-source-updated",
      binding,
    );
  }, request);
  await expect.poll(() => iframe.getAttribute("src")).not.toBe(initialSource);
  await expectCanvasReady(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "get_project_canvas_updates",
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(3);
});

test("a failed candidate commit restores the active Canvas", async ({
  page,
}) => {
  await installMockBridge(page, {
    projectCanvasCandidateCommitError: "candidate commit rejected",
  });
  await page.goto("/");
  await openStarterProject(page);
  const { iframe } = await expectCanvasReady(page);
  const activeSource = await iframe.getAttribute("src");

  await page.getByTestId("project-canvas-reload").click();
  await expect.poll(() => iframe.getAttribute("src")).not.toBe(activeSource);
  await expect(page.getByTestId("project-canvas-reload-error")).toContainText(
    "restored the active version",
  );
  await expectCanvasReady(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "get_project_canvas_package",
          ).length,
      ),
    )
    .toBe(2);
});

test("project canvas preview and full tab stay contained at a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await openStarterProject(page);
  await page.keyboard.press("Escape");

  const surface = page.getByTestId("project-canvas-surface");
  const { iframe } = await expectCanvasReady(page);
  await expect(surface).toHaveAttribute("data-canvas-mode", "preview");
  await expect(page.getByTestId("project-canvas-show-full")).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  const frameBox = await iframe.boundingBox();
  if (!surfaceBox || !frameBox)
    throw new Error("Canvas frame was not visible.");
  expect(frameBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
  expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(
    surfaceBox.x + surfaceBox.width,
  );

  await page.getByTestId("project-canvas-show-full").click();
  await expect(surface).toHaveAttribute("data-canvas-mode", "full");
  await expect(page.getByTestId("channel-composer-overlay")).toBeHidden();
  await expect(
    page
      .frameLocator('[data-testid="project-canvas-frame"]')
      .locator("#canvas-root"),
  ).toHaveAttribute("data-canvas-mode", "full");
});

test("unexpected child navigation tears down the Canvas frame", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await openStarterProject(page);
  const { root } = await expectCanvasReady(page);

  await root.evaluate(() => {
    window.location.href = "about:blank#unexpected-canvas-navigation";
  });

  await expect(page.getByTestId("project-canvas-frame")).toHaveCount(0);
  await expect(page.getByTestId("project-canvas-error")).toContainText(
    "navigated away",
  );
  await expect(page.getByTestId("project-canvas-open-source")).toBeVisible();
});

test("a reload that returns after project navigation is released as stale", async ({
  page,
}) => {
  await installMockBridge(page, { projectCanvasActivationDelayMs: 300 });
  await page.goto("/");
  await openStarterProject(page);
  await expectCanvasReady(page);

  await page.getByTestId("project-canvas-reload").click();
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("project-canvas-surface")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
            (command) => command === "release_project_canvas_package",
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(2);
});
