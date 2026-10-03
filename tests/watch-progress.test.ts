import { expect, test } from "bun:test";
import { fullyWatched, resumePosition } from "../app/client/watch-progress";

test("watched status starts exactly thirty seconds from the end", () => {
  expect(fullyWatched({ duration: 120, positionSeconds: 89 })).toBe(false);
  expect(fullyWatched({ duration: 120, positionSeconds: 90 })).toBe(true);
  expect(fullyWatched({ duration: 120, positionSeconds: 120 })).toBe(true);
  expect(fullyWatched({ duration: 120, positionSeconds: 130 })).toBe(true);
});

test("zero progress never marks a video watched, including short videos", () => {
  for (const duration of [10, 30, 120]) {
    expect(fullyWatched({ duration, positionSeconds: 0 })).toBe(false);
  }
  expect(fullyWatched({ duration: 10, positionSeconds: 1 })).toBe(true);
  for (const duration of [null, 0, -1, Number.NaN, Infinity]) {
    expect(fullyWatched({ duration, positionSeconds: 100 })).toBe(false);
  }
  for (const positionSeconds of [-1, Number.NaN, Infinity]) {
    expect(fullyWatched({ duration: 120, positionSeconds })).toBe(false);
  }
});

test("watched videos restart while unfinished videos resume", () => {
  expect(resumePosition({ duration: 120, positionSeconds: 89 })).toBe(89);
  expect(resumePosition({ duration: 120, positionSeconds: 90 })).toBe(0);
  expect(resumePosition({ duration: null, positionSeconds: 90 })).toBe(90);
  expect(resumePosition({ duration: 10, positionSeconds: 0 })).toBe(0);
});
