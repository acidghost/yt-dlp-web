import { expect, test } from "bun:test";
import { controlPlayer } from "../app/client/player-keys";

function fixture() {
  let paused = true;
  let fullscreen = false;
  const player = {
    get paused() {
      return paused;
    },
    play: async () => {
      paused = false;
    },
    pause: () => {
      paused = true;
    },
    currentTime: 2,
    duration: 30,
    seekable: { length: 0 } as TimeRanges,
    playbackRate: 1,
    volume: 1,
    muted: false,
  };
  const press = (key: string, repeat = false) =>
    controlPlayer(
      player as unknown as HTMLVideoElement,
      { key, repeat } as KeyboardEvent,
      () => {
        fullscreen = !fullscreen;
      },
    );
  return { player, press, isFullscreen: () => fullscreen };
}

test("play/pause and mute ignore repeated keys", () => {
  const { player, press } = fixture();
  expect(press(" ")).toBe(true);
  expect(player.paused).toBe(false);
  press("k", true);
  expect(player.paused).toBe(false);
  press("k");
  expect(player.paused).toBe(true);
  press("m");
  press("m", true);
  expect(player.muted).toBe(true);
  expect(press("x")).toBe(false);
});

test("fullscreen toggles with f/F and ignores repeated keys", () => {
  const { press, isFullscreen } = fixture();
  expect(press("f")).toBe(true);
  expect(isFullscreen()).toBe(true);
  expect(press("f", true)).toBe(true);
  expect(isFullscreen()).toBe(true);
  expect(press("F")).toBe(true);
  expect(isFullscreen()).toBe(false);
});

test("seeking respects media bounds and unavailable durations", () => {
  const { player, press } = fixture();
  press("ArrowRight");
  expect(player.currentTime).toBe(7);
  press("l");
  expect(player.currentTime).toBe(17);
  press("j");
  press("ArrowLeft");
  press("ArrowLeft");
  expect(player.currentTime).toBe(0);
  player.currentTime = 29;
  press("l");
  expect(player.currentTime).toBe(30);
  player.duration = Number.NaN;
  expect(press("ArrowLeft")).toBe(false);
  player.seekable = { length: 1, start: () => 12, end: () => 20 } as TimeRanges;
  player.currentTime = 13;
  press("j");
  expect(player.currentTime).toBe(12);
});

test("speed stays within player limits; vertical arrows are left for scrolling", () => {
  const { player, press } = fixture();
  for (let i = 0; i < 10; i++) press(">");
  expect(player.playbackRate).toBe(2);
  for (let i = 0; i < 10; i++) press("<");
  expect(player.playbackRate).toBe(0.25);
  expect(press("ArrowDown")).toBe(false);
  expect(press("ArrowUp")).toBe(false);
  expect(player.volume).toBe(1);
});
