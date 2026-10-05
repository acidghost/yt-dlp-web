import * as z from "zod";

export type VideoId = string;

export const QualitySchema = z.enum(["360", "480", "720", "1080", "best"]);
export type Quality = z.infer<typeof QualitySchema>;

export const SavedVariantSchema = QualitySchema;
export type SavedVariant = z.infer<typeof SavedVariantSchema>;

const HeightSchema = z.number().int().positive().nullable();
export const DownloadQualitySchema = z.object({
  requested: QualitySchema.nullable(),
  height: HeightSchema,
});

export const ResolveRequestSchema = z
  .object({
    url: z.string(),
    mode: z.enum(["proxy", "mp4"]).optional(),
    quality: QualitySchema.optional(),
    savedVariant: SavedVariantSchema.optional(),
  })
  .refine(
    (request) =>
      request.savedVariant === undefined ||
      (request.mode === "mp4" &&
        (request.quality === undefined || request.quality === request.savedVariant)),
    { message: "Saved playback requires MP4 mode and a matching quality." },
  );
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
  VideoFields.extend({
    kind: z.literal("proxy"),
    hls: z.string(),
    quality: z.object({
      requested: QualitySchema,
      availableHeights: z.array(z.number().int().positive()).min(1),
    }),
  }),
  VideoFields.extend({
    kind: z.literal("download"),
    stream: z.string(),
    variant: SavedVariantSchema,
    quality: DownloadQualitySchema,
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

export const SavedFileSchema = DownloadQualitySchema.extend({
  variant: SavedVariantSchema,
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type SavedFile = z.infer<typeof SavedFileSchema>;

export const HistoryEntrySchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  channel: z.string().nullable(),
  duration: z.number().nullable(),
  lastWatchedAt: z.string(),
  positionSeconds: z.number(),
  mp4: z.object({ sizeBytes: z.number().nullable(), variants: z.array(SavedFileSchema) }),
});

export const HistoryListSchema = z.array(HistoryEntrySchema);
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const StorageFileSchema = SavedFileSchema.extend({
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
