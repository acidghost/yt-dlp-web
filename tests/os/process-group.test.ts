import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwnedProcess } from "../../app/owned-process";
import { waitFor } from "../support/async";

test("real owned group stops a TERM-resistant descendant before returning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "process-group-"));
  const ready = join(dir, "ready");
  const writes = join(dir, "writes");
  const proc = startOwnedProcess([
    "/bin/sh",
    join(import.meta.dir, "../fixtures/term-resistant.sh"),
    ready,
    writes,
  ]);
  const pipes = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  try {
    await waitFor(
      () => Bun.file(ready).exists(),
      (value) => value,
      "descendant writer readiness",
    );
    const stopping = proc.stop();
    expect(proc.stop()).toBe(stopping);
    await stopping;
    await pipes;
    const before = await Bun.file(writes).text();
    await Bun.sleep(100); // Real liveness proof, not policy time.
    expect(await Bun.file(writes).text()).toBe(before);
  } finally {
    try {
      await proc.stop();
      await pipes;
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `Unconfirmed termination: kept ${dir}; stop remaining writers before removing it.`,
      );
      // biome-ignore lint/correctness/noUnsafeFinally: Unconfirmed termination must fail disposal and retain files, even after another assertion failed.
      throw error;
    }
  }
}, 6000);

test("real owned stop confirms disappearance when the leader exits promptly on TERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "process-reaping-"));
  let safe = true;
  try {
    // Repeat the real race; the syscall suite covers its errno deterministically.
    for (let attempt = 0; attempt < 10; attempt++) {
      const ready = join(dir, `ready-${attempt}`);
      const proc = startOwnedProcess([
        "/bin/sh",
        join(import.meta.dir, "../fixtures/term-ready.sh"),
        ready,
      ]);
      safe = false;
      const pipes = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      try {
        await waitFor(
          () => Bun.file(ready).exists(),
          (value) => value,
          "leader readiness",
        );
        await proc.stop();
        await pipes;
        expect(await proc.exited).not.toBe(0);
      } finally {
        await proc.stop();
        await pipes;
        safe = true;
      }
    }
  } finally {
    if (safe) await rm(dir, { recursive: true, force: true });
    else
      console.error(
        `Unconfirmed termination: kept ${dir}; stop remaining writers before removing it.`,
      );
  }
}, 6000);
