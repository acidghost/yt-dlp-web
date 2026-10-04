import * as z from "zod";

export type VideoId = string;

export const ResolveRequestSchema = z.object({
  url: z.string(),
  mode: z.enum(["proxy", "mp4"]).optional(),
});
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

export const WatchRequestSchema = z.object({ token: z.string() });
export type WatchRequest = z.infer<typeof WatchRequestSchema>;

export const ProgressRequestSchema = z.object({
  token: z.string(),
  positionSeconds: z.number().finite().min(0).max(604800),
});
export type ProgressRequest = z.infer<typeof ProgressRequestSchema>;

export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

const VideoFields = z.object({
  id: z.string(),
  url: z.string(),
  token: z.string(),
  title: z.string(),
  channel: z.string().nullable(),
  duration: z.number().nullable(),
  positionSeconds: z.number(),
});

export const ResolvedVideoSchema = z.discriminatedUnion("kind", [
  VideoFields.extend({ kind: z.literal("proxy"), hls: z.string() }),
  VideoFields.extend({
    kind: z.literal("download"),
    stream: z.string(),
  }),
]);
export type ResolvedVideo = z.infer<typeof ResolvedVideoSchema>;

export const TransferProgressSchema = z.object({
  phase: z.enum(["checking", "video", "audio", "mp4", "merging", "processing", "finalizing"]),
  downloadedBytes: z.number().finite().nonnegative().nullable(),
  totalBytes: z.number().finite().positive().nullable(),
  totalEstimated: z.boolean(),
  speedBytesPerSecond: z.number().finite().nonnegative().nullable(),
});
export type TransferProgress = z.infer<typeof TransferProgressSchema>;

export const PreparingVideoSchema = z.object({
  kind: z.literal("preparing"),
  jobToken: z.uuid(),
});

export const ResolveResponseSchema = z.union([ResolvedVideoSchema, PreparingVideoSchema]);

export const PreparationSnapshotSchema = z.discriminatedUnion("state", [
  TransferProgressSchema.extend({ state: z.literal("preparing") }),
  z.object({ state: z.literal("canceling") }),
  z.object({ state: z.literal("canceled") }),
  z.object({ state: z.literal("error"), error: z.string() }),
  z.object({ state: z.literal("ready"), video: ResolvedVideoSchema }),
]);
export type PreparationSnapshot = z.infer<typeof PreparationSnapshotSchema>;

export const HistoryEntrySchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  channel: z.string().nullable(),
  duration: z.number().nullable(),
  lastWatchedAt: z.string(),
  positionSeconds: z.number(),
  mp4: z.object({ sizeBytes: z.number().nullable() }),
});

export const HistoryListSchema = z.array(HistoryEntrySchema);
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const StorageFileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{11}$/),
  title: z.string().nullable(),
  channel: z.string().nullable(),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  modifiedAt: z.iso.datetime(),
});
export const StorageListSchema = z.array(StorageFileSchema);
export type StorageFile = z.infer<typeof StorageFileSchema>;

export type ApiResponse =
  | ResolvedVideo
  | z.infer<typeof PreparingVideoSchema>
  | PreparationSnapshot
  | HistoryEntry[]
  | StorageFile[]
  | ApiError
  | OkResponse;
