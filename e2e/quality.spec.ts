import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "playwright/test";
import { QualitySchema } from "../app/protocol";

const url = "https://www.youtube.com/watch?v=abcdefghijk";

async function api(page: Page) {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/storage", (route) => route.fulfill({ json: [] }));
  // Use the real stream endpoint: a 200-only route double cannot reliably seek
  // with preload=metadata. Publication/selection remain covered by journeys.
  for (const quality of QualitySchema.options) {
    const dir = join(import.meta.dirname, "../tmp/e2e-data/media/abcdefghijk", `q-${quality}`);
    await mkdir(dir, { recursive: true });
    await copyFile(join(import.meta.dirname, "fixtures/player.mp4"), join(dir, "video.mp4"));
    await writeFile(
      join(dir, "quality.json"),
      JSON.stringify({ version: 1, requested: quality, height: 90 }),
    );
  }
  await page.route("**/api/resolve", (route) => {
    const { quality = "720" } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        kind: "download",
        id: "abcdefghijk",
        url,
        token: "fixture-token",
        title: "Quality fixture",
        channel: null,
        duration: 12,
        positionSeconds: 0,
        stream: `/api/stream/abcdefghijk/${quality}`,
        variant: quality,
        quality: { requested: quality, height: 90 },
      },
    });
  });
}

test("browser preference persists, explicit link wins, and invalid stored values fall back to 720", async ({
  page,
}) => {
  await api(page);
  await page.goto("/");
  const quality = page.getByLabel("Max quality", { exact: true });
  await expect(quality).toHaveValue("720");
  await expect(page.locator("#quality-hint")).toContainText("Up to 720p applies when you prepare.");
  await quality.selectOption("480");
  await page.reload();
  await expect(quality).toHaveValue("480");
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4&quality=1080`);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(quality).toHaveValue("1080");
  await expect(page.locator("#current-quality")).toHaveText("MP4 · 90p (Up to 1080p)");
  await page.goto("/");
  await expect(quality).toHaveValue("480");
  await page.evaluate(() => localStorage.setItem("video-quality", "bogus"));
  await page.reload();
  await expect(quality).toHaveValue("720");
});

test("blocked preference storage does not prevent selecting and preparing a cap", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "video-quality") {
        throw new Error("Storage blocked");
      }
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "video-quality") {
        throw new Error("Storage blocked");
      }
      return set.call(this, key, value);
    };
  });
  await api(page);
  await page.goto("/");
  await page.getByLabel("Max quality", { exact: true }).selectOption("360");
  await page.getByLabel("YouTube video URL").fill(url);
  await page.getByLabel("Playback mode").selectOption("mp4");
  await page.getByRole("button", { name: "Prepare video", exact: true }).click();
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute("src", "/api/stream/abcdefghijk/360");
});

test("invalid explicit quality links never contact resolve", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/resolve", (route) => {
    calls++;
    return route.abort();
  });
  for (const quality of ["1440", "", "../360"]) {
    await page.goto(`/?url=${encodeURIComponent(url)}&quality=${encodeURIComponent(quality)}`);
    await expect(page.locator("#status")).toHaveText("Unknown video quality.");
    await expect(page.locator("video")).not.toHaveAttribute("src");
  }
  expect(calls).toBe(0);
});

for (const width of [375, 1280]) {
  test(`quality preparation controls fit ${width}px with keyboard focus and touch targets`, async ({
    page,
  }) => {
    await api(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const controls = [
      page.getByLabel("YouTube video URL"),
      page.getByLabel("Playback mode"),
      page.getByLabel("Max quality", { exact: true }),
      page.getByRole("button", { name: "Prepare video", exact: true }),
      page.getByRole("button", { name: "Fill page", exact: true }),
    ];
    const bounds = [];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.height, `${control} touch target height`).toBeGreaterThanOrEqual(44);
      bounds.push(box);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    if (width === 1280) {
      const center = (bounds[0]?.y ?? 0) + (bounds[0]?.height ?? 0) / 2;
      for (const box of bounds) {
        expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - center)).toBeLessThan(1);
      }
    }
    const quality = page.getByLabel("Max quality", { exact: true });
    await quality.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(quality).toBeFocused();
    await quality.selectOption("1080");
    await expect(quality).toHaveValue("1080");
    await expect(page.locator("video")).not.toHaveAttribute("src");
  });
}

test("editing the video URL keeps its new timestamp instead of the old source playhead", async ({
  page,
}) => {
  await api(page);
  const media = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/stream/abcdefghijk/360") && response.status() === 206,
  );
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4&quality=360&t=2`);
  const player = page.locator("video");
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await player.evaluate((video: HTMLVideoElement) => {
    if (video.readyState === 0) {
      video.preload = "metadata";
      video.load();
    }
  });
  expect((await media).headers()["accept-ranges"]).toBe("bytes");
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(2, 1);
  await player.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 8;
  });
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(8, 1);

  await page.getByLabel("YouTube video URL").fill(`${url}&t=3`);
  await page.getByLabel("Max quality", { exact: true }).selectOption("1080");
  await page.getByRole("button", { name: "Prepare video", exact: true }).click();
  await expect(player).toHaveAttribute("src", "/api/stream/abcdefghijk/1080");
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(3, 1);
  expect(await player.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test("native-capability fallback reports only the cap, not the manifest's highest height", async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of ["MediaSource", "ManagedMediaSource", "WebKitMediaSource"]) {
      Object.defineProperty(window, name, { value: undefined, configurable: true });
    }
    const canPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return type === "application/vnd.apple.mpegurl" ? "maybe" : canPlay.call(this, type);
    };
  });
  await api(page);
  await page.route("**/api/resolve", (route) =>
    route.fulfill({
      json: {
        kind: "proxy",
        id: "abcdefghijk",
        url,
        token: "fixture-token",
        title: "Quality fixture",
        channel: null,
        duration: 12,
        positionSeconds: 0,
        hls: "/api/proxy/fixture-token/0",
        quality: { requested: "720", availableHeights: [360, 720] },
      },
    }),
  );
  // This is UI/capability proof, not Safari/native-HLS decoding proof.
  await page.route("**/api/proxy/**", (route) =>
    route.fulfill({
      path: `${import.meta.dirname}/fixtures/player.mp4`,
      contentType: "video/mp4",
    }),
  );
  await page.goto(`/?url=${encodeURIComponent(url)}&quality=720`);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute("src", "/api/proxy/fixture-token/0");
  await expect(page.locator("#current-quality")).toHaveText("Auto · Up to 720p");
  await expect(page.locator("#current-quality")).not.toContainText("currently");
});
