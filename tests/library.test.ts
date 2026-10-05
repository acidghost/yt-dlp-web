import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library, resetLibrary } from "../app/library";

const id = "abcdefghijk";

const meta = { title: "Fixture", channel: "Channel", duration: 10 };

test("library owns its directory and clock, closes idempotently, and persists across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "library-"));
  let library: Library | undefined;

  try {
    library = new Library(dir, () => Date.parse("2030-01-01T00:00:00Z"));
    library.remember(id, meta);
    library.watch(id, meta);
    library.progress(id, 4);

    const media = join(dir, "media", id, "q-720");

    await mkdir(media, { recursive: true });
    await writeFile(join(media, "video.mp4"), "fixture");

    const rows = await library.list();

    expect(rows[0]).toMatchObject({
      title: "Fixture",
      positionSeconds: 4,
      lastWatchedAt: "2030-01-01T00:00:00.000Z",
      mp4: { sizeBytes: 7 },
    });

    library.close();
    library.close();

    expect(() => library?.metadata(id)).toThrow();

    library = new Library(dir);

    expect(await library.list()).toEqual(rows);
  } finally {
    library?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const schema of [
  "id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, duration REAL, last_watched_at TEXT NOT NULL, media_token TEXT",
  "id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, duration REAL, last_watched_at TEXT, channel TEXT, position_seconds REAL NOT NULL DEFAULT 0 CHECK(position_seconds >= 0)",
]) {
  test(`rejects unsupported schema without touching legacy/media files: ${schema}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "library-schema-"));

    try {
      const db = new Database(join(dir, "library.sqlite"), { create: true });

      db.run(`CREATE TABLE videos (${schema}); PRAGMA user_version = 4;`);
      db.close();

      const legacy = join(dir, "tmp", `${crypto.randomUUID()}.mp4`);

      await mkdir(join(dir, "tmp"));
      await writeFile(legacy, "keep");

      expect(() => new Library(dir)).toThrow(/Unsupported library schema.*reset/i);
      expect(await Bun.file(legacy).text()).toBe("keep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("opens the current schema regardless of user_version without resetting history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "library-current-"));
  let library: Library | undefined;

  try {
    const db = new Database(join(dir, "library.sqlite"), { create: true });

    db.run(`CREATE TABLE videos (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        duration REAL,
        last_watched_at TEXT,
        channel TEXT,
        position_seconds REAL NOT NULL DEFAULT 0
      ); PRAGMA user_version = 4;`);
    db.query("INSERT INTO videos (id, title, last_watched_at) VALUES (?, ?, ?)").run(
      id,
      "Existing history",
      "2026-01-01T00:00:00.000Z",
    );
    db.close();
    library = new Library(dir);

    expect((await library.list())[0]).toMatchObject({
      title: "Existing history",
      positionSeconds: 0,
    });
  } finally {
    library?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reset removes only database sidecars; media and legacy files survive a fresh library", async () => {
  const dir = await mkdtemp(join(tmpdir(), "library-reset-"));
  let library: Library | undefined;

  try {
    library = new Library(dir);
    library.watch(id, meta);
    library.close();

    const media = join(dir, "media", id, "q-720");

    await mkdir(media, { recursive: true });
    await mkdir(join(dir, "tmp"));
    await writeFile(join(media, "video.mp4"), "saved");
    await utimes(
      join(media, "video.mp4"),
      new Date("2026-09-01T12:00:00Z"),
      new Date("2026-09-01T12:00:00Z"),
    );
    await writeFile(join(dir, "tmp", "legacy.mp4"), "legacy");

    for (const suffix of ["-wal", "-shm", "-journal"]) {
      await writeFile(join(dir, `library.sqlite${suffix}`), "sidecar");
    }

    resetLibrary(dir);

    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      expect(await Bun.file(join(dir, `library.sqlite${suffix}`)).exists()).toBe(false);
    }

    expect(await Bun.file(join(media, "video.mp4")).text()).toBe("saved");
    expect(await Bun.file(join(dir, "tmp", "legacy.mp4")).text()).toBe("legacy");

    library = new Library(dir);

    expect(await library.list()).toEqual([]);
    expect(await library.storage()).toEqual([
      {
        variant: "720",
        requested: null,
        height: null,
        id,
        title: null,
        channel: null,
        sizeBytes: 5,
        modifiedAt: "2026-09-01T12:00:00.000Z",
      },
    ]);
    expect(await library.list()).toEqual([]);
  } finally {
    library?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("simultaneous libraries keep directories, clocks, and disposal independent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "library-isolation-"));
  const first = new Library(join(dir, "first"), () => 1000);
  const second = new Library(join(dir, "second"), () => 2000);

  try {
    first.watch(id, meta);
    second.watch(id, { ...meta, title: "Other instance" });

    expect((await first.list())[0]).toMatchObject({
      title: "Fixture",
      lastWatchedAt: new Date(1000).toISOString(),
    });
    expect((await second.list())[0]).toMatchObject({
      title: "Other instance",
      lastWatchedAt: new Date(2000).toISOString(),
    });

    first.close();
    second.progress(id, 5);

    expect(second.position(id)).toBe(5);
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});
