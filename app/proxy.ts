import type { HlsSource } from "./media";
import { InputError } from "./media-errors";
import type { Quality } from "./protocol";
import { qualityHeight, qualityLabel } from "./quality";

export type UpstreamFetch = (url: string, options: RequestInit) => Promise<Response>;

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
      if (!location) {
        throw new InputError("YouTube redirected without a location.");
      }

      current = allowedUrl(location, current);
      continue;
    }

    return { response, url: current };
  }

  throw new InputError("Too many YouTube media redirects.");
}

async function playlistText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new InputError("YouTube returned an empty HLS playlist.");
  }

  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }

      size += value.byteLength;
      if (size > 2_000_000) {
        throw new InputError("The HLS playlist is too large for this demo.");
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ProxySession {
  private resources = new Map<string, Resource>();
  private ids = new Map<string, string>();
  private root = "";
  availableHeights: number[] = [];

  constructor(
    private source: HlsSource,
    private upstream: UpstreamFetch,
    readonly createdAt = Date.now(),
    private quality: Quality = "720",
  ) {
    this.register(source.manifest);
  }

  private register(value: string, base?: string): string {
    const url = allowedUrl(value, base);
    const previous = this.ids.get(url);
    if (previous) {
      return previous;
    }
    if (this.resources.size >= 10_000) {
      throw new InputError("Too many HLS resources for this demo.");
    }

    const id = String(this.resources.size);

    this.resources.set(id, {
      url,
      playlist: new URL(url).pathname.endsWith(".m3u8"),
    });
    this.ids.set(url, id);

    return id;
  }

  private rewrite(text: string, url: string, token: string, master = false): string {
    if (!text.startsWith("#EXTM3U")) {
      throw new InputError("YouTube did not return an HLS playlist.");
    }

    let lines = text.trimEnd().split(/\r?\n/);
    if (master) {
      // Keep the requested compatible ladder and its referenced audio group.
      const cap = qualityHeight(this.quality);
      const height = (line: string) => Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1]);
      const compatible = (line: string) => {
        const renditionHeight = height(line);
        return (
          /CODECS="[^"]*avc1\.[^"]*,mp4a\.40\.2"/.test(line) &&
          Number.isSafeInteger(renditionHeight) &&
          renditionHeight > 0 &&
          (cap === null || renditionHeight <= cap)
        );
      };
      const chosen = lines
        .filter((line) => line.startsWith("#EXT-X-STREAM-INF:") && compatible(line))
        .sort((a, b) => height(b) - height(a))
        .find((line) => {
          const group = /AUDIO="([^"]+)"/.exec(line)?.[1];
          return (
            group &&
            lines.some(
              (audio) =>
                audio.startsWith("#EXT-X-MEDIA:") &&
                audio.includes("TYPE=AUDIO") &&
                audio.includes(`GROUP-ID="${group}"`),
            )
          );
        });
      const group = chosen && /AUDIO="([^"]+)"/.exec(chosen)?.[1];
      const audio = lines.filter(
        (line) =>
          line.startsWith("#EXT-X-MEDIA:") &&
          line.includes("TYPE=AUDIO") &&
          line.includes(`GROUP-ID="${group}"`),
      );
      if (!group || !audio.length) {
        const hint =
          this.quality === "best" ? "Choose Save MP4." : "Try a higher limit or choose Save MP4.";
        throw new InputError(
          `No H.264/AAC YouTube HLS playlist with audio (${qualityLabel(this.quality)}). ${hint}`,
        );
      }

      const defaultAudio = audio.find((line) => /NAME="[^"]*original"/i.test(line)) ?? audio[0];
      const selected: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) {
          break;
        }

        if (line.startsWith("#EXT-X-MEDIA:")) {
          if (audio.includes(line)) {
            selected.push(
              line.replace(/DEFAULT=(YES|NO)/, `DEFAULT=${line === defaultAudio ? "YES" : "NO"}`),
            );
          }
        } else if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
        } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
          const uri = lines[++i];
          if (line.includes(`AUDIO="${group}"`) && compatible(line) && uri) {
            selected.push(line, uri);
          }
        } else {
          selected.push(line);
        }
      }

      this.availableHeights = [
        ...new Set(selected.filter((line) => line.startsWith("#EXT-X-STREAM-INF:")).map(height)),
      ].sort((a, b) => a - b);
      if (this.availableHeights.length === 0) {
        throw new InputError(
          `No playable HLS renditions (${qualityLabel(this.quality)}). Choose Save MP4.`,
        );
      }
      lines = selected;
    }

    const path = (value: string) => `/api/proxy/${token}/${this.register(value, url)}`;

    return `${lines
      .map((line) =>
        line.startsWith("#")
          ? line.replace(/\bURI="([^"]+)"/g, (_, value: string) => `URI="${path(value)}"`)
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
    if (!response.ok) {
      throw new InputError(
        response.status === 403
          ? "YouTube's HLS link expired or was denied. Retry or select a download mode."
          : "Could not fetch YouTube's HLS playlist.",
      );
    }

    this.root = this.rewrite(await playlistText(response), url, token, true);
  }

  async serve(token: string, id: string, range?: string): Promise<Response> {
    const resource = this.resources.get(id);
    if (!resource) {
      return new Response("Not found.", { status: 404 });
    }
    if (id === "0") {
      return new Response(this.root, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }

    try {
      const { response, url } = await fetchSafe(
        resource.url,
        this.source.headers,
        this.upstream,
        resource.playlist ? undefined : range,
      );
      if (response.status === 403 || response.status === 410) {
        await response.body?.cancel();

        return new Response("YouTube's media link expired or was denied. Press Play again.", {
          status: 410,
        });
      }
      if (!response.ok) {
        await response.body?.cancel();

        return new Response("Upstream media request failed.", { status: 502 });
      }
      if (resource.playlist) {
        return new Response(this.rewrite(await playlistText(response), url, token), {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }

      const headers = new Headers({
        "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });

      for (const name of ["content-range", "accept-ranges"]) {
        const value = response.headers.get(name);
        if (value) {
          headers.set(name, value);
        }
      }

      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return new Response(
        error instanceof InputError ? error.message : "Upstream media request failed.",
        { status: 502 },
      );
    }
  }
}
