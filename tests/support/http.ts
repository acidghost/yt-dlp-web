import {
  HistoryListSchema,
  type PreparationSnapshot,
  PreparationSnapshotSchema,
  PreparingVideoSchema,
  ResolvedVideoSchema,
} from "../../app/protocol";
import { waitFor } from "./async";

export const videoUrl = "https://www.youtube.com/watch?v=abcdefghijk";

export function requestResolve(
  base: string,
  url = videoUrl,
  headers = {},
  mode = "mp4",
  signal?: AbortSignal,
) {
  return fetch(`${base}/api/resolve`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ url, mode }),
  });
}

export const cancelDownload = (base: string, token: string) =>
  fetch(`${base}/api/downloads/${token}`, { method: "DELETE" });

export async function waitForSnapshot<State extends PreparationSnapshot["state"]>(
  base: string,
  token: string,
  state: State,
  headers = {},
) {
  const snapshot = await waitFor(
    async () => {
      const response = await fetch(`${base}/api/downloads/${token}`, {
        headers,
      });
      if (!response.ok) {
        throw new Error(`Job ${token}: HTTP ${response.status}: ${await response.text()}`);
      }

      return PreparationSnapshotSchema.parse(await response.json());
    },
    (snapshot) => snapshot.state === state,
    `job ${token} to reach ${state}`,
  );

  return snapshot as Extract<PreparationSnapshot, { state: State }>;
}

// Return the real application fact, not a fabricated successful HTTP response.
export async function prepared(base: string, response: Response, headers = {}) {
  if (response.status !== 202) {
    if (!response.ok) {
      throw new Error(`Resolve: HTTP ${response.status}: ${await response.text()}`);
    }

    return ResolvedVideoSchema.parse(await response.json());
  }

  const { jobToken } = PreparingVideoSchema.parse(await response.json());
  const snapshot = await waitFor(
    async () => {
      const read = await fetch(`${base}/api/downloads/${jobToken}`, {
        headers,
      });
      if (!read.ok) {
        throw new Error(`Job ${jobToken}: HTTP ${read.status}`);
      }

      return PreparationSnapshotSchema.parse(await read.json());
    },
    (value) => value.state === "ready" || value.state === "error" || value.state === "canceled",
    `completion of job ${jobToken}`,
  );
  if (snapshot.state !== "ready") {
    throw new Error(
      `Preparation ${snapshot.state}: ${"error" in snapshot ? snapshot.error : "no playback result"}`,
    );
  }

  return snapshot.video;
}

export async function resolveVideo(base: string, url = videoUrl, headers = {}) {
  const video = await prepared(base, await requestResolve(base, url, headers), headers);
  if (video.kind !== "download") {
    throw new Error("Expected MP4 preparation");
  }

  return video;
}

export const history = async (base: string) =>
  HistoryListSchema.parse(await (await fetch(`${base}/api/history`)).json());

export const watched = (base: string, id: string, token: string, extra = {}, headers = {}) =>
  fetch(`${base}/api/history/${id}/watched`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ token, ...extra }),
  });

export const progress = (base: string, id: string, token: string, positionSeconds: unknown) =>
  fetch(`${base}/api/history/${id}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, positionSeconds }),
  });

export const proxyResolve = (base: string) => requestResolve(base, videoUrl, {}, "proxy");

export const removeHistory = (base: string, id: string, filesOnly = false, headers = {}) =>
  fetch(`${base}/api/history/${id}${filesOnly ? "/files" : ""}`, {
    method: "DELETE",
    headers,
  });
