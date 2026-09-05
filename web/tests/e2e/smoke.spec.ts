import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

function mantapTicket(subject: string, email: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: subject, email })).toString(
    "base64url",
  );
  return `${header}.${payload}.test-signature`;
}

function nip98Pubkey(authorization: string | undefined): string {
  expect(authorization).toMatch(/^Nostr /);
  const event = JSON.parse(
    Buffer.from(authorization?.slice("Nostr ".length) ?? "", "base64").toString(
      "utf8",
    ),
  ) as { pubkey: string };
  return event.pubkey;
}

test("home page loads with Hive branding", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("main").getByRole("img", { name: "Hive" }),
  ).toBeVisible();
});

test("home page shows repositories section", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Repositories")).toBeVisible();
});

test("Hive redirects a signed-out browser to Mantap", async ({ page }) => {
  await page.route("https://mantap.onebrick.io/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Mantap</title>",
    });
  });

  const discussion = "69e04c53-040e-4ba3-b1f2-6abb6cae5243";
  await page.goto(`/app?discussion=${discussion}`);

  await expect(page).toHaveURL(/https:\/\/mantap\.onebrick\.io\//);
  const loginUrl = new URL(page.url());
  const callback = new URL(loginUrl.searchParams.get("returnTo") ?? "");
  expect(callback.pathname).toBe("/mantul-sso");
  expect(callback.searchParams.get("returnTo")).toBe(
    `/app?discussion=${discussion}`,
  );
});

test("Hive redirects a missing SSO ticket to Mantap", async ({ page }) => {
  await page.route("https://mantap.onebrick.io/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Mantap</title>",
    });
  });

  await page.goto("/mantul-sso");

  await expect(page).toHaveURL(/https:\/\/mantap\.onebrick\.io\//);
  const loginUrl = new URL(page.url());
  const callback = new URL(loginUrl.searchParams.get("returnTo") ?? "");
  expect(callback.pathname).toBe("/mantul-sso");
  expect(callback.searchParams.get("returnTo")).toBe("/app");
});

test("Hive restores the requested discussion after Mantap SSO", async ({
  page,
}) => {
  await page.route("**/api/onebrick/sso/exchange", async (route) => {
    const pubkey = nip98Pubkey(route.request().headers().authorization);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        email: "bricko@onebrick.io",
        subject: "mantap-user:bricko",
        pubkey,
        channel_id: "62ae672f-ab7b-4619-b013-13eec0111943",
        role: "member",
      }),
    });
  });
  const discussion = "69e04c53-040e-4ba3-b1f2-6abb6cae5243";
  const ticket = mantapTicket("mantap-user:bricko", "bricko@onebrick.io");

  await page.goto(
    `/mantul-sso?returnTo=${encodeURIComponent(`/app?discussion=${discussion}`)}#ticket=${ticket}`,
  );

  await expect(page).toHaveURL(`/app?discussion=${discussion}`);
});

test("Hive rejects an external post-SSO return target", async ({ page }) => {
  await page.route("**/api/onebrick/sso/exchange", async (route) => {
    const pubkey = nip98Pubkey(route.request().headers().authorization);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        email: "bricko@onebrick.io",
        subject: "mantap-user:bricko",
        pubkey,
        channel_id: "62ae672f-ab7b-4619-b013-13eec0111943",
        role: "member",
      }),
    });
  });
  const ticket = mantapTicket("mantap-user:bricko", "bricko@onebrick.io");

  await page.goto(
    `/mantul-sso?returnTo=${encodeURIComponent("https://example.com/phish")}#ticket=${ticket}`,
  );

  await expect(page).toHaveURL(/\/app$/);
});

test("Hive returns a Mantap ticket to the native desktop callback", async ({
  page,
}) => {
  const ticket = mantapTicket("mantap-user:bricko", "bricko@onebrick.io");
  const callback = "http://127.0.0.1:43123/callback/native-nonce";
  await page.route("http://127.0.0.1:43123/**", async (route) => {
    await route.fulfill({ status: 200, body: "Hive sign-in complete" });
  });

  await page.goto(
    `/mantul-sso?desktop_callback=${encodeURIComponent(callback)}#ticket=${ticket}`,
  );

  await expect(page).toHaveURL(
    `${callback}?ticket=${encodeURIComponent(ticket)}`,
  );
});

test("Hive switches Mantap accounts without rebinding their browser identities", async ({
  page,
}) => {
  const observed: Array<{ subject: string; pubkey: string }> = [];
  const subjectsByTicket = new Map([
    [
      mantapTicket("mantap-user:bricki", "bricki@onebrick.io"),
      "mantap-user:bricki",
    ],
    [
      mantapTicket("mantap-user:bricko", "bricko@onebrick.io"),
      "mantap-user:bricko",
    ],
  ]);

  await page.route("**/api/onebrick/sso/exchange", async (route) => {
    const request = route.request();
    const { ticket } = request.postDataJSON() as { ticket: string };
    const subject = subjectsByTicket.get(ticket);
    expect(subject).toBeTruthy();
    const pubkey = nip98Pubkey(request.headers().authorization);
    observed.push({ subject: subject ?? "", pubkey });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        email:
          subject === "mantap-user:bricki"
            ? "bricki@onebrick.io"
            : "bricko@onebrick.io",
        subject,
        pubkey,
        channel_id: "62ae672f-ab7b-4619-b013-13eec0111943",
        role: "member",
      }),
    });
  });

  const brickiTicket = [...subjectsByTicket.entries()].find(
    ([, subject]) => subject === "mantap-user:bricki",
  )?.[0];
  const brickoTicket = [...subjectsByTicket.entries()].find(
    ([, subject]) => subject === "mantap-user:bricko",
  )?.[0];
  expect(brickiTicket).toBeTruthy();
  expect(brickoTicket).toBeTruthy();

  await page.goto(`/mantul-sso#ticket=${brickiTicket}`);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto(`/mantul-sso#ticket=${brickoTicket}`);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto(`/mantul-sso#ticket=${brickiTicket}`);
  await expect(page).toHaveURL(/\/app$/);

  expect(observed).toHaveLength(3);
  expect(observed[0].pubkey).not.toBe(observed[1].pubkey);
  expect(observed[2].pubkey).toBe(observed[0].pubkey);
});

test("Hive rotates a historical conflicting key once and completes SSO", async ({
  page,
}) => {
  const pubkeys: string[] = [];
  let attempt = 0;
  await page.addInitScript(() => {
    localStorage.setItem("hive.mantap.nostr-secret.v1", `${"00".repeat(31)}01`);
  });
  await page.route("**/api/onebrick/sso/exchange", async (route) => {
    attempt += 1;
    const pubkey = nip98Pubkey(route.request().headers().authorization);
    pubkeys.push(pubkey);
    if (attempt === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "nostr_key_already_bound" }),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        email: "bricki@onebrick.io",
        subject: "mantap-user:bricki",
        pubkey,
        channel_id: "62ae672f-ab7b-4619-b013-13eec0111943",
        role: "member",
      }),
    });
  });

  const ticket = mantapTicket("mantap-user:bricki", "bricki@onebrick.io");
  await page.goto(`/mantul-sso#ticket=${ticket}`);
  await expect(
    page.getByText("Syncing your Mantap account with your Hive identity…"),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/app$/);

  expect(attempt).toBe(2);
  expect(pubkeys[0]).not.toBe(pubkeys[1]);
});

test("Hive shows an actionable SSO error instead of redirecting in a loop", async ({
  page,
}) => {
  await page.route("**/api/onebrick/sso/exchange", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "mantap_sso_unavailable" }),
    });
  });

  const ticket = mantapTicket("mantap-user:bricki", "bricki@onebrick.io");
  await page.goto(`/mantul-sso#ticket=${ticket}`);

  await expect(page).toHaveURL(/\/mantul-sso$/);
  await expect(
    page.getByText(
      "Hive cannot validate Mantap right now. Please try again shortly.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Return to Mantap" }),
  ).toBeVisible();
});

test("invite requires age and legal consent before opening Hive", async ({
  page,
}) => {
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: {
          terms_markdown: "# Terms",
          privacy_markdown: "# Privacy",
          age_attestation_required: true,
          version: "policy-v1",
        },
      }),
    });
  });
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify([
        { draft: false, prerelease: false, assets: [] },
        {
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "Hive_0.5.21_aarch64.dmg",
              browser_download_url:
                "https://github.com/BrickO-Brick/hive/releases/download/desktop-v0.5.21/Hive_0.5.21_aarch64.dmg",
            },
            {
              name: "Hive_0.5.21_x64.dmg",
              browser_download_url:
                "https://github.com/BrickO-Brick/hive/releases/download/desktop-v0.5.21/Hive_0.5.21_x64.dmg",
            },
            {
              name: "Hive_0.5.21_amd64.AppImage",
              browser_download_url:
                "https://github.com/BrickO-Brick/hive/releases/download/desktop-v0.5.21/Hive_0.5.21_amd64.AppImage",
            },
            {
              name: "Hive_0.5.21_x64-setup_alpha-unsigned.exe",
              browser_download_url:
                "https://github.com/BrickO-Brick/hive/releases/download/desktop-v0.5.21/Hive_0.5.21_x64-setup_alpha-unsigned.exe",
            },
          ],
        },
      ]),
    });
  });
  await page.goto("/invite/demo-code");

  await expect(
    page.getByRole("link", { name: "Download it now" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/BrickO-Brick/hive/releases/download/desktop-v0.5.21/Hive_0.5.21_x64-setup_alpha-unsigned.exe",
  );

  const ageConfirmation = page.getByLabel("I am 18 years of age or older.");
  const agreementConfirmation = page.getByLabel(
    "I agree to the Hive Terms of Service and Privacy Policy.",
  );
  const acceptInvite = page.getByRole("button", {
    name: "Accept invite in Hive",
  });

  await expect(ageConfirmation).toBeVisible();
  await expect(agreementConfirmation).toBeVisible();
  await expect(acceptInvite).toBeDisabled();

  const termsLink = page.getByRole("button", { name: "Terms of Service" });
  const privacyLink = page.getByRole("button", { name: "Privacy Policy" });
  await expect(termsLink).toHaveCSS("text-decoration-line", "none");
  await expect(privacyLink).toHaveCSS("text-decoration-line", "none");
  await termsLink.hover();
  await expect(termsLink).toHaveCSS("text-decoration-line", "underline");
  await page.mouse.move(0, 0);
  await privacyLink.hover();
  await expect(privacyLink).toHaveCSS("text-decoration-line", "underline");

  await page
    .locator("label")
    .filter({ hasText: "I am 18 years of age or older." })
    .click();
  await expect(ageConfirmation).toBeChecked();
  await expect(acceptInvite).toBeDisabled();
  await page
    .locator("label")
    .filter({
      hasText: "I agree to the Hive Terms of Service and Privacy Policy.",
    })
    .click({ position: { x: 8, y: 8 } });
  await expect(agreementConfirmation).toBeChecked();
  await expect(acceptInvite).toBeEnabled();

  const consentBox = await page
    .getByTestId("invite-join-policy-notice")
    .boundingBox();
  const acceptButtonBox = await acceptInvite.boundingBox();
  expect(consentBox?.y).toBeLessThan(acceptButtonBox?.y ?? 0);
  expect(consentBox?.width).toBe(acceptButtonBox?.width);
});

test("invite can enroll a NIP-07 identity for browser access", async ({
  page,
}) => {
  const pubkey = "ab".repeat(32);
  await page.addInitScript((extensionPubkey) => {
    (
      window as Window & {
        nostr?: {
          getPublicKey(): Promise<string>;
          signEvent(
            event: Record<string, unknown>,
          ): Promise<Record<string, unknown>>;
        };
      }
    ).nostr = {
      async getPublicKey() {
        return extensionPubkey;
      },
      async signEvent(event) {
        return {
          ...event,
          id: "cd".repeat(32),
          pubkey: extensionPubkey,
          sig: "ef".repeat(64),
        };
      },
    };
  }, pubkey);
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });

  let claimObserved = false;
  await page.route("**/api/invites/claim", async (route) => {
    claimObserved = true;
    const request = route.request();
    const body = request.postData() ?? "";
    expect(JSON.parse(body)).toEqual({
      code: "browser-code",
    });

    const authorization = request.headers().authorization;
    expect(authorization).toMatch(/^Nostr /);
    const event = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString(
        "utf8",
      ),
    ) as {
      pubkey: string;
      tags: string[][];
    };
    expect(event.pubkey).toBe(pubkey);
    expect(event.tags).toContainEqual(["u", request.url()]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual([
      "payload",
      createHash("sha256").update(body).digest("hex"),
    ]);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "joined",
        community_id: "community-id",
        host: "127.0.0.1",
        role: "member",
      }),
    });
  });

  await page.goto("/invite/browser-code");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");
  expect(claimObserved).toBe(true);
});

test("invite asks Safari users to choose their Mac download", async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.5 Safari/605.1.15",
  });
  await context.addInitScript(() => {
    Object.defineProperties(navigator, {
      platform: { configurable: true, value: "MacIntel" },
      maxTouchPoints: { configurable: true, value: 0 },
      userAgentData: { configurable: true, value: undefined },
    });
  });
  const page = await context.newPage();
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({ status: 500 });
  });

  await page.goto("/invite/demo-code");
  const download = page.getByRole("link", { name: "Download it now" });
  await expect(download).toHaveAttribute("aria-haspopup", "dialog");
  await download.click();

  const chooser = page.getByRole("dialog", {
    name: "Which Mac do you have?",
  });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("link", { name: /Newer Mac/ })).toContainText(
    "2021 or later, or a late-2020 Mac with an Apple M1 chip",
  );
  await expect(chooser.getByRole("link", { name: /Older Mac/ })).toContainText(
    "2019 or earlier, or a 2020 Mac with an Intel processor",
  );
  await expect(chooser.getByText("About This Mac")).toBeVisible();

  const openedPagePromise = context.waitForEvent("page");
  await chooser.getByRole("link", { name: /Newer Mac/ }).click();
  const openedPage = await openedPagePromise;
  await expect(chooser).toBeHidden();
  await expect(openedPage).toHaveURL(
    "https://github.com/BrickO-Brick/hive/releases",
  );
  await expect(page).toHaveURL(/\/invite\/demo-code$/);
  await openedPage.close();

  await download.click();
  await expect(chooser).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();
  await expect(download).toBeFocused();
  await context.close();
});

test("invite download falls back for mobile and non-desktop devices", async ({
  browser,
}) => {
  const unsupportedDevices = [
    {
      name: "iPhone Safari",
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "iPadOS desktop mode",
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "Android phone",
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Mobile",
      maxTouchPoints: 5,
    },
    {
      name: "ChromeOS",
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36",
      maxTouchPoints: 0,
    },
  ];

  for (const device of unsupportedDevices) {
    const context = await browser.newContext({ userAgent: device.userAgent });
    await context.addInitScript(({ platform, maxTouchPoints }) => {
      Object.defineProperties(navigator, {
        platform: { configurable: true, value: platform },
        maxTouchPoints: { configurable: true, value: maxTouchPoints },
        userAgentData: {
          configurable: true,
          value: { platform, mobile: maxTouchPoints > 0 },
        },
      });
    }, device);
    const page = await context.newPage();
    await page.route("**/api/join-policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ policy: null }),
      });
    });
    await page.route("https://api.github.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify([
          {
            draft: false,
            prerelease: false,
            assets: [
              {
                name: "Hive_0.5.21_x64.dmg",
                browser_download_url:
                  "https://github.com/BrickO-Brick/hive/releases/download/desktop-v0.5.21/Hive_0.5.21_x64.dmg",
              },
              {
                name: "Hive_0.5.21_amd64.AppImage",
                browser_download_url:
                  "https://github.com/BrickO-Brick/hive/releases/download/desktop-v0.5.21/Hive_0.5.21_amd64.AppImage",
              },
            ],
          },
        ]),
      });
    });

    await page.goto("/invite/demo-code");
    await expect(
      page.getByRole("link", { name: "Download it now" }),
      device.name,
    ).toHaveAttribute("href", "https://github.com/BrickO-Brick/hive/releases");
    await context.close();
  }
});

test("Hive shows BrickO realtime activity from relay signals", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const repositoryDiscussions: Array<Record<string, unknown>> = [];
  const timeoutValue = "${" + "options.timeoutMs}";
  let workspaceContent = [
    "export interface TimeoutOptions {",
    "  timeoutMs: number;",
    "  errorMessage?: string;",
    "}",
    "",
    "export function withTimeout(options: TimeoutOptions) {",
    `  return \`Operation timed out after ${timeoutValue}ms\`;`,
    "}",
    "",
  ].join("\n");
  let workspaceDigest = createHash("sha256")
    .update(workspaceContent)
    .digest("hex");
  let workspaceDirty = false;
  await page.route(
    "**/api/onebrick/repository-discussions/*/workspace**",
    async (route) => {
      const request = route.request();
      expect(nip98Pubkey(request.headers().authorization)).toBe(
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      );
      const url = request.url();
      if (url.endsWith("/file/read")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            path: "src/timeout.ts",
            content: workspaceContent,
            digest: workspaceDigest,
          }),
        });
        return;
      }
      if (url.endsWith("/file/write")) {
        const input = request.postDataJSON() as {
          content: string;
          expectedDigest: string;
          path: string;
        };
        expect(input.expectedDigest).toBe(workspaceDigest);
        workspaceContent = input.content;
        workspaceDigest = createHash("sha256")
          .update(workspaceContent)
          .digest("hex");
        workspaceDirty = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            path: input.path,
            content: workspaceContent,
            digest: workspaceDigest,
          }),
        });
        return;
      }
      if (url.endsWith("/diff")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            currentHeadSha: "ab".repeat(20),
            diff: workspaceDirty
              ? [
                  "diff --git a/src/timeout.ts b/src/timeout.ts",
                  "--- a/src/timeout.ts",
                  "+++ b/src/timeout.ts",
                  "@@ -5,3 +5,3 @@",
                  " export function withTimeout(options: TimeoutOptions) {",
                  `-  return \`Operation timed out after ${timeoutValue}ms\`;`,
                  `+  return \`Timed out safely after ${timeoutValue}ms\`;`,
                  " }",
                ].join("\n")
              : "",
            additions: workspaceDirty ? 1 : 0,
            deletions: workspaceDirty ? 1 : 0,
            changedFiles: workspaceDirty ? 1 : 0,
          }),
        });
        return;
      }
      if (url.endsWith("/commit")) {
        const input = request.postDataJSON() as {
          expectedHeadSha: string;
          message: string;
        };
        expect(input.expectedHeadSha).toBe("ab".repeat(20));
        expect(input.message).toContain("deployment safety");
        workspaceDirty = false;
        repositoryDiscussions[0] = {
          ...repositoryDiscussions[0],
          currentHeadSha: "cd".repeat(20),
          proposalRevision: "cd".repeat(20),
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...repositoryDiscussions[0],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          discussionId: "11111111-2222-4333-8444-555555555555",
          currentHeadSha: workspaceDirty ? "ab".repeat(20) : "ab".repeat(20),
          dirty: workspaceDirty,
          files: [
            {
              path: "src/timeout.ts",
              status: workspaceDirty ? "M" : null,
            },
            { path: "src/retry.ts", status: null },
            { path: "README.md", status: null },
          ],
        }),
      });
    },
  );
  await page.route(
    "**/api/onebrick/repository-discussions/*/close",
    async (route) => {
      expect(nip98Pubkey(route.request().headers().authorization)).toBe(
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      );
      const input = route.request().postDataJSON() as {
        completionEvidence: string;
        expectedHeadSha: string;
      };
      expect(input.expectedHeadSha).toBe("cd".repeat(20));
      expect(input.completionEvidence).toBe(
        "https://github.com/BrickO-Brick/mantul-be/pull/123",
      );
      repositoryDiscussions[0] = {
        ...repositoryDiscussions[0],
        status: "closed",
        completionEvidence: input.completionEvidence,
        closedAt: "2026-09-05T10:00:00Z",
        workspaceCleanedAt: "2026-09-05T10:00:01Z",
        mirrorCleaned: true,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(repositoryDiscussions[0]),
      });
    },
  );
  await page.route("**/api/onebrick/repository-discussions", async (route) => {
    expect(nip98Pubkey(route.request().headers().authorization)).toBe(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON() as {
        owner: string;
        repository: string;
        title: string;
      };
      const discussion = {
        id: "11111111-2222-4333-8444-555555555555",
        owner: input.owner,
        repository: input.repository,
        title: input.title,
        mirrorId: "aa".repeat(32),
        worktreeId: "11111111222243338444555555555555",
        branchRef: "refs/heads/codex/hive-discussion-111111112222",
        baseRef: "refs/heads/main",
        baseSha: "ab".repeat(20),
        currentHeadSha: "ab".repeat(20),
        proposalRevision: null,
        proposalDigest: null,
        testEvidence: [],
        createdBy:
          "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        createdAt: "2026-09-03T10:00:00Z",
        status: "active",
        completionEvidence: null,
        closedBy: null,
        closedAt: null,
        workspaceCleanedAt: null,
        mirrorCleaned: false,
      };
      repositoryDiscussions.push(discussion);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(discussion),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ discussions: repositoryDiscussions }),
    });
  });

  await page.route("**/api/onebrick/github/repositories", async (route) => {
    expect(nip98Pubkey(route.request().headers().authorization)).toBe(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        organizations: ["BrickO-Brick", "brick-io", "BrickI-Brick"],
        repositories: [
          {
            owner: "BrickO-Brick",
            name: "hive",
            description: "Collaboration workspace",
            url: "https://github.com/BrickO-Brick/hive",
            visibility: "public",
            default_branch: "main",
            updated_at: "2026-09-02T10:34:31Z",
            archived: false,
            language: "Rust",
          },
          {
            owner: "BrickO-Brick",
            name: "mantul-be",
            description: "Mantul backend",
            url: "https://github.com/BrickO-Brick/mantul-be",
            visibility: "private",
            default_branch: "main",
            updated_at: "2026-09-02T01:07:29Z",
            archived: false,
            language: "TypeScript",
          },
          {
            owner: "BrickI-Brick",
            name: "dummy",
            description: "BrickI sandbox",
            url: "https://github.com/BrickI-Brick/dummy",
            visibility: "private",
            default_branch: "main",
            updated_at: "2026-09-01T01:07:29Z",
            archived: false,
            language: "TypeScript",
          },
        ],
      }),
    });
  });

  await page.addInitScript(() => {
    const userPubkey =
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const agentPubkey = "22".repeat(32);
    const teammatePubkey = "44".repeat(32);
    const channelId = "62ae672f-ab7b-4619-b013-13eec0111943";
    localStorage.setItem("hive.mantap.nostr-secret.v1", `${"00".repeat(31)}01`);
    localStorage.setItem(
      "hive.mantap.identity.v1",
      JSON.stringify({
        email: "bricki@onebrick.io",
        pubkey: userPubkey,
        channelId,
        role: "owner",
      }),
    );

    type Filter = {
      kinds?: number[];
      authors?: string[];
      "#h"?: string[];
    };
    type HiveWindow = Window & {
      __hiveEmit?: (event: Record<string, unknown>) => void;
      __hiveSockets?: MockWebSocket[];
      __hiveLastPublished?: { id: string };
    };

    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      readonly subscriptions = new Map<string, Filter>();

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        const hiveWindow = window as HiveWindow;
        hiveWindow.__hiveSockets ??= [];
        hiveWindow.__hiveSockets.push(this);
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          this.message(["AUTH", "test-challenge"]);
        }, 0);
      }

      private message(payload: unknown) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(payload) }),
        );
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data !== "string") return;
        const frame = JSON.parse(data) as unknown[];
        if (frame[0] === "AUTH") {
          const auth = frame[1] as { id: string };
          this.message(["OK", auth.id, true, ""]);
          return;
        }
        if (frame[0] === "REQ") {
          const subscriptionId = String(frame[1]);
          const filter = frame[2] as Filter;
          this.subscriptions.set(subscriptionId, filter);
          if (filter.kinds?.includes(39002)) {
            this.message([
              "EVENT",
              subscriptionId,
              {
                id: "91".repeat(32),
                pubkey: "33".repeat(32),
                created_at: 1_788_301_200,
                kind: 39002,
                tags: [
                  ["d", channelId],
                  ["p", userPubkey, "", "owner"],
                  ["p", teammatePubkey, "", "member"],
                  ["p", agentPubkey, "", "bot"],
                ],
                content: "",
                sig: "00".repeat(64),
              },
            ]);
          } else if (filter.kinds?.includes(0)) {
            const profiles = [
              [userPubkey, "BrickI"],
              [teammatePubkey, "Sanny Gaddafi"],
              [agentPubkey, "BrickO"],
            ];
            for (const [pubkey, displayName] of profiles) {
              if (filter.authors && !filter.authors.includes(pubkey)) continue;
              this.message([
                "EVENT",
                subscriptionId,
                {
                  id: `${pubkey.slice(0, 2)}${"0".repeat(62)}`,
                  pubkey,
                  created_at: 1_788_301_205,
                  kind: 0,
                  tags: [],
                  content: JSON.stringify({ display_name: displayName }),
                  sig: "00".repeat(64),
                },
              ]);
            }
          } else if (filter.kinds?.includes(9)) {
            const now = Math.floor(Date.now() / 1000);
            const events = [
              {
                id: "a1".repeat(32),
                pubkey: userPubkey,
                created_at: now - 60,
                kind: 9,
                tags: [["h", channelId]],
                content: "BrickO, apakah koneksi realtime sudah aktif?",
                sig: "00".repeat(64),
              },
              {
                id: "b2".repeat(32),
                pubkey: agentPubkey,
                created_at: now - 52,
                kind: 9,
                tags: [["h", channelId]],
                content:
                  "**Sudah aktif.** Balasan sekarang muncul otomatis tanpa refresh manual.",
                sig: "00".repeat(64),
              },
              {
                id: "f6".repeat(32),
                pubkey: teammatePubkey,
                created_at: now - 44,
                kind: 9,
                tags: [["h", channelId]],
                content: "Saya ikut memantau percakapan ini.",
                sig: "00".repeat(64),
              },
            ];
            for (const event of events) {
              this.message(["EVENT", subscriptionId, event]);
            }
          } else if (filter.kinds?.includes(40902)) {
            this.message([
              "EVENT",
              subscriptionId,
              {
                id: "c3".repeat(32),
                pubkey: "33".repeat(32),
                created_at: 1_788_301_210,
                kind: 20001,
                tags: [["p", agentPubkey]],
                content: "online",
                sig: "00".repeat(64),
              },
            ]);
          }
          this.message(["EOSE", subscriptionId]);
          return;
        }
        if (frame[0] === "CLOSE") {
          this.subscriptions.delete(String(frame[1]));
          return;
        }
        if (frame[0] === "EVENT") {
          const event = frame[1] as { id: string };
          (window as HiveWindow).__hiveLastPublished = event;
          this.message(["OK", event.id, true, ""]);
        }
      }

      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close"));
      }
    }

    const hiveWindow = window as HiveWindow;
    hiveWindow.__hiveEmit = (event) => {
      for (const socket of hiveWindow.__hiveSockets ?? []) {
        for (const [subscriptionId, filter] of socket.subscriptions) {
          const kind = Number(event.kind);
          const pubkey = String(event.pubkey);
          const tags = event.tags as string[][];
          const channel = tags.find((tag) => tag[0] === "h")?.[1];
          if (filter.kinds && !filter.kinds.includes(kind)) continue;
          if (filter.authors && !filter.authors.includes(pubkey)) continue;
          if (filter["#h"] && !filter["#h"].includes(channel ?? "")) continue;
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify(["EVENT", subscriptionId, event]),
            }),
          );
        }
      }
    };
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  await page.goto("/app");
  await expect(
    page.getByTestId("desktop-navigation").getByText("Chat connected"),
  ).toBeVisible();
  await expect(page.getByText("Online and ready").first()).toBeVisible();
  await expect(page.getByText("Sudah aktif.")).toBeVisible();
  const agentMessage = page.getByRole("article", {
    name: "Message from BrickO",
  });
  await expect(agentMessage.getByText("Sudah aktif.")).toBeVisible();
  const teammateMessage = page.getByRole("article", {
    name: "Message from Sanny Gaddafi",
  });
  await expect(
    teammateMessage.getByText("Saya ikut memantau percakapan ini."),
  ).toBeVisible();
  await expect(teammateMessage.getByText("Sanny Gaddafi")).toBeVisible();
  await expect(teammateMessage.getByText("BrickO")).toHaveCount(0);

  const initialComposer = page.getByRole("textbox", { name: "Message BrickO" });
  await initialComposer.fill("@");
  const mentionPicker = page.getByRole("listbox", { name: "Mention someone" });
  await expect(mentionPicker).toBeVisible();
  await expect(
    mentionPicker.getByRole("option", { name: /BrickO.*Agent.*Online/ }),
  ).toBeVisible();
  await expect(
    mentionPicker.getByRole("option", {
      name: /Sanny Gaddafi.*member.*Online/,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-02-mention-picker.png"),
    fullPage: true,
  });
  await initialComposer.press("Enter");
  await expect(initialComposer).toHaveValue("@BrickO ");
  await initialComposer.fill("");

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByText("Start a group conversation")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-03-new-chat.png"),
    fullPage: true,
  });
  await page.getByTestId("conversation-title-input").fill("Engineering");
  await page.getByRole("button", { name: "Create chat" }).click();
  await expect(page).toHaveURL(/conversation=/);
  await expect(
    page.getByRole("heading", { name: "Start Engineering" }),
  ).toBeVisible();
  await expect(page.getByTestId(/conversation-/)).toContainText("Engineering");
  await page.screenshot({
    path: testInfo.outputPath("guide-04-group-chat.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "bricko-lab" }).click();

  await page.getByTestId("open-github-repositories").click();
  await expect(
    page.getByRole("heading", {
      name: "BrickO-Brick + brick-io + BrickI-Brick",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("3 repositories available", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByTestId("github-repository-BrickO-Brick-hive"),
  ).toBeVisible();
  await expect(
    page.getByTestId("github-repository-BrickI-Brick-dummy"),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-05-repositories.png"),
    fullPage: true,
  });
  const repositorySearch = page.getByRole("textbox", {
    name: "Search repositories",
  });
  await repositorySearch.fill("BrickI-Brick");
  await expect(
    page.getByTestId("github-repository-BrickI-Brick-dummy"),
  ).toBeVisible();
  await expect(
    page.getByTestId("github-repository-BrickO-Brick-hive"),
  ).toBeHidden();
  await repositorySearch.fill("");
  await page.getByRole("button", { name: "Mantul", exact: true }).click();
  await expect(
    page.getByTestId("github-repository-BrickO-Brick-hive"),
  ).toBeHidden();
  await expect(
    page.getByTestId("github-repository-BrickO-Brick-mantul-be"),
  ).toBeVisible();
  await page
    .getByTestId("github-repository-BrickO-Brick-mantul-be")
    .getByRole("button", { name: "Start discussion" })
    .click();
  await expect(page.getByText("New repository discussion")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-06-new-repo-discussion.png"),
    fullPage: true,
  });
  await page
    .getByTestId("discussion-title-input")
    .fill("Improve Mantul deployment safety");
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("heading", { name: "Improve Mantul deployment safety" }),
  ).toBeVisible();
  await expect(page.getByText("Isolated repository workspace")).toBeVisible();
  await expect(
    page.getByPlaceholder("Message BrickO about mantul-be…"),
  ).toHaveValue(/BrickO-Brick\/mantul-be/);
  await page.screenshot({
    path: testInfo.outputPath("guide-07-repo-discussion.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Open Simple IDE" }).click();
  await expect(page.getByTestId("simple-ide")).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Editing src/timeout.ts" });
  await expect(editor).toBeVisible();
  await editor.fill(
    workspaceContent.replace(
      "Operation timed out after",
      "Timed out safely after",
    ),
  );
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.getByText("Draft saved in the isolated workspace."),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-10-simple-ide-live.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByText("Review proposed changes")).toBeVisible();
  await expect(page.getByTestId("simple-ide-diff")).toContainText(
    "Timed out safely after",
  );
  await page.screenshot({
    path: testInfo.outputPath("guide-11-review-changes-live.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Create commit" }).click();
  await expect(
    page.getByText(/Commit cdcdcdcdcdcd created locally/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to discussion" }).click();

  await page.evaluate(() => {
    const emit = (
      window as Window & {
        __hiveEmit?: (event: Record<string, unknown>) => void;
      }
    ).__hiveEmit;
    const channelId = "62ae672f-ab7b-4619-b013-13eec0111943";
    const discussionId = "11111111-2222-4333-8444-555555555555";
    const agentPubkey = "22".repeat(32);
    const userPubkey =
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const now = Math.floor(Date.now() / 1000);
    const firstRoot = "d1".repeat(32);
    const secondRoot = "d2".repeat(32);
    const otherRoot = "e1".repeat(32);
    const events = [
      {
        id: firstRoot,
        pubkey: userPubkey,
        created_at: now - 4,
        kind: 9,
        tags: [
          ["h", channelId],
          ["discussion", discussionId],
        ],
        content: "First top-level question",
        sig: "00".repeat(64),
      },
      {
        id: secondRoot,
        pubkey: userPubkey,
        created_at: now - 3,
        kind: 9,
        tags: [
          ["h", channelId],
          ["discussion", discussionId],
        ],
        content: "Second top-level question",
        sig: "00".repeat(64),
      },
      {
        id: "d3".repeat(32),
        pubkey: agentPubkey,
        created_at: now - 2,
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", secondRoot, "", "reply"],
        ],
        content: "Reply to the second root remains visible",
        sig: "00".repeat(64),
      },
      {
        id: otherRoot,
        pubkey: userPubkey,
        created_at: now - 1,
        kind: 9,
        tags: [
          ["h", channelId],
          ["discussion", "another-discussion"],
        ],
        content: "Question from another discussion",
        sig: "00".repeat(64),
      },
      {
        id: "e2".repeat(32),
        pubkey: agentPubkey,
        created_at: now,
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", otherRoot, "", "reply"],
        ],
        content: "Reply from another discussion",
        sig: "00".repeat(64),
      },
    ];
    for (const event of events) emit?.(event);
  });

  await expect(page.getByText("First top-level question")).toBeVisible();
  await expect(page.getByText("Second top-level question")).toBeVisible();
  await expect(
    page.getByText("Reply to the second root remains visible"),
  ).toBeVisible();
  await expect(page.getByText("Question from another discussion")).toHaveCount(
    0,
  );
  await expect(page.getByText("Reply from another discussion")).toHaveCount(0);

  const composer = page.getByPlaceholder("Message BrickO about mantul-be…");
  await expect(
    page.getByRole("textbox", { name: "Message BrickO about mantul-be" }),
  ).toBeVisible();
  await composer.fill("Tolong cek status Hive sekarang");
  await composer.press("Enter");
  await expect(page.getByText("Tolong cek status Hive sekarang")).toBeVisible();
  await page
    .getByRole("article", { name: "Message from You" })
    .filter({ hasText: "Tolong cek status Hive sekarang" })
    .getByRole("button", { name: "Reply to your message" })
    .click();
  await expect(page.getByText(/Replying to You:/)).toBeVisible();
  await page.getByRole("button", { name: "Open threads" }).click();
  await expect(page.getByRole("heading", { name: "Threads" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-08-reply-thread.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close threads" }).click();
  await page.getByRole("button", { name: "Cancel reply" }).click();
  await expect(page.getByText("Preparing a response…").first()).toBeVisible();
  const statusPet = page.getByTestId("bricko-status-pet");
  await expect(page.getByTestId("bricko-companion")).toHaveCount(0);
  await expect(statusPet).toHaveAttribute("data-mode", "thinking");
  await expect(statusPet).toHaveAttribute("data-sprite", "thinking");
  expect(
    await statusPet.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).toContain("bricko-pet-thinking-drift");
  await expect
    .poll(() =>
      statusPet
        .locator(".bricko-pet__image")
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .toContain("bricko-pet-thinking-code");
  await expect(
    page.getByText("Interface: English · Chat: any language"),
  ).toBeVisible();

  const userMessage = page.getByText("Tolong cek status Hive sekarang");
  const userBubbleColors = await userMessage.evaluate((element) => {
    const bubble = element.closest(".rounded");
    if (!bubble) throw new Error("User message bubble was not found");
    const styles = getComputedStyle(bubble);
    return {
      backgroundColor: styles.backgroundColor,
      color: styles.color,
    };
  });
  expect(userBubbleColors).toEqual({
    backgroundColor: "rgb(255, 240, 235)",
    color: "rgb(68, 32, 26)",
  });

  await page.evaluate(
    ({ agentPubkey, channelId }) => {
      (
        window as Window & {
          __hiveEmit?: (event: Record<string, unknown>) => void;
        }
      ).__hiveEmit?.({
        id: "d4".repeat(32),
        pubkey: agentPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 20002,
        tags: [
          ["h", channelId],
          ["e", "d1".repeat(32), "", "root"],
          [
            "e",
            (
              window as Window & {
                __hiveLastPublished?: { id: string };
              }
            ).__hiveLastPublished?.id,
            "",
            "reply",
          ],
        ],
        content: "",
        sig: "00".repeat(64),
      });
    },
    {
      agentPubkey: "22".repeat(32),
      channelId: "62ae672f-ab7b-4619-b013-13eec0111943",
    },
  );
  await expect(page.getByText("Writing a response…").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("hive-activity.png"),
    fullPage: true,
  });

  await page.evaluate(
    ({ agentPubkey, channelId }) => {
      (
        window as Window & {
          __hiveEmit?: (event: Record<string, unknown>) => void;
        }
      ).__hiveEmit?.({
        id: "e5".repeat(32),
        pubkey: agentPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", "d1".repeat(32), "", "root"],
          [
            "e",
            (
              window as Window & {
                __hiveLastPublished?: { id: string };
              }
            ).__hiveLastPublished?.id,
            "",
            "reply",
          ],
        ],
        content: "Semua sistem Hive siap dan koneksi realtime stabil.",
        sig: "00".repeat(64),
      });
    },
    {
      agentPubkey: "22".repeat(32),
      channelId: "62ae672f-ab7b-4619-b013-13eec0111943",
    },
  );
  await expect(
    page.getByText("Semua sistem Hive siap dan koneksi realtime stabil."),
  ).toBeVisible();
  await expect(page.getByText("Online and ready").first()).toBeVisible();
  await expect(statusPet).toHaveAttribute("data-mode", "celebrate");
  await expect(statusPet).toHaveAttribute("data-sprite", "celebrate-code");
  expect(
    await statusPet.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).toContain("bricko-pet-celebrate-code");
  await page.waitForTimeout(1_150);

  await page.evaluate(
    ({ agentPubkey, channelId }) => {
      (
        window as Window & {
          __hiveEmit?: (event: Record<string, unknown>) => void;
        }
      ).__hiveEmit?.({
        id: "e6".repeat(32),
        pubkey: agentPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", "d1".repeat(32), "", "root"],
          [
            "e",
            (
              window as Window & {
                __hiveLastPublished?: { id: string };
              }
            ).__hiveLastPublished?.id,
            "",
            "reply",
          ],
        ],
        content:
          "⚠️ BrickO could not complete this request because of a temporary internal failure. Your original request remains visible above. Use ‘Restore failed request’ to review it before sending again.",
        sig: "00".repeat(64),
      });
    },
    {
      agentPubkey: "22".repeat(32),
      channelId: "62ae672f-ab7b-4619-b013-13eec0111943",
    },
  );
  const restore = page.getByRole("button", { name: "Restore failed request" });
  await expect(restore).toBeVisible();
  await restore.click();
  await expect(composer).toHaveValue("Tolong cek status Hive sekarang");
  await expect(page.getByText(/Replying to You:/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel reply" }).click();

  await page.screenshot({
    path: testInfo.outputPath("hive-polished.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("close-discussion-panel")).toBeVisible();
  const closeAction = page.getByRole("button", {
    name: "Close and clean workspace",
  });
  await expect(closeAction).toBeDisabled();
  await page
    .getByPlaceholder(
      "PR URL, staging deployment URL, or integrated commit SHA",
    )
    .fill("https://github.com/BrickO-Brick/mantul-be/pull/123");
  await expect(closeAction).toBeEnabled();
  await closeAction.click();
  await expect(
    page.getByText("Discussion closed · workspace cleaned"),
  ).toBeVisible();
  await expect(
    page.getByText(/Completion evidence:.*mantul-be\/pull\/123/),
  ).toBeVisible();
  await expect(page.getByText(/archived and read-only/)).toBeVisible();
  await expect(
    page.getByPlaceholder("Message BrickO about mantul-be…"),
  ).toHaveCount(0);

  const desktopNavigation = page.getByTestId("desktop-navigation");
  await expect(desktopNavigation).toHaveCSS("width", "352px");
  await expect(
    desktopNavigation.getByRole("img", { name: "Hive" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("01-desktop-navigation-expanded.png"),
    fullPage: true,
  });

  await page.getByTestId("sidebar-toggle").click();
  await expect(desktopNavigation).toHaveCSS("width", "68px");
  await expect(
    desktopNavigation.getByTestId(
      "discussion-11111111-2222-4333-8444-555555555555",
    ),
  ).toHaveCount(0);
  await expect(
    desktopNavigation.getByRole("img", { name: "Hive" }),
  ).toBeVisible();
  await expect(
    desktopNavigation.getByRole("button", { name: "Repositories" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("02-desktop-navigation-collapsed.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 820, height: 1024 });
  await page.evaluate(
    (storageKey) => localStorage.removeItem(storageKey),
    "hive.navigation.collapsed.v1",
  );
  await page.reload();
  await expect(desktopNavigation).toHaveCSS("width", "68px");
  await page.screenshot({
    path: testInfo.outputPath("03-tablet-navigation-collapsed.png"),
    fullPage: true,
  });

  await page.getByTestId("sidebar-toggle").click();
  await expect(desktopNavigation).toHaveCSS("width", "352px");
  await page.screenshot({
    path: testInfo.outputPath("04-tablet-navigation-expanded.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("mobile-navigation-open")).toBeVisible();
  await expect(page.getByTestId("mobile-navigation")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("05-mobile-navigation-closed.png"),
    fullPage: true,
  });

  await page.getByTestId("mobile-navigation-open").click();
  await expect(page.getByTestId("mobile-navigation")).toBeVisible();
  await expect(
    page.getByTestId("mobile-navigation").getByRole("img", { name: "Hive" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("06-mobile-navigation-open.png"),
    fullPage: true,
  });
  await page.getByTestId("mobile-navigation-close").click();
  await expect(page.getByTestId("mobile-navigation")).toHaveCount(0);

  await page.getByTestId("mobile-navigation-open").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mobile-navigation")).toHaveCount(0);

  await page.getByTestId("mobile-navigation-open").click();
  await page
    .getByTestId("mobile-navigation-backdrop")
    .click({ position: { x: 350, y: 80 } });
  await expect(page.getByTestId("mobile-navigation")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
