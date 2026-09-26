export type VideoId = string;

export type HistoryEntry = {
  id: VideoId;
  url: string;
  title: string;
  channel: string | null;
  duration: number | null;
  lastWatchedAt: string;
  available: { mp4: boolean; hls: boolean };
  sizeBytes: { mp4: number | null; hls: number | null };
};

export type ResolvedVideo = {
  id: VideoId;
  url: string;
  token: string;
  title: string;
  channel: string | null;
  duration: number | null;
  hls?: string;
  stream?: string;
};
