import { expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resetLibrary } from "../app/library";
import { appFixture } from "./support/app";
import { history, prepared, videoUrl, waitForSnapshot, watched } from "./support/http";

function request(base: string, fields: object, headers = {}) {
  return fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ url: videoUrl, mode: "mp4", ...fields }),
  });
}

async function inventory(base: string) {
  const response = await fetch(`${base}/api/storage`);
  expect(response.status).toBe(200);
  return response.json();
}

const metadata = { title: "Quality fixture", duration: 120, channel: "Systems" };

test("different caps publish separate stable files, cache exactly, and survive restart", async () => {
  await using fixture = await appFixture();
  const calls: string[] = [];
  const base = fixture.start({
    download: async (_url, path, options) => {
      const quality = options?.quality ?? "720";
      calls.push(quality);
      await writeFile(path, `bytes-${quality}`);
      return { ...metadata, height: quality === "1080" ? 720 : 360 };
    },
  });
  const low = await prepared(base, await request(base, { quality: "360" }));
  const high = await prepared(base, await request(base, { quality: "1080" }));

  expect(low).toMatchObject({ kind: "download", quality: { requested: "360", height: 360 } });
  expect(high).toMatchObject({ kind: "download", quality: { requested: "1080", height: 720 } });
  if (low.kind !== "download" || high.kind !== "download") {
    throw new Error("Expected MP4s");
  }
  expect(low.stream).toBe("/api/stream/abcdefghijk/360");
  expect(high.stream).toBe("/api/stream/abcdefghijk/1080");
  expect(await (await fetch(`${base}${low.stream}`)).text()).toBe("bytes-360");
  expect(await (await fetch(`${base}${high.stream}`)).text()).toBe("bytes-1080");
  expect(
    await Bun.file(join(fixture.dataDir, "media", low.id, "q-360", "quality.json")).json(),
  ).toEqual({
    version: 1,
    requested: "360",
    height: 360,
  });
  await watched(base, high.id, high.token);
  expect((await history(base))[0]?.mp4).toMatchObject({
    sizeBytes: 19,
    variants: [
      { variant: "360", requested: "360", height: 360, sizeBytes: 9 },
      { variant: "1080", requested: "1080", height: 720, sizeBytes: 10 },
    ],
  });

  const restarted = await fixture.restart();
  const cached = await prepared(restarted, await request(restarted, { quality: "360" }));
  expect(calls).toEqual(["360", "1080"]);
  expect(cached).toMatchObject({ stream: low.stream, quality: { requested: "360", height: 360 } });
  const range = await fetch(`${restarted}${high.stream}`, { headers: { Range: "bytes=0-4" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 0-4/10");
  expect(await range.text()).toBe("bytes");
  const head = await fetch(`${restarted}${low.stream}`, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe("9");
  expect(await head.text()).toBe("");
});

test("omitted quality defaults to 720; best keeps its own slot and reports actual height", async () => {
  await using fixture = await appFixture();
  const calls: string[] = [];
  const base = fixture.start({
    download: async (_url, path, options) => {
      calls.push(options?.quality ?? "missing");
      await writeFile(path, "saved");
      return { ...metadata, height: 1080 };
    },
  });
  const best = await prepared(base, await request(base, { quality: "best" }));
  expect(best).toMatchObject({ quality: { requested: "best", height: 1080 } });
  const response = await request(base, {});
  const { jobToken } = await response.json();
  expect(await waitForSnapshot(base, jobToken, "error")).toMatchObject({
    error: "Downloaded video exceeds the requested quality limit.",
  });
  expect(calls).toEqual(["best", "720"]);
  expect((await inventory(base)).map((file: { variant: string }) => file.variant)).toEqual([
    "best",
  ]);
});

test.each(["1440", "2160", "bogus", "[height<=360]", "../720", 720, null])(
  "invalid quality %j is rejected without downloading",
  async (quality) => {
    await using fixture = await appFixture();
    let calls = 0;
    const base = fixture.start({
      download: async () => {
        calls++;
        return metadata;
      },
    });
    expect((await request(base, { quality })).status).toBe(400);
    expect(calls).toBe(0);
    expect(await inventory(base)).toEqual([]);
  },
);

test("saved selection rejects mode/quality conflicts and never downloads a missing file", async () => {
  await using fixture = await appFixture();
  let calls = 0;
  const base = fixture.start({
    proxy: true,
    download: async () => {
      calls++;
      return metadata;
    },
  });
  expect((await request(base, { savedVariant: "360", quality: "720" })).status).toBe(400);
  expect((await request(base, { savedVariant: "360", mode: "proxy" })).status).toBe(400);
  expect((await request(base, { savedVariant: "../../secret" })).status).toBe(400);
  expect((await request(base, { savedVariant: "360" })).status).toBe(404);
  expect(calls).toBe(0);
});

test("HLS uses the requested cap in the rewritten master and reports retained heights", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true });
  const low = await prepared(base, await request(base, { mode: "proxy", quality: "360" }));
  const high = await prepared(base, await request(base, { mode: "proxy", quality: "1080" }));
  expect(low).toMatchObject({ quality: { requested: "360", availableHeights: [360] } });
  expect(high).toMatchObject({ quality: { requested: "1080", availableHeights: [360, 1080] } });
  if (low.kind !== "proxy" || high.kind !== "proxy") {
    throw new Error("Expected proxies");
  }
  const master = await (await fetch(`${base}${high.hls}`)).text();
  expect(master).toContain("1920x1080");
  expect(master).not.toContain("googlevideo.com");
  expect(master).toContain("DEFAULT=YES");
  expect(await inventory(base)).toEqual([]);
});

test("same-cap requests share a job; a different cap conflicts while cached slots still play", async () => {
  await using fixture = await appFixture();
  const finish = fixture.gate();
  const base = fixture.start({
    download: async (_url, path, options) => {
      if (options?.quality === "1080") {
        await finish.promise;
      }
      await writeFile(path, "saved");
      return { ...metadata, height: 360 };
    },
  });
  await prepared(base, await request(base, { quality: "360" }));
  const first = await request(base, { quality: "1080" });
  const shared = await request(base, { quality: "1080" });
  expect(first.status).toBe(202);
  expect(await shared.json()).toEqual(await first.clone().json());
  const conflict = await request(base, { quality: "480" });
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error).toContain("1080p");
  expect((await request(base, { quality: "360" })).status).toBe(200);
  expect(
    (await fetch(`${base}/api/history/abcdefghijk/files/360`, { method: "DELETE" })).status,
  ).toBe(409);
  finish.release();
  await prepared(base, first);
});

test("corrupt/missing metadata is unknown, visible after DB reset, and explicitly playable only", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  await prepared(base, await request(base, { quality: "360" }));
  const sidecar = join(fixture.dataDir, "media", "abcdefghijk", "q-360", "quality.json");
  await writeFile(sidecar, '{"version":1,"requested":"720","height":720}');
  expect((await inventory(base))[0]).toMatchObject({
    variant: "360",
    requested: null,
    height: null,
  });
  expect((await request(base, { quality: "360" })).status).toBe(409);
  expect((await request(base, { savedVariant: "360" })).status).toBe(200);
  await rm(sidecar);
  await fixture.app.close();
  resetLibrary(fixture.dataDir);
  const restarted = await fixture.restart();
  expect((await inventory(restarted))[0]).toMatchObject({
    title: null,
    variant: "360",
    requested: null,
  });
  expect(await history(restarted)).toEqual([]);
});

test("per-file deletion keeps other qualities, their tokens, and history; guards protect variants", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const low = await prepared(base, await request(base, { quality: "360" }));
  const high = await prepared(base, await request(base, { quality: "720" }));
  await watched(base, low.id, low.token);
  expect(
    (
      await fetch(`${base}/api/stream/abcdefghijk/360`, {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/api/history/abcdefghijk/files/360`, {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect((await fetch(`${base}/api/stream/abcdefghijk/bogus`)).status).toBe(404);
  expect(
    (await fetch(`${base}/api/history/abcdefghijk/files/360`, { method: "DELETE" })).status,
  ).toBe(200);
  expect((await fetch(`${base}/api/stream/abcdefghijk/360`)).status).toBe(404);
  expect((await watched(base, low.id, low.token)).status).toBe(404);
  expect((await watched(base, high.id, high.token)).status).toBe(200);
  expect((await history(base))[0]?.mp4).toMatchObject({
    sizeBytes: 10,
    variants: [{ variant: "720" }],
  });
  expect((await inventory(base)).map((file: { variant: string }) => file.variant)).toEqual(["720"]);
});

test("symlinked quality directories/files cannot be served, replayed, or counted", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const dir = join(fixture.dataDir, "media", "abcdefghijk");
  await mkdir(dir, { recursive: true });
  const outside = join(fixture.dataDir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "video.mp4"), "secret");
  await symlink(outside, join(dir, "q-360"));
  await mkdir(join(dir, "q-480"));
  await symlink(join(outside, "video.mp4"), join(dir, "q-480", "video.mp4"));
  expect(await inventory(base)).toEqual([]);
  expect((await request(base, { savedVariant: "360" })).status).toBe(404);
  expect((await request(base, { savedVariant: "480" })).status).toBe(404);
  expect((await fetch(`${base}/api/stream/abcdefghijk/360`)).status).toBe(404);
  expect((await fetch(`${base}/api/stream/abcdefghijk/480`)).status).toBe(404);
});

test("canceling another cap preserves completed files, metadata and watch progress", async () => {
  await using fixture = await appFixture();
  const started = fixture.gate();
  const base = fixture.start({
    download: async (_url, path, options) => {
      await writeFile(path, options?.quality === "360" ? "completed" : "partial");
      if (options?.quality === "1080") {
        started.release();
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            resolve();
          } else {
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        throw new DOMException("Canceled", "AbortError");
      }
      return { ...metadata, height: 360 };
    },
  });
  const saved = await prepared(base, await request(base, { quality: "360" }));
  await watched(base, saved.id, saved.token);
  await fetch(`${base}/api/history/${saved.id}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: saved.token, positionSeconds: 12 }),
  });
  const before = await history(base);
  const { jobToken } = await (await request(base, { quality: "1080" })).json();
  await started.promise;
  expect((await fetch(`${base}/api/downloads/${jobToken}`, { method: "DELETE" })).status).toBe(202);
  await waitForSnapshot(base, jobToken, "canceled");
  expect(await history(base)).toEqual(before);
  expect((await inventory(base)).map((file: { variant: string }) => file.variant)).toEqual(["360"]);
  expect(await (await fetch(`${base}/api/stream/abcdefghijk/360`)).text()).toBe("completed");
  expect((await request(base, { savedVariant: "1080" })).status).toBe(404);
});

test("dangling quality-slot symlinks are rejected before starting a download", async () => {
  await using fixture = await appFixture();
  let downloads = 0;
  const base = fixture.start({
    download: async (_url, path) => {
      downloads++;
      await writeFile(path, "bytes");
      return metadata;
    },
  });
  const dir = join(fixture.dataDir, "media", "abcdefghijk");
  await mkdir(dir, { recursive: true });
  await symlink(join(fixture.dataDir, "missing"), join(dir, "q-360"));
  const response = await request(base, { quality: "360" });
  const { jobToken } = await response.json();
  await waitForSnapshot(base, jobToken, "error");
  expect(downloads).toBe(0);
  expect(await inventory(base)).toEqual([]);
});

test("a staged symlink is never published as a ready MP4 and cleanup keeps its target", async () => {
  await using fixture = await appFixture();
  const outside = join(fixture.dataDir, "outside.mp4");
  const base = fixture.start({
    download: async (_url, path) => {
      await symlink(outside, path);
      return { ...metadata, height: 360 };
    },
  });
  await writeFile(outside, "secret");
  await expect(prepared(base, await request(base, { quality: "360" }))).rejects.toThrow(
    "nonempty MP4",
  );
  expect(await inventory(base)).toEqual([]);
  expect(await Bun.file(outside).text()).toBe("secret");
  expect((await request(base, { savedVariant: "360" })).status).toBe(404);
});

test.each([
  ["malformed JSON", "{broken"],
  ["unsupported version", '{"version":2,"requested":"360","height":360}'],
  ["height above cap", '{"version":1,"requested":"360","height":480}'],
  ["oversized metadata", `{"version":1,"requested":"360","height":360}${" ".repeat(4096)}`],
] as const)(
  "%s sidecar leaves bytes playable explicitly but cannot verify a cache hit",
  async (_name, text) => {
    await using fixture = await appFixture();
    const base = fixture.start();
    await prepared(base, await request(base, { quality: "360" }));
    await writeFile(join(fixture.dataDir, "media", "abcdefghijk", "q-360", "quality.json"), text);
    expect((await inventory(base))[0]).toMatchObject({
      variant: "360",
      requested: null,
      height: null,
    });
    expect((await request(base, { quality: "360" })).status).toBe(409);
    expect((await request(base, { savedVariant: "360" })).status).toBe(200);
    expect(await (await fetch(`${base}/api/stream/abcdefghijk/360`)).text()).toBe("abcdefghij");
  },
);

test("symlinked quality metadata cannot verify a cache hit even when its fields match", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  await prepared(base, await request(base, { quality: "360" }));
  const sidecar = join(fixture.dataDir, "media", "abcdefghijk", "q-360", "quality.json");
  const outside = join(fixture.dataDir, "outside.json");
  await writeFile(outside, '{"version":1,"requested":"360","height":360}');
  await rm(sidecar);
  await symlink(outside, sidecar);
  expect((await inventory(base))[0]).toMatchObject({ requested: null, height: null });
  expect((await request(base, { quality: "360" })).status).toBe(409);
  expect((await request(base, { savedVariant: "360" })).status).toBe(200);
});
