// Controlled history/storage boundaries; real app, Lit DOM, and native media.
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "playwright/test";
import type { HistoryEntry, StorageFile } from "../app/protocol";
import { deferred } from "../tests/support/async";

const history: HistoryEntry[] = [
  {
    id: "aaaaaaaaaaa",
    url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    title: "Alpha server",
    channel: "Small Systems",
    duration: 120,
    lastWatchedAt: "2026-10-03T00:00:00.000Z",
    positionSeconds: 0,
    mp4: { sizeBytes: 100 },
  },
  {
    id: "bbbbbbbbbbb",
    url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
    title: "Parser [WAL]",
    channel: "Debug Diaries",
    duration: 120,
    lastWatchedAt: "2026-10-01T00:00:00.000Z",
    positionSeconds: 40,
    mp4: { sizeBytes: null },
  },
  {
    id: "ccccccccccc",
    url: "https://www.youtube.com/watch?v=ccccccccccc",
    title: "SQLite WAL",
    channel: null,
    duration: 120,
    lastWatchedAt: "2026-10-02T00:00:00.000Z",
    positionSeconds: 100,
    mp4: { sizeBytes: 50 },
  },
];
const files: StorageFile[] = [
  {
    id: "aaaaaaaaaaa",
    title: "Alpha server",
    channel: "Small Systems",
    sizeBytes: 100,
    modifiedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "ccccccccccc",
    title: "SQLite WAL",
    channel: null,
    sizeBytes: 50,
    modifiedAt: "2026-10-04T00:00:00.000Z",
  },
  {
    id: "ddddddddddd",
    title: "Fuzz workshop",
    channel: "Debug Diaries",
    sizeBytes: 500,
    modifiedAt: "2026-10-02T00:00:00.000Z",
  },
  {
    id: "eeeeeeeeeee",
    title: null,
    channel: null,
    sizeBytes: 200,
    modifiedAt: "2026-10-03T00:00:00.000Z",
  },
];

async function library(page: Page, rows = history, saved = files) {
  await page.route("**/api/history", (route) => route.fulfill({ json: rows }));
  await page.route("**/api/storage", (route) => route.fulfill({ json: saved }));
}

async function rowIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).dataset.id),
  );
}

async function settleRender(page: Page) {
  // Let an already delivered response finish its reactive DOM update.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

test("each tab offers its two sorts, orders correctly, and remembers an independent selection", async ({
  page,
}) => {
  await library(page);
  await page.goto("/");

  // A wrapping label also contains option text; match the accessible role/name instead.
  const sort = page.getByRole("combobox", { name: "Sort", exact: true });
  const originalSort = await sort.elementHandle();
  const historyRows = page.locator(".history-item");
  const fileRows = page.locator(".saved-file-item");

  await expect(sort.locator("option")).toHaveText(["Recent first", "Oldest first"]);
  await expect
    .poll(() => rowIds(historyRows))
    .toEqual(["aaaaaaaaaaa", "ccccccccccc", "bbbbbbbbbbb"]);
  await sort.focus();
  await sort.selectOption("oldest");

  await expect(sort).toBeFocused();
  await expect
    .poll(() => rowIds(historyRows))
    .toEqual(["bbbbbbbbbbb", "ccccccccccc", "aaaaaaaaaaa"]);
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();

  await expect(page.getByRole("button", { name: "Saved MP4s", exact: true })).toBeFocused();
  await expect(sort).toBeEnabled();
  await expect(sort.locator("option")).toHaveText(["Largest", "Most recent"]);
  await expect(sort).toHaveValue("largest");
  await expect
    .poll(() => rowIds(fileRows))
    .toEqual(["ddddddddddd", "eeeeeeeeeee", "aaaaaaaaaaa", "ccccccccccc"]);
  await sort.focus();
  await sort.selectOption("most-recent");

  await expect(sort).toBeFocused();
  await expect
    .poll(() => rowIds(fileRows))
    .toEqual(["ccccccccccc", "eeeeeeeeeee", "ddddddddddd", "aaaaaaaaaaa"]);
  await expect(page.locator("caption")).toHaveText("Saved MP4s, most recent modification first");
  await page.getByRole("button", { name: "Watch history", exact: true }).click();

  await expect(sort).toHaveValue("oldest");
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();

  await expect(sort).toHaveValue("most-recent");
  expect(
    await page.evaluate(
      (original) => document.querySelector("#library-sort") === original,
      originalSort,
    ),
  ).toBe(true);
  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
});

test("history only shows badges for saved MP4s", async ({ page }) => {
  await library(page);
  await page.goto("/");

  await expect(page.locator('.history-item[data-id="aaaaaaaaaaa"] chip')).toHaveText("MP4 · 100 B");
  await expect(page.locator('.history-item[data-id="ccccccccccc"] chip')).toHaveText("MP4 · 50 B");
  const unsaved = page.locator('.history-item[data-id="bbbbbbbbbbb"]');
  await expect(unsaved).toContainText("Parser [WAL]");
  await expect(unsaved.locator("chip")).toHaveCount(0);
  await expect(unsaved.locator(".badges")).toHaveCount(0);
  await expect(
    unsaved.getByRole("button", { name: "Play Parser [WAL]", exact: true }),
  ).toBeEnabled();
});

for (const width of [1280, 800]) {
  test(`library view, search and sort share one row at ${width}px with an active query`, async ({
    page,
  }) => {
    await library(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".history-item")).toHaveCount(3);
    await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
    await page.getByLabel("Search title or channel").fill("a");
    await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();

    const views = page.getByRole("group", { name: "Library view", exact: true });
    const search = page.getByRole("searchbox", { name: "Search title or channel", exact: true });
    const sort = page.getByRole("combobox", { name: "Sort", exact: true });
    const controls = [views, search, sort];
    const tops = await Promise.all(
      controls.map(async (control) => (await control.boundingBox())?.y ?? -1),
    );

    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2);
    const searchBounds = await search.boundingBox();
    const sortBounds = await sort.boundingBox();
    const gap = (sortBounds?.x ?? -1) - ((searchBounds?.x ?? 0) + (searchBounds?.width ?? 0));
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();

    const fileTops = await Promise.all(
      controls.map(async (control) => (await control.boundingBox())?.y ?? -1),
    );
    expect(Math.max(...fileTops) - Math.min(...fileTops)).toBeLessThan(2);
  });
}

test("search finds unrevealed history, stays shared across tabs, and never filters the storage total", async ({
  page,
}) => {
  const rows: HistoryEntry[] = Array.from({ length: 13 }, (_, index) => ({
    ...(history[0] as HistoryEntry),
    id: `video${String(index).padStart(6, "0")}`,
    title: `Video ${index}`,
    channel: null,
  }));
  rows.push({ ...(history[1] as HistoryEntry), title: "Unrevealed parser" });
  await library(page, rows);
  await page.goto("/");

  await expect(page.locator(".history-item")).toHaveCount(12);
  await page.getByLabel("Search title or channel").fill("  DEBUG  ");

  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect(page.locator(".history-item")).toContainText("Unrevealed parser");
  await expect(page.locator(".library-subtotal")).toHaveText("0 B in all matching results");
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();

  await expect(page.getByLabel("Search title or channel")).toHaveValue("  DEBUG  ");
  await expect(page.locator(".saved-file-item")).toHaveCount(1);
  await expect(page.locator(".saved-file-item")).toContainText("Fuzz workshop");
  await expect(page.locator(".library-subtotal")).toHaveText("500 B in all matching results");
  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
  await expect(page.locator(".size-fill")).toHaveAttribute("style", "width: 100%");
  await page.getByLabel("Search title or channel").fill("eeee");

  await expect(page.locator(".saved-file-item")).toContainText("Saved video (eeeeeeeeeee)");
  await expect(page.locator(".size-fill")).toHaveAttribute("style", "width: 40%");
  await expect(page.locator(".saved-file-item")).toContainText("Not in watch history");
  await expect(page.getByRole("button", { name: /Delete files and history/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Mark .*watched|Reset watch progress/ }),
  ).toHaveCount(0);
  await page.getByLabel("Search title or channel").fill("Channel unavailable");

  await expect(page.getByText(/No saved MP4s match/)).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();

  await expect(page.getByLabel("Search title or channel")).toBeFocused();
  await expect(page.locator(".saved-file-item")).toHaveCount(4);
});

test("chunking follows all filtered results; refresh preserves state and query/tab/sort changes reset the chunk", async ({
  page,
}) => {
  const saved = Array.from({ length: 25 }, (_, index) => ({
    id: `file${String(index).padStart(7, "0")}`,
    title: `Saved clip ${index}`,
    channel: "Library",
    sizeBytes: index + 1,
    modifiedAt: "2026-10-01T00:00:00.000Z",
  }));
  await library(page, [], saved);
  await page.goto("/");
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();

  await expect(page.locator(".saved-file-item")).toHaveCount(12);
  await expect(page.getByText("Showing 12 of 25 saved MP4s")).toBeVisible();
  await page.getByRole("button", { name: "Show 12 more" }).click();

  await expect(page.locator(".saved-file-item")).toHaveCount(24);
  await page.getByRole("button", { name: "Refresh library" }).click();

  await expect(page.locator(".saved-file-item")).toHaveCount(24);
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("most-recent");

  await expect(page.locator(".saved-file-item")).toHaveCount(12);
  await page.getByRole("button", { name: "Show 12 more" }).click();
  await page.getByLabel("Search title or channel").fill("clip");

  await expect(page.locator(".saved-file-item")).toHaveCount(12);
  await expect(page.getByText("Showing 12 of 25 matches")).toBeVisible();
  await expect(page.locator(".library-subtotal")).toHaveText("325 B in all matching results");
  await page.getByRole("button", { name: "Show 12 more" }).click();
  await page.getByRole("button", { name: "Refresh library" }).click();

  await expect(page.locator(".saved-file-item")).toHaveCount(24);
  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue(
    "most-recent",
  );
  await expect(page.getByLabel("Search title or channel")).toHaveValue("clip");
  await page.getByRole("button", { name: "Watch history", exact: true }).click();
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();

  await expect(page.locator(".saved-file-item")).toHaveCount(12);
  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 325 B · 25 files");
});

test("an older initial storage response cannot overwrite a newer refresh", async ({ page }) => {
  const first = deferred();
  let calls = 0;
  await page.route("**/api/history", (route) => route.fulfill({ json: history }));
  await page.route("**/api/storage", async (route) => {
    if (++calls === 1) {
      await first.promise;
      await route.fulfill({ json: [{ ...files[0], sizeBytes: 1 }] });
    } else {
      await route.fulfill({ json: files });
    }
  });
  try {
    await page.goto("/");
    await expect.poll(() => calls).toBe(1);
    await page.getByRole("button", { name: "Refresh library" }).click();
    await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");

    const delivered = page.waitForResponse(
      async (response) =>
        response.url().endsWith("/api/storage") && (await response.json())[0]?.sizeBytes === 1,
    );
    first.resolve();
    await delivered;
    await settleRender(page);

    await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
  } finally {
    first.resolve();
  }
});

for (const failure of ["HTTP error", "invalid schema"] as const) {
  test(`first storage ${failure} is unavailable, never zero bytes, while history remains usable`, async ({
    page,
  }) => {
    await page.route("**/api/history", (route) => route.fulfill({ json: history }));
    await page.route("**/api/storage", (route) =>
      route.fulfill(
        failure === "HTTP error"
          ? { status: 500, json: { error: "Failure" } }
          : { json: [{ ...files[0], modifiedAt: null }] },
      ),
    );
    await page.goto("/");

    await expect(page.locator(".storage-total")).toHaveText("Storage unavailable");
    await expect(page.locator(".history-item")).toHaveCount(3);
    await expect(page.locator(".storage-warning")).toContainText("Refresh library to try again");
    await expect(page.locator(".storage-total")).not.toContainText("0 B");
  });
}

test("failed refresh retains a stale snapshot and recovery keeps query/tab/sort selections", async ({
  page,
}) => {
  let failing = false;
  await page.route("**/api/history", (route) => route.fulfill({ json: history }));
  await page.route("**/api/storage", (route) =>
    route.fulfill(failing ? { status: 500, json: { error: "Failure" } } : { json: files }),
  );
  await page.goto("/");
  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("oldest");
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("most-recent");
  await page.getByLabel("Search title or channel").fill("fuzz");

  failing = true;
  await page.getByRole("button", { name: "Refresh library" }).click();

  await expect(page.locator(".storage-warning")).toContainText("Storage is stale");
  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
  await expect(page.locator(".saved-file-item")).toContainText("Fuzz workshop");

  failing = false;
  await page.getByRole("button", { name: "Refresh library" }).click();

  await expect(page.locator(".storage-warning")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue(
    "most-recent",
  );
  await expect(page.getByLabel("Search title or channel")).toHaveValue("fuzz");
  await page.getByRole("button", { name: "Watch history", exact: true }).click();

  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("oldest");
});

test("history failure does not suppress storage or invent an outside-history count", async ({
  page,
}) => {
  await page.route("**/api/history", (route) =>
    route.fulfill({ status: 500, json: { error: "Failure" } }),
  );
  await page.route("**/api/storage", (route) => route.fulfill({ json: files }));
  await page.goto("/");

  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
  await expect(page.getByText(/saved files are outside watch history/)).toHaveCount(0);
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();

  await expect(page.locator(".saved-file-item")).toHaveCount(4);
});

test("file deletion confirms, preserves the query and sorts, updates totals, and focuses the visible Library heading", async ({
  page,
}) => {
  let saved = files;
  const deletes: string[] = [];
  await page.route("**/api/history", (route) => route.fulfill({ json: history }));
  await page.route("**/api/storage", (route) => route.fulfill({ json: saved }));
  await page.route("**/api/history/ddddddddddd/files", (route) => {
    deletes.push(route.request().method());
    saved = saved.filter((file) => file.id !== "ddddddddddd");
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("oldest");
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("most-recent");
  await page.getByLabel("Search title or channel").fill("fuzz");

  const button = page.getByRole("button", {
    name: "Delete downloaded files for Fuzz workshop",
    exact: true,
  });
  const dismissed = page.waitForEvent("dialog");
  const dismissClick = button.click();
  await (await dismissed).dismiss();
  await dismissClick;

  expect(deletes).toEqual([]);
  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");

  const confirmed = page.waitForEvent("dialog");
  const deleteClick = button.click();
  const dialog = await confirmed;
  expect(dialog.message()).toBe('Delete downloaded files for "Fuzz workshop"?');
  await dialog.accept();
  await deleteClick;

  await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 350 B · 3 files");
  await expect(page.locator("#history-title")).toBeFocused();
  await expect(page.getByLabel("Search title or channel")).toHaveValue("fuzz");
  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue(
    "most-recent",
  );
  expect(deletes).toEqual(["DELETE"]);
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "Watch history", exact: true }).click();

  await expect(page.locator(".history-item")).toHaveCount(3);
  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("oldest");
});

test("a storage read begun before deletion is invalidated before the mutation finishes", async ({
  page,
}) => {
  const heldRead = deferred();
  const heldDelete = deferred();
  let calls = 0;
  let deleting = false;
  let saved = files;
  await page.route("**/api/history", (route) => route.fulfill({ json: history }));
  await page.route("**/api/storage", async (route) => {
    if (++calls === 2) {
      await heldRead.promise;
      await route.fulfill({ json: [{ ...files[0], sizeBytes: 9999 }] });
    } else {
      await route.fulfill({ json: saved });
    }
  });
  await page.route("**/api/history/ddddddddddd/files", async (route) => {
    deleting = true;
    await heldDelete.promise;
    saved = saved.filter((file) => file.id !== "ddddddddddd");
    await route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto("/");
    await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
    await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
    await page.getByRole("button", { name: "Refresh library" }).click();
    await expect.poll(() => calls).toBe(2);

    const confirmation = page.waitForEvent("dialog");
    const clicking = page
      .getByRole("button", { name: "Delete downloaded files for Fuzz workshop", exact: true })
      .click();
    await (await confirmation).accept();
    await clicking;
    await expect.poll(() => deleting).toBe(true);

    const delivered = page.waitForResponse(
      async (response) =>
        response.url().endsWith("/api/storage") && (await response.json())[0]?.sizeBytes === 9999,
    );
    heldRead.resolve();
    await delivered;
    await settleRender(page);

    await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 850 B · 4 files");
    await expect(page.locator(".storage-warning")).toContainText("Storage is stale");

    heldDelete.resolve();
    await expect(page.locator(".storage-total")).toHaveText("Saved MP4s: 350 B · 3 files");
    await expect(page.locator(".saved-file-item")).toHaveCount(3);
  } finally {
    heldRead.resolve();
    heldDelete.resolve();
  }
});

test("search, sort, tabs, refresh and search-field shortcuts preserve the native player and current time", async ({
  page,
}) => {
  const id = "libplay0001";
  const mediaDir = join(import.meta.dirname, "../tmp/e2e-data/media", id);
  await mkdir(mediaDir, { recursive: true });
  await copyFile(join(import.meta.dirname, "fixtures/player.mp4"), join(mediaDir, "video.mp4"));
  await library(page);
  await page.route("**/api/resolve", (route) =>
    route.fulfill({
      json: {
        kind: "download",
        id,
        url: `https://youtu.be/${id}`,
        token: "fixture-token",
        title: "Playback fixture",
        channel: null,
        duration: 12,
        positionSeconds: 0,
        stream: `/api/stream/${id}`,
      },
    }),
  );
  await page.goto(`/?url=${encodeURIComponent(`https://youtu.be/${id}`)}&mode=mp4`);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  const player = page.locator("video");
  await player.evaluate((video: HTMLVideoElement) => {
    video.preload = "metadata";
    video.load();
  });
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThan(0);
  await player.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 4;
  });
  await expect
    .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(4, 1);
  const original = await player.elementHandle();
  const query = page.getByLabel("Search title or channel");
  await query.fill("sqlite");
  await query.press("Space");
  await query.press("K");
  await query.press("J");
  await query.press("L");
  await query.press("F");

  await expect(query).toBeFocused();
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("oldest");
  await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("most-recent");
  await page.getByRole("button", { name: "Refresh library" }).click();

  expect(
    await page.evaluate((original) => document.querySelector("video") === original, original),
  ).toBe(true);
  await expect(player).toHaveAttribute("src", `/api/stream/${id}`);
  expect(await player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(4, 1);
  expect(await player.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`saved-file table fits a 390px ${colorScheme} viewport with long metadata and 44px actions`, async ({
    page,
  }) => {
    await library(
      page,
      [],
      [
        {
          ...(files[0] as StorageFile),
          title: "An exceptionally long video title ".repeat(8),
          channel: "LongChannelNameWithoutSpaces".repeat(5),
        },
      ],
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByRole("button", { name: "Saved MP4s", exact: true }).click();
    await expect(page.locator(".saved-file-item")).toHaveCount(1);
    await expect(page.getByText(/1 saved file is outside watch history/)).toBeVisible();
    await page.getByLabel("Search title or channel").fill("long");
    await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();

    const views = await page.getByRole("group", { name: "Library view" }).boundingBox();
    const search = await page.getByLabel("Search title or channel").boundingBox();
    const sort = await page.getByRole("combobox", { name: "Sort", exact: true }).boundingBox();
    expect(search?.y).toBeGreaterThan((views?.y ?? 0) + (views?.height ?? 0));
    expect(sort?.y).toBeGreaterThan((search?.y ?? 0) + (search?.height ?? 0));
    expect(search?.width).toBeCloseTo(sort?.width ?? 0, 0);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page
        .locator(".storage-table")
        .evaluate((table) => table.scrollWidth <= table.clientWidth),
    ).toBe(true);
    const bounds = await page.locator(".saved-file-item button").first().boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("combobox", { name: "Sort", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toBeFocused();
  });
}
