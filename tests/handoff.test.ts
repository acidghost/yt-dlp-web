import { expect, test } from "bun:test";
import {
  handoffSearch,
  parseHandoff,
  resolveKind,
} from "../app/client/handoff";

const url = "https://www.youtube.com/watch?v=abcdefghijk";

test("URL handoff defaults to proxy, explicit modes select downloads, and invalid modes never prepare", () => {
  expect(parseHandoff("")).toBeNull();
  expect(parseHandoff(`?url=${encodeURIComponent(url)}`)).toEqual({
    url,
    mode: "proxy",
  });
  for (const mode of ["proxy", "mp4"] as const) {
    const handoff = parseHandoff(
      `?url=${encodeURIComponent(url)}&mode=${mode}`,
    );
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
