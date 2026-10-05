import { expect, mock, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Download, InputError } from "../app/media";
import { PreparingVideoSchema, ResolvedVideoSchema } from "../app/protocol";
import { appFixture } from "./support/app";
import {
  prepared as complete,
  history,
  proxyResolve,
  removeHistory,
  requestResolve,
  resolveVideo as resolve,
  videoUrl as url,
  waitForSnapshot,
  watched,
} from "./support/http";

test("downloads a private MP4 file before returning a local stream link", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const data = await resolve(base);

  expect(data.kind).toBe("download");
  expect(data.title).toBe("Fixture");
  expect(data.stream).toBe("/api/stream/abcdefghijk/720");
  expect(JSON.stringify(data)).not.toContain(fixture.dir);

  const file = Bun.file(join(fixture.dataDir, "media", data.id, "q-720", "video.mp4"));

  expect(await file.text()).toBe("abcdefghij");
  expect((await requestResolve(base, "https://youtube.com.evil/watch?v=abcdefghijk")).status).toBe(
    400,
  );
});

test("proxies a nested HLS master, audio, map and ranged segments without downloading", async () => {
  await using fixture = await appFixture();
  const download = mock<Download>(async () => {
    throw new Error("Proxy must not download");
  });
  const base = fixture.start({ proxy: true, download });
  const response = await proxyResolve(base);

  expect(response.status).toBe(200);

  const data = ResolvedVideoSchema.parse(await response.json());

  expect(data.kind).toBe("proxy");

  if (data.kind !== "proxy") {
    throw new Error("Expected a proxy");
  }

  expect("stream" in data).toBe(false);
  expect(data.hls).toMatch(/^\/api\/proxy\/[\da-f-]+\/0$/);
  expect(download).not.toHaveBeenCalled();
  expect(
    await Bun.file(join(fixture.dataDir, "media", data.id, "q-720", "video.mp4")).exists(),
  ).toBe(false);

  const master = await (await fetch(`${base}${data.hls}`)).text();

  expect(master).toContain("DEFAULT=YES");
  expect(master).not.toContain("googlevideo.com");
  expect(master).not.toContain("1920x1080");

  const urls = master.match(/\/api\/proxy\/[\da-f-]+\/\d+/g) ?? [];

  expect(urls.length).toBe(2);

  const video = await (await fetch(`${base}${urls[1]}`)).text();

  expect(video).not.toContain("googlevideo.com");

  const resources = video.match(/\/api\/proxy\/[\da-f-]+\/\d+/g) ?? [];

  expect(resources.length).toBe(2);
  expect(await (await fetch(`${base}${resources[0]}`)).text()).toBe("init");

  const segment = await fetch(`${base}${resources[1]}`, {
    headers: { Range: "bytes=0-6" },
  });

  expect(segment.status).toBe(206);
  expect(segment.headers.get("content-range")).toBe("bytes 0-6/7");
  expect(await segment.text()).toBe("segment");
  expect(
    (
      await fetch(`${base}${resources[1]}`, {
        headers: { Range: "bytes=0-1,3-4" },
      })
    ).status,
  ).toBe(416);

  const audio = await (await fetch(`${base}${urls[0]}`)).text();

  expect(audio).not.toContain("googlevideo.com");
  expect((await fetch(`${base}${data.hls.replace(/\/0$/, "/9999")}`)).status).toBe(404);
  expect((await fetch(`${base}/api/proxy/unknown/0`)).status).toBe(404);
});

test("bundles the player and its assets", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const html = await (await fetch(base)).text();

  expect(html).toContain('type="module"');

  const script = html.match(/<script[^>]+src="([^"]+\.js)"/);

  expect(script).not.toBeNull();

  const scriptUrl = script?.[1];
  if (!scriptUrl) {
    throw new Error("Bundled script URL is missing");
  }

  const bundled = await fetch(new URL(scriptUrl, base));

  expect(bundled.status).toBe(200);

  const client = await bundled.text();
  if (process.env.NODE_ENV === "production") {
    expect(html).not.toContain("bun-hmr");
    expect(client).not.toContain("bun-hmr");
  }

  expect(client).toContain("Hls");
  // Registration code must ship, not just custom-element tags in Lit templates.
  expect(client).toMatch(/customElements\.define\(\s*["']media-controller["']/);
  expect(client).toMatch(/customElements\.define\(\s*["']media-playback-rate-menu["']/);
  expect(client).toContain("Stream (HLS)");
  expect(client).toContain("Save MP4");
  expect(client).toContain("Max quality");
  expect(client).toContain("Best compatible");
  expect(client).toContain("Delete files and history");
  expect(client).toContain("Delete files");
  expect(client).toContain("Prepare video");
  expect(client).not.toContain("No files");
  expect(client).not.toContain("Published MP4 file lengths only");
  expect(client).not.toContain("Recent first and Oldest first use");
  expect(client).not.toContain("Most recent uses MP4 modification time");
  expect(client).not.toContain("Bars compare file sizes");
  expect(client).not.toContain("library-sort-note");
  expect(client).toContain("Open on YouTube");
  expect(client).toContain("Channel unavailable");

  const stylesheet = html.match(/<link[^>]+href="([^"]+\.css)"/);

  expect(stylesheet).not.toBeNull();

  const cssUrl = stylesheet?.[1];
  if (!cssUrl) {
    throw new Error("Bundled stylesheet URL is missing");
  }

  const css = await fetch(new URL(cssUrl, base));

  expect(css.status).toBe(200);
  expect(await css.text()).toContain("video");

  const icon = html.match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/);

  expect(icon).not.toBeNull();

  const iconUrl = icon?.[1];
  if (!iconUrl) {
    throw new Error("Bundled favicon URL is missing");
  }

  const favicon = await fetch(new URL(iconUrl, base));

  expect(favicon.status).toBe(200);
  expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
  expect(await favicon.text()).toContain("<svg");
});

test("serves full and single byte ranges, including suffix ranges and HEAD", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const data = await resolve(base);
  const media = `${base}${data.stream}`;
  const full = await fetch(media);

  expect(full.status).toBe(200);
  expect(await full.text()).toBe("abcdefghij");
  expect(full.headers.get("accept-ranges")).toBe("bytes");

  const range = await fetch(media, { headers: { Range: "bytes=2-5" } });

  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(range.headers.get("content-length")).toBe("4");
  expect(await range.text()).toBe("cdef");
  expect(await (await fetch(media, { headers: { Range: "bytes=-3" } })).text()).toBe("hij");

  const head = await fetch(media, { method: "HEAD" });

  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
});

test("download failures are reported and never create a playable session", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({
    download: async () => {
      throw new InputError("Download failed.");
    },
  });
  const response = await requestResolve(base);

  expect(response.status).toBe(202);

  const { jobToken } = PreparingVideoSchema.parse(await response.clone().json());

  expect(await waitForSnapshot(base, jobToken, "error")).toEqual({
    state: "error",
    error: "Download failed.",
  });

  const snapshot = await fetch(`${base}/api/downloads/${jobToken}`);

  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toEqual({
    state: "error",
    error: "Download failed.",
  });
});

test("downloads reuse stable media across requests and restart; ranges and HEAD still work", async () => {
  await using fixture = await appFixture();
  let downloads = 0;
  const download: Download = async (_url, path) => {
    downloads++;
    await writeFile(path, "abcdefghij");

    return { title: "Durable fixture", duration: 10, channel: null };
  };
  const base = fixture.start({ download });
  const first = await resolve(base);

  expect((await requestResolve(base)).status).toBe(200);
  expect(downloads).toBe(1);
  expect(first.stream).toBe("/api/stream/abcdefghijk/720");

  const restarted = await fixture.restart({ download });
  const replay = await resolve(restarted);

  expect(downloads).toBe(1);
  expect(replay.title).toBe("Durable fixture");
  expect(replay.stream).toBe(first.stream);

  const range = await fetch(`${restarted}${replay.stream}`, {
    headers: { Range: "bytes=1-2" },
  });

  expect(range.status).toBe(206);
  expect(await range.text()).toBe("bc");

  const head = await fetch(`${restarted}${replay.stream}`, { method: "HEAD" });

  expect(head.headers.get("content-length")).toBe("10");
});

test("failed downloads remove staging, and startup clears abandoned staging without touching legacy tmp", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({
    download: async (_url, path) => {
      await writeFile(path, "partial");
      throw new Error("yt-dlp failed");
    },
  });

  await expect(resolve(base)).rejects.toThrow("Could not prepare video.");

  const mediaDir = join(fixture.dataDir, "media", "abcdefghijk");

  expect(await Bun.file(join(mediaDir, "q-720", "video.mp4")).exists()).toBe(false);
  expect((await readdir(mediaDir)).some((name) => name.startsWith(".staging-"))).toBe(false);

  const abandoned = `.staging-${crypto.randomUUID()}`;

  await mkdir(join(mediaDir, abandoned));
  await writeFile(join(mediaDir, abandoned, "video.mp4"), "unfinished");
  await mkdir(join(fixture.dataDir, "tmp"));
  await writeFile(join(fixture.dataDir, "tmp", "legacy.mp4"), "keep");
  await writeFile(join(fixture.dataDir, "unrelated.txt"), "unrelated");

  const saved = join(fixture.dataDir, "media", "123456789ab");

  await mkdir(saved);
  await writeFile(join(saved, "video.mp4"), "saved");
  await fixture.restart();

  expect(await readdir(mediaDir)).not.toContain(abandoned);
  expect(await Bun.file(join(fixture.dataDir, "tmp", "legacy.mp4")).text()).toBe("keep");
  expect(await Bun.file(join(fixture.dataDir, "unrelated.txt")).text()).toBe("unrelated");
  expect(await Bun.file(join(saved, "video.mp4")).text()).toBe("saved");
});

test("duplicate prepares share one download and both deletes are idempotent", async () => {
  await using fixture = await appFixture();
  const gate = fixture.gate();
  const finish = gate.release;
  let downloads = 0;
  const started = fixture.gate();
  const base = fixture.start({
    download: async (_url, path) => {
      downloads++;
      started.release();
      await gate.promise;
      await writeFile(path, "abcdefghij");

      return { title: "Fixture", duration: 10, channel: null };
    },
  });
  const one = await requestResolve(base);
  const two = await requestResolve(base);

  expect(one.status).toBe(202);
  expect(two.status).toBe(202);

  await started.promise;

  expect(downloads).toBe(1);
  expect((await removeHistory(base, "abcdefghijk", true)).status).toBe(409);
  expect((await removeHistory(base, "abcdefghijk")).status).toBe(409);

  finish();

  const a = await complete(base, one);
  const b = await complete(base, two);
  if (a.kind !== "download" || b.kind !== "download") {
    throw new Error("Expected native preparations");
  }

  expect(a.stream).toBe(b.stream);
  expect(downloads).toBe(1);
  expect((await watched(base, a.id, a.token)).status).toBe(200);
  expect((await removeHistory(base, a.id, true, { Origin: "https://evil.example" })).status).toBe(
    403,
  );
  expect((await removeHistory(base, a.id, true)).status).toBe(200);
  expect((await history(base))[0]).toMatchObject({
    mp4: { sizeBytes: null },
  });
  expect((await fetch(`${base}${a.stream}`)).status).toBe(404);
  expect((await removeHistory(base, a.id, true)).status).toBe(200);

  const again = await resolve(base);

  expect(downloads).toBe(2);
  expect((await watched(base, a.id, again.token)).status).toBe(200);
  expect((await removeHistory(base, a.id)).status).toBe(200);
  expect(await history(base)).toEqual([]);
  expect((await removeHistory(base, a.id)).status).toBe(200);
  expect((await removeHistory(base, "short")).status).toBe(404);
  expect((await removeHistory(base, "../secret")).status).toBe(404);
  expect((await watched(base, a.id, again.token)).status).toBe(404);
});

test("handoff modes map to their preparation requests without recording a watch", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true });
  const { parseHandoff, resolveKind } = await import("../app/client/handoff");

  for (const mode of [null, "mp4"] as const) {
    const handoff = parseHandoff(`?url=${encodeURIComponent(url)}${mode ? `&mode=${mode}` : ""}`);
    if (!handoff || "error" in handoff) {
      throw new Error("Invalid fixture handoff");
    }

    const result = await complete(
      base,
      await requestResolve(
        base,
        handoff.url,
        {},
        handoff.mode === "mp4" ? "mp4" : resolveKind(handoff.mode),
      ),
    );

    expect(result.kind).toBe(mode === null ? "proxy" : "download");

    if (result.kind === "proxy") {
      expect(result.hls).toStartWith("/api/proxy/");
    }
  }

  expect(await history(base)).toEqual([]);
  expect(parseHandoff(`?url=${encodeURIComponent(url)}&mode=bad`)).toEqual({
    error: "Unknown playback mode.",
  });

  const foreign = parseHandoff("?url=https%3A%2F%2Fevil.example%2Fwatch%3Fv%3Dabcdefghijk");
  if (!foreign || "error" in foreign) {
    throw new Error("Invalid HTTPS fixture");
  }

  const rejected = await requestResolve(base, foreign.url, {}, resolveKind(foreign.mode));

  expect(rejected.status).toBe(400);
  expect(await history(base)).toEqual([]);
});

test("proxy sessions expire with an actionable message and evict to free capacity", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({ proxy: true, sessionTtlMs: 1200 });
  const first = await (await proxyResolve(base)).json();

  expect((await fetch(`${base}${first.hls}`)).status).toBe(200);

  fixture.advanceTime(1300);

  const expired = await fetch(`${base}${first.hls}`);

  expect(expired.status).toBe(404);

  const message = (await expired.json()).error;

  expect(message).toContain("expired");
  expect(message).toContain("Play again");

  for (let i = 0; i < 16; i++) {
    expect((await proxyResolve(base)).status).toBe(200);
  }

  expect((await proxyResolve(base)).status).toBe(429);

  fixture.advanceTime(1300);

  const fresh = await proxyResolve(base);

  expect(fresh.status).toBe(200);
  expect((await fetch(`${base}${(await fresh.json()).hls}`)).status).toBe(200);
});
