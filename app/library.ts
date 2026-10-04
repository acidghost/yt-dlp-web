import { Database, type Statement } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry, VideoId } from "./protocol";

export const validVideoId = (id: string): boolean => /^[a-zA-Z0-9_-]{11}$/.test(id);

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

const createVideos = `CREATE TABLE videos (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        duration REAL,
        last_watched_at TEXT,
        channel TEXT,
        position_seconds REAL NOT NULL DEFAULT 0
      )`;

type SchemaRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

function schemaRows(db: Database): SchemaRow[] {
  return db
    .query<SchemaRow, []>(
      `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
       WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name`,
    )
    .all();
}

// Run only while the server is stopped; media files are deliberately separate.
export function resetLibrary(dataDir: string): void {
  const path = join(dataDir, "library.sqlite");

  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(path + suffix, { force: true });
  }
}

export class Library {
  private db: Database;

  // Assigned by prepareStatements(), called from the constructor.
  private listRows!: Statement<Row, []>;
  private find!: Statement<Metadata, [string]>;
  private rememberRow!: Statement<unknown, [string, string, number | null, string | null]>;
  private watchRow!: Statement<unknown, [string, string, number | null, string | null, string]>;
  private deleteRow!: Statement<unknown, [string]>;
  private findPosition!: Statement<{ position_seconds: number }, [string]>;
  private savePosition!: Statement<unknown, [number, string]>;

  private closed = false;

  constructor(
    private dataDir: string,
    private now: () => number = Date.now,
  ) {
    mkdirSync(dataDir, { recursive: true });

    const path = join(dataDir, "library.sqlite");
    this.db = new Database(path, { create: true });

    try {
      this.checkSchema(path);
      this.prepareStatements();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.db.close();
    this.closed = true;
  }

  private checkSchema(path: string): void {
    const actual = schemaRows(this.db);
    if (actual.length === 0) {
      this.db.run(createVideos);
      return;
    }

    const reference = new Database(":memory:");

    try {
      reference.run(createVideos);
      if (JSON.stringify(actual) !== JSON.stringify(schemaRows(reference))) {
        throw new Error(
          `Unsupported library schema in ${path}. Stop the server and run yt-dlp-web --reset-db with the same DATA_DIR.`,
        );
      }
    } finally {
      reference.close();
    }
  }

  private prepareStatements(): void {
    this.listRows = this.db.query<Row, []>(
      "SELECT id, title, duration, channel, last_watched_at, position_seconds FROM videos " +
        "WHERE last_watched_at IS NOT NULL ORDER BY last_watched_at DESC, id",
    );

    this.find = this.db.query<Metadata, [string]>(
      "SELECT title, duration, channel FROM videos WHERE id = ?1",
    );
    this.rememberRow = this.db.query<unknown, [string, string, number | null, string | null]>(
      `INSERT INTO videos (id, title, duration, channel) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, duration=excluded.duration,
         channel=COALESCE(excluded.channel, videos.channel)`,
    );
    this.watchRow = this.db.query<unknown, [string, string, number | null, string | null, string]>(
      `INSERT INTO videos (id, title, duration, channel, last_watched_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, duration=excluded.duration,
         channel=COALESCE(excluded.channel, videos.channel),
         last_watched_at=excluded.last_watched_at`,
    );

    this.deleteRow = this.db.query<unknown, [string]>("DELETE FROM videos WHERE id = ?1");

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
    if (!validVideoId(id)) {
      throw new Error("Invalid video ID");
    }

    this.watchRow.run(
      id,
      meta.title,
      meta.duration,
      meta.channel,
      new Date(this.now()).toISOString(),
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
  async list(): Promise<HistoryEntry[]> {
    return Promise.all(
      this.listRows.all().map(async (row) => {
        const dir = join(this.dataDir, "media", row.id);
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
