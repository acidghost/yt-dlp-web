import { expect, type Page, test } from "playwright/test";
import { HistoryListSchema } from "../app/protocol";

// Full application journeys. No API interception or invented tokens/history:
// only the host's external media/CDN collaborators are controlled.
const ids = ["native00001", "proxy000001"];
test.beforeEach(async ({ request }) => {
  for (const id of ids)
    expect((await request.delete(`/api/history/${id}`)).ok()).toBe(true);
});

async function play(page: Page) {
  const button = page.locator("media-controller media-play-button");
  await expect(button).not.toHaveAttribute("disabled");
  await button.focus();
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeGreaterThan(1);
}

async function rows(page: Page) {
  return HistoryListSchema.parse(
    await (await page.request.get("/api/history")).json(),
  );
}

test("native preparation, user playback and saved watch/progress survive page reload and replay", async ({
  page,
}) => {
  const id = "native00001";
  await page.goto(
    `/?url=${encodeURIComponent(`https://youtu.be/${id}`)}&mode=mp4`,
  );
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  expect(
    await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => video.paused),
  ).toBe(true);
  expect((await rows(page)).find((row) => row.id === id)).toBeUndefined();
  await play(page);
  await page.locator("media-play-button").focus();
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page.locator("video").evaluate((video: HTMLVideoElement) => video.paused),
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await rows(page)).find((row) => row.id === id)?.positionSeconds ?? 0,
    )
    .toBeGreaterThan(0);
  const saved = (await rows(page)).find((row) => row.id === id);
  expect(saved?.mp4.sizeBytes).toBeGreaterThan(0);
  await page.goto("/");
  const entry = page.locator(`.history-item[data-id="${id}"]`);
  await expect(entry).toContainText("Local fixture video");
  await expect(entry).toContainText("MP4");
  expect((await rows(page)).find((row) => row.id === id)).toEqual(saved);
  await entry
    .getByRole("button", { name: "Play Local fixture video", exact: true })
    .click();
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    `/api/stream/${id}`,
  );
  expect(
    await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => video.paused),
  ).toBe(true);
});

test("default proxy mode plays real rewritten local HLS with separate audio through the application", async ({
  page,
}) => {
  const resources: string[] = [];
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname.startsWith("/api/proxy/") &&
      response.ok()
    )
      resources.push(response.url());
  });
  const admission = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/resolve",
  );
  await page.goto(
    `/?url=${encodeURIComponent("https://youtu.be/proxy000001")}`,
  );
  await expect(page.locator("#player-mode")).toHaveValue("proxy");
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  expect(
    await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => video.paused),
  ).toBe(true);
  expect(
    (await rows(page)).find((row) => row.id === "proxy000001"),
  ).toBeUndefined();
  const { hls } = await (await admission).json();
  const master = await (await page.request.get(hls)).text();
  const audio = /^#EXT-X-MEDIA:.*TYPE=AUDIO.*URI="([^"]+)"/m.exec(master)?.[1];
  const video = master
    .split("\n")
    .find((line) => line.startsWith("/api/proxy/"));
  if (!audio || !video)
    throw new Error("Expected rewritten separate audio/video playlists");
  const audioPlaylist = await (await page.request.get(audio)).text();
  const videoPlaylist = await (await page.request.get(video)).text();
  const audioSegments = audioPlaylist
    .split("\n")
    .filter((line) => line.startsWith("/api/proxy/"));
  const videoSegments = videoPlaylist
    .split("\n")
    .filter((line) => line.startsWith("/api/proxy/"));
  expect(audioSegments.length).toBeGreaterThan(0);
  expect(videoSegments.length).toBeGreaterThan(0);
  await play(page);
  // page's response events are browser requests, not APIRequestContext reads.
  await expect
    .poll(() =>
      resources.some((url) => audioSegments.includes(new URL(url).pathname)),
    )
    .toBe(true);
  await expect
    .poll(() =>
      resources.some((url) => videoSegments.includes(new URL(url).pathname)),
    )
    .toBe(true);
  await expect(
    page.locator('.history-item[data-id="proxy000001"]'),
  ).toContainText("Local fixture HLS");
  expect(
    (await rows(page)).find((row) => row.id === "proxy000001")?.mp4.sizeBytes,
  ).toBeNull();
});

test("active native download cancels globally, confirms cleanup, and permits a successful retry", async ({
  page,
}) => {
  const id = `cancel${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`;
  const admission = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/resolve",
  );
  await page.goto(
    `/?url=${encodeURIComponent(`https://youtu.be/${id}`)}&mode=mp4`,
  );
  const { jobToken } = await (await admission).json();
  await expect(page.locator(".download-progress")).toContainText(
    "Downloading video",
  );
  await page
    .getByRole("button", { name: "Cancel download", exact: true })
    .click();
  await expect(page.locator("#status")).toContainText(
    "Download canceled. Partial files removed.",
  );
  await expect(
    page.getByRole("button", { name: "Prepare video" }),
  ).toBeEnabled();
  expect(
    await (await page.request.get(`/api/downloads/${jobToken}`)).json(),
  ).toEqual({ state: "canceled" });
  expect((await page.request.get(`/api/stream/${id}`)).status()).toBe(404);
  expect((await rows(page)).find((row) => row.id === id)).toBeUndefined();
  const retry = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/resolve",
  );
  await page.getByRole("button", { name: "Prepare video" }).click();
  const response = await retry;
  expect(response.status()).toBe(202);
  expect((await response.json()).jobToken).not.toBe(jobToken);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    `/api/stream/${id}`,
  );
});
