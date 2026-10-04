import { expect, test } from "bun:test";
import { historyView, savedTitle, storageView } from "../app/client/library-view";
import type { HistoryEntry, StorageFile } from "../app/protocol";

function entry(id: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: "Tiny server",
    channel: "Systems",
    duration: 120,
    lastWatchedAt: "2026-10-01T10:00:00.000Z",
    positionSeconds: 0,
    mp4: { sizeBytes: null },
    ...overrides,
  };
}

function file(id: string, overrides: Partial<StorageFile> = {}): StorageFile {
  return {
    id,
    title: "Tiny server",
    channel: "Systems",
    sizeBytes: 10,
    modifiedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

test("history search matches literal title OR channel, ignoring case and surrounding whitespace", () => {
  const rows = [
    entry("aaaaaaaaaaa", { title: "SQLite [WAL]", channel: null }),
    entry("bbbbbbbbbbb", { channel: "Debug Diaries" }),
  ];

  expect(historyView(rows, "  sqlite  ", "recent").map((row) => row.id)).toEqual(["aaaaaaaaaaa"]);
  expect(historyView(rows, "DEBUG", "recent").map((row) => row.id)).toEqual(["bbbbbbbbbbb"]);
  expect(historyView(rows, "[WAL]", "recent").map((row) => row.id)).toEqual(["aaaaaaaaaaa"]);
  expect(historyView(rows, ".*", "recent")).toEqual([]);
  expect(historyView(rows, "Channel unavailable", "recent")).toEqual([]);
  expect(historyView(rows, "sqlite diaries", "recent")).toEqual([]);
});

test("search handles Unicode, empty queries, and matches beyond the first 12 rows", () => {
  const rows = Array.from({ length: 13 }, (_, index) => entry(String(index).padStart(11, "0")));
  rows.push(entry("aaaaaaaaaaa", { title: "ÉTUDES 日本語" }));

  expect(historyView(rows, "日本", "recent").map((row) => row.id)).toEqual(["aaaaaaaaaaa"]);
  expect(historyView(rows, "études", "recent").map((row) => row.id)).toEqual(["aaaaaaaaaaa"]);
  expect(historyView(rows, "   ", "recent")).toHaveLength(14);
  expect(historyView(rows, "etudes", "recent")).toEqual([]);
});

test("Recent first and Oldest first order last playback time regardless of MP4 size/presence", () => {
  const rows = [
    entry("bbbbbbbbbbb", { lastWatchedAt: "2026-10-02T00:00:00.000Z", mp4: { sizeBytes: 500 } }),
    entry("aaaaaaaaaaa", { lastWatchedAt: "2026-10-03T00:00:00.000Z" }),
    entry("ccccccccccc", { lastWatchedAt: "2026-10-01T00:00:00.000Z", mp4: { sizeBytes: 9999 } }),
  ];

  expect(historyView(rows, "", "recent").map((row) => row.id)).toEqual([
    "aaaaaaaaaaa",
    "bbbbbbbbbbb",
    "ccccccccccc",
  ]);
  expect(historyView(rows, "", "oldest").map((row) => row.id)).toEqual([
    "ccccccccccc",
    "bbbbbbbbbbb",
    "aaaaaaaaaaa",
  ]);
  expect(rows.map((row) => row.id)).toEqual(["bbbbbbbbbbb", "aaaaaaaaaaa", "ccccccccccc"]);
});

test.each(["recent", "oldest"] as const)(
  "history %s breaks equal dates by ascending ID without mutating the source",
  (sort) => {
    const rows = [entry("aaaaaaaaaaa"), entry("AAAAAAAAAAA"), entry("00000000000")];

    expect(historyView(rows, "", sort).map((row) => row.id)).toEqual([
      "00000000000",
      "AAAAAAAAAAA",
      "aaaaaaaaaaa",
    ]);
    expect(rows.map((row) => row.id)).toEqual(["aaaaaaaaaaa", "AAAAAAAAAAA", "00000000000"]);
  },
);

test("saved-file search uses known title/channel or the visible ID fallback, not a missing-channel label", () => {
  const retained = file("aaaaaaaaaaa", { title: null, channel: null });
  const files = [
    retained,
    file("bbbbbbbbbbb", { title: "SQLite [WAL]", channel: "Debug Diaries" }),
  ];

  expect(savedTitle(retained)).toBe("Saved video (aaaaaaaaaaa)");
  expect(storageView(files, "  AAAA  ", "largest").map((row) => row.id)).toEqual(["aaaaaaaaaaa"]);
  expect(storageView(files, "debug", "largest").map((row) => row.id)).toEqual(["bbbbbbbbbbb"]);
  expect(storageView(files, "[wal]", "largest").map((row) => row.id)).toEqual(["bbbbbbbbbbb"]);
  expect(storageView(files, "Channel unavailable", "largest")).toEqual([]);
  expect(storageView(files, ".*", "largest")).toEqual([]);
});

test("Largest and Most recent have distinct numeric-size and MP4-modification orders", () => {
  const files = [
    file("bbbbbbbbbbb", { sizeBytes: 200, modifiedAt: "2026-10-02T10:00:00.000Z" }),
    file("aaaaaaaaaaa", { sizeBytes: 300, modifiedAt: "2026-10-01T10:00:00.000Z" }),
    file("ccccccccccc", { sizeBytes: 100, modifiedAt: "2026-10-03T10:00:00.000Z" }),
  ];

  expect(storageView(files, "", "largest").map((row) => row.id)).toEqual([
    "aaaaaaaaaaa",
    "bbbbbbbbbbb",
    "ccccccccccc",
  ]);
  expect(storageView(files, "", "most-recent").map((row) => row.id)).toEqual([
    "ccccccccccc",
    "bbbbbbbbbbb",
    "aaaaaaaaaaa",
  ]);
  expect(files.map((row) => row.id)).toEqual(["bbbbbbbbbbb", "aaaaaaaaaaa", "ccccccccccc"]);
});

test.each(["largest", "most-recent"] as const)(
  "saved files %s break equal values by ascending ID without mutating the source",
  (sort) => {
    const files = [file("aaaaaaaaaaa"), file("AAAAAAAAAAA"), file("00000000000")];

    expect(storageView(files, "", sort).map((row) => row.id)).toEqual([
      "00000000000",
      "AAAAAAAAAAA",
      "aaaaaaaaaaa",
    ]);
    expect(files.map((row) => row.id)).toEqual(["aaaaaaaaaaa", "AAAAAAAAAAA", "00000000000"]);
  },
);

test("filtering returns all matches and empty datasets remain empty under every order", () => {
  const files = Array.from({ length: 14 }, (_, index) => file(String(index).padStart(11, "0")));

  expect(storageView(files, "server", "largest")).toHaveLength(14);
  expect(historyView([], "", "recent")).toEqual([]);
  expect(historyView([], "", "oldest")).toEqual([]);
  expect(storageView([], "", "largest")).toEqual([]);
  expect(storageView([], "", "most-recent")).toEqual([]);
});
