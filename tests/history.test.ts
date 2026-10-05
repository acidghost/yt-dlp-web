import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { appFixture } from "./support/app";
import {
  history,
  progress,
  proxyResolve,
  requestResolve,
  resolveVideo as resolve,
  videoUrl as url,
  watched,
} from "./support/http";

test("saves playback position for both modes and retains it near the end", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true });
  const proxy = await (await proxyResolve(base)).json();

  expect(proxy.positionSeconds).toBe(0);
  expect((await progress(base, proxy.id, proxy.token, 12)).status).toBe(200);
  expect(await history(base)).toEqual([]);
  expect((await watched(base, proxy.id, proxy.token)).status).toBe(200);
  expect((await progress(base, proxy.id, "wrong-token", 12)).status).toBe(404);
  expect((await progress(base, "aaaaaaaaaaa", proxy.token, 12)).status).toBe(404);
  expect((await progress(base, proxy.id, proxy.token, -1)).status).toBe(400);
  expect((await progress(base, proxy.id, proxy.token, "12")).status).toBe(400);
  expect((await progress(base, proxy.id, proxy.token, 12.8)).status).toBe(200);
  expect((await history(base))[0]?.positionSeconds).toBe(12);
  expect((await watched(base, proxy.id, proxy.token)).status).toBe(200);
  expect((await history(base))[0]?.positionSeconds).toBe(12);

  const restarted = await fixture.restart({ proxy: true });
  const freshProxy = await (await proxyResolve(restarted)).json();

  expect(freshProxy.positionSeconds).toBe(12);

  const mp4 = await resolve(restarted);

  expect(mp4.positionSeconds).toBe(12);
  expect((await progress(restarted, freshProxy.id, freshProxy.token, 29)).status).toBe(200);
  expect((await history(restarted))[0]?.positionSeconds).toBe(29);
});

test("resets progress without a playback token and preserves history and files across restart", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const video = await resolve(base);

  await watched(base, video.id, video.token);
  await progress(base, video.id, video.token, 10);

  const before = (await history(base))[0];
  if (!before) {
    throw new Error("Missing watched history");
  }

  const reset = (id: string, headers = {}) =>
    fetch(`${base}/api/history/${id}/progress`, { method: "DELETE", headers });

  expect((await reset(video.id, { Origin: "https://evil.example" })).status).toBe(403);
  expect((await reset(video.id, { Host: "evil.example" })).status).toBe(403);
  expect((await history(base))[0]?.positionSeconds).toBe(10);
  expect((await reset("short")).status).toBe(404);
  expect((await reset("aaaaaaaaaaa")).status).toBe(404);

  const response = await reset(video.id);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect((await history(base))[0]).toEqual({ ...before, positionSeconds: 0 });
  expect((await reset(video.id)).status).toBe(200);

  const restarted = await fixture.restart();

  expect((await history(restarted))[0]).toEqual({
    ...before,
    positionSeconds: 0,
  });
  expect((await resolve(restarted)).positionSeconds).toBe(0);
});

test("marks history fully watched using trusted duration without a playback token", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({
    download: async (_url, path) => {
      await writeFile(path, "abcdefghij");

      return { title: "Fixture", channel: "Fixture channel", duration: 10.5 };
    },
  });
  const video = await resolve(base);

  await watched(base, video.id, video.token);

  const before = (await history(base))[0];
  if (!before) {
    throw new Error("Missing watched history");
  }
  if (video.duration === null) {
    throw new Error("Missing trusted duration");
  }

  const mark = (id: string, headers = {}) =>
    fetch(`${base}/api/history/${id}/progress`, { method: "PUT", headers });

  expect((await mark(video.id, { Origin: "https://evil.example" })).status).toBe(403);
  expect((await mark(video.id, { Host: "evil.example" })).status).toBe(403);
  expect((await mark(video.id, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await history(base))[0]?.positionSeconds).toBe(0);
  expect((await mark("short")).status).toBe(404);
  expect((await mark("aaaaaaaaaaa")).status).toBe(404);

  const response = await mark(video.id);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect((await mark(video.id)).status).toBe(200);
  expect((await history(base))[0]).toEqual({
    ...before,
    positionSeconds: video.duration,
  });

  const restarted = await fixture.restart();

  expect((await history(restarted))[0]).toEqual({
    ...before,
    positionSeconds: video.duration,
  });
  expect((await resolve(restarted)).positionSeconds).toBe(video.duration);
  expect(
    (
      await fetch(`${restarted}/api/history/${video.id}/progress`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);
  expect((await history(restarted))[0]?.positionSeconds).toBe(0);
});

test("marking watched refuses unknown or unusable durations without changing progress", async () => {
  for (const duration of [null, 0, -1]) {
    await using fixture = await appFixture();
    const base = fixture.start({
      download: async (_url, path) => {
        await writeFile(path, "abcdefghij");

        return { title: "Fixture", channel: null, duration };
      },
    });
    const video = await resolve(base);

    await watched(base, video.id, video.token);

    const response = await fetch(`${base}/api/history/${video.id}/progress`, {
      method: "PUT",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Video duration is unavailable.",
    });
    expect((await history(base))[0]?.positionSeconds).toBe(0);

    await fixture.app.close();
  }
});

test("history is written only for a successfully resolved, playing proxy; survives restart and replays", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true });

  expect(await history(base)).toEqual([]);

  const resolved = await (await proxyResolve(base)).json();

  expect(resolved.id).toBe("abcdefghijk");
  expect(resolved.url).toBe(url);
  expect(await history(base)).toEqual([]);
  expect(
    (
      await watched(base, "abcdefghijk", resolved.token, {
        title: "Forged",
        channel: "Forged channel",
      })
    ).status,
  ).toBe(200);

  const rows = await history(base);

  expect(rows).toHaveLength(1);

  const firstRow = rows[0];
  if (!firstRow) {
    throw new Error("Expected a history row");
  }

  expect(rows[0]).toMatchObject({
    id: "abcdefghijk",
    url,
    title: "Proxy fixture",
    channel: "Proxy channel",
    duration: 30,
    mp4: { sizeBytes: null },
  });
  expect(Number.isNaN(Date.parse(firstRow.lastWatchedAt))).toBe(false);

  const restarted = await fixture.restart({ proxy: true });

  expect(await history(restarted)).toEqual(rows);

  const replay = await requestResolve(restarted, firstRow.url, {}, "proxy");

  expect(replay.status).toBe(200);
  expect((await replay.json()).token).not.toBe(resolved.token);
});

test("download history checks files, validates watch token and ID, and preserves metadata across restart", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const resolved = await resolve(base);
  const mediaDir = join(fixture.dataDir, "media", resolved.id, "q-720");

  expect(await history(base)).toEqual([]);
  expect((await watched(base, "invalid/../", resolved.token)).status).toBe(404);
  expect((await watched(base, "short", resolved.token)).status).toBe(404);
  expect((await watched(base, "abcdefghijk", "invalid")).status).toBe(404);
  expect((await watched(base, "aaaaaaaaaaa", resolved.token)).status).toBe(404);
  expect(
    (
      await watched(base, "abcdefghijk", resolved.token, {
        title: "Forged",
        channel: "Forged channel",
        url: "https://evil.test",
      })
    ).status,
  ).toBe(200);

  const rows = await history(base);

  expect(rows[0]).toMatchObject({
    id: "abcdefghijk",
    url,
    title: "Fixture",
    channel: "Fixture channel",
    duration: 10,
    mp4: { sizeBytes: 10 },
  });

  const restarted = await fixture.restart();

  expect(await history(restarted)).toEqual(rows);

  await writeFile(join(mediaDir, "video.mp4"), "abc");

  expect((await history(restarted))[0]?.mp4.sizeBytes).toBe(3);

  await rm(join(mediaDir, "video.mp4"));

  expect((await history(restarted))[0]).toMatchObject({
    id: "abcdefghijk",
    title: "Fixture",
    mp4: { sizeBytes: null },
  });
  expect((await watched(restarted, "abcdefghijk", resolved.token)).status).toBe(404);
  expect((await resolve(restarted)).kind).toBe("download");
  expect((await history(restarted))[0]?.mp4.sizeBytes).toBe(10);
});

test("repeated plays update a single row, newest first; proxy replay retains downloaded-file badges", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true });
  const first = await resolve(base);

  expect((await watched(base, first.id, first.token)).status).toBe(200);

  const otherUrl = "https://www.youtube.com/watch?v=123456789ab";

  fixture.advanceTime(5);

  const second = await resolve(base, otherUrl);

  expect((await watched(base, second.id, second.token)).status).toBe(200);
  expect((await history(base)).map((row) => row.id)).toEqual([second.id, first.id]);

  fixture.advanceTime(5);

  const proxy = await (await proxyResolve(base)).json();

  expect((await watched(base, first.id, proxy.token)).status).toBe(200);

  const rows = await history(base);

  expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  expect(rows[0]).toMatchObject({
    title: "Proxy fixture",
    mp4: { sizeBytes: 10 },
  });
  expect((await watched(base, first.id, proxy.token, { url: otherUrl })).status).toBe(200);
  expect(await history(base)).toHaveLength(2);
  expect(
    (
      await watched(
        base,
        first.id,
        proxy.token,
        {},
        {
          Origin: "https://evil.example",
        },
      )
    ).status,
  ).toBe(403);
});
