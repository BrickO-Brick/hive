import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { expectSmoothCorners } from "../helpers/css";

const AUDIO_URL = "http://127.0.0.1:4173/sounds/ping.mp3";

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      async value() {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.frequency.value = 220;
        oscillator.connect(destination);
        oscillator.start();
        destination.stream.getAudioTracks()[0]?.addEventListener(
          "ended",
          () => {
            oscillator.stop();
            void context.close();
          },
          { once: true },
        );
        return destination.stream;
      },
    });
  });

  await installMockBridge(page, {
    deferredComposerUploads: true,
    sendMessageErrors: testInfo.title.includes("shows a send error")
      ? ["relay rejected voice note"]
      : undefined,
    uploadDescriptors: [
      {
        duration: 9.4,
        filename: "voice-note-123.mp4",
        sha256: "a".repeat(64),
        size: 16424,
        type: "video/mp4",
        uploaded: Math.floor(Date.now() / 1000),
        url: AUDIO_URL,
      },
    ],
  });
});

test("restores the voice note and shows a send error after upload succeeds", async ({
  page,
}) => {
  await page.goto("/");
  const channel = page.getByTestId("channel-general");
  await expect(channel).toBeVisible({ timeout: 10_000 });
  await channel.click();

  await page.getByRole("button", { name: "Record voice note" }).click();
  await expect(page.getByTestId("voice-note-recorder")).toBeVisible();
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "Finish voice note" }).click();

  const composerCard = page.getByTestId("composer-voice-note-card");
  await expect(composerCard).toBeVisible();
  await page.getByTestId("send-message").click();

  await expect(composerCard).toBeVisible();
  await expect(
    page.getByText("Message failed to send: relay rejected voice note"),
  ).toBeVisible();
});

test("records from the composer and renders an inline waveform card", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 2200, height: 720 });
  await page.goto("/");
  const showError = page.getByRole("button", { name: "Show Error" });
  const channel = page.getByTestId("channel-general");
  await expect(channel.or(showError)).toBeVisible({ timeout: 10_000 });
  if (await showError.isVisible()) {
    await showError.click();
    throw new Error(await page.locator("body").innerText());
  }
  await channel.click();

  const attach = page.getByRole("button", { name: "Attach file" });
  const record = page.getByRole("button", { name: "Record voice note" });
  const emoji = page.getByRole("button", { name: "Emoji" });
  await expect(record).toBeVisible();

  const [attachBox, recordBox, emojiBox] = await Promise.all([
    attach.boundingBox(),
    record.boundingBox(),
    emoji.boundingBox(),
  ]);
  expect(attachBox).not.toBeNull();
  expect(recordBox).not.toBeNull();
  expect(emojiBox).not.toBeNull();
  expect(recordBox?.x).toBeGreaterThan(attachBox?.x ?? 0);
  expect(recordBox?.x).toBeLessThan(emojiBox?.x ?? Number.POSITIVE_INFINITY);

  await record.click();
  const recorder = page.getByTestId("voice-note-recorder");
  await expect(recorder).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Recording voice note" }),
  ).toHaveCount(0);
  await expect(attach).toBeHidden();
  const discard = page.getByRole("button", { name: "Discard voice note" });
  await expect(discard).toBeVisible();
  const [recorderBox, discardBox] = await Promise.all([
    recorder.boundingBox(),
    discard.boundingBox(),
  ]);
  expect(recorderBox).not.toBeNull();
  expect(discardBox).not.toBeNull();
  expect(discardBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    (recorderBox?.x ?? 0) + 1,
  );
  await expect(recorder).toContainText(/\d+:\d{2} \/ 5:00/);
  const finish = page.getByRole("button", { name: "Finish voice note" });
  await expect(finish).toBeEnabled();
  const liveWaveform = page.getByTestId("voice-note-live-waveform");
  const firstRecordedSample = liveWaveform.locator(
    '[data-waveform-sample="recorded-0"]',
  );
  await expect(firstRecordedSample).toBeAttached();
  const firstSampleStart = await firstRecordedSample.boundingBox();
  await page.waitForTimeout(200);
  const firstSampleAfter = await firstRecordedSample.boundingBox();
  expect(firstSampleStart).not.toBeNull();
  expect(firstSampleAfter).not.toBeNull();
  expect(firstSampleAfter?.x ?? 0).toBeLessThan((firstSampleStart?.x ?? 0) - 2);
  expect(firstSampleAfter?.height).toBe(firstSampleStart?.height);
  const [waveformBox, lastBarBox] = await Promise.all([
    liveWaveform.boundingBox(),
    liveWaveform.locator("span").last().boundingBox(),
  ]);
  expect(waveformBox).not.toBeNull();
  expect(lastBarBox).not.toBeNull();
  expect((lastBarBox?.x ?? 0) + (lastBarBox?.width ?? 0)).toBeGreaterThan(
    (waveformBox?.x ?? 0) + (waveformBox?.width ?? 0) - 6,
  );
  await waitForAnimations(page);
  await page.getByTestId("message-composer-toolbar").screenshot({
    path: "test-results/voice-note/voice-note-recorder.png",
  });

  await finish.click();
  const composerCard = page.getByTestId("composer-voice-note-card");
  await expect(composerCard).toBeVisible();
  await waitForAnimations(page);
  const composerCardBox = await composerCard.boundingBox();
  expect(composerCardBox).not.toBeNull();
  expect(
    composerCardBox?.width ?? Number.POSITIVE_INFINITY,
  ).toBeLessThanOrEqual(336);
  await expect(
    composerCard.getByRole("button", { name: "Play voice note" }),
  ).toBeVisible();
  await expect(
    composerCard.getByRole("slider", { name: "Voice note playback position" }),
  ).toBeVisible();
  await expect(composerCard).toContainText(/\d+:\d{2}/);
  await expect(composerCard).not.toContainText(/· Voice note/);
  const composerVoiceNote = composerCard.locator("..");
  const removeVoiceNote = composerVoiceNote.getByTestId(
    "remove-composer-voice-note",
  );
  await expect(removeVoiceNote).toHaveCSS("opacity", "0");
  await composerVoiceNote.hover();
  await expect(removeVoiceNote).toHaveCSS("opacity", "1");
  const removeVoiceNoteBox = await removeVoiceNote.boundingBox();
  expect(removeVoiceNoteBox).not.toBeNull();
  expect(removeVoiceNoteBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(
    (composerCardBox?.x ?? 0) + (composerCardBox?.width ?? 0),
  );
  expect(removeVoiceNoteBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    composerCardBox?.y ?? 0,
  );
  expect(
    (removeVoiceNoteBox?.x ?? 0) + (removeVoiceNoteBox?.width ?? 0),
  ).toBeGreaterThan((composerCardBox?.x ?? 0) + (composerCardBox?.width ?? 0));
  expect(
    (removeVoiceNoteBox?.y ?? 0) + (removeVoiceNoteBox?.height ?? 0),
  ).toBeGreaterThan(composerCardBox?.y ?? 0);
  const composerPlaybackWaveform = composerCard.getByTestId(
    "voice-note-playback-waveform",
  );
  const [playbackBox, playbackLastBarBox] = await Promise.all([
    composerPlaybackWaveform.boundingBox(),
    composerPlaybackWaveform.locator("span").last().boundingBox(),
  ]);
  expect(playbackBox).not.toBeNull();
  expect(playbackLastBarBox).not.toBeNull();
  expect(
    (playbackLastBarBox?.x ?? 0) + (playbackLastBarBox?.width ?? 0),
  ).toBeGreaterThan((playbackBox?.x ?? 0) + (playbackBox?.width ?? 0) - 6);
  await waitForAnimations(page);
  await page.screenshot({
    clip: {
      height: (composerCardBox?.height ?? 0) + 16,
      width: (composerCardBox?.width ?? 0) + 16,
      x: (composerCardBox?.x ?? 0) - 8,
      y: (composerCardBox?.y ?? 0) - 8,
    },
    path: "test-results/voice-note/voice-note-composer-card.png",
  });
  await expect(page.getByTestId("send-message")).toBeEnabled();
  await page.getByTestId("send-message").click();

  const card = page.getByTestId("audio-message-attachment").last();
  await expect(card).toBeVisible();
  const playbackWaveform = card.getByTestId("voice-note-playback-waveform");
  await expect(playbackWaveform).toHaveAttribute(
    "data-waveform-state",
    "ready",
  );
  await expect
    .poll(() =>
      playbackWaveform
        .locator("span")
        .evaluateAll((bars) =>
          bars.some((bar) => bar.getBoundingClientRect().height > 3),
        ),
    )
    .toBe(true);
  const waveformGeometry = await playbackWaveform.evaluate((waveform) => {
    const waveformBox = waveform.getBoundingClientRect();
    return Array.from(waveform.querySelectorAll("span")).map((bar) => {
      const barBox = bar.getBoundingClientRect();
      return {
        bottom: barBox.bottom,
        radius: Number.parseFloat(getComputedStyle(bar).borderTopLeftRadius),
        top: barBox.top,
        waveformBottom: waveformBox.bottom,
        waveformTop: waveformBox.top,
        width: barBox.width,
      };
    });
  });
  expect(waveformGeometry.length).toBeGreaterThan(0);
  for (const bar of waveformGeometry) {
    expect(bar.radius).toBeGreaterThanOrEqual(bar.width / 2);
    expect(bar.top).toBeGreaterThanOrEqual(bar.waveformTop);
    expect(bar.bottom).toBeLessThanOrEqual(bar.waveformBottom);
  }
  const playbackControl = card.getByTestId("voice-note-playback-control");
  await expect(card).toHaveClass(/\brounded-2xl\b/);
  await expect(playbackControl).toHaveClass(/\brounded-lg\b/);
  await expectSmoothCorners(card);
  await expectSmoothCorners(playbackControl);
  await expect(
    card.getByRole("button", { name: "Play voice note" }),
  ).toBeVisible();
  const playPauseIcon = card.getByTestId("voice-note-play-pause-icon");
  const primaryIconPath = card.getByTestId("voice-note-play-pause-path-0");
  await expect(playPauseIcon).toHaveAttribute("data-icon-state", "play");
  await expect(playPauseIcon).toHaveCSS("width", "23px");
  await expect(playPauseIcon).toHaveCSS("height", "23px");
  await expect(primaryIconPath).toHaveCSS("fill", /rgb/);
  await expect(primaryIconPath).toHaveCSS("stroke-linejoin", "round");
  const playPath = await primaryIconPath.getAttribute("d");
  await primaryIconPath.evaluate((element) => {
    element.setAttribute("data-morph-identity", "preserved");
  });
  await card.getByRole("button", { name: "Play voice note" }).click();
  await expect(
    card.getByRole("button", { name: "Pause voice note" }),
  ).toBeVisible();
  await expect(playPauseIcon).toHaveAttribute("data-icon-state", "pause");
  await expect(primaryIconPath).toHaveAttribute(
    "data-morph-identity",
    "preserved",
  );
  await expect.poll(() => primaryIconPath.getAttribute("d")).not.toBe(playPath);
  await waitForAnimations(page);
  await card.screenshot({
    path: "test-results/voice-note/voice-note-card-paused.png",
  });
  await card.getByRole("button", { name: "Pause voice note" }).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await expect(
    card.getByRole("slider", { name: "Voice note playback position" }),
  ).toBeVisible();
  await expect(card).toContainText(/\d+:\d{2}/);
  await expect(card).not.toContainText(/· Voice note/);
  const playbackRate = card.getByTestId("voice-note-playback-rate");
  const playbackRateValue = card.getByTestId("voice-note-playback-rate-value");
  await expect(playbackRate).toHaveCSS("opacity", "0");
  await waitForAnimations(page);
  await card.hover();
  await expect(playbackRate).toHaveCSS("opacity", "1");
  await expectSmoothCorners(playbackRate);
  await expect(playbackRate).toHaveCSS("padding-left", "10px");
  await expect(playbackRate).toHaveCSS("padding-top", "2px");
  const [rateBackground, playButtonBackground] = await Promise.all([
    playbackRate.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
    card
      .getByRole("button", { name: "Play voice note" })
      .locator("..")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(rateBackground).toBe(playButtonBackground);
  const widestPlaybackRateWidth = (await playbackRate.boundingBox())?.width;
  expect(widestPlaybackRateWidth).toBeGreaterThan(0);
  await expect(playbackRateValue).toHaveText("1×");
  await playbackRate.click();
  await expect(playbackRateValue).toHaveText("1.5×");
  expect((await playbackRate.boundingBox())?.width).toBe(
    widestPlaybackRateWidth,
  );
  await expect(card.locator("audio")).toHaveJSProperty("playbackRate", 1.5);
  await playbackRate.click();
  await expect(playbackRateValue).toHaveText("2×");
  expect((await playbackRate.boundingBox())?.width).toBe(
    widestPlaybackRateWidth,
  );
  await playbackRate.click();
  await expect(playbackRateValue).toHaveText(".5×");
  expect((await playbackRate.boundingBox())?.width).toBe(
    widestPlaybackRateWidth,
  );
  await playbackRate.click();
  await expect(playbackRateValue).toHaveText("1×");

  const slider = card.getByRole("slider", {
    name: "Voice note playback position",
  });
  await slider.evaluate((element: HTMLInputElement) => {
    element.value = String(Number(element.max) / 2);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const progressClip = await card
    .getByTestId("voice-note-progress-waveform")
    .evaluate((element) => getComputedStyle(element).clipPath);
  expect(progressClip).toContain("50%");
  await waitForAnimations(page);
  await card.screenshot({
    path: "test-results/voice-note/voice-note-card.png",
  });
});

test("keeps emoji available but blocks GIFs beside a queued voice note", async ({
  page,
}) => {
  await page.route("http://localhost:3000/info", (route) =>
    route.fulfill({
      body: JSON.stringify({
        gif: {
          provider: "klipy",
          search: "/gifs/search",
          share: "/gifs/share",
        },
        supported_extensions: ["buzz-gif"],
      }),
      contentType: "application/nostr+json",
    }),
  );

  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.getByRole("button", { name: "Record voice note" }).click();
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "Finish voice note" }).click();
  await expect(page.getByTestId("composer-voice-note-card")).toBeVisible();

  const pickerButton = page.getByTestId("composer-emoji-button");
  await expect(pickerButton).toBeEnabled();
  await expect(pickerButton).toHaveAccessibleName("Insert emoji or GIF");
  await pickerButton.click();
  await expect(page.getByRole("tab", { name: "Emoji" })).toBeEnabled();
  await expect(page.getByRole("tab", { name: "GIFs" })).toBeDisabled();
});

test("starting a duplicate voice-note player pauses the other instance", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (
            window as Window & {
              __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: unknown;
            }
          ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
      ),
    )
    .toBe(true);

  await page.evaluate(
    ({ audioUrl }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            extraTags: string[][];
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      if (!emit) throw new Error("Mock message emitter is unavailable.");
      const input = {
        channelName: "general",
        content: `[voice-note-123.mp4](${audioUrl})`,
        extraTags: [
          [
            "imeta",
            `url ${audioUrl}`,
            "m video/mp4",
            "duration 9.4",
            "filename voice-note-123.mp4",
          ],
        ],
      };
      emit(input);
      emit(input);
    },
    { audioUrl: AUDIO_URL },
  );

  const cards = page.getByTestId("audio-message-attachment");
  await expect(cards).toHaveCount(2);
  const firstAudio = cards.nth(0).locator("audio");
  const secondAudio = cards.nth(1).locator("audio");

  await cards.nth(0).getByRole("button", { name: "Play voice note" }).click();
  await expect(firstAudio).toHaveJSProperty("paused", false);
  await cards.nth(1).getByRole("button", { name: "Play voice note" }).click();
  await expect(firstAudio).toHaveJSProperty("paused", true);
  await expect(secondAudio).toHaveJSProperty("paused", false);
});
