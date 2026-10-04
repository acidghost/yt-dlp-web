// Browser integration: controlled backend replies isolate DOM/media regressions.
// Full real-API journeys live in journeys.spec.ts.
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "playwright/test";
import type { HistoryEntry } from "../app/protocol";
import { deferred } from "../tests/support/async";

const url = "https://www.youtube.com/watch?v=abcdefghijk";
const entry = {
  id: "abcdefghijk",
  url,
  title: "Fixture video",
  channel: "Fixture channel",
  duration: 120,
  lastWatchedAt: "2026-09-27T10:00:00.000Z",
  positionSeconds: 90,
  mp4: { sizeBytes: 10 },
};
const video = {
  ...entry,
  kind: "download",
  token: "session-token",
  stream: `/api/stream/${entry.id}`,
};

test("history derives watched status and resets it without preparing or deleting files", async ({
  page,
}) => {
  let rows = [
    entry,
    { ...entry, id: "aaaaaaaaaaa", title: "Unfinished", positionSeconds: 89 },
    {
      ...entry,
      id: "bbbbbbbbbbb",
      title: "Unstarted",
      duration: 10,
      positionSeconds: 0,
    },
    {
      ...entry,
      id: "ccccccccccc",
      title: "Unknown duration",
      duration: null,
      positionSeconds: 0,
    },
  ];
  await page.route("**/api/history", (route) => route.fulfill({ json: rows }));
  await page.route("**/api/history/*/progress", (route) => {
    const method = route.request().method();
    expect(["DELETE", "PUT"]).toContain(method);
    expect(route.request().postData()).toBeNull();
    rows = rows.map((row) =>
      row.id === entry.id
        ? {
            ...row,
            positionSeconds: method === "PUT" ? (row.duration ?? 0) : 0,
          }
        : row,
    );
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const watched = page.locator(`.history-item[data-id="${entry.id}"]`);
  await expect(watched).toContainText("Fully watched");
  await expect(watched).not.toContainText("Continue at");
  await expect(page.locator(".history-watched")).toHaveCount(1);
  await expect(
    page.locator('.history-item[data-id="aaaaaaaaaaa"]'),
  ).toContainText("Continue at 1:29");
  await expect(
    page.getByRole("button", {
      name: "Reset watch progress for Unstarted",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Mark Unstarted as fully watched",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "Mark Unknown duration as fully watched",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Reset watch progress for Fixture video",
      exact: true,
    })
    .click();
  await expect(watched).not.toContainText("Fully watched");
  await expect(watched).not.toContainText("Continue at");
  await expect(watched).toContainText("MP4");
  await expect(
    page.getByRole("button", {
      name: "Reset watch progress for Fixture video",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Play Fixture video", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect(page.locator(".history-watched")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Mark Fixture video as fully watched",
      exact: true,
    })
    .click();
  await expect(watched).toContainText("Fully watched");
  await expect(watched).toContainText("MP4");
  await expect(
    page.getByRole("button", {
      name: "Mark Fixture video as fully watched",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Reset watch progress for Fixture video",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Play Fixture video", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect(page.locator(".history-watched")).toHaveCount(1);
});

for (const action of ["reset", "mark"] as const) {
  test(`a failed ${action} leaves progress unchanged and offers a retry`, async ({
    page,
  }) => {
    await page.route("**/api/history", (route) =>
      route.fulfill({
        json: [{ ...entry, positionSeconds: action === "reset" ? 90 : 0 }],
      }),
    );
    await page.route("**/api/history/*/progress", (route) =>
      route.fulfill({ status: 500, json: { error: "Failure" } }),
    );
    await page.goto("/");
    const button = page.getByRole("button", {
      name:
        action === "reset"
          ? "Reset watch progress for Fixture video"
          : "Mark Fixture video as fully watched",
      exact: true,
    });
    await button.click();
    await expect(page.getByRole("alert")).toHaveText(
      action === "reset"
        ? "Could not reset watch progress. Try again."
        : "Could not mark video as watched. Try again.",
    );
    await expect(page.locator(".history-watched")).toHaveCount(
      action === "reset" ? 1 : 0,
    );
    await expect(button).toBeEnabled();
  });
}

async function serveMedia(page: Page): Promise<void> {
  // Use the real MP4 endpoint: route.fulfill(path) ignores Range requests,
  // which lets Chromium read metadata but prevents reliable native seeking.
  const mediaDir = join(import.meta.dirname, "../tmp/e2e-data/media", entry.id);
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

for (const mode of ["mp4", "proxy"] as const) {
  test(`${mode} watched videos restart but explicit timestamps still win`, async ({
    page,
  }) => {
    await serveMedia(page);
    if (mode === "mp4") {
      const range = await page.request.get(video.stream, {
        headers: { Range: "bytes=0-15" },
      });
      expect(range.status()).toBe(206);
      expect((await range.body()).length).toBe(16);
    }
    await page.route("**/api/history", (route) =>
      route.fulfill({ json: [entry] }),
    );
    await page.route("**/api/resolve", (route) =>
      route.fulfill({
        json: {
          ...video,
          ...(mode === "proxy"
            ? { kind: "proxy", hls: "/fixture-media/player.m3u8" }
            : {}),
        },
      }),
    );
    for (const [timestamp, expected] of [
      ["", 0],
      ["&t=3", 3],
    ] as const) {
      await page.goto(
        `/?url=${encodeURIComponent(url)}&mode=${mode}${timestamp}`,
      );
      await expect(page.locator("#status")).toHaveAttribute(
        "data-phase",
        "ready",
      );
      const player = page.locator("video");
      await player.evaluate((el: HTMLVideoElement) => {
        if (
          el.readyState === 0 &&
          el.getAttribute("src")?.startsWith("/api/stream/")
        ) {
          el.preload = "metadata";
          el.load();
        }
      });
      await expect
        .poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState))
        .toBeGreaterThan(0);
      await expect
        .poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime))
        .toBeCloseTo(expected, 1);
      expect(await player.evaluate((el: HTMLVideoElement) => el.paused)).toBe(
        true,
      );
    }
  });
}

test("live progress marks completion, retains the ended position, and reset waits for in-flight saves", async ({
  page,
}) => {
  await serveMedia(page);
  let positionSeconds = 0;
  let saveHeld = false;
  const { promise: heldSave, resolve: releaseSave } = deferred();
  const writes: string[] = [];
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: [{ ...entry, positionSeconds }] }),
  );
  await page.route("**/api/resolve", (route) =>
    route.fulfill({ json: { ...video, positionSeconds: 0 } }),
  );
  await page.route("**/api/history/*/watched", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/history/*/progress", async (route) => {
    const method = route.request().method();
    if (method === "DELETE") {
      positionSeconds = 0;
      writes.push("reset");
    } else if (method === "PUT") {
      positionSeconds = entry.duration;
      writes.push("mark");
    } else {
      const seconds = route.request().postDataJSON().positionSeconds;
      if (seconds === 120) {
        saveHeld = true;
        await heldSave;
      }
      positionSeconds = seconds;
      writes.push(`save:${seconds}`);
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4&t=89`);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  const player = page.locator("video");
  const original = await player.elementHandle();
  await player.evaluate((el: HTMLVideoElement) => {
    Object.defineProperty(el, "duration", { configurable: true, value: 120 });
    let position = 0;
    Object.defineProperty(el, "currentTime", {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    });
    el.dispatchEvent(new Event("loadedmetadata"));
    el.dispatchEvent(new Event("playing"));
  });
  await expect(page.locator(".history-item")).toContainText("Continue at 1:29");
  await player.evaluate((el: HTMLVideoElement) => {
    el.currentTime = 90;
    el.dispatchEvent(new Event("pause"));
  });
  await expect(page.locator(".history-watched")).toHaveText("✓ Fully watched");
  await player.evaluate((el: HTMLVideoElement) => {
    el.currentTime = 120;
    el.dispatchEvent(new Event("ended"));
  });
  await expect.poll(() => saveHeld).toBe(true);
  const reset = page.getByRole("button", {
    name: "Reset watch progress for Fixture video",
    exact: true,
  });
  await reset.click();
  await expect(reset).toBeDisabled();
  expect(writes).not.toContain("reset");
  releaseSave();
  await expect(page.locator("#status")).toContainText("Watch progress reset");
  await expect(reset).toHaveCount(0);
  expect(writes.slice(-2)).toEqual(["save:120", "reset"]);
  expect(positionSeconds).toBe(0);
  await expect(page.locator(".history-watched")).toHaveCount(0);
  expect(await player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBe(
    0,
  );
  expect(new URL(page.url()).searchParams.has("t")).toBe(false);
  expect(
    await page.evaluate(
      (el) => document.querySelector("video") === el,
      original,
    ),
  ).toBe(true);
  await player.evaluate((el: HTMLVideoElement) =>
    el.dispatchEvent(new Event("pause")),
  );
  expect(positionSeconds).toBe(0);
  await page
    .getByRole("button", {
      name: "Mark Fixture video as fully watched",
      exact: true,
    })
    .click();
  await expect(page.locator("#status")).toContainText(
    "Marked as fully watched",
  );
  await expect(page.locator(".history-watched")).toHaveCount(1);
  expect(positionSeconds).toBe(entry.duration);
  expect(writes.at(-1)).toBe("mark");
  expect(await player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBe(
    0,
  );
});

test("marking watched survives a late watch-recording response", async ({
  page,
}) => {
  let positionSeconds = 0;
  let watchPending = false;
  let progressWrites = 0;
  const { promise: heldWatch, resolve: releaseWatch } = deferred();
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: [{ ...entry, positionSeconds }] }),
  );
  await page.route("**/api/resolve", (route) =>
    route.fulfill({ json: { ...video, positionSeconds: 0 } }),
  );
  await page.route("**/api/history/*/watched", async (route) => {
    watchPending = true;
    await heldWatch;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/history/*/progress", (route) => {
    if (route.request().method() === "PUT") positionSeconds = entry.duration;
    else {
      progressWrites++;
      positionSeconds = route.request().postDataJSON().positionSeconds;
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4`);
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "ready");
  const player = page.locator("video");
  await player.evaluate((el) => el.dispatchEvent(new Event("playing")));
  await expect.poll(() => watchPending).toBe(true);
  await page
    .getByRole("button", {
      name: "Mark Fixture video as fully watched",
      exact: true,
    })
    .click();
  await expect(page.locator(".history-watched")).toHaveCount(1);
  const response = page.waitForResponse("**/api/history/*/watched");
  releaseWatch();
  await response;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await player.evaluate((el) => el.dispatchEvent(new Event("pause")));
  await expect(page.locator(".history-watched")).toHaveCount(1);
  expect(positionSeconds).toBe(entry.duration);
  expect(progressWrites).toBe(0);
});

for (const filesOnly of [true, false]) {
  test(`${filesOnly ? "files-only" : "files-and-history"} deletion uses the correct endpoint and distinct history outcome`, async ({
    page,
  }) => {
    let rows: HistoryEntry[] = [entry];
    const deletes: string[] = [];
    await page.route("**/api/history", (route) =>
      route.fulfill({ json: rows }),
    );
    await page.route("**/api/history/**", (route) => {
      expect(route.request().method()).toBe("DELETE");
      deletes.push(new URL(route.request().url()).pathname);
      rows = filesOnly ? [{ ...entry, mp4: { sizeBytes: null } }] : [];
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto("/");
    const label = filesOnly
      ? "Delete downloaded files for Fixture video"
      : "Delete files and history for Fixture video";
    const confirmation = page.waitForEvent("dialog");
    const clicking = page
      .getByRole("button", { name: label, exact: true })
      .click();
    const dialog = await confirmation;
    expect(dialog.message()).toBe(
      `${filesOnly ? "Delete downloaded files" : "Delete files and history"} for "Fixture video"?`,
    );
    await dialog.accept();
    await clicking;
    await expect(page.locator("#status")).toHaveText(
      filesOnly ? "Downloaded files deleted." : "Files and history deleted.",
    );
    expect(deletes).toEqual([
      `/api/history/${entry.id}${filesOnly ? "/files" : ""}`,
    ]);
    if (filesOnly) {
      await expect(page.locator(".history-item")).toContainText(
        "Fixture video",
      );
      await expect(page.locator(".history-item")).toContainText("No files");
      await expect(
        page.getByRole("button", { name: label, exact: true }),
      ).toHaveCount(0);
    } else await expect(page.locator(".history-item")).toHaveCount(0);
  });
}

test("dismissing deletion confirmation preserves files/history and sends no mutation", async ({
  page,
}) => {
  const deletes: string[] = [];
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: [entry] }),
  );
  await page.route("**/api/history/**", (route) => {
    deletes.push(route.request().url());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const confirmation = page.waitForEvent("dialog");
  const clicking = page
    .getByRole("button", {
      name: "Delete files and history for Fixture video",
      exact: true,
    })
    .click();
  await (await confirmation).dismiss();
  await clicking;
  expect(deletes).toEqual([]);
  await expect(page.locator(".history-item")).toContainText("Fixture video");
  await expect(page.locator(".history-item")).toContainText("MP4");
});

test("a deletion API failure preserves the history row and never claims success", async ({
  page,
}) => {
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: [entry] }),
  );
  await page.route("**/api/history/**", (route) =>
    route.fulfill({ status: 500, json: { error: "Deletion failed." } }),
  );
  await page.goto("/");
  const confirmation = page.waitForEvent("dialog");
  const clicking = page
    .getByRole("button", {
      name: "Delete downloaded files for Fixture video",
      exact: true,
    })
    .click();
  await (await confirmation).accept();
  await clicking;
  await expect(page.locator("#status")).toHaveText("Deletion failed.");
  await expect(page.locator(".history-item")).toContainText("Fixture video");
  await expect(page.locator(".history-item")).toContainText("MP4");
});
