import * as z from "zod";

export type VideoId = string;

export const ResolveRequestSchema = z.object({
  url: z.string(),
  mode: z.enum(["proxy", "download", "mp4"]).optional(),
});
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

export const WatchRequestSchema = z.object({ token: z.string() });
export type WatchRequest = z.infer<typeof WatchRequestSchema>;
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
});

export const ResolvedVideoSchema = z.discriminatedUnion("kind", [
  VideoFields.extend({ kind: z.literal("proxy"), hls: z.string() }),
  VideoFields.extend({
    kind: z.literal("download"),
    stream: z.string(),
    hls: z.string().optional(),
  }),
]);
export type ResolvedVideo = z.infer<typeof ResolvedVideoSchema>;

export const HistoryEntrySchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  channel: z.string().nullable(),
  duration: z.number().nullable(),
  lastWatchedAt: z.string(),
  available: z.object({ mp4: z.boolean(), hls: z.boolean() }),
  sizeBytes: z.object({
    mp4: z.number().nullable(),
    hls: z.number().nullable(),
  }),
});
export const HistoryListSchema = z.array(HistoryEntrySchema);
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export type ApiResponse =
  | ResolvedVideo
  | HistoryEntry[]
  | ApiError
  | OkResponse;
