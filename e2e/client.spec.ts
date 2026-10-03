import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "playwright/test";

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

async function serveFixtureMedia(page: Page): Promise<void> {
  const mediaDir = join(import.meta.dirname, "../tmp/e2e-data/media", video.id);
  await mkdir(mediaDir, { recursive: true });
  await copyFile(
    join(import.meta.dirname, "fixtures/player.mp4"),
    join(mediaDir, "video.mp4"),
  );
  await page.route("**/fixture-media/*", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (!name || !/^player(?:-\d+\.mpegts|\.m3u8)$/.test(name))
      return route.abort();
    return route.fulfill({
      path: `${import.meta.dirname}/fixtures/${name}`,
      contentType: name.endsWith("m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp2t",
    });
  });
}

async function loadFixtureMetadata(page: Page): Promise<void> {
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await page.locator("video").evaluate((player: HTMLVideoElement) => {
    // Native sources defer loading until playback; request metadata without playing.
    if (
      player.readyState === 0 &&
      player.getAttribute("src")?.startsWith("/api/stream/")
    ) {
      player.preload = "metadata";
      player.load();
    }
  });
}

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
  await serveFixtureMedia(page);
  await page.route("**/api/history", (route) =>
    route.fulfill({
      json: [{ ...entry("Fixture video"), positionSeconds: 8 }],
    }),
  );
  await page.route("**/api/resolve", (route) =>
    route.fulfill({ json: { ...video, positionSeconds: 8 } }),
  );

  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4`);
  await loadFixtureMetadata(page);
  await expect(page.locator("#status")).toContainText("continue at 0:08");
  await expect(page.locator(".history-item")).toContainText("Continue at 0:08");
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((player: HTMLVideoElement) => player.currentTime),
    )
    .toBeCloseTo(8, 1);
});

test("the integrated speed menu tracks video state and owns its keyboard actions", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => route.fulfill({ json: video }));
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4`);

  const player = page.locator("video");
  const controller = page.locator("media-controller");
  const originalController = await controller.elementHandle();
  const originalVideo = await player.elementHandle();
  const speed = page.locator("media-playback-rate-menu-button");
  const menu = page.locator("media-playback-rate-menu");
  // Exercise the deployed bundle, not Bun's development error overlay.
  await expect(page.locator("bun-hmr")).toHaveCount(0);
  await expect(speed).toHaveAttribute("mediaplaybackrate", "1");
  await expect(player).not.toHaveAttribute("controls");
  await expect(page.locator(".speed-control")).toHaveCount(0);
  await speed.click();
  await expect(menu).not.toHaveAttribute("hidden");
  await expect(
    menu.getByRole("menuitemradio", { name: "0.25x", exact: true }),
  ).toBeFocused();
  await menu.getByRole("menuitemradio", { name: "1.5x", exact: true }).click();
  await expect(menu).toHaveAttribute("hidden");
  await expect(speed).toHaveAttribute("mediaplaybackrate", "1.5");
  expect(
    await player.evaluate((el) => (el as HTMLVideoElement).playbackRate),
  ).toBe(1.5);

  await speed.focus();
  await page.keyboard.press("Shift+Period");
  expect(
    await player.evaluate((el) => (el as HTMLVideoElement).playbackRate),
  ).toBe(1.5);
  await player.focus();
  await page.keyboard.press("Shift+Period");
  await expect(speed).toHaveAttribute("mediaplaybackrate", "1.75");
  await player.evaluate((el) => {
    (el as HTMLVideoElement).playbackRate = 1.1;
  });
  await expect(speed).toHaveAttribute("mediaplaybackrate", "1.1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await speed.focus();
  await page.keyboard.press("Enter");
  await expect(
    menu.getByRole("menuitemradio", { name: "0.25x", exact: true }),
  ).toBeFocused();
  const currentRate = menu.getByRole("menuitemradio", {
    name: "1.1x",
    exact: true,
  });
  await expect(currentRate).toHaveAttribute("aria-checked", "true");
  await currentRate.focus();
  await page.keyboard.press("ArrowDown");
  const nextRate = menu.getByRole("menuitemradio", {
    name: "1.25x",
    exact: true,
  });
  await expect(nextRate).toBeFocused();
  // No sleeps: fast close/reopen can coalesce styles and skip transitionend.
  for (const key of ["Space", "Enter", "Space"]) {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("hidden");
    await expect(speed).toBeFocused();
    await page.keyboard.press(key);
    await expect(menu).not.toHaveAttribute("hidden");
    await expect(
      menu.getByRole("menuitemradio", { name: "0.25x", exact: true }),
    ).toBeFocused();
  }
  await nextRate.focus();
  await page.keyboard.press("Space");
  await expect(speed).toHaveAttribute("mediaplaybackrate", "1.25");
  await expect(menu).toHaveAttribute("hidden");
  expect(await player.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(
    true,
  );

  await page.getByRole("button", { name: "Fill page" }).click();
  expect(
    await controller.evaluate(
      (el, original) => el === original,
      originalController,
    ),
  ).toBe(true);
  expect(
    await player.evaluate((el, original) => el === original, originalVideo),
  ).toBe(true);
  await expect(speed).toHaveAttribute("mediaplaybackrate", "1.25");
  const bounds = await controller.boundingBox();
  const speedBounds = await speed.boundingBox();
  expect(speedBounds?.y).toBeGreaterThan(bounds?.y ?? 0);
  expect(
    (speedBounds?.y ?? 0) + (speedBounds?.height ?? 0),
  ).toBeLessThanOrEqual((bounds?.y ?? 0) + (bounds?.height ?? 0) + 1);
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
  const backToPlayer = page.getByRole("button", { name: "Back to player" });
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
  const originalUrl = page.url();
  const historyLength = await page.evaluate(() => window.history.length);
  await backToPlayer.click();
  await expect(page.locator("#player")).toBeFocused();
  await expect(backToPlayer).toHaveCount(0);
  await expect(page).toHaveURL(originalUrl);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  expect(
    await page
      .locator("#player")
      .evaluate((element) => element.matches(":target")),
  ).toBe(false);
  await expect(page.locator("media-controller")).toHaveCSS(
    "outline-style",
    "none",
  );
  expect(
    await page.evaluate(
      (original) => document.querySelector("video") === original,
      player,
    ),
  ).toBe(true);

  // Keyboard activation should focus the player without fragment navigation.
  await page.evaluate(() => {
    const videoElement = document.querySelector("video");
    if (!videoElement) throw new Error("Missing player");
    window.scrollTo(
      0,
      window.scrollY + videoElement.getBoundingClientRect().bottom + 1,
    );
  });
  await expect(backToPlayer).toBeVisible();
  await backToPlayer.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#player")).toBeFocused();
  await expect(backToPlayer).toHaveCount(0);
  await expect(page).toHaveURL(originalUrl);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(page.locator("media-controller")).toHaveCSS(
    "outline-style",
    "solid",
  );

  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});

test("source-less controls are disabled functionally and accessibly", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  const controller = page.locator("media-controller");
  await expect(controller).toHaveAttribute("gesturesdisabled");
  await expect(controller).toHaveAttribute("nohotkeys");
  await expect(controller).toHaveAttribute("novolumepref");
  await expect(controller).toHaveAttribute("nomutedpref");
  for (const tag of [
    "media-play-button",
    "media-mute-button",
    "media-playback-rate-menu-button",
    "media-time-range",
    "media-volume-range",
  ]) {
    const control = controller.locator(tag);
    await expect(control).toHaveAttribute("disabled");
    await expect(control).toHaveAttribute("aria-disabled", "true");
  }
  for (const tag of ["media-time-range", "media-volume-range"]) {
    await expect(controller.locator(`${tag} input`)).toBeDisabled();
  }
  await expect(
    controller.locator("media-fullscreen-button"),
  ).not.toHaveAttribute("disabled");
  await controller.locator("media-play-button").dispatchEvent("click");
  await controller.locator("media-mute-button").dispatchEvent("click");
  expect(
    await page
      .locator("video")
      .evaluate((el) => (el as HTMLVideoElement).muted),
  ).toBe(false);
  await controller
    .locator("media-playback-rate-menu-button")
    .dispatchEvent("click");
  await expect(controller.locator("media-playback-rate-menu")).toHaveAttribute(
    "hidden",
  );
  expect(
    await page
      .locator("video")
      .evaluate((el) => (el as HTMLVideoElement).paused),
  ).toBe(true);
});

for (const mode of ["mp4", "proxy"] as const) {
  test(`${mode} playback uses real control events, records history, seeks and saves progress`, async ({
    page,
  }) => {
    const watched: unknown[] = [];
    const progress: { positionSeconds: number }[] = [];
    let holdResolve = false;
    let releaseResolve: (() => void) | undefined;
    const resolveHeld = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    await page.route("**/api/history", (route) =>
      route.fulfill({ json: watched.length ? [entry("Fixture video")] : [] }),
    );
    await page.route("**/api/history/*/watched", (route) => {
      watched.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/history/*/progress", (route) => {
      progress.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await serveFixtureMedia(page);
    if (mode === "mp4") {
      // Use the real server's Range/206 handling, not a full-body 200 mock.
      const range = await page.request.get(video.stream, {
        headers: { Range: "bytes=0-31" },
      });
      expect(range.status()).toBe(206);
      expect(range.headers()["accept-ranges"]).toBe("bytes");
      expect(range.headers()["content-range"]).toMatch(/^bytes 0-31\/\d+$/);
      expect((await range.body()).length).toBe(32);
    }
    await page.route("**/api/resolve", async (route) => {
      if (holdResolve) await resolveHeld;
      await route.fulfill({
        json:
          mode === "mp4"
            ? video
            : {
                ...video,
                kind: "proxy",
                hls: "/fixture-media/player.m3u8",
              },
      });
    });
    await page.goto(`/?url=${encodeURIComponent(url)}&mode=${mode}`);
    const player = page.locator("video");
    const controller = page.locator("media-controller");
    const originalController = await controller.elementHandle();
    const originalVideo = await player.elementHandle();
    const play = controller.locator("media-play-button");
    await expect(play).not.toHaveAttribute("disabled");
    expect(await player.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(
      true,
    );
    await play.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLVideoElement).currentTime))
      .toBeGreaterThan(0);
    await expect.poll(() => watched.length).toBe(1);
    await expect(page.locator(".history-item")).toContainText("Fixture video");
    expect(
      await controller.evaluate(
        (el, original) => el === original,
        originalController,
      ),
    ).toBe(true);
    expect(
      await player.evaluate((el, original) => el === original, originalVideo),
    ).toBe(true);
    // Focused controls must stay visible beyond the normal two-second idle timeout.
    await page.waitForTimeout(2500);
    await expect(controller.locator(".player-actions")).toHaveCSS(
      "opacity",
      "1",
    );
    await page.keyboard.press("Space");
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLVideoElement).paused))
      .toBe(true);
    const seek = controller.locator("media-time-range input");
    await expect(seek).toBeEnabled();
    // Seekability must come from the served media, not API metadata.
    await expect
      .poll(() =>
        player.evaluate((el) => {
          const video = el as HTMLVideoElement;
          return video.seekable.length
            ? video.seekable.end(video.seekable.length - 1)
            : 0;
        }),
      )
      .toBeGreaterThan(10);
    const seekBounds = await seek.boundingBox();
    if (!seekBounds) throw new Error("Missing seek input bounds");
    await seek.click({
      position: { x: seekBounds.width / 2, y: seekBounds.height / 2 },
    });
    await seek.press("ArrowRight");
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLVideoElement).currentTime))
      .toBeGreaterThan(5);
    // A duplicate global ArrowRight would add five seconds, not a slider step.
    expect(
      await player.evaluate((el) => (el as HTMLVideoElement).currentTime),
    ).toBeLessThan(7);
    expect(await player.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(
      true,
    );
    await expect
      .poll(async () =>
        Number(
          await controller
            .locator("media-time-display")
            .getAttribute("mediaduration"),
        ),
      )
      .toBeCloseTo(12, 0);
    await seek.hover();
    await expect(controller.locator("media-time-range")).toHaveAttribute(
      "mediapreviewtime",
      /\d/,
    );
    // Force a pause-save after seeking (time updates are deliberately throttled).
    await play.click();
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLVideoElement).paused))
      .toBe(false);
    await play.click();
    await expect
      .poll(() => progress.some((item) => item.positionSeconds >= 5))
      .toBe(true);

    const mute = controller.locator("media-mute-button");
    await mute.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLVideoElement).muted))
      .toBe(true);
    // Muting displays zero without changing stored volume. Wait for the slider
    // to reflect mute before End, then for unmute before the next key.
    const volumeRange = controller.locator("media-volume-range");
    const volume = volumeRange.locator("input");
    await expect(volume).toHaveValue("0");
    await volume.press("End");
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLVideoElement).muted))
      .toBe(false);
    await expect(volumeRange).not.toHaveAttribute("mediamuted");
    await expect(volume).toHaveValue("1");
    // Local slider keys change only volume, not playback or seek position.
    const position = await player.evaluate(
      (el) => (el as HTMLVideoElement).currentTime,
    );
    await volume.press("ArrowLeft");
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLVideoElement).volume))
      .toBeLessThan(1);
    expect(
      await player.evaluate((el) => (el as HTMLVideoElement).currentTime),
    ).toBe(position);
    await player.focus();
    await player.evaluate((el) =>
      el.addEventListener("keydown", (event) => event.preventDefault(), {
        once: true,
      }),
    );
    await page.keyboard.press("KeyM");
    expect(await player.evaluate((el) => (el as HTMLVideoElement).muted)).toBe(
      false,
    );

    // Fullscreen targets the controller, not the native video, so menus come along.
    if (await page.evaluate(() => document.fullscreenEnabled)) {
      await controller.locator("media-fullscreen-button").click();
      await expect
        .poll(() =>
          controller.evaluate((el) => document.fullscreenElement === el),
        )
        .toBe(true);
      await controller.locator("media-playback-rate-menu-button").click();
      const fullscreenMenu = controller.locator("media-playback-rate-menu");
      await expect(
        fullscreenMenu.getByRole("menuitemradio", {
          name: "0.25x",
          exact: true,
        }),
      ).toBeFocused();
      await fullscreenMenu
        .getByRole("menuitemradio", { name: "1.5x", exact: true })
        .click();
      expect(
        await player.evaluate((el) => (el as HTMLVideoElement).playbackRate),
      ).toBe(1.5);
      await controller.locator("media-fullscreen-button").click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement))
        .toBeNull();
    }
    // Source changes retain both nodes and clear an open menu during preparation.
    holdResolve = true;
    await controller.locator("media-playback-rate-menu-button").click();
    await page.getByRole("button", { name: "Prepare video" }).click();
    await expect(controller).toHaveAttribute("gesturesdisabled");
    await expect(play).toHaveAttribute("disabled");
    await expect(play).toHaveAttribute("aria-disabled", "true");
    await expect(seek).toBeDisabled();
    await expect(
      controller.locator("media-playback-rate-menu"),
    ).toHaveAttribute("hidden");
    releaseResolve?.();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-phase",
      "ready",
    );
    await expect(
      controller.locator("media-playback-rate-menu"),
    ).toHaveAttribute("hidden");
    expect(
      await controller.evaluate(
        (el, original) => el === original,
        originalController,
      ),
    ).toBe(true);
    expect(
      await player.evaluate((el, original) => el === original, originalVideo),
    ).toBe(true);
    expect(await player.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(
      true,
    );
  });
}

test("compact and landscape player controls stay attached without overflow", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => route.fulfill({ json: video }));
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4`);
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
    { width: 1800, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    const controller = page.locator("media-controller");
    await controller.locator("media-playback-rate-menu-button").click();
    const menu = controller.locator("media-playback-rate-menu");
    await expect(menu).not.toHaveAttribute("hidden");
    await expect(
      menu.getByRole("menuitemradio", { name: "0.25x", exact: true }),
    ).toBeFocused();
    const frame = await controller.boundingBox();
    const menuBounds = await menu.boundingBox();
    expect(menuBounds?.x).toBeGreaterThanOrEqual(frame?.x ?? 0);
    expect(menuBounds?.y).toBeGreaterThanOrEqual(frame?.y ?? 0);
    expect((menuBounds?.x ?? 0) + (menuBounds?.width ?? 0)).toBeLessThanOrEqual(
      (frame?.x ?? 0) + (frame?.width ?? 0) + 1,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    if (viewport.width === 375)
      await expect(controller.locator("media-volume-range")).toBeHidden();
    await page.keyboard.press("Escape");
  }
});

test("seek stays above compact controls and joins the action row on larger players", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => route.fulfill({ json: video }));
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4`);
  const controller = page.locator("media-controller");
  const originalNodes = await page
    .locator("media-controller, #player, media-time-range")
    .elementHandles();

  for (const width of [375, 800, 820, 1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const inline = width >= 820;
    if (inline) await expect(controller).toHaveAttribute("breakpointlg");
    else await expect(controller).not.toHaveAttribute("breakpointlg");
    const bounds = await controller.evaluate((element) => {
      const rect = (selector: string) => {
        const control = element.querySelector(selector);
        if (!control) throw new Error(`Missing ${selector}`);
        const { x, y, width, height, right, bottom } =
          control.getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      };
      return {
        frame: element.getBoundingClientRect().toJSON(),
        seek: rect("media-time-range"),
        play: rect("media-play-button"),
        volume: rect("media-volume-range"),
        time: rect("media-time-display"),
        speed: rect("media-playback-rate-menu-button"),
        fullscreen: rect("media-fullscreen-button"),
      };
    });
    expect(bounds.time.y).toBeCloseTo(bounds.play.y, 0);
    expect(bounds.speed.y).toBeCloseTo(bounds.play.y, 0);
    expect(bounds.fullscreen.y).toBeCloseTo(bounds.play.y, 0);
    if (inline) {
      expect(bounds.seek.y).toBeCloseTo(bounds.play.y, 0);
      expect(bounds.seek.x).toBeGreaterThanOrEqual(bounds.volume.right - 1);
      expect(bounds.seek.right).toBeLessThanOrEqual(bounds.time.x + 1);
      expect(bounds.seek.width).toBeGreaterThan(bounds.frame.width * 0.4);
    } else {
      expect(bounds.seek.bottom).toBeCloseTo(bounds.play.y, 0);
      expect(bounds.seek.x).toBeCloseTo(bounds.frame.x, 0);
      expect(bounds.seek.width).toBeCloseTo(bounds.frame.width, 0);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate((originals) => {
        const nodes = document.querySelectorAll(
          "media-controller, #player, media-time-range",
        );
        return originals.every((original, index) => nodes[index] === original);
      }, originalNodes),
    ).toBe(true);
  }
});

for (const mode of ["mp4", "proxy"] as const) {
  test(`${mode} timestamp bookmarks override resume without autoplay or watch recording`, async ({
    page,
  }) => {
    await serveFixtureMedia(page);
    let watched = 0;
    await page.route("**/api/history", (route) =>
      route.fulfill({
        json: [
          {
            ...entry("Fixture video"),
            mp4: { sizeBytes: mode === "mp4" ? 10 : null },
          },
        ],
      }),
    );
    await page.route("**/api/history/*/watched", (route) => {
      watched++;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/resolve", (route) =>
      route.fulfill({
        json: {
          ...video,
          positionSeconds: 8,
          ...(mode === "proxy"
            ? { kind: "proxy", hls: "/fixture-media/player.m3u8" }
            : {}),
        },
      }),
    );
    for (const [videoUrl, timestamp, expected] of [
      [url, "3", 3],
      [`${url}&t=4s`, null, 4],
      [`${url}&t=4s`, "0", 0],
      [url, "-1", 8],
      [url, "999", null],
    ] as const) {
      const search = new URLSearchParams({ url: videoUrl, mode });
      if (timestamp !== null) search.set("t", timestamp);
      await page.goto(`/?${search}`);
      const player = page.locator("video");
      await loadFixtureMetadata(page);
      await expect
        .poll(() =>
          player.evaluate((el: HTMLVideoElement) =>
            Number.isFinite(el.duration) ? el.duration : 0,
          ),
        )
        .toBeGreaterThan(0);
      const target =
        expected ??
        (await player.evaluate((el: HTMLVideoElement) => el.duration));
      await expect
        .poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime))
        .toBeCloseTo(target, 1);
      if (expected === 0)
        await expect(page.locator("#status")).toHaveText(
          "Ready. Press play in the video controls.",
        );
      expect(await player.evaluate((el: HTMLVideoElement) => el.paused)).toBe(
        true,
      );
      expect(watched).toBe(0);
    }

    // Editing the URL and replaying history must not reuse a previous link's timestamp.
    await page.getByLabel("YouTube video URL").fill(`${url}&start=2`);
    await page
      .getByRole("button", { name: "Prepare video", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate((el: HTMLVideoElement) => el.currentTime),
      )
      .toBeCloseTo(2, 1);
    expect(new URL(page.url()).searchParams.get("t")).toBe("2");
    const originalPlayer = await page.locator("video").elementHandle();
    await page
      .getByRole("button", { name: "Play Fixture video", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate((el: HTMLVideoElement) => el.currentTime),
      )
      .toBeCloseTo(8, 1);
    expect(new URL(page.url()).searchParams.has("t")).toBe(false);
    expect(
      await page.evaluate(
        (original) => document.querySelector("video") === original,
        originalPlayer,
      ),
    ).toBe(true);
    expect(watched).toBe(0);
  });
}

test("copy timestamp links use the playing source, mode and current time without changing playback", async ({
  page,
  context,
}) => {
  await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
  await serveFixtureMedia(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) =>
    route.fulfill({ json: { ...video, positionSeconds: 5 } }),
  );
  await page.goto("/");
  const copy = page.getByRole("button", {
    name: "Copy timestamp link",
    exact: true,
  });
  await expect(copy).toBeDisabled();
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4#history-title`);
  const player = page.locator("video");
  await loadFixtureMetadata(page);
  await expect
    .poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeCloseTo(5, 1);
  const originalPlayer = await player.elementHandle();
  const address = page.url();
  await player.evaluate((el: HTMLVideoElement) => {
    el.currentTime = 5.75;
  });
  await expect
    .poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeCloseTo(5.75, 1);
  await page
    .getByLabel("YouTube video URL")
    .fill("https://www.youtube.com/watch?v=123456789ab");
  await page.clock.pauseAt(new Date("2030-01-01T00:10:00Z"));
  await copy.click();
  const feedback = page.locator(".timestamp-tools [role='status']");
  await expect(feedback).toHaveText("Copied");
  expect(
    await feedback.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    ),
  ).toBeLessThan(
    await copy.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    ),
  );
  const copied = new URL(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(copied.origin).toBe(new URL(address).origin);
  expect(copied.pathname).toBe("/");
  expect(Object.fromEntries(copied.searchParams)).toEqual({
    url,
    mode: "mp4",
    t: "5",
  });
  expect(copied.hash).toBe("");
  await page.clock.runFor(2999);
  await expect(feedback).toHaveText("Copied");
  await copy.click();
  await expect(feedback).toHaveText("Copied");
  await page.clock.runFor(2999);
  await expect(feedback).toHaveText("Copied");
  await page.clock.runFor(1);
  await expect(feedback).toBeEmpty();
  expect(page.url()).toBe(address);
  expect(
    await player.evaluate((el: HTMLVideoElement) => el.currentTime),
  ).toBeCloseTo(5.75, 1);
  expect(await player.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  expect(
    await page.evaluate(
      (original) => document.querySelector("video") === original,
      originalPlayer,
    ),
  ).toBe(true);
});

test("clipboard failure leaves a selectable timestamp link and preparation clears it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
  });
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) =>
    route.fulfill({
      json: { ...video, kind: "proxy", hls: "/fixture-media/player.m3u8" },
    }),
  );
  await serveFixtureMedia(page);
  await page.goto(`/?url=${encodeURIComponent(url)}&t=3`);
  await expect
    .poll(() =>
      page.locator("video").evaluate((el: HTMLVideoElement) => el.currentTime),
    )
    .toBeCloseTo(3, 1);
  await page
    .getByRole("button", { name: "Copy timestamp link", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Copy the link below" }),
  ).toBeVisible();
  const fallback = page.getByLabel("Timestamp link", { exact: true });
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute("readonly");
  expect(
    Object.fromEntries(new URL(await fallback.inputValue()).searchParams),
  ).toEqual({ url, mode: "proxy", t: "3" });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await fallback.focus();
  await page.keyboard.press("KeyK");
  expect(
    await page.locator("video").evaluate((el: HTMLVideoElement) => el.paused),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Prepare video", exact: true })
    .click();
  await expect(fallback).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "Copy the link below" }),
  ).toHaveCount(0);
});
