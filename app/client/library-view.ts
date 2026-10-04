import type { HistoryEntry, StorageFile } from "../protocol";

export type HistorySort = "recent" | "oldest";
export type FilesSort = "largest" | "most-recent";

export function savedTitle(file: StorageFile): string {
  return file.title ?? `Saved video (${file.id})`;
}

export function historyView(
  entries: HistoryEntry[],
  query: string,
  sort: HistorySort,
): HistoryEntry[] {
  const needle = query.trim().toLowerCase();
  const direction = sort === "recent" ? -1 : 1;

  return entries
    .filter((entry) => matches(entry.title, entry.channel, needle))
    .sort((first, second) => {
      const dateOrder =
        direction * (Date.parse(first.lastWatchedAt) - Date.parse(second.lastWatchedAt));
      return dateOrder || compareIds(first.id, second.id);
    });
}

export function storageView(files: StorageFile[], query: string, sort: FilesSort): StorageFile[] {
  const needle = query.trim().toLowerCase();

  return files
    .filter((file) => matches(savedTitle(file), file.channel, needle))
    .sort((first, second) => {
      const order =
        sort === "largest"
          ? second.sizeBytes - first.sizeBytes
          : Date.parse(second.modifiedAt) - Date.parse(first.modifiedAt);
      return order || compareIds(first.id, second.id);
    });
}

function matches(title: string, channel: string | null, query: string): boolean {
  return title.toLowerCase().includes(query) || (channel ?? "").toLowerCase().includes(query);
}

function compareIds(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
