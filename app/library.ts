import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry, VideoId } from "./protocol";

export const validVideoId = (id: string): boolean =>
  /^[a-zA-Z0-9_-]{11}$/.test(id);

type Row = {
  id: string;
  title: string;
  duration: number | null;
  channel: string | null;
  last_watched_at: string;
  position_seconds: number;
};

// Server-validated video metadata, shared by remember/watch upserts.
type Metadata = {
  title: string;
  duration: number | null;
  channel: string | null;
};

export class Library {
  private db: Database;
  // Assigned by prepareStatements(), called from the constructor.
  private listRows!: Statement<Row, []>;
  private find!: Statement<Metadata, [string]>;
  private rememberRow!: Statement<
    unknown,
    [string, string, number | null, string | null]
  >;
  private watchRow!: Statement<
    unknown,
    [string, string, number | null, string | null, string]
  >;
  private deleteRow!: Statement<unknown, [string]>;
  private findPosition!: Statement<{ position_seconds: number }, [string]>;
  private savePosition!: Statement<unknown, [number, string]>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "library.sqlite"), { create: true });
    this.migrate();
    this.prepareStatements();
  }

  // One row per canonical video ID; migrations never touch media files.
  private migrate(): void {
    const { user_version: version } = this.db
      .query("PRAGMA user_version")
      .get() as { user_version: number };

    if (version === 0) {
      this.db.run(`CREATE TABLE videos (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        duration REAL,
        last_watched_at TEXT,
        channel TEXT,
        position_seconds REAL NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 4;`);
      return;
    }

    // v1 stored PoC UUIDs in media_token. Drop the column; never import or
    // delete those tmp/ files.
    if (version === 1) {
      this.db.transaction(() => {
        this.db.run(`CREATE TABLE videos_new (
          id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, duration REAL,
          last_watched_at TEXT, channel TEXT,
          position_seconds REAL NOT NULL DEFAULT 0
        );
        INSERT INTO videos_new (id, title, duration, last_watched_at)
          SELECT id, title, duration, last_watched_at FROM videos;
        DROP TABLE videos;
        ALTER TABLE videos_new RENAME TO videos;
        PRAGMA user_version = 4;`);
      })();
      return;
    }

    if (version === 2) {
      this.db.transaction(() => {
        this.db.run(
          "ALTER TABLE videos ADD COLUMN channel TEXT; ALTER TABLE videos ADD COLUMN position_seconds REAL NOT NULL DEFAULT 0; PRAGMA user_version = 4;",
        );
      })();
      return;
    }

    if (version === 3) {
      this.db.run(
        "ALTER TABLE videos ADD COLUMN position_seconds REAL NOT NULL DEFAULT 0; PRAGMA user_version = 4;",
      );
      return;
    }

    if (version !== 4)
      throw new Error(`Unsupported library schema version: ${version}`);
  }

  private prepareStatements(): void {
    this.listRows = this.db.query<Row, []>(
      "SELECT id, title, duration, channel, last_watched_at, position_seconds FROM videos " +
        "WHERE last_watched_at IS NOT NULL ORDER BY last_watched_at DESC, id",
    );
    this.find = this.db.query<Metadata, [string]>(
      "SELECT title, duration, channel FROM videos WHERE id = ?1",
    );
    this.rememberRow = this.db.query<
      unknown,
      [string, string, number | null, string | null]
    >(
      `INSERT INTO videos (id, title, duration, channel) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, duration=excluded.duration,
         channel=COALESCE(excluded.channel, videos.channel)`,
    );
    this.watchRow = this.db.query<
      unknown,
      [string, string, number | null, string | null, string]
    >(
      `INSERT INTO videos (id, title, duration, channel, last_watched_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, duration=excluded.duration,
         channel=COALESCE(excluded.channel, videos.channel),
         last_watched_at=excluded.last_watched_at`,
    );
    this.deleteRow = this.db.query<unknown, [string]>(
      "DELETE FROM videos WHERE id = ?1",
    );
    this.findPosition = this.db.query<{ position_seconds: number }, [string]>(
      "SELECT position_seconds FROM videos WHERE id = ?1",
    );
    this.savePosition = this.db.query<unknown, [number, string]>(
      "UPDATE videos SET position_seconds = ?1 WHERE id = ?2 AND last_watched_at IS NOT NULL",
    );
  }

  metadata(id: VideoId): Metadata | null {
    return this.find.get(id);
  }

  remember(id: VideoId, meta: Metadata): void {
    this.rememberRow.run(id, meta.title, meta.duration, meta.channel);
  }

  watch(id: VideoId, meta: Metadata): void {
    if (!validVideoId(id)) throw new Error("Invalid video ID");
    this.watchRow.run(
      id,
      meta.title,
      meta.duration,
      meta.channel,
      new Date().toISOString(),
    );
  }

  delete(id: VideoId): void {
    this.deleteRow.run(id);
  }

  position(id: VideoId): number {
    return this.findPosition.get(id)?.position_seconds ?? 0;
  }

  progress(id: VideoId, positionSeconds: number): void {
    this.savePosition.run(positionSeconds, id);
  }

  // MP4 size comes from the published file, never from a DB flag.
  async list(dataDir: string): Promise<HistoryEntry[]> {
    return Promise.all(
      this.listRows.all().map(async (row) => {
        const dir = join(dataDir, "media", row.id);
        const mp4 = Bun.file(join(dir, "video.mp4"));
        const mp4Bytes = (await mp4.exists()) && mp4.size > 0 ? mp4.size : null;

        return {
          id: row.id,
          url: `https://www.youtube.com/watch?v=${row.id}`,
          title: row.title,
          channel: row.channel,
          duration: row.duration,
          lastWatchedAt: row.last_watched_at,
          positionSeconds: row.position_seconds,
          mp4: { sizeBytes: mp4Bytes },
        } satisfies HistoryEntry;
      }),
    );
  }
}
