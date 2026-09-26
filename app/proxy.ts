import { type HlsSource, InputError } from "./media";

export type UpstreamFetch = (
  url: string,
  options: RequestInit,
) => Promise<Response>;
type Resource = { url: string; playlist: boolean };

function allowedUrl(value: string, base?: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new InputError("Invalid YouTube HLS URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".googlevideo.com") ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new InputError("YouTube HLS referenced a disallowed host or URL.");
  }
  return url.href;
}

async function fetchSafe(
  url: string,
  headers: Record<string, string>,
  upstream: UpstreamFetch,
  range?: string,
) {
  let current = allowedUrl(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await upstream(current, {
      headers: { ...headers, ...(range ? { Range: range } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new InputError("YouTube redirected without a location.");
      current = allowedUrl(location, current);
      continue;
    }
    return { response, url: current };
  }
  throw new InputError("Too many YouTube media redirects.");
}

async function playlistText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new InputError("YouTube returned an empty HLS playlist.");
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > 2_000_000)
        throw new InputError("The HLS playlist is too large for this demo.");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ProxySession {
  readonly createdAt = Date.now();
  private resources = new Map<string, Resource>();
  private ids = new Map<string, string>();
  private root = "";

  constructor(
    private source: HlsSource,
    private upstream: UpstreamFetch,
  ) {
    this.register(source.manifest);
  }

  private register(value: string, base?: string): string {
    const url = allowedUrl(value, base);
    const previous = this.ids.get(url);
    if (previous) return previous;
    if (this.resources.size >= 10_000)
      throw new InputError("Too many HLS resources for this demo.");
    const id = String(this.resources.size);
    this.resources.set(id, {
      url,
      playlist: new URL(url).pathname.endsWith(".m3u8"),
    });
    this.ids.set(url, id);
    return id;
  }

  private rewrite(
    text: string,
    url: string,
    token: string,
    master = false,
  ): string {
    if (!text.startsWith("#EXTM3U"))
      throw new InputError("YouTube did not return an HLS playlist.");
    let lines = text.trimEnd().split(/\r?\n/);
    if (master) {
      // YouTube's master includes VP9, 1080p and sometimes 38 dubbed audio tracks.
      // Keep H.264/AAC ≤720p and the audio group referenced by those variants.
      const chosen = lines.find(
        (line) =>
          line.startsWith("#EXT-X-STREAM-INF:") &&
          /CODECS="[^"]*avc1\.[^"]*,mp4a\.40\.2"/.test(line) &&
          Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1]) <= 720 &&
          /AUDIO="[^"]+"/.test(line),
      );
      const group = chosen && /AUDIO="([^"]+)"/.exec(chosen)?.[1];
      const audio = lines.filter(
        (line) =>
          line.startsWith("#EXT-X-MEDIA:") &&
          line.includes("TYPE=AUDIO") &&
          line.includes(`GROUP-ID="${group}"`),
      );
      if (!group || !audio.length)
        throw new InputError(
          "No H.264/AAC YouTube HLS playlist with audio at or below 720p. Select a download mode instead.",
        );
      const defaultAudio =
        audio.find((line) => /NAME="[^"]*original"/i.test(line)) ?? audio[0];
      const selected: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) break;
        if (line.startsWith("#EXT-X-MEDIA:")) {
          if (audio.includes(line))
            selected.push(
              line.replace(
                /DEFAULT=(YES|NO)/,
                `DEFAULT=${line === defaultAudio ? "YES" : "NO"}`,
              ),
            );
        } else if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
        } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
          const uri = lines[++i];
          if (
            line.includes(`AUDIO="${group}"`) &&
            /CODECS="[^"]*avc1\.[^"]*,mp4a\.40\.2"/.test(line) &&
            Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1]) <= 720 &&
            uri
          ) {
            selected.push(line, uri);
          }
        } else selected.push(line);
      }
      lines = selected;
    }
    const path = (value: string) =>
      `/api/proxy/${token}/${this.register(value, url)}`;
    return `${lines
      .map((line) =>
        line.startsWith("#")
          ? line.replace(
              /\bURI="([^"]+)"/g,
              (_, value: string) => `URI="${path(value)}"`,
            )
          : line.trim()
            ? path(line.trim())
            : line,
      )
      .join("\n")}\n`;
  }

  async prepare(token: string): Promise<void> {
    const { response, url } = await fetchSafe(
      this.source.manifest,
      this.source.headers,
      this.upstream,
    );
    if (!response.ok)
      throw new InputError(
        response.status === 403
          ? "YouTube's HLS link expired or was denied. Retry or select a download mode."
          : "Could not fetch YouTube's HLS playlist.",
      );
    this.root = this.rewrite(await playlistText(response), url, token, true);
  }

  async serve(token: string, id: string, range?: string): Promise<Response> {
    const resource = this.resources.get(id);
    if (!resource) return new Response("Not found.", { status: 404 });
    if (id === "0")
      return new Response(this.root, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    try {
      const { response, url } = await fetchSafe(
        resource.url,
        this.source.headers,
        this.upstream,
        resource.playlist ? undefined : range,
      );
      if (response.status === 403 || response.status === 410) {
        await response.body?.cancel();
        return new Response(
          "YouTube's media link expired or was denied. Press Play again.",
          { status: 410 },
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        return new Response("Upstream media request failed.", { status: 502 });
      }
      if (resource.playlist)
        return new Response(
          this.rewrite(await playlistText(response), url, token),
          {
            headers: {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "no-store",
            },
          },
        );
      const headers = new Headers({
        "Content-Type":
          response.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      for (const name of ["content-range", "accept-ranges"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return new Response(
        error instanceof InputError
          ? error.message
          : "Upstream media request failed.",
        { status: 502 },
      );
    }
  }
}
