import { expect, test } from "@playwright/test";

test("download page presents the latest Hive desktop installers", async ({
  page,
}, testInfo) => {
  await page.route(
    "https://api.github.com/repos/BrickO-Brick/hive/releases?per_page=10",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          {
            draft: false,
            prerelease: false,
            tag_name: "desktop-v0.5.21",
            name: "Hive Desktop v0.5.21",
            body: "A more collaborative Hive.",
            html_url:
              "https://github.com/BrickO-Brick/hive/releases/tag/desktop-v0.5.21",
            published_at: "2026-09-03T00:00:00Z",
            assets: [
              {
                name: "Hive_0.5.21_aarch64.dmg",
                browser_download_url:
                  "https://downloads.example/Hive_0.5.21_aarch64.dmg",
              },
              {
                name: "Hive_0.5.21_x64.dmg",
                browser_download_url:
                  "https://downloads.example/Hive_0.5.21_x64.dmg",
              },
              {
                name: "Hive_0.5.21_x64-setup_alpha-unsigned.exe",
                browser_download_url:
                  "https://downloads.example/Hive_0.5.21_x64-setup_alpha-unsigned.exe",
              },
            ],
          },
        ]),
      });
    },
  );

  await page.goto("/download");

  await expect(page).toHaveTitle(/Hive/i);
  await expect(
    page.getByRole("heading", {
      name: "Bring the whole Hive to your desktop.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Latest: Hive 0.5.21")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Mac · Apple Silicon/ }),
  ).toHaveAttribute(
    "href",
    "https://downloads.example/Hive_0.5.21_aarch64.dmg",
  );
  await expect(
    page.getByRole("link", { name: /Windows · x64/ }),
  ).toHaveAttribute(
    "href",
    "https://downloads.example/Hive_0.5.21_x64-setup_alpha-unsigned.exe",
  );

  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("hive-download-desktop.png"),
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(
    page.getByRole("link", { name: /Mac · Apple Silicon/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Windows · x64/ })).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("hive-download-mobile.png"),
  });
});
