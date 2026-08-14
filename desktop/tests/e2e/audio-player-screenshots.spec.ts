import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";

const CHANNEL = "general";
const AUDIO_SHA = "a".repeat(64);

test("audio attachments stay compact and avoid time-progression work", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() {
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value() {
        this.dispatchEvent(new Event("pause"));
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get() {
        return 75;
      },
    });
  });
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId(`channel-${CHANNEL}`).click();
  await expect(page.getByTestId("message-timeline")).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
              channelName: "general",
            }) ?? false,
        ),
      { timeout: 5_000 },
    )
    .toBe(true);

  const attachments = Array.from({ length: 6 }, (_, index) => {
    const url = `http://localhost:3000/media/${AUDIO_SHA}${index}.mp3`;
    return {
      line: `![Audio fixture ${index + 1}](${url})`,
      tag: [
        "imeta",
        `url ${url}`,
        "m audio/mpeg",
        `filename fixture-${index + 1}.mp3`,
      ],
    };
  });
  await page.evaluate((attachments) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: `Six compact audio attachments\n\n${attachments.map(({ line }) => line).join("\n\n")}`,
      extraTags: attachments.map(({ tag }) => tag),
    });
  }, attachments);

  const players = page.locator("[data-audio-player]");
  await expect(players).toHaveCount(6);
  await expect(players.first()).toBeVisible();
  await expect(page.locator("[data-image-mosaic]")).toHaveCount(0);

  await page.evaluate(() => {
    const hook = { activeMutations: 0, idleMutations: 0 };
    (
      window as typeof window & {
        __AUDIO_PERF__?: typeof hook;
      }
    ).__AUDIO_PERF__ = hook;
    document.querySelectorAll("[data-audio-player]").forEach((node, index) => {
      new MutationObserver((records) => {
        if (index === 0) hook.activeMutations += records.length;
        else hook.idleMutations += records.length;
      }).observe(node, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
  });

  const firstPlayer = players.first();
  await firstPlayer.getByRole("button", { name: "Play audio" }).click();
  const pauseButton = firstPlayer.getByRole("button", { name: "Pause audio" });
  await expect(pauseButton).toBeVisible();
  await page.evaluate(() => {
    const hook = (
      window as typeof window & {
        __AUDIO_PERF__?: { activeMutations: number; idleMutations: number };
      }
    ).__AUDIO_PERF__;
    if (hook) hook.activeMutations = 0;
  });
  const audio = firstPlayer.locator("audio");
  for (const currentTime of [15, 30, 45]) {
    await audio.evaluate((element, value) => {
      element.currentTime = value;
      element.dispatchEvent(new Event("timeupdate"));
    }, currentTime);
  }
  await expect(firstPlayer.getByText("0:45 / 1:15")).toBeVisible();
  const evidence = await page.evaluate(
    () =>
      (window as typeof window & { __AUDIO_PERF__?: unknown }).__AUDIO_PERF__,
  );
  expect(evidence).toEqual({ activeMutations: 9, idleMutations: 0 });

  await page.screenshot({
    path: testInfo.outputPath("audio-player-final.png"),
    fullPage: true,
  });
});
