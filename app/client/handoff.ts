export type PlayerMode = "proxy" | "mp4";
export type Handoff =
  | { url: string; mode: PlayerMode }
  | { error: string }
  | null;

export function parseHandoff(search: string): Handoff {
  const params = new URLSearchParams(search);
  if (!params.has("url"))
    return params.has("mode")
      ? { error: "Add a video URL to the link." }
      : null;
  const mode = params.get("mode") ?? "proxy";
  if (mode !== "proxy" && mode !== "mp4")
    return { error: "Unknown playback mode." };
  const url = params.get("url") ?? "";
  try {
    if (new URL(url).protocol !== "https:") throw new Error("Not HTTPS");
  } catch {
    return { error: "Enter an HTTPS video URL." };
  }
  // Only the server decides whether this is a supported YouTube video URL.
  return { url, mode };
}

export function handoffSearch(url: string, mode: PlayerMode): string {
  return new URLSearchParams({ url, mode }).toString();
}

export function resolveKind(mode: PlayerMode): "proxy" | "download" {
  return mode === "proxy" ? "proxy" : "download";
}
