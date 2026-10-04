import { expect, mock, test } from "bun:test";
import { runCli } from "../app/cli";
import { appFixture } from "./support/app";

test("CLI reset dispatch never starts a server or validates an unused port", () => {
  const start = mock(() => {
    throw new Error("Must not start");
  });
  const reset = mock();
  const log = mock();
  expect(
    runCli({
      argv: ["--reset-db"],
      env: { DATA_DIR: "fixture", PORT: "bad" },
      start,
      reset,
      log,
    }),
  ).toBeNull();
  expect(reset.mock.calls).toEqual([["fixture"]]);
  expect(start).not.toHaveBeenCalled();
  expect(log.mock.calls).toEqual([["Reset library database in fixture"]]);
});

for (const [argv, env] of [
  [["unknown"], {}],
  [["--reset-db", "extra"], {}],
  [[], { PORT: "0" }],
  [[], { PORT: "65536" }],
  [[], { PORT: "1.5" }],
  [[], { PORT: "bad" }],
] as const) {
  test(`invalid CLI input has no startup/reset effects: ${JSON.stringify({ argv, env })}`, () => {
    const start = mock(() => {
      throw new Error("Must not start");
    });
    const reset = mock();
    expect(() => runCli({ argv, env, start, reset, log: mock() })).toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
}

test("CLI composes a real application from explicit environment values", async () => {
  await using fixture = await appFixture();
  const log = mock();
  const app = runCli({
    argv: [],
    env: { PORT: "3000", HOST: "127.0.0.1", DATA_DIR: fixture.dataDir },
    log,
    start: (options) => {
      expect(options).toEqual({
        port: 3000,
        dataDir: fixture.dataDir,
        hostname: "127.0.0.1",
        publicOrigin: null,
      });
      fixture.start({ ...options, port: Number(process.env.TEST_PORT ?? 0) });
      return fixture.app;
    },
  });
  expect(app).toBe(fixture.app);
  expect((await fetch(`http://127.0.0.1:${app?.server.port}/healthz`)).ok).toBe(
    true,
  );
  expect(log).toHaveBeenCalledTimes(1);
});
