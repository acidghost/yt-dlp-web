import {
  type HistoryEntry,
  type SavedFile,
  SavedVariantSchema,
  type StorageFile,
} from "../protocol";
import { qualityLabel } from "../quality";

export type HistorySort = "recent" | "oldest";
export type FilesSort = "largest" | "most-recent";

export function savedTitle(file: StorageFile): string {
  return file.title ?? `Saved video (${file.id})`;
}

export function savedQualityLabel(
  file: Pick<SavedFile, "variant" | "requested" | "height">,
): string {
  const actual = file.height === null ? "Quality unknown" : `${file.height}p`;
  if (file.requested !== null) {
    return `${actual} (${qualityLabel(file.requested)})`;
  }
  return `${actual} (${file.variant} slot, unverified)`;
}

export function preferredSavedFile(files: SavedFile[]): SavedFile | undefined {
  return (
    files.find((file) => file.variant === "720") ??
    files
      .filter((file) => file.height !== null)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] ??
    files[0]
  );
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
      return (
        order ||
        compareIds(first.id, second.id) ||
        SavedVariantSchema.options.indexOf(first.variant) -
          SavedVariantSchema.options.indexOf(second.variant)
      );
    });
}

function matches(title: string, channel: string | null, query: string): boolean {
  return title.toLowerCase().includes(query) || (channel ?? "").toLowerCase().includes(query);
}

function compareIds(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
