import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StorageListSchema } from "../app/protocol";
import { appFixture } from "./support/app";
import { history, prepared, progress, proxyResolve, resolveVideo, watched } from "./support/http";

async function storage(base: string) {
  const response = await fetch(`${base}/api/storage`);

  expect(response.status).toBe(200);

  return StorageListSchema.parse(await response.json());
}

const modifiedAt = "2026-09-01T12:00:00.000Z";

async function saveFile(dataDir: string, id: string, bytes: string) {
  const dir = join(dataDir, "media", id, "q-720");
  const path = join(dir, "video.mp4");

  await mkdir(dir, { recursive: true });
  await writeFile(path, bytes);
  await utimes(path, new Date(modifiedAt), new Date(modifiedAt));

  return path;
}

test("storage includes completed unplayed downloads without creating watch history", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const video = await resolveVideo(base);
  const path = join(fixture.dataDir, "media", video.id, "q-720", "video.mp4");

  await utimes(path, new Date(modifiedAt), new Date(modifiedAt));

  const response = await fetch(`${base}/api/storage`);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toEqual([
    {
      variant: "720",
      requested: "720",
      height: null,
      id: video.id,
      title: "Fixture",
      channel: "Fixture channel",
      sizeBytes: 10,
      modifiedAt,
    },
  ]);
  expect(await history(base)).toEqual([]);
});

test("watching and editing progress do not change file dates; files-only deletion retains history", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true });
  const video = await resolveVideo(base);
  const path = join(fixture.dataDir, "media", video.id, "q-720", "video.mp4");

  await utimes(path, new Date(modifiedAt), new Date(modifiedAt));

  const before = await storage(base);

  await watched(base, video.id, video.token);
  await progress(base, video.id, video.token, 4);

  expect(await storage(base)).toEqual(before);

  const proxy = await (await proxyResolve(base)).json();

  await watched(base, proxy.id, proxy.token);

  expect(await storage(base)).toEqual([
    {
      variant: "720",
      requested: "720",
      height: null,
      id: video.id,
      title: "Proxy fixture",
      channel: "Proxy channel",
      sizeBytes: 10,
      modifiedAt,
    },
  ]);
  expect((await fetch(`${base}/api/history/${video.id}/files`, { method: "DELETE" })).status).toBe(
    200,
  );
  expect(await storage(base)).toEqual([]);
  expect((await history(base))[0]).toMatchObject({
    id: video.id,
    positionSeconds: 4,
    mp4: { sizeBytes: null },
  });
});

test("storage returns retained metadata-free files and current sizes/mtimes across restart", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const path = await saveFile(fixture.dataDir, "aaaaaaaaaaa", "saved");
  const first = [
    {
      variant: "720" as const,
      requested: null,
      height: null,
      id: "aaaaaaaaaaa",
      title: null,
      channel: null,
      sizeBytes: 5,
      modifiedAt,
    },
  ];

  expect(await storage(base)).toEqual(first);
  expect(await history(base)).toEqual([]);

  const restarted = await fixture.restart();

  expect(await storage(restarted)).toEqual(first);

  const newer = "2026-09-02T12:00:00.000Z";

  await writeFile(path, "replacement");
  await utimes(path, new Date(newer), new Date(newer));

  expect(await storage(restarted)).toEqual([
    {
      variant: "720" as const,
      requested: null,
      height: null,
      id: "aaaaaaaaaaa",
      title: null,
      channel: null,
      sizeBytes: 11,
      modifiedAt: newer,
    },
  ]);

  await rm(path);

  expect(await storage(restarted)).toEqual([]);
});

test("a metadata-free retained file replays without downloading and deletes without a history record", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({
    download: async () => {
      throw new Error("A retained MP4 must not redownload");
    },
  });
  await saveFile(fixture.dataDir, "aaaaaaaaaaa", "saved");

  const replay = await prepared(
    base,
    await fetch(`${base}/api/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        mode: "mp4",
        savedVariant: "720",
      }),
    }),
  );
  if (replay.kind !== "download") {
    throw new Error("Expected saved MP4 playback");
  }

  expect(replay).toMatchObject({ id: "aaaaaaaaaaa", kind: "download", positionSeconds: 0 });
  expect(await (await fetch(`${base}${replay.stream}`)).text()).toBe("saved");
  expect(await history(base)).toEqual([]);
  expect(await storage(base)).toEqual([
    {
      variant: "720" as const,
      requested: null,
      height: null,
      id: "aaaaaaaaaaa",
      title: null,
      channel: null,
      sizeBytes: 5,
      modifiedAt,
    },
  ]);

  const response = await fetch(`${base}/api/history/aaaaaaaaaaa/files`, { method: "DELETE" });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(await storage(base)).toEqual([]);
  expect(await history(base)).toEqual([]);
});

test("a missing media root or proxy-only history has no stored MP4s", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true });

  expect(await storage(base)).toEqual([]);

  const proxy = await (await proxyResolve(base)).json();

  await watched(base, proxy.id, proxy.token);

  expect(await storage(base)).toEqual([]);
  expect((await history(base))[0]?.mp4.sizeBytes).toBeNull();
});

test("inventory excludes zero bytes, staging, invalid IDs, sidecars, legacy files and symlinks", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const media = join(fixture.dataDir, "media");
  const saved = await saveFile(fixture.dataDir, "aaaaaaaaaaa", "saved");

  await saveFile(fixture.dataDir, "bbbbbbbbbbb", "");
  await saveFile(fixture.dataDir, "short", "invalid");
  await mkdir(join(media, "ccccccccccc", ".staging-fixture"), { recursive: true });
  await writeFile(join(media, "ccccccccccc", ".staging-fixture", "video.mp4"), "partial");
  await writeFile(join(media, "aaaaaaaaaaa", "info.json"), "sidecar");
  await writeFile(join(media, "ddddddddddd"), "not a directory");
  await symlink(join(media, "aaaaaaaaaaa"), join(media, "eeeeeeeeeee"));
  await mkdir(join(media, "fffffffffff", "q-720"), { recursive: true });
  await symlink(saved, join(media, "fffffffffff", "q-720", "video.mp4"));
  await mkdir(join(media, "ggggggggggg", "q-720", "video.mp4"), { recursive: true });
  await mkdir(join(fixture.dataDir, "tmp"));
  await writeFile(join(fixture.dataDir, "tmp", "legacy.mp4"), "legacy");

  expect(await storage(base)).toEqual([
    {
      variant: "720" as const,
      requested: null,
      height: null,
      id: "aaaaaaaaaaa",
      title: null,
      channel: null,
      sizeBytes: 5,
      modifiedAt,
    },
  ]);
});

test("inventory order is deterministic by ID, not size or modification date", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();

  await saveFile(fixture.dataDir, "bbbbbbbbbbb", "large");
  await saveFile(fixture.dataDir, "aaaaaaaaaaa", "a");

  expect(await storage(base)).toEqual([
    {
      variant: "720" as const,
      requested: null,
      height: null,
      id: "aaaaaaaaaaa",
      title: null,
      channel: null,
      sizeBytes: 1,
      modifiedAt,
    },
    {
      variant: "720" as const,
      requested: null,
      height: null,
      id: "bbbbbbbbbbb",
      title: null,
      channel: null,
      sizeBytes: 5,
      modifiedAt,
    },
  ]);
});

test("an ENOENT scan race omits the disappeared file without failing the inventory", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();

  await saveFile(fixture.dataDir, "aaaaaaaaaaa", "saved");

  const stat = spyOn(fs, "lstat").mockRejectedValueOnce(
    Object.assign(new Error("Disappeared"), { code: "ENOENT" }),
  );

  try {
    expect(await storage(base)).toEqual([]);
  } finally {
    stat.mockRestore();
  }

  expect(await storage(base)).toEqual([
    {
      variant: "720" as const,
      requested: null,
      height: null,
      id: "aaaaaaaaaaa",
      title: null,
      channel: null,
      sizeBytes: 5,
      modifiedAt,
    },
  ]);
});

test("non-ENOENT stat failures return an error instead of an understated total or filesystem paths", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();

  await saveFile(fixture.dataDir, "aaaaaaaaaaa", "saved");

  const stat = spyOn(fs, "lstat").mockRejectedValueOnce(
    Object.assign(new Error(`Read failed: ${fixture.dataDir}`), { code: "EIO" }),
  );

  try {
    const response = await fetch(`${base}/api/storage`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not load storage." });
  } finally {
    stat.mockRestore();
  }
});

test("non-ENOENT root read failures do not return an empty inventory", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();

  await writeFile(join(fixture.dataDir, "media"), "not a directory");

  const response = await fetch(`${base}/api/storage`);

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Could not load storage." });
});

test("storage rejects hostile Host and Origin with the existing read guards", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();

  expect((await fetch(`${base}/api/storage`, { headers: { Host: "evil.example" } })).status).toBe(
    403,
  );
  expect(
    (await fetch(`${base}/api/storage`, { headers: { Origin: "https://evil.example" } })).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/api/storage`, {
        headers: {
          Host: `localhost:${fixture.app.server.port}`,
          Origin: `http://localhost:${fixture.app.server.port}`,
        },
      })
    ).status,
  ).toBe(200);
});

test("storage accepts only the configured PUBLIC_ORIGIN host/origin without CORS", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ publicOrigin: "https://player.example.com" });
  const response = await fetch(`${base}/api/storage`, {
    headers: { Host: "player.example.com", Origin: "https://player.example.com" },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toEqual([]);
  expect((await fetch(`${base}/api/storage`)).status).toBe(403);
  expect(
    (await fetch(`${base}/api/storage`, { headers: { Host: "player.example.com", Origin: base } }))
      .status,
  ).toBe(403);
});
