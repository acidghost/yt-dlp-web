import { expect, test } from "playwright/test";

const url = "https://www.youtube.com/watch?v=abcdefghijk";
const video = {
  kind: "download",
  id: "abcdefghijk",
  url,
  token: "session-token",
  title: "Fixture video",
  channel: "Fixture channel",
  duration: 10,
  positionSeconds: 0,
  stream: "/api/stream/abcdefghijk",
};

const entry = (title: string) => ({
  id: "abcdefghijk",
  url,
  title,
  channel: "Fixture channel",
  duration: 10,
  lastWatchedAt: "2026-09-27T10:00:00.000Z",
  positionSeconds: 0,
  mp4: { sizeBytes: 10 },
});

test("a late history response cannot replace a newer refresh", async ({
  page,
}) => {
  let releaseFirst: (() => void) | undefined;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let historyCalls = 0;
  await page.route("**/api/history", async (route) => {
    historyCalls++;
    if (historyCalls === 1) {
      await firstHeld;
      await route.fulfill({ json: [entry("Older row")] });
    } else {
      await route.fulfill({ json: [entry("Newer row")] });
    }
  });
  await page.route("**/api/resolve", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ mode: "mp4" });
    await route.fulfill({ json: video });
  });

  await page.goto("/");
  await expect.poll(() => historyCalls).toBe(1);
  await page.getByLabel("YouTube video URL").fill(url);
  await page.getByLabel("Playback mode").selectOption("mp4");
  await page.getByRole("button", { name: "Prepare video" }).click();

  await expect(page.locator(".history-item")).toContainText("Newer row");
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  const player = await page.locator("video").elementHandle();
  const oldResponse = page.waitForResponse(async (response) => {
    if (!response.url().endsWith("/api/history")) return false;
    const rows = await response.json();
    return rows[0]?.title === "Older row";
  });
  releaseFirst?.();
  await oldResponse;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator(".history-item")).toContainText("Newer row");
  expect(
    await page.evaluate(
      (original) => document.querySelector("video") === original,
      player,
    ),
  ).toBe(true);
});

test("a malformed successful response shows an error without attaching a source", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => {
    const { stream: _stream, ...missingStream } = video;
    return route.fulfill({ json: missingStream });
  });

  await page.goto("/");
  await page.getByLabel("YouTube video URL").fill(url);
  await page.getByLabel("Playback mode").selectOption("mp4");
  await page.getByRole("button", { name: "Prepare video" }).click();

  await expect(page.locator("#status")).toHaveText(
    "Server returned an invalid video response.",
  );
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "error");
  await expect(page.locator("video")).not.toHaveAttribute("src");
  await expect(page.locator("#title")).toHaveCount(0);
});

test("download mode attaches the saved MP4", async ({ page }) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => route.fulfill({ json: video }));

  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4`);
  await expect(page.getByLabel("YouTube video URL")).toHaveValue(url);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute("src", video.stream);
});

test("a saved position is shown and applied after metadata loads", async ({
  page,
}) => {
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: [{ ...entry("Long video"), positionSeconds: 83 }] }),
  );
  await page.route("**/api/resolve", (route) =>
    route.fulfill({ json: { ...video, duration: 240, positionSeconds: 83 } }),
  );

  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4`);
  await expect(page.locator("#status")).toContainText("continue at 1:23");
  await expect(page.locator(".history-item")).toContainText("Continue at 1:23");
  const seekedTo = await page.locator("video").evaluate((player) => {
    let position = 0;
    Object.defineProperty(player, "currentTime", {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    });
    player.dispatchEvent(new Event("loadedmetadata"));
    return position;
  });
  expect(seekedTo).toBe(83);
});

test("the compact speed selector sits beside shortcut help and stays in sync", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => route.fulfill({ json: video }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const player = page.locator("video");
  const speed = page.getByRole("combobox", { name: "Playback speed" });
  await expect(speed).toBeDisabled();
  await page.getByLabel("YouTube video URL").fill(url);
  await page.getByLabel("Playback mode").selectOption("mp4");
  await page.getByRole("button", { name: "Prepare video" }).click();
  await expect(speed).toBeEnabled();
  await expect(speed).toHaveValue("1");
  const videoBounds = await player.boundingBox();
  const helpBounds = await page.locator(".player-shortcuts").boundingBox();
  const controlBounds = await speed.boundingBox();
  expect(videoBounds).not.toBeNull();
  expect(helpBounds).not.toBeNull();
  expect(controlBounds).not.toBeNull();
  expect(controlBounds?.width).toBeLessThan(110);
  expect(controlBounds?.y).toBeGreaterThanOrEqual(
    (videoBounds?.y ?? 0) + (videoBounds?.height ?? 0),
  );
  expect(controlBounds?.x).toBeGreaterThan(
    (helpBounds?.x ?? 0) + (helpBounds?.width ?? 0),
  );
  expect(
    Math.abs(
      (controlBounds?.y ?? 0) +
        (controlBounds?.height ?? 0) / 2 -
        (helpBounds?.y ?? 0) -
        (helpBounds?.height ?? 0) / 2,
    ),
  ).toBeLessThan(3);

  await speed.selectOption("1.5");
  expect(
    await player.evaluate(
      (element) => (element as HTMLVideoElement).playbackRate,
    ),
  ).toBe(1.5);
  await speed.focus();
  await page.keyboard.press("Shift+Period");
  expect(
    await player.evaluate(
      (element) => (element as HTMLVideoElement).playbackRate,
    ),
  ).toBe(1.5);
  await player.focus();
  await page.keyboard.press("Shift+Period");
  await expect(speed).toHaveValue("1.75");
  await player.evaluate((element) => {
    (element as HTMLVideoElement).playbackRate = 0.75;
  });
  await expect(speed).toHaveValue("0.75");
  await player.evaluate((element) => {
    (element as HTMLVideoElement).playbackRate = 1.1;
  });
  await expect(speed).toHaveValue("1.1");

  await page.getByRole("button", { name: "Fill page" }).click();
  await expect(speed).toHaveValue("1.1");
  expect(
    await player.evaluate(
      (element) => (element as HTMLVideoElement).playbackRate,
    ),
  ).toBe(1.1);
});

test("keyboard shortcuts control a prepared player without hijacking form controls", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => route.fulfill({ json: video }));
  await page.goto("/");

  const player = page.locator("video");
  await page.keyboard.press("Space");
  expect(
    await player.evaluate((element) => (element as HTMLVideoElement).paused),
  ).toBe(true);

  await page.getByLabel("YouTube video URL").fill(url);
  await page.getByLabel("Playback mode").selectOption("mp4");
  await page.getByRole("button", { name: "Prepare video" }).click();
  await expect(player).toHaveAttribute("src", video.stream);

  await player.evaluate((element) => {
    const videoElement = element as HTMLVideoElement;
    let paused = true;
    let position = 2;
    Object.defineProperties(videoElement, {
      paused: { configurable: true, get: () => paused },
      currentTime: {
        configurable: true,
        get: () => position,
        set: (value: number) => {
          position = value;
        },
      },
      duration: { configurable: true, get: () => 30 },
    });
    videoElement.play = async () => {
      paused = false;
    };
    videoElement.pause = () => {
      paused = true;
    };
  });

  const state = () =>
    player.evaluate((element) => {
      const videoElement = element as HTMLVideoElement;
      return {
        paused: videoElement.paused,
        time: videoElement.currentTime,
        rate: videoElement.playbackRate,
        volume: videoElement.volume,
        muted: videoElement.muted,
      };
    });
  await player.focus();
  await page.keyboard.press("Space");
  expect((await state()).paused).toBe(false);
  await page.keyboard.press("KeyK");
  expect((await state()).paused).toBe(true);
  await page.keyboard.press("ArrowRight");
  expect((await state()).time).toBe(7);
  await page.keyboard.press("KeyL");
  expect((await state()).time).toBe(17);
  await page.keyboard.press("KeyJ");
  expect((await state()).time).toBe(7);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect((await state()).time).toBe(0);
  await page.keyboard.press("Shift+Period");
  expect((await state()).rate).toBe(1.25);
  await page.keyboard.press("Shift+Comma");
  expect((await state()).rate).toBe(1);
  await page.keyboard.press("KeyM");
  expect((await state()).muted).toBe(true);

  await page.getByLabel("YouTube video URL").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  expect((await state()).paused).toBe(true);
  expect((await state()).time).toBe(0);
  await page.getByRole("button", { name: "Fill page" }).focus();
  await page.keyboard.press("Space");
  expect((await state()).paused).toBe(true);

  await page.locator("#title").click();
  await page.keyboard.press("Control+ArrowRight");
  expect((await state()).time).toBe(0);
  await page.keyboard.press("ArrowRight");
  expect((await state()).time).toBe(5);
  await page.evaluate(() => {
    document.body.style.minHeight = "200vh";
    document.body.tabIndex = -1;
    document.body.focus();
    window.scrollTo(0, 0);
  });
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  expect((await state()).volume).toBe(1);
});

test("theater width and history chunks keep the player in place", async ({
  page,
}) => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    ...entry(`Video ${index + 1}`),
    id: `video${String(index).padStart(6, "0")}`,
  }));
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: entries }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.locator(".history-item")).toHaveCount(12);
  await expect(page.getByText("Showing 12 of 25 videos")).toBeVisible();
  const player = await page.locator("video").elementHandle();
  const panel = page.locator(".player-panel");
  const standardWidth = (await panel.boundingBox())?.width ?? 0;
  const headerWidth =
    (await page.locator(".site-header").boundingBox())?.width ?? 0;
  const historyWidth =
    (await page.locator(".history-panel").boundingBox())?.width ?? 0;
  expect(Math.abs(standardWidth - headerWidth)).toBeLessThan(2);
  expect(Math.abs(standardWidth - historyWidth)).toBeLessThan(2);
  const videoWidth = (await page.locator("video").boundingBox())?.width ?? 0;
  await expect(panel).not.toHaveClass(/\bbox\b/);
  expect(Math.abs(videoWidth - standardWidth)).toBeLessThan(2);
  const controlTops = await Promise.all(
    [
      page.getByLabel("YouTube video URL"),
      page.getByLabel("Playback mode"),
      page.getByRole("button", { name: "Prepare video" }),
      page.getByRole("button", { name: "Fill page" }),
    ].map(async (control) => (await control.boundingBox())?.y ?? -1),
  );
  expect(Math.max(...controlTops) - Math.min(...controlTops)).toBeLessThan(5);
  const fillPage = page.getByRole("button", { name: "Fill page" });
  await fillPage.click();
  await expect(fillPage).toHaveAttribute("aria-pressed", "true");
  expect((await panel.boundingBox())?.width).toBeGreaterThan(standardWidth);
  expect(
    await page.evaluate(
      (original) => document.querySelector("video") === original,
      player,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Show 12 more" }).click();
  await expect(page.locator(".history-item")).toHaveCount(24);
  await page.getByRole("button", { name: "Show 1 more" }).click();
  await expect(page.locator(".history-item")).toHaveCount(25);
  await expect(page.getByRole("button", { name: /Show .* more/ })).toHaveCount(
    0,
  );
  const backToPlayer = page.getByRole("link", { name: "Back to player" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(backToPlayer).toHaveCount(0);
  await page.evaluate(() => {
    const videoElement = document.querySelector("video");
    if (!videoElement) throw new Error("Missing player");
    window.scrollTo(
      0,
      window.scrollY + videoElement.getBoundingClientRect().bottom + 1,
    );
  });
  await expect(backToPlayer).toBeVisible();
  expect(
    await backToPlayer.evaluate(
      (element) => getComputedStyle(element).position,
    ),
  ).toBe("fixed");
  await backToPlayer.click();
  await expect(page.locator("#player")).toBeFocused();
  await expect(backToPlayer).toHaveCount(0);

  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});
