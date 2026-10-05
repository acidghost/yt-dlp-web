import { expect, type Page, test } from "playwright/test";
import { HistoryListSchema, StorageListSchema } from "../app/protocol";

// Full application journeys. No API interception or invented tokens/history:
// only the host's external media/CDN collaborators are controlled.
const ids = ["native00001", "proxy000001"];

test.beforeEach(async ({ request }) => {
  for (const id of ids) {
    expect((await request.delete(`/api/history/${id}`)).ok()).toBe(true);
  }
});

async function play(page: Page) {
  const button = page.locator("media-controller media-play-button");

  await expect(button).not.toHaveAttribute("disabled");

  await button.focus();
  await page.keyboard.press("Space");

  await expect
    .poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(1);
}

async function rows(page: Page) {
  return HistoryListSchema.parse(await (await page.request.get("/api/history")).json());
}

test("native preparation, user playback and saved watch/progress survive page reload and replay", async ({
  page,
}) => {
  const id = "native00001";

  await page.goto(`/?url=${encodeURIComponent(`https://youtu.be/${id}`)}&mode=mp4`);

  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(
    true,
  );
  expect((await rows(page)).find((row) => row.id === id)).toBeUndefined();
  const storage = StorageListSchema.parse(await (await page.request.get("/api/storage")).json());
  expect(storage.find((file) => file.id === id)).toMatchObject({
    title: "Local fixture video",
    channel: "Local fixture channel",
  });
  expect(storage.find((file) => file.id === id)?.sizeBytes).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
  const savedFile = page.locator(`.saved-file-item[data-id="${id}"]`);
  await expect(savedFile).toContainText("Not in watch history");
  await expect(savedFile).toContainText("Modified");
  const preparing = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/resolve",
  );
  await savedFile.getByRole("button", { name: "Play Local fixture video", exact: true }).click();
  expect((await preparing).ok()).toBe(true);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(
    true,
  );
  expect((await rows(page)).find((row) => row.id === id)).toBeUndefined();

  await play(page);
  await page.locator("media-play-button").focus();
  await page.keyboard.press("Space");

  await expect
    .poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(true);
  await expect
    .poll(async () => (await rows(page)).find((row) => row.id === id)?.positionSeconds ?? 0)
    .toBeGreaterThan(0);

  const saved = (await rows(page)).find((row) => row.id === id);

  expect(saved?.mp4.sizeBytes).toBeGreaterThan(0);

  await page.goto("/");

  const entry = page.locator(`.history-item[data-id="${id}"]`);

  await expect(entry).toContainText("Local fixture video");
  await expect(entry).toContainText("MP4");
  expect((await rows(page)).find((row) => row.id === id)).toEqual(saved);

  await entry.getByRole("button", { name: "Play Local fixture video", exact: true }).click();

  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute("src", `/api/stream/${id}/720`);
  expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(
    true,
  );

  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
  const confirmation = page.waitForEvent("dialog");
  const deleting = page
    .locator(`.saved-file-item[data-id="${id}"]`)
    .getByRole("button", {
      name: "Delete 90p (Up to 720p) MP4 for Local fixture video",
      exact: true,
    })
    .click();
  await (await confirmation).accept();
  await deleting;
  await expect(page.locator("#status")).toHaveText("Saved MP4 deleted.");
  await expect(page.locator(`.saved-file-item[data-id="${id}"]`)).toHaveCount(0);
  expect(
    StorageListSchema.parse(await (await page.request.get("/api/storage")).json()).find(
      (file) => file.id === id,
    ),
  ).toBeUndefined();
  expect((await rows(page)).find((row) => row.id === id)).toMatchObject({
    title: "Local fixture video",
    mp4: { sizeBytes: null },
  });
  await expect(page.locator("#history-title")).toBeFocused();
});

test("default proxy mode plays real rewritten local HLS with separate audio through the application", async ({
  page,
}) => {
  const resources: string[] = [];

  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/proxy/") && response.ok()) {
      resources.push(response.url());
    }
  });

  const admission = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/resolve",
  );

  await page.goto(`/?url=${encodeURIComponent("https://youtu.be/proxy000001")}`);

  await expect(page.locator("#player-mode")).toHaveValue("proxy");
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(
    true,
  );
  expect((await rows(page)).find((row) => row.id === "proxy000001")).toBeUndefined();

  const { hls } = await (await admission).json();
  const master = await (await page.request.get(hls)).text();
  const audio = /^#EXT-X-MEDIA:.*TYPE=AUDIO.*URI="([^"]+)"/m.exec(master)?.[1];
  const video = master.split("\n").find((line) => line.startsWith("/api/proxy/"));
  if (!audio || !video) {
    throw new Error("Expected rewritten separate audio/video playlists");
  }

  const audioPlaylist = await (await page.request.get(audio)).text();
  const videoPlaylist = await (await page.request.get(video)).text();
  const audioSegments = audioPlaylist.split("\n").filter((line) => line.startsWith("/api/proxy/"));
  const videoSegments = videoPlaylist.split("\n").filter((line) => line.startsWith("/api/proxy/"));

  expect(audioSegments.length).toBeGreaterThan(0);
  expect(videoSegments.length).toBeGreaterThan(0);

  await play(page);
  await expect(page.locator("#current-quality")).toContainText("Auto · Up to 720p · currently 90p");

  // page's response events are browser requests, not APIRequestContext reads.
  await expect
    .poll(() => resources.some((url) => audioSegments.includes(new URL(url).pathname)))
    .toBe(true);
  await expect
    .poll(() => resources.some((url) => videoSegments.includes(new URL(url).pathname)))
    .toBe(true);
  await expect(page.locator('.history-item[data-id="proxy000001"]')).toContainText(
    "Local fixture HLS",
  );
  expect((await rows(page)).find((row) => row.id === "proxy000001")?.mp4.sizeBytes).toBeNull();
});

test("active native download cancels globally, confirms cleanup, and permits a successful retry", async ({
  page,
}) => {
  const id = `cancel${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`;
  const admission = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/resolve",
  );

  await page.goto(`/?url=${encodeURIComponent(`https://youtu.be/${id}`)}&mode=mp4`);

  const { jobToken } = await (await admission).json();

  await expect(page.locator(".download-progress")).toContainText("Downloading video");

  await page.getByRole("button", { name: "Cancel download", exact: true }).click();

  await expect(page.locator("#status")).toContainText("Download canceled. Partial files removed.");
  await expect(page.getByRole("button", { name: "Prepare video" })).toBeEnabled();
  expect(await (await page.request.get(`/api/downloads/${jobToken}`)).json()).toEqual({
    state: "canceled",
  });
  expect((await page.request.get(`/api/stream/${id}/720`)).status()).toBe(404);
  expect((await rows(page)).find((row) => row.id === id)).toBeUndefined();

  const retry = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/resolve",
  );

  await page.getByRole("button", { name: "Prepare video" }).click();

  const response = await retry;

  expect(response.status()).toBe(202);
  expect((await response.json()).jobToken).not.toBe(jobToken);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute("src", `/api/stream/${id}/720`);
});

test("quality changes are explicit, preserve the same-video playhead, and save/replay/delete distinct cap files", async ({
  page,
  context,
}) => {
  const id = "quality0001";
  expect((await page.request.delete(`/api/history/${id}`)).ok()).toBe(true);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const requests: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/resolve") {
      requests.push(request.postDataJSON());
    }
  });
  await page.goto(`/?url=${encodeURIComponent(`https://youtu.be/${id}`)}&mode=mp4&quality=360&t=2`);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  const player = page.locator("video");
  const original = await player.elementHandle();
  await player.evaluate((video: HTMLVideoElement) => {
    if (video.readyState === 0) {
      video.preload = "metadata";
      video.load();
    }
  });
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(2, 1);
  await player.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 8.5;
    video.playbackRate = 1.75;
    video.volume = 0.3;
    video.muted = true;
  });
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(8.5, 1);
  const count = requests.length;
  await page.getByLabel("Max quality", { exact: true }).selectOption("1080");
  await expect(player).toHaveAttribute("src", `/api/stream/${id}/360`);
  expect(requests).toHaveLength(count);
  await expect(page.locator("#current-quality")).toContainText("90p (Up to 360p)");
  await page.getByRole("button", { name: "Copy timestamp link", exact: true }).click();
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.searchParams.get("quality")).toBe("360");
  expect(copied.searchParams.get("t")).toBe("8");
  await page.getByLabel("Playback mode").selectOption("proxy");
  await expect(player).toHaveAttribute("src", `/api/stream/${id}/360`);
  expect(requests).toHaveLength(count);
  await page.getByLabel("Playback mode").selectOption("mp4");
  await expect(player).toHaveAttribute("src", `/api/stream/${id}/360`);
  expect(requests).toHaveLength(count);

  await page.getByRole("button", { name: "Prepare video", exact: true }).click();
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(player).toHaveAttribute("src", `/api/stream/${id}/1080`);
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(8.5, 1);
  expect(
    await player.evaluate((video: HTMLVideoElement) => ({
      rate: video.playbackRate,
      volume: video.volume,
      muted: video.muted,
      paused: video.paused,
    })),
  ).toEqual({ rate: 1.75, volume: 0.3, muted: true, paused: true });
  expect(await page.evaluate((node) => document.querySelector("video") === node, original)).toBe(
    true,
  );
  expect(new URL(page.url()).searchParams.get("t")).toBe("8");
  await expect(page.locator("#current-quality")).toContainText("90p (Up to 1080p)");
  await play(page);
  await expect.poll(async () => (await rows(page)).some((row) => row.id === id)).toBe(true);
  await player.evaluate((video: HTMLVideoElement) => video.pause());

  await page.goto("/");
  await expect(page.getByLabel("Max quality", { exact: true })).toHaveValue("1080");
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
  const files = page.locator(`.saved-file-item[data-id="${id}"]`);
  await expect(files).toHaveCount(2);
  const lowRow = page.locator(`.saved-file-item[data-id="${id}"][data-variant="360"]`);
  await lowRow.getByRole("button", { name: "Play Local fixture video", exact: true }).click();
  await expect(player).toHaveAttribute("src", `/api/stream/${id}/360`);
  expect(requests.at(-1)).toMatchObject({ mode: "mp4", savedVariant: "360" });
  const highRow = page.locator(`.saved-file-item[data-id="${id}"][data-variant="1080"]`);
  await highRow.getByRole("button", { name: "Play Local fixture video", exact: true }).click();
  await expect(player).toHaveAttribute("src", `/api/stream/${id}/1080`);
  const confirmed = page.waitForEvent("dialog");
  const deleting = lowRow.getByRole("button", { name: /Delete .* MP4/ }).click();
  await (await confirmed).accept();
  await deleting;
  await expect(files).toHaveCount(1);
  await expect(player).toHaveAttribute("src", `/api/stream/${id}/1080`);
  const row = (await rows(page)).find((row) => row.id === id);
  expect(row?.mp4.variants.map((file) => file.variant)).toEqual(["1080"]);
  expect((await page.request.get(`/api/stream/${id}/360`)).status()).toBe(404);
  expect((await page.request.get(`/api/stream/${id}/1080`)).ok()).toBe(true);
  await page.request.delete(`/api/history/${id}`);
});
