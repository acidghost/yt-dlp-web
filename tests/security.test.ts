import { expect, mock, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { join } from "node:path";

import { ResolvedVideoSchema } from "../app/protocol";
import { appFixture } from "./support/app";
import {
  prepared as complete,
  history,
  removeHistory,
  requestResolve,
  resolveVideo as resolve,
  videoUrl as url,
  waitForSnapshot,
  watched,
} from "./support/http";

test("allows same-port localhost pages but rejects non-loopback hosts", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const data = await resolve(base, url, {
    Host: `localhost:${fixture.app.server.port}`,
    Origin: `http://localhost:${fixture.app.server.port}`,
  });

  expect(data.kind).toBe("download");

  const media = await fetch(`${base}${data.stream}`, {
    headers: {
      Host: `localhost:${fixture.app.server.port}`,
      Origin: `http://localhost:${fixture.app.server.port}`,
    },
  });

  expect(media.status).toBe(200);
  expect(
    (
      await requestResolve(base, url, {
        Host: "evil.example:3000",
        Origin: "http://evil.example:3000",
      })
    ).status,
  ).toBe(403);
});

test("rejects bad ranges, missing files, large requests and cross-site origins", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const data = await resolve(base);
  const media = `${base}${data.stream}`;

  for (const range of ["bytes=11-", "bytes=4-2", "bytes=0-1,5-6"]) {
    const response = await fetch(media, { headers: { Range: range } });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  }

  expect((await fetch(`${base}/api/stream/unknown`)).status).toBe(404);
  expect((await requestResolve(base, "x".repeat(3000))).status).toBe(400);
  expect((await requestResolve(base, url, { Origin: "https://evil.example" })).status).toBe(403);
  expect((await fetch(`${base}/app/server.ts`)).status).toBe(404);

  const page = await (await fetch(base)).text();

  expect(page).toContain("<video-app");

  await rm(join(fixture.dataDir, "media", data.id, "video.mp4"));

  expect((await fetch(media)).status).toBe(404);
});

test("rejects malformed JSON shapes before preparing or recording a watch", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const badResolve = await fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode: 42 }),
  });

  expect(badResolve.status).toBe(400);
  expect(await badResolve.json()).toEqual({ error: "Invalid request." });
  expect(
    ResolvedVideoSchema.safeParse({
      kind: "download",
      id: "abcdefghijk",
      url,
      token: "token",
      title: "Incomplete",
      channel: null,
      duration: null,
    }).success,
  ).toBe(false);

  const resolved = await resolve(base);
  const badWatch = await fetch(`${base}/api/history/${resolved.id}/watched`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: 42 }),
  });

  expect(badWatch.status).toBe(400);
  expect(await history(base)).toEqual([]);
});

test("healthz answers probes from any Host and never emits CORS headers", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const probe = await fetch(`${base}/healthz`, {
    headers: { Host: "10.42.0.7:3000" },
  });

  expect(probe.status).toBe(200);
  expect(await probe.json()).toEqual({ ok: true });
  expect(probe.headers.get("access-control-allow-origin")).toBeNull();

  const mutation = await requestResolve(base);

  expect(mutation.headers.get("access-control-allow-origin")).toBeNull();
});

test("PUBLIC_ORIGIN admits only its host for reads and mutations", async () => {
  await using fixture = await appFixture();
  const base = fixture.start({
    proxy: true,
    publicOrigin: "https://player.example.com",
  });
  const ingress = {
    Host: "player.example.com",
    Origin: "https://player.example.com",
  };
  // Note: under `just dev`, Bun's own HTML-route guard blocks foreign Hosts
  // for the page itself; the compiled binary serves it fine (covered by the
  // build smoke test). Here we verify the API surface we control.
  const listing = await fetch(`${base}/api/history`, {
    headers: { Host: "player.example.com" },
  });

  expect(listing.status).toBe(200);
  expect(await listing.json()).toEqual([]);

  const resolved = await (
    await requestResolve(
      base,
      url,
      {
        ...ingress,
        "Sec-Fetch-Site": "same-origin",
      },
      "proxy",
    )
  ).json();

  expect(
    (
      await fetch(`${base}${resolved.hls}`, {
        headers: { Host: "player.example.com" },
      })
    ).status,
  ).toBe(200);
  // Loopback names are no longer accepted once an ingress origin is set.
  expect((await requestResolve(base)).status).toBe(403);
  expect(
    (
      await fetch(`${base}/api/history`, {
        headers: { Host: `localhost:${fixture.app.server.port}` },
      })
    ).status,
  ).toBe(403);
  // Foreign Origin is denied for both reads and mutations.
  expect(
    (
      await fetch(`${base}/api/history`, {
        headers: { Host: "player.example.com", Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await requestResolve(
        base,
        url,
        {
          Host: "player.example.com",
          Origin: "https://evil.example",
        },
        "proxy",
      )
    ).status,
  ).toBe(403);
});

test("no-Origin browser attempts and cross-site fetch metadata on mutations are denied", async () => {
  await using fixture = await appFixture();
  const base = fixture.start();
  const post = (headers: Record<string, string>) => requestResolve(base, url, headers);

  expect((await post({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await post({ "Sec-Fetch-Site": "same-site" })).status).toBe(403);
  expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).toBe(202);

  const resolved = await complete(base, await post({}));

  expect((await watched(base, resolved.id, resolved.token)).status).toBe(200);
  expect(
    (
      await removeHistory(base, resolved.id, false, {
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await removeHistory(base, resolved.id, false, {
        "Sec-Fetch-Site": "same-origin",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${base}/api/stream/${resolved.id}`, {
        headers: { Host: "evil.example:3000" },
      })
    ).status,
  ).toBe(403);
});

// Node's HTTP writer supplies actual chunk framing and can omit Content-Type;
// fetch(string) would add a media type and buffer/advertise the body length.
async function chunkedResolve(
  base: string,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      `${base}/api/resolve`,
      {
        method: "POST",
        headers: { "Transfer-Encoding": "chunked", ...headers },
      },
      resolve,
    );

    req.on("error", reject);
    req.setTimeout(2500, () => req.destroy(new Error("HTTP body request did not settle")));

    expect(req.getHeader("content-length")).toBeUndefined();

    // Split inside é's UTF-8 encoding, so byte counts cannot be character counts.
    const split = bytes.indexOf(0xc3) + 1 || Math.min(8, bytes.length);

    req.write(bytes.slice(0, split));
    req.end(bytes.slice(split));
  });
  const chunks: Buffer[] = [];

  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk));
  }

  return {
    status: response.statusCode,
    body: JSON.parse(Buffer.concat(chunks).toString()),
  };
}

function paddedResolveBody(size: number) {
  const json = JSON.stringify({ url: `${url}&note=é`, mode: "mp4" });

  return json + " ".repeat(size - Buffer.byteLength(json));
}

test.each(["buffered", "chunked"] as const)(
  "accepts otherwise-valid %s JSON at the 2048-byte limit",
  async (wire) => {
    await using fixture = await appFixture();
    const download = mock(async (_url: string, path: string) => {
      await writeFile(path, "complete");

      return { title: "Body fixture", channel: null, duration: 10 };
    });
    const base = fixture.start({ download });
    const body = paddedResolveBody(2048);

    expect(Buffer.byteLength(body)).toBe(2048);

    const response =
      wire === "chunked"
        ? await chunkedResolve(base, new TextEncoder().encode(body), {
            "Content-Type": "application/json",
          })
        : await fetch(`${base}/api/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }).then(async (response) => ({
            status: response.status,
            body: await response.json(),
          }));

    expect(response.status).toBe(202);
    expect(response.body.kind).toBe("preparing");

    await waitForSnapshot(base, response.body.jobToken, "ready");

    expect(download).toHaveBeenCalledTimes(1);
    expect(await history(base)).toEqual([]);
  },
);

test.each(["buffered", "chunked"] as const)(
  "rejects otherwise-valid %s JSON at 2049 bytes before preparation",
  async (wire) => {
    await using fixture = await appFixture();
    const download = mock(async () => ({
      title: "Must not prepare",
      channel: null,
      duration: 10,
    }));
    const base = fixture.start({ download });
    const body = paddedResolveBody(2049);

    expect(Buffer.byteLength(body)).toBe(2049);
    expect(body.length).toBe(2048);

    const response =
      wire === "chunked"
        ? await chunkedResolve(base, new TextEncoder().encode(body), {
            "Content-Type": "application/json",
          })
        : await fetch(`${base}/api/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }).then(async (response) => ({
            status: response.status,
            body: await response.json(),
          }));

    expect(response).toEqual({
      status: 400,
      body: { error: "Request is too large." },
    });
    expect(download).not.toHaveBeenCalled();
    expect(await history(base)).toEqual([]);
    expect(
      await Bun.file(join(fixture.dataDir, "media", "abcdefghijk", "video.mp4")).exists(),
    ).toBe(false);
  },
);

test.each([undefined, "text/plain", "application/octet-stream"])(
  "rejects Content-Type %s before preparation",
  async (contentType) => {
    await using fixture = await appFixture();
    const download = mock(async () => ({
      title: "Must not prepare",
      channel: null,
      duration: 10,
    }));
    const base = fixture.start({ download });
    const response = await chunkedResolve(
      base,
      new TextEncoder().encode(JSON.stringify({ url, mode: "mp4" })),
      contentType ? { "Content-Type": contentType } : {},
    );

    expect(response).toEqual({
      status: 415,
      body: { error: "Expected application/json." },
    });
    expect(download).not.toHaveBeenCalled();
    expect(await history(base)).toEqual([]);
  },
);

test.each(["", "{"])("rejects empty or invalid JSON %j before preparation", async (body) => {
  await using fixture = await appFixture();
  const download = mock(async () => ({
    title: "Must not prepare",
    channel: null,
    duration: 10,
  }));
  const base = fixture.start({ download });
  const response = await chunkedResolve(base, new TextEncoder().encode(body), {
    "Content-Type": "application/json",
  });

  expect(response).toEqual({
    status: 400,
    body: { error: "Expected JSON body." },
  });
  expect(download).not.toHaveBeenCalled();
  expect(await history(base)).toEqual([]);
});
