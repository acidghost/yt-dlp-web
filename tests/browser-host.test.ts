import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserHost } from "../e2e/support/server";
import { waitFor } from "./support/async";
import {
  cancelDownload,
  history,
  requestResolve,
  resolveVideo,
  waitForSnapshot,
  watched,
} from "./support/http";

test("browser host uses real preparation/history, rewritten audio/video HLS and cancellation/retry APIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-host-"));
  const app = startBrowserHost(dir, Number(process.env.TEST_PORT ?? 0));
  const base = `http://127.0.0.1:${app.server.port}`;

  try {
    const video = await resolveVideo(base, "https://youtu.be/native00001");

    expect(video.title).toBe("Local fixture video");
    expect(await history(base)).toEqual([]);

    await watched(base, video.id, video.token);

    expect((await history(base))[0]?.mp4.sizeBytes).toBeGreaterThan(0);

    const proxy = await (
      await requestResolve(base, "https://youtu.be/proxy000001", {}, "proxy")
    ).json();
    const master = await (await fetch(`${base}${proxy.hls}`)).text();

    expect(master).toContain("DEFAULT=YES");
    expect(master).not.toContain("googlevideo.com");

    const playlists = master.match(/\/api\/proxy\/[\da-f-]+\/\d+/g) ?? [];

    expect(playlists).toHaveLength(2);

    for (const path of playlists) {
      const playlist = await (await fetch(`${base}${path}`)).text();
      const segment = playlist.split("\n").find((line) => line.startsWith("/api/proxy/"));

      expect(segment).toBeDefined();

      const response = await fetch(`${base}${segment}`);
      const data = new Uint8Array(await response.arrayBuffer());

      expect(response.headers.get("content-type")).toBe("video/mp2t");
      expect(data.length).toBeGreaterThan(188);
      expect(data[0]).toBe(0x47); // Actual MPEG-TS sync byte, not placeholder text.
    }

    const { jobToken } = await (await requestResolve(base, "https://youtu.be/cancel00001")).json();

    await waitFor(
      () => waitForSnapshot(base, jobToken, "preparing"),
      (snapshot) => snapshot.phase === "video",
      "fixture transfer readiness",
    );
    await cancelDownload(base, jobToken);
    await waitForSnapshot(base, jobToken, "canceled");

    expect(await readdir(join(dir, "media", "cancel00001"))).toEqual([]);
    expect((await fetch(`${base}/api/stream/cancel00001`)).status).toBe(404);
    expect((await resolveVideo(base, "https://youtu.be/cancel00001")).kind).toBe("download");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
