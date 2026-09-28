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
  stream: "/api/stream/abcdefghijk",
};

const entry = (title: string) => ({
  id: "abcdefghijk",
  url,
  title,
  channel: "Fixture channel",
  duration: 10,
  lastWatchedAt: "2026-09-27T10:00:00.000Z",
  available: { mp4: true, hls: false },
  sizeBytes: { mp4: 10, hls: null },
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

test("missing HLS keeps the downloaded MP4 available after a mode switch", async ({
  page,
}) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => route.fulfill({ json: video }));

  await page.goto(`/?url=${encodeURIComponent(url)}&mode=hls`);
  await expect(page.getByLabel("YouTube video URL")).toHaveValue(url);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "error");
  await expect(page.locator("#status")).toContainText(
    "HLS packaging is unavailable",
  );
  await page.getByLabel("Playback mode").selectOption("mp4");
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute("src", video.stream);
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
