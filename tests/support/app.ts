import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadTerminationError } from "../../app/media";
import { startServer } from "../../app/server";
import { deferred } from "./async";

type Options = NonNullable<Parameters<typeof startServer>[0]> & {
  proxy?: boolean;
};

export async function appFixture() {
  const dir = await mkdtemp(join(tmpdir(), "yt-dlp-test-"));
  const dataDir = join(dir, "data");
  let app: ReturnType<typeof startServer> | undefined;
  let options: Options = {};
  let time = Date.now();
  const releases: (() => void)[] = [];
  const fixture = {
    dir,
    dataDir,
    now: () => time,
    advanceTime: (ms: number) => {
      time += ms;
    },
    get app() {
      if (!app) {
        throw new Error("Fixture not started");
      }

      return app;
    },
    // Only the unsafe-termination regression uses a fake with no actual writer.
    confirmedNoExternalWriters: false,
    gate() {
      const gate = deferred();

      releases.push(gate.resolve);

      return { promise: gate.promise, release: gate.resolve };
    },
    start(config: Options = {}) {
      if (app) {
        throw new Error("Use restart() to close the previous instance first");
      }

      options = config;

      const { proxy, ...serverOptions } = config;

      app = startServer({
        port: Number(process.env.TEST_PORT ?? 0),
        dataDir,
        now: fixture.now,
        download: async (_url, path) => {
          await writeFile(path, "abcdefghij");

          return { title: "Fixture", channel: "Fixture channel", duration: 10 };
        },
        ...(proxy ? proxyOptions : {}),
        ...serverOptions,
      });

      return `http://127.0.0.1:${app.server.port}`;
    },
    async restart(config = options) {
      await app?.close();
      app = undefined;

      return fixture.start(config);
    },
    async [Symbol.asyncDispose]() {
      for (const release of releases) {
        release();
      }

      try {
        await app?.close();
      } catch (error) {
        if (!fixture.confirmedNoExternalWriters || !(error instanceof DownloadTerminationError)) {
          throw error;
        }
      }

      // Do not remove data if close/termination was not confirmed above.
      await rm(dir, { recursive: true, force: true });
    },
  };

  return fixture;
}

// Wire responses only: real ProxySession performs every validation/rewrite.
const proxyOptions = {
  extractHls: async () => ({
    title: "Proxy fixture",
    channel: "Proxy channel",
    duration: 30,
    manifest: "https://manifest.googlevideo.com/master.m3u8",
    headers: { "User-Agent": "fixture-agent" },
  }),
  upstreamFetch: async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/master.m3u8") {
      return new Response(
        [
          "#EXTM3U",
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English - original",DEFAULT=NO,URI="https://rr1.googlevideo.com/audio.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"',
          "https://rr1.googlevideo.com/video.m3u8",
          '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2",AUDIO="aac"',
          "https://rr1.googlevideo.com/large.m3u8",
        ].join("\n"),
      );
    }
    if (path === "/video.m3u8") {
      return new Response(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.ts?range=0-10\n#EXT-X-ENDLIST',
      );
    }
    if (path === "/audio.m3u8") {
      return new Response(
        "#EXTM3U\n#EXTINF:6,\nhttps://rr1.googlevideo.com/audio.ts\n#EXT-X-ENDLIST",
      );
    }
    if (path === "/seg.ts") {
      return new Response("segment", {
        status: new Headers(options.headers).has("Range") ? 206 : 200,
        headers: {
          "Content-Range": "bytes 0-6/7",
          "Content-Type": "video/mp2t",
        },
      });
    }
    if (path === "/init.mp4") {
      return new Response("init");
    }
    if (path === "/audio.ts") {
      return new Response("audio");
    }

    throw new Error(`Unexpected upstream path: ${path}`);
  },
};
