import { expect, test } from "bun:test";
import { handoffSearch, parseHandoff, resolveKind } from "../app/client/handoff";

const url = "https://www.youtube.com/watch?v=abcdefghijk";

test("URL handoff defaults to proxy, explicit modes select downloads, and invalid modes never prepare", () => {
  expect(parseHandoff("")).toBeNull();
  expect(parseHandoff(`?url=${encodeURIComponent(url)}`)).toEqual({
    url,
    mode: "proxy",
  });

  for (const mode of ["proxy", "mp4"] as const) {
    const handoff = parseHandoff(`?url=${encodeURIComponent(url)}&mode=${mode}`);

    expect(handoff).toEqual({ url, mode });
    expect(resolveKind(mode)).toBe(mode === "proxy" ? "proxy" : "download");
  }

  expect(parseHandoff(`?url=${encodeURIComponent(url)}&mode=bogus`)).toEqual({
    error: "Unknown playback mode.",
  });
  expect(parseHandoff("?url=javascript%3Aalert(1)")).toEqual({
    error: "Enter an HTTPS video URL.",
  });
  expect(parseHandoff("?url=not-a-url")).toEqual({
    error: "Enter an HTTPS video URL.",
  });
  expect(parseHandoff("?mode=mp4")).toEqual({
    error: "Add a video URL to the link.",
  });
});

test("address updates round trip for the two playback modes", () => {
  for (const mode of ["proxy", "mp4"] as const) {
    expect(parseHandoff(`?${handoffSearch(url, mode)}`)).toEqual({ url, mode });
  }
});

test("timestamp links round trip in both modes, including an explicit start at zero", () => {
  for (const mode of ["proxy", "mp4"] as const) {
    for (const startSeconds of [0, 83, 3723]) {
      const search = handoffSearch(url, mode, startSeconds);

      expect(new URLSearchParams(search).get("t")).toBe(String(startSeconds));
      expect(parseHandoff(`?${search}`)).toEqual({ url, mode, startSeconds });
    }
  }
});

test("bookmarks accept seconds and YouTube-style timestamps in query parameters or fragments", () => {
  for (const [timestamp, startSeconds] of [
    ["83", 83],
    ["83s", 83],
    ["1m23s", 83],
    ["1h2m3s", 3723],
    ["2m", 120],
    ["0s", 0],
  ] as const) {
    for (const parameter of ["t", "start"]) {
      expect(parseHandoff(`?url=${encodeURIComponent(url)}&${parameter}=${timestamp}`)).toEqual({
        url,
        mode: "proxy",
        startSeconds,
      });

      const timestampedUrl = `${url}&${parameter}=${timestamp}`;

      expect(parseHandoff(`?url=${encodeURIComponent(timestampedUrl)}`)).toEqual({
        url: timestampedUrl,
        mode: "proxy",
        startSeconds,
      });
    }

    const shortUrl = `https://youtu.be/abcdefghijk#t=${timestamp}`;

    expect(parseHandoff(`?url=${encodeURIComponent(shortUrl)}`)).toEqual({
      url: shortUrl,
      mode: "proxy",
      startSeconds,
    });
  }

  expect(parseHandoff(`?url=${encodeURIComponent(`${url}&t=83s`)}&t=0`)).toEqual({
    url: `${url}&t=83s`,
    mode: "proxy",
    startSeconds: 0,
  });
});

test("invalid timestamps are ignored without weakening URL or mode validation", () => {
  for (const timestamp of [
    "",
    "-1",
    "1.5",
    "Infinity",
    "NaN",
    "1e2",
    "1mgarbage",
    "1s2m",
    "9007199254740992",
  ]) {
    expect(parseHandoff(`?url=${encodeURIComponent(url)}&t=${timestamp}`)).toEqual({
      url,
      mode: "proxy",
    });

    const timestampedUrl = `${url}&t=${timestamp}`;

    expect(parseHandoff(`?url=${encodeURIComponent(timestampedUrl)}`)).toEqual({
      url: timestampedUrl,
      mode: "proxy",
    });
  }

  expect(parseHandoff(`?url=${encodeURIComponent(url)}&t=bad&start=83`)).toEqual({
    url,
    mode: "proxy",
    startSeconds: 83,
  });
  expect(parseHandoff(`?url=${encodeURIComponent(url)}&t=0&start=83`)).toEqual({
    url,
    mode: "proxy",
    startSeconds: 0,
  });
  expect(parseHandoff("?t=83")).toEqual({
    error: "Add a video URL to the link.",
  });
  expect(parseHandoff("?url=javascript%3Aalert(1)&t=83")).toEqual({
    error: "Enter an HTTPS video URL.",
  });
  expect(parseHandoff(`?url=${encodeURIComponent(url)}&mode=bad&t=83`)).toEqual({
    error: "Unknown playback mode.",
  });
});
