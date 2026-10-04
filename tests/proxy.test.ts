import { expect, test } from "bun:test";
import { InputError } from "../app/media";
import { ProxySession } from "../app/proxy";

const source = {
  title: "Fixture",
  duration: 5,
  channel: null,
  manifest: "https://manifest.googlevideo.com/master.m3u8",
  headers: {},
};

test("rejects disallowed manifest hosts and does not follow redirects to other hosts", async () => {
  const called: string[] = [];
  const upstream = async (url: string, options: RequestInit) => {
    expect(options.redirect).toBe("manual");

    called.push(url);

    return new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1/admin" },
    });
  };

  expect(
    () =>
      new ProxySession(
        {
          ...source,
          manifest: "https://manifest.googlevideo.com.evil.example/master.m3u8",
        },
        upstream,
      ),
  ).toThrow(InputError);

  const proxy = new ProxySession(source, upstream);

  await expect(proxy.prepare("token")).rejects.toThrow(InputError);
  expect(called).toEqual([source.manifest]);
});

test("rejects playlists that try to make the server fetch unrelated hosts", async () => {
  const proxy = new ProxySession(
    source,
    async () =>
      new Response(
        [
          "#EXTM3U",
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",URI="https://rr1.googlevideo.com/audio.m3u8"',
          '#EXT-X-STREAM-INF:RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"',
          "https://localhost:3000/secret",
        ].join("\n"),
      ),
  );

  await expect(proxy.prepare("token")).rejects.toThrow("disallowed host");
});

test("marks the original audio rendition default and excludes incompatible variants", async () => {
  const proxy = new ProxySession(
    source,
    async () =>
      new Response(
        [
          "#EXTM3U",
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Dubbed",DEFAULT=NO,URI="https://rr1.googlevideo.com/dub.m3u8"',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English - original",DEFAULT=NO,URI="https://rr1.googlevideo.com/original.m3u8"',
          '#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"',
          "https://rr1.googlevideo.com/video.m3u8",
          '#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"',
          "https://rr1.googlevideo.com/large.m3u8",
        ].join("\n"),
      ),
  );

  await proxy.prepare("token");

  const master = await (await proxy.serve("token", "0")).text();

  expect(master).toMatch(/NAME="English - original"[^\n]*DEFAULT=YES/);
  expect(master).toMatch(/NAME="Dubbed"[^\n]*DEFAULT=NO/);
  expect(master).not.toContain("1920x1080");
  expect(master).not.toContain("googlevideo.com");
});

test("rejects video-only playlists before publishing a proxy session", async () => {
  const proxy = new ProxySession(
    source,
    async () => new Response("#EXTM3U\n#EXTINF:6,\nhttps://rr1.googlevideo.com/segment.ts\n"),
  );

  await expect(proxy.prepare("token")).rejects.toThrow("with audio");
});

test("allowed relative redirects rebase playlist resources without automatic fetch redirects", async () => {
  const called: string[] = [];
  const proxy = new ProxySession(source, async (url, options) => {
    expect(options.redirect).toBe("manual");

    called.push(url);
    if (url === source.manifest) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/edge/master.m3u8" },
      });
    }
    if (url.endsWith("/edge/master.m3u8")) {
      return new Response(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="original",DEFAULT=NO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"\nvideo.m3u8',
      );
    }

    return new Response("#EXTM3U\n#EXTINF:5,\nsegment.ts\n");
  });

  await proxy.prepare("token");

  const master = await (await proxy.serve("token", "0")).text();

  expect(master).toContain('URI="/api/proxy/token/1"');
  expect(await (await proxy.serve("token", "1")).text()).toContain("/api/proxy/token/3");
  expect(called).toEqual([
    source.manifest,
    "https://manifest.googlevideo.com/edge/master.m3u8",
    "https://manifest.googlevideo.com/edge/audio.m3u8",
  ]);
});

test("redirect chains stop after the permitted three hops", async () => {
  const called: string[] = [];
  const proxy = new ProxySession(source, async (url, options) => {
    expect(options.redirect).toBe("manual");

    called.push(url);

    return new Response(null, {
      status: 302,
      headers: { Location: `/hop-${called.length}.m3u8` },
    });
  });

  await expect(proxy.prepare("token")).rejects.toThrow("Too many YouTube media redirects.");
  expect(called).toEqual([
    source.manifest,
    "https://manifest.googlevideo.com/hop-1.m3u8",
    "https://manifest.googlevideo.com/hop-2.m3u8",
    "https://manifest.googlevideo.com/hop-3.m3u8",
  ]);
});
