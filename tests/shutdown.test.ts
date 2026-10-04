import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SIGTERM stops the HTTP server and exits cleanly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yt-dlp-web-shutdown-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: "3000",
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
  };
  delete env.PUBLIC_ORIGIN;
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../app/index.ts")], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        ready = (await fetch("http://127.0.0.1:3000/healthz")).ok;
        if (ready) break;
      } catch {
        // Wait for the child to bind.
      }
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    proc.kill("SIGTERM");
    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(2_000).then(() => null),
    ]);
    expect(exitCode).toBe(0);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SIGTERM stops active download descendants before removing staging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yt-dlp-active-shutdown-"));
  const bin = join(dir, "bin");
  const dataDir = join(dir, "data");
  const heartbeat = join(dir, "heartbeat");
  await mkdir(bin);
  const child = `process.on("SIGTERM", () => {}); for (let i=0; i<1000; i++) { await Bun.write(${JSON.stringify(heartbeat)}, String(i)); await Bun.sleep(10); }`;
  await writeFile(
    join(bin, "yt-dlp"),
    `#!${process.execPath}
const args = process.argv.slice(2);
await Bun.write(args[args.indexOf("--output") + 1], "partial");
const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], {stdout:"inherit",stderr:"inherit"});
await child.exited;
`,
    { mode: 0o755 },
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: "3000",
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    PATH: `${bin}:${process.env.PATH}`,
  };
  delete env.PUBLIC_ORIGIN;
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../app/index.ts")],
    { env, stdout: "ignore", stderr: "ignore" },
  );
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch("http://127.0.0.1:3000/healthz")).ok) break;
      } catch {
        /* Wait for the child to bind. */
      }
      await Bun.sleep(50);
    }
    const response = await fetch("http://127.0.0.1:3000/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://youtu.be/abcdefghijk",
        mode: "mp4",
      }),
    });
    expect(response.status).toBe(202);
    for (let i = 0; !(await Bun.file(heartbeat).exists()) && i < 100; i++)
      await Bun.sleep(10);
    expect(await Bun.file(heartbeat).exists()).toBe(true);
    const media = join(dataDir, "media", "abcdefghijk");
    expect(
      (await readdir(media)).some((name) => name.startsWith(".staging-")),
    ).toBe(true);
    proc.kill("SIGTERM");
    expect(
      await Promise.race([proc.exited, Bun.sleep(3_000).then(() => null)]),
    ).toBe(0);
    expect(await readdir(media)).toEqual([]);
    const stopped = await Bun.file(heartbeat).text();
    await Bun.sleep(100);
    expect(await Bun.file(heartbeat).text()).toBe(stopped);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 6_000);
