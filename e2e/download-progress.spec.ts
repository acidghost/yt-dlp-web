import { expect, type Page, type Route, test } from "playwright/test";
import type { PreparationSnapshot, TransferProgress } from "../app/protocol";

const url = "https://www.youtube.com/watch?v=abcdefghijk";
const token = "a1111111-1111-4111-8111-111111111111";
const video = {
  kind: "download" as const,
  id: "abcdefghijk",
  url,
  token: "playback-token",
  title: "Fixture",
  channel: null,
  duration: 120,
  positionSeconds: 8,
  stream: "/api/stream/abcdefghijk",
};
function active(
  phase: TransferProgress["phase"] = "video",
): Extract<PreparationSnapshot, { state: "preparing" }> {
  return {
    state: "preparing",
    phase,
    downloadedBytes: 156 * 1024 * 1024,
    totalBytes: 240 * 1024 * 1024,
    totalEstimated: true,
    speedBytesPerSecond: 6.2 * 1024 * 1024,
  };
}
async function prepare(
  page: Page,
  handler: (route: Route) => Promise<void>,
  timestamp = "",
) {
  await page.route("**/api/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/resolve", (route) => {
    expect(route.request().postDataJSON()).toEqual({ url, mode: "mp4" });
    return route.fulfill({
      status: 202,
      json: { kind: "preparing", jobToken: token },
    });
  });
  await page.route("**/api/downloads/*", handler);
  await page.goto(`/?url=${encodeURIComponent(url)}&mode=mp4${timestamp}`);
}

test("player-centered progress labels current transfers and preserves the player through ready", async ({
  page,
}) => {
  let snapshot: PreparationSnapshot = active();
  await prepare(page, (route) => route.fulfill({ json: snapshot }), "&t=3");
  const panel = page.locator(".download-progress");
  const player = await page.locator("video").elementHandle();
  const controller = await page.locator("media-controller").elementHandle();
  await expect(panel).toContainText("156.0 MiB of ≈ 240.0 MiB");
  await expect(panel).toContainText("6.2 MiB/s");
  await expect(panel).toContainText("≈ 65%");
  await expect(page.locator("#status")).not.toContainText("MiB");
  await expect(page.locator("video")).not.toHaveAttribute("src");
  await expect(page.getByLabel("YouTube video URL")).toBeDisabled();
  snapshot = {
    state: "preparing",
    phase: "audio",
    downloadedBytes: 4.8 * 1024 * 1024,
    totalBytes: 12 * 1024 * 1024,
    totalEstimated: false,
    speedBytesPerSecond: 1.6 * 1024 * 1024,
  };
  await expect(panel).toContainText("Downloading audio");
  await expect(panel).toContainText("4.8 MiB of 12.0 MiB");
  await expect(panel).toContainText("40%");
  snapshot = { ...active("merging"), speedBytesPerSecond: null };
  await expect(panel).toContainText("Combining audio and video");
  await expect(panel.locator("progress")).toBeHidden();
  await expect(panel).not.toContainText("MiB/s");
  snapshot = { ...active("processing"), speedBytesPerSecond: null };
  await expect(panel).toContainText("Processing MP4");
  await expect(panel.locator("progress")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Cancel download" }),
  ).toBeEnabled();
  snapshot = { ...active("finalizing"), speedBytesPerSecond: null };
  await expect(panel).toContainText("Saving MP4");
  await expect(
    page.getByRole("button", { name: "Cancel download" }),
  ).toBeHidden();
  snapshot = { state: "ready", video };
  await expect(panel).toHaveCount(0);
  await expect(page.locator("#status")).toContainText("continue at 0:03");
  await expect(page.locator("video")).toHaveAttribute("src", video.stream);
  expect(
    await page.evaluate(
      ([p, c]) =>
        document.querySelector("video") === p &&
        document.querySelector("media-controller") === c,
      [player, controller],
    ),
  ).toBe(true);
  expect(
    await page.locator("video").evaluate((p: HTMLVideoElement) => p.paused),
  ).toBe(true);
});

test("unknown totals are indeterminate and mobile/fullscreen Cancel stays clear of controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const snapshot: PreparationSnapshot = {
    ...active(),
    totalBytes: null,
    totalEstimated: false,
    speedBytesPerSecond: null,
  };
  await prepare(page, (route) =>
    route.fulfill({
      json:
        route.request().method() === "DELETE"
          ? { state: "canceled" }
          : snapshot,
    }),
  );
  const panel = page.locator(".download-progress");
  await expect(panel).toContainText("156.0 MiB downloaded");
  await expect(panel).toContainText("Calculating speed");
  await expect(panel.locator("progress")).not.toHaveAttribute("value");
  await expect(panel).not.toContainText("%");
  await expect(panel).toContainText("every tab");
  const action = page.getByRole("button", { name: "Cancel download" });
  await expect(action).toBeVisible();
  const assertFits = async () => {
    const box = await panel.boundingBox();
    const controls = await page.locator(".player-actions").boundingBox();
    const target = await action.boundingBox();
    expect(box && controls && target).toBeTruthy();
    if (!box || !controls || !target)
      throw new Error("Missing preparation geometry");
    expect(box.y + box.height).toBeLessThanOrEqual(controls.y + 1);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(
      await page.evaluate(() => innerWidth),
    );
  };
  await assertFits();
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.locator("media-fullscreen-button").click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.localName))
      .toBe("media-controller");
    await expect(action).toBeVisible();
    await assertFits();
    await action.click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-phase",
      "canceled",
    );
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement))
      .toBeNull();
    await expect(
      page.getByRole("button", { name: "Prepare video" }),
    ).toBeFocused();
  }
});

test("global cancellation waits for cleanup and restores keyboard focus", async ({
  page,
}) => {
  let snapshot: PreparationSnapshot = active();
  let deletes = 0;
  await prepare(page, async (route) => {
    if (route.request().method() === "DELETE") {
      deletes++;
      snapshot = { state: "canceling" };
      await route.fulfill({ status: 202, json: snapshot });
    } else await route.fulfill({ json: snapshot });
  });
  const action = page.getByRole("button", { name: "Cancel download" });
  await expect(action).toBeEnabled();
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toContainText("Removing partial files");
  const canceling = page.getByRole("button", { name: "Canceling…" });
  await expect(canceling).toBeFocused();
  expect((await canceling.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(
    page.getByRole("button", { name: "Prepare video" }),
  ).toBeDisabled();
  await expect(page.locator("video")).not.toHaveAttribute("src");
  snapshot = { state: "canceled" };
  await expect(page.locator("#status")).toHaveText(
    "Download canceled. Partial files removed.",
  );
  await expect(
    page.getByRole("button", { name: "Prepare video" }),
  ).toBeFocused();
  await expect(page.locator(".download-progress")).toHaveCount(0);
  expect(deletes).toBe(1);
});

test("a stale ready GET cannot attach over global cancellation", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let canceled = false;
  await prepare(page, async (route) => {
    if (route.request().method() === "DELETE") {
      canceled = true;
      await route.fulfill({ json: { state: "canceled" } });
    } else if (++calls === 1) await route.fulfill({ json: active() });
    else {
      await held;
      // The client may abort the obsolete GET as well as ignore its result.
      await route.fulfill({ json: { state: "ready", video } }).catch(() => {});
    }
  });
  await expect.poll(() => calls).toBe(2);
  await page.getByRole("button", { name: "Cancel download" }).click();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-phase",
    "canceled",
  );
  expect(canceled).toBe(true);
  release();
  await page.waitForTimeout(100);
  await expect(page.locator("video")).not.toHaveAttribute("src");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-phase",
    "canceled",
  );
});

test("polling and cancel failures never claim that the download stopped", async ({
  page,
}) => {
  let failing = false;
  await prepare(page, async (route) => {
    if (failing || route.request().method() === "DELETE") await route.abort();
    else await route.fulfill({ json: active() });
  });
  await expect(page.locator(".download-progress")).toContainText("6.2 MiB/s");
  failing = true;
  await expect(page.locator("#status")).toContainText(
    "Progress connection lost",
  );
  await expect(page.locator(".download-progress")).toContainText("Last seen");
  await expect(page.locator(".download-progress")).not.toContainText(
    "6.2 MiB/s",
  );
  await page.getByRole("button", { name: "Cancel download" }).click();
  await expect(page.locator(".download-progress")).toContainText(
    "Could not cancel download",
  );
  await expect(
    page.getByRole("button", { name: "Cancel download" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Prepare video" }),
  ).toBeDisabled();
  failing = false;
  await expect(page.locator(".download-progress")).toContainText("6.2 MiB/s", {
    timeout: 10_000,
  });
  await expect(page.locator("video")).not.toHaveAttribute("src");
});

test("pagehide sends global keepalive cancellation, visibility changes do not", async ({
  page,
}) => {
  let deletes = 0;
  await prepare(page, async (route) => {
    if (route.request().method() === "DELETE") {
      deletes++;
      await route.fulfill({ json: { state: "canceled" } });
    } else await route.fulfill({ json: active() });
  });
  await expect(page.locator(".download-progress")).toContainText("156.0 MiB");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(deletes).toBe(0);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  await expect.poll(() => deletes).toBe(1);
});

test("remote cancellation and safe errors stop polling without attaching a source", async ({
  page,
}) => {
  let snapshot: PreparationSnapshot = active();
  await prepare(page, (route) => route.fulfill({ json: snapshot }));
  await expect(page.locator(".download-progress")).toBeVisible();
  snapshot = {
    state: "error",
    error: "Could not finish download cleanup. Partial files may remain.",
  };
  await expect(page.locator("#status")).toHaveAttribute("data-phase", "error");
  await expect(page.locator("#status")).toContainText("cleanup");
  await expect(page.locator("video")).not.toHaveAttribute("src");
  snapshot = { state: "canceling" };
  await page.getByRole("button", { name: "Prepare video" }).click();
  await expect(page.locator("#status")).toContainText("Canceling download");
  snapshot = { state: "canceled" };
  await expect(page.locator("#status")).toHaveAttribute(
    "data-phase",
    "canceled",
  );
  await expect(page.locator("video")).not.toHaveAttribute("src");
});

test("back/forward-cache restore reconciles pagehide cancellation instead of leaving the form busy", async ({
  page,
}) => {
  let snapshot: PreparationSnapshot = active();
  await prepare(page, async (route) => {
    if (route.request().method() === "DELETE") snapshot = { state: "canceled" };
    await route.fulfill({ json: snapshot });
  });
  await expect(page.locator(".download-progress")).toContainText("156.0 MiB");
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect.poll(() => snapshot.state).toBe("canceled");
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(page.locator("#status")).toHaveAttribute(
    "data-phase",
    "canceled",
  );
  await expect(
    page.getByRole("button", { name: "Prepare video" }),
  ).toBeEnabled();
  await expect(page.locator("video")).not.toHaveAttribute("src");
});

test("a restored page can retry cancellation when the close request was lost", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deletes = 0;
  await prepare(page, async (route) => {
    if (route.request().method() === "DELETE") {
      if (++deletes === 1) await held;
      await route.abort().catch(() => {});
    } else await route.fulfill({ json: active() });
  });
  await page.getByRole("button", { name: "Cancel download" }).click();
  await expect.poll(() => deletes).toBe(1);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect.poll(() => deletes).toBe(2);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(
    page.getByRole("button", { name: "Cancel download" }),
  ).toBeEnabled();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-phase",
    "downloading",
  );
  release();
  await expect(page.locator("video")).not.toHaveAttribute("src");
});
