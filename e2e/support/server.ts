import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createShutdown, registerSignals } from "../../app/lifecycle";
import { startServer } from "../../app/server";

const fixtures = join(import.meta.dir, "../fixtures");

// Ordinary composition, not fixture flags/endpoints in the production app.
// Tokens, jobs, publication, guards and persistence are all the real server.
export function startBrowserHost(dataDir: string, port: number) {
  const canceled = new Set<string>();

  return startServer({
    port,
    dataDir,
    download: async (url, output, options) => {
      const id = url.slice(-11);
      if (id.startsWith("cancel") && !canceled.has(id)) {
        await Bun.write(output, "partial");
        options?.onProgress({
          phase: "video",
          downloadedBytes: 7,
          totalBytes: 100,
          totalEstimated: false,
          speedBytesPerSecond: 10,
        });
        await new Promise<void>((resolve) => {
          if (options?.signal.aborted) {
            resolve();
          } else {
            options?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          }
        });
        // External downloader's cleanup delay; the real job stays canceling.
        await Bun.sleep(100);
        canceled.add(id);
        throw new DOMException("Canceled", "AbortError");
      }

      await Bun.write(output, Bun.file(join(fixtures, "player.mp4")));

      return {
        title: "Local fixture video",
        channel: "Local fixture channel",
        duration: 12,
        height: 90,
      };
    },
    extractHls: async () => ({
      title: "Local fixture HLS",
      channel: "Local fixture channel",
      duration: 12,
      manifest: "https://manifest.googlevideo.com/master.m3u8",
      headers: {},
    }),
    upstreamFetch: async (url) => {
      const name = new URL(url).pathname.slice(1);
      if (!/^(?:master|video|audio)\.m3u8$|^(?:video|audio)-\d+\.mpegts$/.test(name)) {
        throw new Error(`Unexpected fixture resource: ${name}`);
      }

      return new Response(Bun.file(join(fixtures, "proxy", name)), {
        headers: {
          "Content-Type": name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
        },
      });
    },
  });
}

if (import.meta.main) {
  // A single serial Playwright host owns this fixed test-only directory. The
  // browser-integration specs also install their native media fixtures here.
  const dataDir = join(import.meta.dir, "../../tmp/e2e-data");

  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });

  const app = startBrowserHost(dataDir, Number(process.env.PORT ?? 3000));
  const shutdown = createShutdown({
    app,
    log: console.log,
    complete: (outcome) => {
      if (outcome !== "graceful") {
        process.exit(1);
      }
      void rm(dataDir, { recursive: true, force: true }).then(() => process.exit(0));
    },
  });

  registerSignals(process, shutdown);
}
