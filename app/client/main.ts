import Hls from "hls.js";
import { html, LitElement, nothing } from "lit";
import "media-chrome";
import "media-chrome/menu";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ApiErrorSchema,
  type HistoryEntry,
  HistoryListSchema,
  OkResponseSchema,
  type PreparationSnapshot,
  PreparationSnapshotSchema,
  type ProgressRequest,
  type ResolvedVideo,
  type ResolveRequest,
  ResolveResponseSchema,
  type StorageFile,
  StorageListSchema,
  type WatchRequest,
} from "../protocol";
import {
  handoffSearch,
  type PlayerMode,
  parseHandoff,
  resolveKind,
  videoStartSeconds,
} from "./handoff";
import {
  type FilesSort,
  type HistorySort,
  historyView,
  savedTitle,
  storageView,
} from "./library-view";
import { controlPlayer } from "./player-keys";
import { fullyWatched, resumePosition } from "./watch-progress";

type Phase = "idle" | "extracting" | "downloading" | "ready" | "error" | "canceled";

const downloadPhases = {
  checking: "Checking video…",
  video: "Downloading video",
  audio: "Downloading audio",
  mp4: "Downloading MP4",
  merging: "Combining audio and video…",
  processing: "Processing MP4…",
  finalizing: "Saving MP4…",
};

type Notice = { phase: Phase; text: string };

const HISTORY_CHUNK_SIZE = 12;

function fileSize(bytes: number | null): string {
  if (bytes === null) {
    return "Size unavailable";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function durationLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "Duration unavailable";
  }

  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");

  return `${minutes}:${remainder}`;
}

@customElement("video-app")
export class VideoApp extends LitElement {
  // Keep the app in light DOM; player controls style their own Shadow DOM.
  override createRenderRoot(): HTMLElement {
    return this;
  }

  @state() private mode: PlayerMode = "proxy";
  @state() private url = "";

  @state() private notice: Notice = {
    phase: "idle",
    text: "Paste a public YouTube video URL to get started.",
  };
  @state() private source: ResolvedVideo | null = null;

  @state() private preparation: PreparationSnapshot | null = null;
  @state() private progressConnectionLost = false;
  @state() private cancelPending = false;
  @state() private cancelError = "";
  @state() private jobToken: string | null = null;
  private preparationGeneration = 0;
  private preparationFocus: Element | null = null;
  private pollTimer: number | undefined;
  private pollController: AbortController | null = null;
  private pollFailures = 0;

  @state() private history: HistoryEntry[] = [];
  @state() private historyError = "";
  @state() private historyLoaded = false;
  @state() private storage: StorageFile[] | null = null;
  @state() private storageError = "";
  @state() private storageStale = false;
  private storageRequest = 0;
  @state() private libraryView: "history" | "files" = "history";
  @state() private libraryQuery = "";
  @state() private historySort: HistorySort = "recent";
  @state() private filesSort: FilesSort = "largest";

  @state() private widePlayer = false;
  @state() private showBackToPlayer = false;
  @state() private visibleHistoryCount = HISTORY_CHUNK_SIZE;
  @state() private deleting = false;
  @state() private updatingProgress = false;

  @state() private copyStatus = "";
  @state() private copyFallback = "";
  private copyStatusTimer: number | undefined;

  private startSeconds: number | undefined;
  private historyRequest = 0;
  private watchedThisPlay = false;
  private watchRecorded = false;
  private hls: Hls | null = null;
  private pendingResumeSeconds: number | null = null;

  private lastProgressAt = 0;
  private lastProgressSeconds = -1;
  private progressInFlight = false;
  private progressSaved: Promise<void> = Promise.resolve();
  private pendingProgress: { source: ResolvedVideo; seconds: number } | null = null;

  private get busy(): boolean {
    return (
      this.deleting ||
      this.updatingProgress ||
      this.notice.phase === "extracting" ||
      this.notice.phase === "downloading"
    );
  }

  private fail(message: string): void {
    this.notice = { phase: "error", text: message };
  }

  private attachReady(): void {
    this.pendingResumeSeconds =
      this.startSeconds ?? (this.source ? resumePosition(this.source) : 0);
    if (this.attachSource()) {
      this.notice = {
        phase: "ready",
        text: this.pendingResumeSeconds
          ? `Ready to continue at ${durationLabel(this.pendingResumeSeconds)}. Press play in the video controls.`
          : "Ready. Press play in the video controls.",
      };
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("scroll", this.updateBackToPlayer, {
      passive: true,
    });
    window.addEventListener("resize", this.updateBackToPlayer);
    window.addEventListener("pagehide", this.cancelOnExit);
    window.addEventListener("pageshow", this.resumePreparation);
    document.addEventListener("visibilitychange", this.saveOnHide);
    document.addEventListener("keydown", this.handleKey);
    void this.refreshLibrary();
    if (this.jobToken) {
      void this.pollPreparation(this.preparationGeneration, this.jobToken);
    }
  }

  override firstUpdated(): void {
    const handoff = parseHandoff(window.location.search);
    if (!handoff) {
      return;
    }
    if ("error" in handoff) {
      this.url = new URLSearchParams(window.location.search).get("url") ?? "";
      this.fail(handoff.error);

      return;
    }

    this.url = handoff.url;
    this.mode = handoff.mode;
    this.startSeconds = handoff.startSeconds;
    // Prepare the selected source, but never start browser playback automatically.
    void this.prepare(false);
  }

  private get player(): HTMLVideoElement {
    const player = this.querySelector("video");
    if (!player) {
      throw new Error("Missing video element");
    }

    return player;
  }

  private async loadHistory(): Promise<void> {
    const request = ++this.historyRequest;

    try {
      const response = await fetch("/api/history");
      if (!response.ok) {
        throw new Error("Could not load history.");
      }

      const entries = HistoryListSchema.parse(await response.json());
      if (request !== this.historyRequest) {
        return;
      }

      // A history read may have started before the latest progress save.
      this.history = entries.map((entry) =>
        this.watchRecorded && entry.id === this.source?.id
          ? { ...entry, positionSeconds: this.source.positionSeconds }
          : entry,
      );
      this.historyError = "";
      this.historyLoaded = true;
    } catch {
      if (request !== this.historyRequest) {
        return;
      }

      this.historyError = "Could not load watch history. Playback is still available.";
    }
  }

  private async loadStorage(): Promise<void> {
    const request = ++this.storageRequest;

    try {
      const response = await fetch("/api/storage");
      if (!response.ok) {
        throw new Error("Could not load storage.");
      }
      const files = StorageListSchema.parse(await response.json());
      if (request !== this.storageRequest) {
        return;
      }

      this.storage = files;
      this.storageError = "";
      this.storageStale = false;
    } catch {
      if (request !== this.storageRequest) {
        return;
      }
      this.storageError = "Could not load saved MP4s. Refresh library to try again.";
      this.storageStale = true;
    }
  }

  private async refreshLibrary(): Promise<void> {
    // Each read owns its error and generation; neither suppresses the other.
    await Promise.all([this.loadHistory(), this.loadStorage()]);
  }

  private invalidateStorage(): void {
    ++this.storageRequest;
    this.storageStale = true;
  }

  private resetPlayer(): void {
    this.hls?.destroy();
    this.hls = null;
    this.player.pause();
    this.player.removeAttribute("src");
    this.player.load();

    // A source reset must not leave an open speed menu over disabled controls.
    const menu = this.querySelector<HTMLElement>("media-playback-rate-menu");
    if (menu) {
      menu.hidden = true;
    }
    this.watchedThisPlay = false;
    this.watchRecorded = false;
    this.pendingResumeSeconds = null;
    this.resetCopyFeedback();
    this.lastProgressAt = 0;
    this.lastProgressSeconds = -1;
  }

  private attachSource(): boolean {
    const source = this.source;
    if (!source) {
      return false;
    }
    if (source.kind === "download") {
      this.player.src = source.stream;

      return true;
    }
    if (Hls.isSupported()) {
      const hls = new Hls();

      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && this.hls === hls) {
          this.fail(`HLS playback failed: ${data.details}`);
        }
      });
      hls.loadSource(source.hls);
      hls.attachMedia(this.player);

      return true;
    }
    if (this.player.canPlayType("application/vnd.apple.mpegurl")) {
      this.player.src = source.hls;

      return true;
    }

    this.fail("This browser cannot play HLS. Try Download + Native MP4.");

    return false;
  }

  private updateAddress(): void {
    const url = this.url.trim();
    const search = url ? `?${handoffSearch(url, this.mode, this.startSeconds)}` : "";

    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  }

  private submit(event: SubmitEvent): void {
    event.preventDefault();
    void this.prepare();
  }

  private changeUrl(event: Event): void {
    this.url = (event.currentTarget as HTMLInputElement).value;
    this.startSeconds = videoStartSeconds(this.url.trim());
  }

  private async clearUrl(): Promise<void> {
    this.url = "";
    this.startSeconds = undefined;
    await this.updateComplete;
    this.querySelector<HTMLInputElement>("#url")?.focus();
  }

  private resetCopyFeedback(): void {
    window.clearTimeout(this.copyStatusTimer);
    this.copyStatusTimer = undefined;
    this.copyStatus = "";
    this.copyFallback = "";
  }

  private async copyTimestampLink(): Promise<void> {
    const source = this.source;
    if (!source) {
      return;
    }

    const seconds = this.player.currentTime;
    if (!Number.isFinite(seconds) || seconds < 0) {
      return;
    }

    const link = new URL(window.location.pathname, window.location.origin);

    link.search = handoffSearch(
      source.url,
      source.kind === "download" ? "mp4" : "proxy",
      Math.floor(seconds),
    );
    this.resetCopyFeedback();

    try {
      await navigator.clipboard.writeText(link.href);
      if (this.source !== source || !this.isConnected) {
        return;
      }

      this.resetCopyFeedback();
      this.copyStatus = "Copied";
      this.copyStatusTimer = window.setTimeout(() => {
        this.copyStatus = "";
        this.copyStatusTimer = undefined;
      }, 3000);
    } catch {
      if (this.source !== source || !this.isConnected) {
        return;
      }

      this.resetCopyFeedback();
      this.copyStatus = "Could not copy. Copy the link below.";
      this.copyFallback = link.href;
    }
  }

  private async prepare(updateAddress = true): Promise<void> {
    if (this.busy) {
      return;
    }

    const url = this.url.trim();
    if (updateAddress) {
      this.updateAddress();
    }
    if (!url) {
      this.fail("Enter a video URL.");

      return;
    }

    const focused = this.ownerDocument.activeElement;

    this.preparationFocus = focused;

    const generation = ++this.preparationGeneration;

    this.clearPoll();
    this.jobToken = null;
    this.preparation = null;
    this.progressConnectionLost = false;
    this.cancelPending = false;
    this.cancelError = "";
    this.pollFailures = 0;
    this.saveProgress(true);
    this.source = null;
    this.resetPlayer();

    const kind = resolveKind(this.mode);
    if (kind === "download") {
      this.invalidateStorage();
    }

    this.notice =
      kind === "proxy"
        ? { phase: "extracting", text: "Extracting YouTube HLS tracks…" }
        : {
            phase: "downloading",
            text: downloadPhases.checking,
          };

    try {
      const request: ResolveRequest = {
        url,
        mode: this.mode,
      };
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = ApiErrorSchema.safeParse(payload);

        throw new Error(failure.success ? failure.data.error : "Could not prepare video.");
      }

      const result = ResolveResponseSchema.safeParse(payload);
      if (
        !result.success ||
        (result.data.kind !== kind && !(kind === "download" && result.data.kind === "preparing"))
      ) {
        throw new Error("Server returned an invalid video response.");
      }
      if (generation !== this.preparationGeneration || !this.isConnected) {
        if (result.data.kind === "preparing") {
          this.cancelKeepalive(result.data.jobToken);
        }

        return;
      }

      if (result.data.kind === "preparing") {
        this.jobToken = result.data.jobToken;
        void this.pollPreparation(generation, this.jobToken);
      } else {
        this.source = result.data;
        this.attachReady();
        void this.refreshLibrary();
      }
    } catch (error) {
      if (generation === this.preparationGeneration && this.isConnected) {
        this.fail(
          error instanceof Error && error.name === "TimeoutError"
            ? "Preparation request timed out. A download may still be running; retry preparation."
            : error instanceof Error
              ? error.message
              : "Could not prepare video.",
        );
        void this.refreshLibrary();
      }
    } finally {
      await this.updateComplete;
      if (
        generation === this.preparationGeneration &&
        focused instanceof HTMLElement &&
        focused.isConnected &&
        this.ownerDocument.activeElement === this.ownerDocument.body
      ) {
        focused.focus();
      }
    }
  }

  private clearPoll(): void {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollController?.abort();
    this.pollController = null;
  }

  private activePreparation(generation: number, token: string): boolean {
    return this.isConnected && generation === this.preparationGeneration && token === this.jobToken;
  }

  private finishPreparation(): void {
    this.clearPoll();
    this.jobToken = null;
    this.preparation = null;
    this.cancelPending = false;
    this.cancelError = "";
    this.progressConnectionLost = false;
  }

  private applyPreparation(snapshot: PreparationSnapshot): void {
    this.preparation = snapshot;
    this.cancelPending = false;
    this.progressConnectionLost = false;
    if (snapshot.state === "preparing") {
      this.notice = {
        phase: "downloading",
        text: downloadPhases[snapshot.phase],
      };
    } else if (snapshot.state === "canceling") {
      this.cancelError = "";
      this.notice = {
        phase: "downloading",
        text: "Canceling download… Removing partial files.",
      };
    } else {
      const generation = this.preparationGeneration;
      const canceled = snapshot.state === "canceled";
      const focused = canceled
        ? this.querySelector<HTMLButtonElement>('button[aria-label="Prepare video"]')
        : this.preparationFocus;

      this.preparationFocus = null;
      this.finishPreparation();
      if (snapshot.state === "ready" && snapshot.video.kind === "download") {
        this.source = snapshot.video;
        this.attachReady();
      } else if (snapshot.state === "canceled") {
        this.notice = {
          phase: "canceled",
          text: "Download canceled. Partial files removed.",
        };
      } else {
        this.fail(
          snapshot.state === "error"
            ? snapshot.error
            : "Server returned an invalid video response.",
        );
      }

      // Terminal status arrives after publication or cancellation/error cleanup.
      void this.refreshLibrary();

      // Prepare and the outcome notice are outside the fullscreen target.
      // Leave an empty fullscreen player on cancellation/failure, not on ready.
      const exit =
        !this.source &&
        this.ownerDocument.fullscreenElement === this.querySelector("media-controller")
          ? this.ownerDocument.exitFullscreen().catch(() => {})
          : Promise.resolve();

      void Promise.all([this.updateComplete, exit]).then(() => {
        if (
          generation === this.preparationGeneration &&
          focused instanceof HTMLElement &&
          focused.isConnected &&
          (canceled || this.ownerDocument.activeElement === this.ownerDocument.body)
        ) {
          const fullscreen = this.ownerDocument.fullscreenElement;
          if (fullscreen && !fullscreen.contains(focused)) {
            (this.source
              ? this.player
              : this.querySelector<HTMLElement>("media-fullscreen-button")
            )?.focus();
          } else {
            focused.focus();
          }
        }
      });
    }
  }

  private async pollPreparation(generation: number, token: string): Promise<void> {
    if (!this.activePreparation(generation, token)) {
      return;
    }

    const controller = new AbortController();

    this.pollController = controller;

    try {
      const response = await fetch(`/api/downloads/${token}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!this.activePreparation(generation, token)) {
        return;
      }
      if (response.status === 404) {
        this.applyPreparation({
          state: "error",
          error: "Download status expired or the server restarted. Prepare video again.",
        });

        return;
      }
      if (!response.ok) {
        throw new Error("Progress unavailable");
      }

      const snapshot = PreparationSnapshotSchema.parse(await response.json());
      if (!this.activePreparation(generation, token)) {
        return;
      }

      this.pollFailures = 0;
      this.applyPreparation(snapshot);
    } catch {
      if (!this.activePreparation(generation, token)) {
        return;
      }

      this.pollFailures++;
      this.progressConnectionLost = true;
      this.notice = {
        phase: "downloading",
        text: "Progress connection lost. Reconnecting…",
      };
    } finally {
      if (this.pollController === controller) {
        this.pollController = null;
      }
    }

    if (this.activePreparation(generation, token)) {
      const delay = Math.min(8_000, 1_000 * 2 ** Math.min(this.pollFailures, 3));

      this.pollTimer = window.setTimeout(() => void this.pollPreparation(generation, token), delay);
    }
  }

  private async cancelDownload(): Promise<void> {
    const token = this.jobToken;
    if (
      !token ||
      this.cancelPending ||
      this.preparation?.state === "canceling" ||
      (this.preparation?.state === "preparing" && this.preparation.phase === "finalizing")
    ) {
      return;
    }

    // Invalidate any in-flight GET before sending DELETE; old ready replies
    // must not attach a source over a cancellation or a later preparation.
    const generation = ++this.preparationGeneration;

    this.clearPoll();
    this.invalidateStorage();
    this.cancelPending = true;
    this.cancelError = "";
    this.notice = { phase: "downloading", text: "Canceling download…" };

    try {
      const response = await fetch(`/api/downloads/${token}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error("Could not cancel");
      }

      const snapshot = PreparationSnapshotSchema.parse(await response.json());
      if (!this.activePreparation(generation, token)) {
        return;
      }

      this.applyPreparation(snapshot);
    } catch {
      if (!this.activePreparation(generation, token)) {
        return;
      }

      this.cancelError = "Could not cancel download. It may still be running; try again.";
      this.notice = { phase: "downloading", text: this.cancelError };
      this.progressConnectionLost = true;
    } finally {
      if (generation === this.preparationGeneration) {
        this.cancelPending = false;
      }
      if (this.activePreparation(generation, token)) {
        void this.pollPreparation(generation, token);
      }
    }
  }

  private cancelKeepalive(token: string): void {
    void fetch(`/api/downloads/${token}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  }

  private readonly cancelOnExit = (): void => {
    ++this.preparationGeneration;
    this.clearPoll();
    if (this.jobToken) {
      this.cancelKeepalive(this.jobToken);
    }
  };

  private readonly resumePreparation = (event: PageTransitionEvent): void => {
    // A back/forward-cache restore is not a new background job: reconcile the
    // cancellation sent on pagehide so the restored form does not stay busy.
    if (event.persisted && this.jobToken) {
      void this.pollPreparation(this.preparationGeneration, this.jobToken);
    }
  };

  private changeMode(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value !== "proxy" && value !== "mp4") {
      return;
    }

    this.mode = value;
    this.updateAddress();
    if (this.busy) {
      return;
    }

    if (!this.source) {
      this.notice = {
        phase: "idle",
        text: "Press Prepare video to use the selected mode.",
      };

      return;
    }

    if (this.source.kind === "download" && value === "mp4") {
      this.resetPlayer();
      this.attachReady();

      return;
    }

    // A proxy switch extracts fresh signed URLs; a download reuses the saved MP4.
    void this.prepare(false);
  }

  private replay(entry: Pick<HistoryEntry, "url" | "mp4">): void {
    if (this.busy) {
      return;
    }

    this.url = entry.url;
    this.startSeconds = undefined;
    this.mode = entry.mp4.sizeBytes !== null ? "mp4" : "proxy";
    this.focusPlayer();
    void this.prepare();
  }

  private focusPlayer(): void {
    this.player.focus();
    this.player.scrollIntoView({ block: "start" });
  }

  private readonly updateBackToPlayer = (): void => {
    const player = this.querySelector("video");
    if (player) {
      this.showBackToPlayer = player.getBoundingClientRect().bottom <= 0;
    }
  };

  private changeLibraryView(view: "history" | "files"): void {
    this.libraryView = view;
    this.visibleHistoryCount = HISTORY_CHUNK_SIZE;
  }

  private changeLibraryQuery(event: Event): void {
    this.libraryQuery = (event.currentTarget as HTMLInputElement).value;
    this.visibleHistoryCount = HISTORY_CHUNK_SIZE;
  }

  private async clearLibrarySearch(): Promise<void> {
    this.libraryQuery = "";
    this.visibleHistoryCount = HISTORY_CHUNK_SIZE;
    await this.updateComplete;
    this.querySelector<HTMLInputElement>("#library-query")?.focus();
  }

  private changeLibrarySort(event: Event): void {
    const sort = (event.currentTarget as HTMLSelectElement).value;
    if (this.libraryView === "history" && (sort === "recent" || sort === "oldest")) {
      this.historySort = sort;
    } else if (this.libraryView === "files" && (sort === "largest" || sort === "most-recent")) {
      this.filesSort = sort;
    } else {
      return;
    }
    this.visibleHistoryCount = HISTORY_CHUNK_SIZE;
  }

  private showMoreHistory(): void {
    this.visibleHistoryCount += HISTORY_CHUNK_SIZE;
  }

  private togglePlayerWidth(): void {
    this.widePlayer = !this.widePlayer;
  }

  private async deleteEntry(
    entry: Pick<HistoryEntry, "id" | "title">,
    filesOnly: boolean,
  ): Promise<void> {
    if (this.busy) {
      return;
    }

    const action = filesOnly ? "Delete downloaded files" : "Delete files and history";
    if (!window.confirm(`${action} for "${entry.title}"?`)) {
      return;
    }

    if (this.source?.id === entry.id) {
      this.source = null;
      this.resetPlayer();
    }

    this.deleting = true;
    ++this.historyRequest;
    this.invalidateStorage();

    try {
      const path = `/api/history/${entry.id}${filesOnly ? "/files" : ""}`;
      const response = await fetch(path, { method: "DELETE" });
      if (!response.ok) {
        const failure = ApiErrorSchema.safeParse(await response.json().catch(() => null));

        throw new Error(failure.success ? failure.data.error : "Could not delete video.");
      }

      const payload: unknown = await response.json().catch(() => null);
      if (!OkResponseSchema.safeParse(payload).success) {
        throw new Error("Server returned an invalid delete response.");
      }

      await this.refreshLibrary();
      this.notice = {
        phase: "idle",
        text: filesOnly ? "Downloaded files deleted." : "Files and history deleted.",
      };
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Could not delete video.");
    } finally {
      this.deleting = false;
      await this.updateComplete;

      const selector = this.libraryView === "history" ? ".history-item" : ".saved-file-item";
      const item = [...this.querySelectorAll<HTMLElement>(selector)].find(
        (element) => element.dataset.id === entry.id,
      );
      if (filesOnly && item) {
        item.querySelector<HTMLButtonElement>(".history-play")?.focus();
      } else {
        this.querySelector<HTMLElement>("#history-title")?.focus();
      }
    }
  }

  private async setWatchProgress(entry: HistoryEntry, watched: boolean): Promise<void> {
    if (this.busy) {
      return;
    }

    const failureMessage = watched
      ? "Could not mark video as watched. Try again."
      : "Could not reset watch progress. Try again.";

    this.updatingProgress = true;
    ++this.historyRequest;

    const source = this.source?.id === entry.id ? this.source : null;
    if (source) {
      // Pause without saving again; queued/in-flight writes must finish before the edit.
      this.watchRecorded = false;
      this.player.pause();
    }
    if (this.pendingProgress?.source.id === entry.id) {
      this.pendingProgress = null;
    }

    try {
      await this.progressSaved;

      const response = await fetch(`/api/history/${entry.id}/progress`, {
        method: watched ? "PUT" : "DELETE",
      });
      if (!response.ok || !OkResponseSchema.safeParse(await response.json()).success) {
        throw new Error(failureMessage);
      }

      if (source) {
        // Invalidate any late watch-recording response from before this edit.
        this.source = {
          ...source,
          positionSeconds: watched ? (entry.duration ?? 0) : 0,
        };
        this.watchedThisPlay = false;
        this.pendingResumeSeconds = 0;
        this.resumePlayback();
        this.lastProgressAt = 0;
        this.lastProgressSeconds = -1;
        this.startSeconds = undefined;
        this.updateAddress();
        this.notice = {
          phase: "ready",
          text: watched
            ? "Marked as fully watched. Press play to start from the beginning."
            : "Watch progress reset. Press play to start from the beginning.",
        };
      }
      await this.loadHistory();
    } catch {
      this.historyError = failureMessage;
      // A failed edit leaves the paused source usable and its saved progress intact.
      if (source) {
        this.watchedThisPlay = false;
      }
    } finally {
      this.updatingProgress = false;
      await this.updateComplete;

      // The action changes after editing progress; keep keyboard focus in this row.
      const item = [...this.querySelectorAll<HTMLLIElement>(".history-item")].find(
        (element) => element.dataset.id === entry.id,
      );

      if (item) {
        item.querySelector<HTMLButtonElement>(".history-play")?.focus();
      } else {
        this.querySelector<HTMLElement>("#history-title")?.focus();
      }
    }
  }

  private startedPlay(): void {
    this.watchedThisPlay = false;
    this.watchRecorded = false;
  }

  private resumePlayback(): void {
    if (this.pendingResumeSeconds === null) {
      return;
    }

    const duration = this.player.duration;
    if (Number.isNaN(duration) || duration <= 0) {
      return;
    }

    const position = this.pendingResumeSeconds;
    const seconds = Number.isFinite(duration) ? Math.min(position, duration) : position;

    try {
      this.player.currentTime = seconds;
      this.pendingResumeSeconds = null;
      if (seconds !== position && this.notice.phase === "ready") {
        this.notice = {
          phase: "ready",
          text: `Ready to continue at ${durationLabel(seconds)}. Press play in the video controls.`,
        };
      }
    } catch {
      // Some HLS streams do not expose a seekable range immediately.
    }
  }

  private saveProgress(force = false): void {
    const source = this.source;
    if (!source || !this.watchRecorded || this.updatingProgress) {
      return;
    }

    const seconds = Math.floor(this.player.currentTime);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastProgressAt < 5000) {
      return;
    }
    if (!force && seconds === this.lastProgressSeconds) {
      return;
    }

    this.lastProgressAt = now;
    this.lastProgressSeconds = seconds;
    this.pendingProgress = { source, seconds };
    if (!this.progressInFlight) {
      this.progressSaved = this.flushProgress();
    }
  }

  private async flushProgress(): Promise<void> {
    if (this.progressInFlight) {
      return;
    }

    this.progressInFlight = true;

    try {
      while (this.pendingProgress) {
        const { source, seconds } = this.pendingProgress;

        this.pendingProgress = null;

        const request: ProgressRequest = {
          token: source.token,
          positionSeconds: seconds,
        };

        try {
          const response = await fetch(`/api/history/${source.id}/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
            keepalive: true,
          });
          if (!response.ok || !OkResponseSchema.safeParse(await response.json()).success) {
            continue;
          }

          source.positionSeconds = seconds;
          this.history = this.history.map((entry) =>
            entry.id === source.id ? { ...entry, positionSeconds: seconds } : entry,
          );
        } catch {
          // A later time update or pause can retry saving the position.
        }
      }
    } finally {
      this.progressInFlight = false;
    }
  }

  private readonly saveOnHide = (): void => {
    if (document.visibilityState === "hidden") {
      this.saveProgress(true);
    }
  };

  private focusRateMenu(event: Event): void {
    const menu = event.currentTarget as HTMLElement;
    if (event.target !== menu || menu.hidden) {
      return;
    }

    // Complete the menu's transition-driven focus handoff when animations are
    // disabled or coalesced, consuming the pending once-listener as well.
    if (menu.getAnimations().length === 0) {
      menu.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "opacity" }));
    }
  }

  private readonly toggleFullscreen = (): void => {
    // Reuse the control's fullscreen target and browser fallbacks.
    this.querySelector<HTMLElement>("media-fullscreen-button")?.click();
  };

  private handleSeekKey(event: KeyboardEvent): void {
    if (!this.source || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    // Keep all player shortcuts available while the seek slider is focused.
    // Prevent native range steps for handled keys; leave Home/End alone.
    if (controlPlayer(this.player, event, this.toggleFullscreen)) {
      event.preventDefault();
    }
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }

    if (
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "k"
    ) {
      const input = this.querySelector<HTMLInputElement>("#url");
      if (input && !input.disabled) {
        event.preventDefault();
        input.focus();
      }
      return;
    }

    if (!this.source || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    // event.target is retargeted at shadow boundaries. Let buttons, ranges and
    // menus own their keys even when their internal input is hidden from target.
    if (
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            (target.closest(
              "input, textarea, select, button, a, [contenteditable], [role='button'], [role='textbox'], [role='slider'], [role='menu'], [role^='menuitem'], [role='listbox'], [role='option'], [role='combobox']",
            ) ||
              (target as HTMLElement).isContentEditable),
        )
    ) {
      return;
    }

    if (controlPlayer(this.player, event, this.toggleFullscreen)) {
      event.preventDefault();
    }
  };

  private async playing(): Promise<void> {
    const source = this.source;
    if (!source || this.watchedThisPlay || this.updatingProgress) {
      return;
    }

    this.watchedThisPlay = true;

    try {
      const request: WatchRequest = { token: source.token };
      const response = await fetch(`/api/history/${source.id}/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok || !OkResponseSchema.safeParse(await response.json()).success) {
        throw new Error("Could not save watch history.");
      }
      if (this.source !== source || this.updatingProgress) {
        return;
      }

      this.watchRecorded = true;
      if (this.player.paused) {
        this.saveProgress(true);
      }
      void this.refreshLibrary();
    } catch {
      if (this.source === source) {
        this.notice = {
          ...this.notice,
          text: "Playing, but could not save watch history.",
        };
      }
    }
  }

  private playbackError(): void {
    if (!this.source || !this.player.currentSrc) {
      return;
    }

    this.fail(
      this.source.kind === "proxy"
        ? "Proxy playback failed. Signed links may have expired; prepare the video again."
        : "Playback failed. Check that the downloaded files still exist.",
    );
  }

  override disconnectedCallback(): void {
    ++this.storageRequest;
    this.cancelOnExit();
    this.resetCopyFeedback();
    window.removeEventListener("scroll", this.updateBackToPlayer);
    window.removeEventListener("resize", this.updateBackToPlayer);
    window.removeEventListener("pagehide", this.cancelOnExit);
    window.removeEventListener("pageshow", this.resumePreparation);
    document.removeEventListener("visibilitychange", this.saveOnHide);
    document.removeEventListener("keydown", this.handleKey);
    this.hls?.destroy();
    this.hls = null;
    super.disconnectedCallback();
  }

  override render() {
    return html`
      ${this.renderPlayer()}
      ${
        this.showBackToPlayer
          ? html`
              <button
                class="back-to-player plain <big>"
                type="button"
                @click=${this.focusPlayer}
              >
                Back to player
              </button>
            `
          : ""
      }
      ${this.renderHistory()}
    `;
  }

  override updated(): void {
    this.updateBackToPlayer();
  }

  private renderPlayer() {
    const statusColorway =
      this.notice.phase === "error"
        ? "bad color"
        : this.notice.phase === "ready"
          ? "ok color"
          : "info color";
    const playerClass = `player-panel console${this.widePlayer ? " wide-player" : ""}`;

    return html`
      <section class=${playerClass} aria-labelledby="player-title">
        <h2 id="player-title" class="vh">Player</h2>

        <form id="resolve" @submit=${this.submit}>
          <label class="vh" for="url">YouTube video URL</label>
          <label class="vh" for="player-mode">Playback mode</label>
          <div class="player-controls tool-bar">
            <div class="clearable-input">
              <input
                id="url"
                type="url"
                placeholder="https://www.youtube.com/watch?v=…"
                autocomplete="url"
                aria-keyshortcuts="Control+k"
                required
                .value=${this.url}
                @input=${this.changeUrl}
                ?disabled=${this.busy}
              >
              <button
                class="input-clear"
                type="button"
                aria-label="Clear URL"
                title="Clear URL"
                ?hidden=${!this.url}
                ?disabled=${this.busy}
                @click=${this.clearUrl}
              ><span aria-hidden="true">×</span></button>
            </div>
            <select
              id="player-mode"
              .value=${this.mode}
              @change=${this.changeMode}
              ?disabled=${this.busy}
            >
              <option value="proxy">Proxy YouTube HLS (starts sooner)</option>
              <option value="mp4">Download + Native MP4</option>
            </select>
            <strong>
              <button
                class="console <big>"
                type="submit"
                aria-label="Prepare video"
                title="Prepare video"
                ?disabled=${this.busy}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#prepare-icon"></use>
                </svg>
              </button>
            </strong>
            <button
              class="plain <big>"
              type="button"
              aria-pressed=${this.widePlayer}
              @click=${this.togglePlayerWidth}
            >
              Fill page
            </button>
          </div>
        </form>

        <p
          id="status"
          class=${statusColorway}
          data-phase=${this.notice.phase}
          role="status"
          aria-live="polite"
        >${this.notice.text}</p>
        ${
          this.notice.phase === "error"
            ? html`
                <p class="hint">${
                  this.mode === "proxy"
                    ? "Retry preparation or choose Download + Native MP4."
                    : "Retry preparation or try Proxy YouTube HLS."
                }</p>
              `
            : ""
        }
        ${
          this.source
            ? html`
                <h3 id="title">${this.source.title}</h3>
                <p class="video-meta">${
                  this.source.channel ? html`${this.source.channel} · ` : ""
                }${durationLabel(this.source.duration)}</p>
              `
            : ""
        }

        <media-controller
          class="player-controller"
          nohotkeys
          novolumepref
          nomutedpref
          ?noautohide=${this.notice.phase === "downloading"}
          defaultstreamtype="on-demand"
          ?gesturesdisabled=${!this.source}
        >
          <!-- biome-ignore lint/a11y/useMediaCaption: Captions are not extracted in this app. -->
          <video
            id="player"
            slot="media"
            playsinline
            preload="none"
            tabindex="0"
            aria-label="Video player"
            @play=${this.startedPlay}
            @playing=${this.playing}
            @loadedmetadata=${this.resumePlayback}
            @canplay=${this.resumePlayback}
            @timeupdate=${() => this.saveProgress()}
            @pause=${() => this.saveProgress(true)}
            @ended=${() => this.saveProgress(true)}
            @error=${this.playbackError}
          ></video>
          ${this.renderPreparation()}
          <media-playback-rate-menu
            hidden
            anchor="auto"
            @toggle=${this.focusRateMenu}
            rates="0.25 0.5 0.75 1 1.25 1.5 1.75 2"
            ?disabled=${!this.source}
            aria-disabled=${this.source ? nothing : "true"}
          ></media-playback-rate-menu>
          <media-control-bar class="player-actions">
            <!-- Block activation too: tooltip setup can attach click listeners to disabled buttons. -->
            <media-play-button
              .preventClick=${!this.source}
              ?disabled=${!this.source}
              aria-disabled=${this.source ? nothing : "true"}
            ></media-play-button>
            <media-mute-button
              .preventClick=${!this.source}
              ?disabled=${!this.source}
              aria-disabled=${this.source ? nothing : "true"}
            ></media-mute-button>
            <media-volume-range
              ?disabled=${!this.source}
              aria-disabled=${this.source ? nothing : "true"}
            ></media-volume-range>
            <media-time-range
              ?disabled=${!this.source}
              aria-disabled=${this.source ? nothing : "true"}
              @keydown=${this.handleSeekKey}
            ></media-time-range>
            <media-time-display showduration notoggle></media-time-display>
            <span class="player-control-spacer"></span>
            <media-playback-rate-menu-button
              .preventClick=${!this.source}
              ?disabled=${!this.source}
              aria-disabled=${this.source ? nothing : "true"}
            ></media-playback-rate-menu-button>
            <media-fullscreen-button></media-fullscreen-button>
          </media-control-bar>
        </media-controller>

        <p class="hint player-shortcuts">
          Keyboard: <kbd>Ctrl+K</kbd> focus URL · <kbd>Space</kbd>/<kbd>K</kbd> play/pause
          · <kbd>←</kbd>/<kbd>→</kbd> seek 5s
          · <kbd>J</kbd>/<kbd>L</kbd> seek 10s · <kbd>&lt;</kbd>/<kbd>&gt;</kbd> speed · <kbd>M</kbd> mute
          · <kbd>F</kbd> fullscreen
        </p>
        <div class="timestamp-tools tool-bar">
          <button
            class="plain <big>"
            type="button"
            ?disabled=${!this.source}
            @click=${this.copyTimestampLink}
          >
            Copy timestamp link
          </button>
          <span role="status" aria-live="polite">${this.copyStatus}</span>
          ${
            this.copyFallback
              ? html`
                  <label>
                    Timestamp link
                    <input type="text" readonly .value=${this.copyFallback}>
                  </label>
                `
              : nothing
          }
        </div>
      </section>
    `;
  }

  private renderPreparation() {
    if (this.notice.phase !== "downloading") {
      return nothing;
    }

    const snapshot = this.preparation;
    const progress = snapshot?.state === "preparing" ? snapshot : null;
    const phase = progress?.phase ?? "checking";
    const canceling = this.cancelPending || snapshot?.state === "canceling";
    const finalizing = phase === "finalizing";
    const postprocessing = phase === "merging" || phase === "processing";
    const transferring = !canceling && phase !== "checking" && !postprocessing && !finalizing;

    const bytes = progress?.downloadedBytes ?? null;
    const total = progress?.totalBytes ?? null;
    const estimate = progress?.totalEstimated ? "≈ " : "";
    const percentage =
      transferring && !this.progressConnectionLost && bytes !== null && total !== null
        ? Math.min(100, (bytes / total) * 100)
        : null;
    const byteText = canceling
      ? "Removing partial files"
      : bytes === null
        ? "Waiting for transfer data"
        : !transferring
          ? `Last transfer: ${fileSize(bytes)} downloaded`
          : total === null
            ? `${fileSize(bytes)} downloaded`
            : `${fileSize(bytes)} of ${estimate}${fileSize(total)}`;
    const speedText = this.progressConnectionLost
      ? "Speed unavailable"
      : progress?.speedBytesPerSecond == null
        ? "Calculating speed…"
        : `${(progress.speedBytesPerSecond / (1024 * 1024)).toFixed(1)} MiB/s`;

    const progressLabel =
      phase === "audio"
        ? "Current audio track download"
        : phase === "video"
          ? "Current video track download"
          : "MP4 preparation progress";
    const progressValueText =
      percentage === null
        ? "Total size unavailable"
        : `${estimate ? "Approximately " : ""}${Math.round(percentage)} percent of current transfer`;
    const support = canceling
      ? "Waiting for the process to stop and cleanup to finish."
      : finalizing
        ? "Publishing the finished MP4. Cancellation is no longer available."
        : phase === "merging"
          ? "Preparing one playable MP4."
          : phase === "video"
            ? "Audio downloads next. Playback is ready after the MP4 is saved."
            : phase === "audio"
              ? "Video downloaded. Audio and video will be combined next."
              : phase === "mp4" || phase === "processing"
                ? "Playback is ready after the MP4 is saved."
                : "Checking saved files and available MP4 tracks.";

    return html`
      <div class="download-overlay" slot="centered-chrome">
        <section class="download-progress" aria-labelledby="download-heading">
          <div class="download-top">
            <div>
              <strong id="download-heading">Preparing MP4</strong>
              <span class="download-phase">${
                canceling ? "Canceling download…" : downloadPhases[phase]
              }</span>
            </div>
            <button
              class="plain <big>"
              type="button"
              @click=${this.cancelDownload}
              ?hidden=${finalizing}
              ?disabled=${!this.jobToken}
              aria-disabled=${canceling ? "true" : nothing}
            >${canceling ? "Canceling…" : "Cancel download"}</button>
          </div>

          <div class="download-metrics">
            <span>${this.progressConnectionLost && !canceling ? "Last seen: " : ""}${byteText}</span>
            ${transferring ? html`<span>${speedText}</span>` : nothing}
            ${percentage === null ? nothing : html`<span>${estimate}${Math.round(percentage)}%</span>`}
          </div>
          <progress
            max="100"
            value=${percentage === null ? nothing : percentage}
            ?hidden=${canceling || postprocessing || finalizing}
            aria-label=${progressLabel}
            aria-valuetext=${progressValueText}
          ></progress>
          <p class="download-support">${
            this.progressConnectionLost && !canceling
              ? "Reconnecting… The download may still be running."
              : support
          }</p>
          ${this.cancelError ? html`<p class="download-support">${this.cancelError}</p>` : nothing}
          ${
            canceling || finalizing
              ? nothing
              : html`
                  <p class="download-support">
                    Cancel stops this video's download in every tab. Closing this tab also cancels it.
                  </p>
                `
          }
        </section>
      </div>
    `;
  }

  private renderHistory() {
    const isHistory = this.libraryView === "history";
    const entries = isHistory ? historyView(this.history, this.libraryQuery, this.historySort) : [];
    const files = isHistory
      ? []
      : storageView(this.storage ?? [], this.libraryQuery, this.filesSort);
    const matches = isHistory ? entries.length : files.length;
    const visibleCount = Math.min(matches, this.visibleHistoryCount);
    const remaining = matches - visibleCount;
    const hasQuery = this.libraryQuery.trim().length > 0;
    const matchedBytes = isHistory
      ? entries.reduce((sum, entry) => sum + (entry.mp4.sizeBytes ?? 0), 0)
      : files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const loaded = isHistory ? this.historyLoaded : this.storage !== null;
    let resultKind = matches === 1 ? "saved MP4" : "saved MP4s";
    if (hasQuery) {
      resultKind = matches === 1 ? "match" : "matches";
    } else if (isHistory) {
      resultKind = matches === 1 ? "video" : "videos";
    }

    return html`
      <section class="history-panel archive" aria-labelledby="history-title">
        <div class="history-heading">
          <h2 id="history-title" tabindex="-1">Library</h2>
          ${this.renderStorageSummary()}
        </div>
        ${this.renderOutsideHistory()}
        ${
          this.storageError || (this.storageStale && this.storage !== null)
            ? html`
                <p class="storage-warning warn color" role=${this.storageError ? "alert" : "status"}>
                  ${this.storage !== null ? "Storage is stale. " : "Storage unavailable. "}
                  ${this.storageError || "Refresh library to update saved MP4s."}
                </p>
              `
            : nothing
        }
        ${this.renderLibraryControls()}
        ${this.historyError ? html`<p class="bad color" role="alert">${this.historyError}</p>` : nothing}
        <div class="library-results" role="status" aria-live="polite">
          ${loaded ? html`<span class="history-count">Showing ${visibleCount} of ${matches} ${resultKind}</span>` : nothing}
          ${loaded && hasQuery ? html`<span class="library-subtotal">${fileSize(matchedBytes)} in all matching results</span>` : nothing}
        </div>
        ${
          matches === 0
            ? this.renderLibraryEmpty()
            : isHistory
              ? html`<ul class="history-list">${repeat(
                  entries.slice(0, visibleCount),
                  (entry) => entry.id,
                  (entry) => this.renderHistoryEntry(entry),
                )}</ul>`
              : this.renderStorageTable(files.slice(0, visibleCount))
        }
        ${
          remaining > 0
            ? html`
                <div class="history-navigation tool-bar">
                  <button class="plain <big>" type="button" @click=${this.showMoreHistory}>
                    Show ${Math.min(remaining, HISTORY_CHUNK_SIZE)} more
                  </button>
                </div>
              `
            : nothing
        }
      </section>
    `;
  }

  private renderStorageSummary() {
    const storage = this.storage;
    const pendingLabel = this.storageError ? "Storage unavailable" : "Loading saved MP4s…";
    const totalBytes = storage?.reduce((sum, file) => sum + file.sizeBytes, 0) ?? null;

    return html`
      <div class="library-summary">
        <span class="storage-total">${
          storage === null
            ? pendingLabel
            : html`
                Saved MP4s: <strong>${fileSize(totalBytes)}</strong> · ${storage.length}
                ${storage.length === 1 ? "file" : "files"}
              `
        }</span>
        <button
          class="plain"
          type="button"
          ?disabled=${this.busy}
          @click=${this.refreshLibrary}
        >Refresh library</button>
      </div>
    `;
  }

  private renderLibraryControls() {
    const isHistory = this.libraryView === "history";
    const sort = isHistory ? this.historySort : this.filesSort;
    const options: [HistorySort | FilesSort, string][] = isHistory
      ? [
          ["recent", "Recent first"],
          ["oldest", "Oldest first"],
        ]
      : [
          ["largest", "Largest"],
          ["most-recent", "Most recent"],
        ];

    return html`
      <div class="library-toolbar">
        <div class="library-tabs" role="group" aria-label="Library view">
          <button
            class="plain"
            type="button"
            aria-pressed=${isHistory}
            @click=${() => this.changeLibraryView("history")}
          >Watch history</button>
          <button
            class="plain"
            type="button"
            aria-pressed=${!isHistory}
            @click=${() => this.changeLibraryView("files")}
          >Saved MP4s</button>
        </div>
        <div class="library-search">
          <label for="library-query">Search title or channel</label>
          <div class="clearable-input">
            <input
              id="library-query"
              type="search"
              placeholder=${isHistory ? "Search watched videos" : "Search saved MP4s"}
              .value=${this.libraryQuery}
              @input=${this.changeLibraryQuery}
            >
            <button
              class="input-clear"
              type="button"
              aria-label="Clear search"
              title="Clear search"
              ?hidden=${!this.libraryQuery}
              @click=${this.clearLibrarySearch}
            ><span aria-hidden="true">×</span></button>
          </div>
        </div>
        <label class="library-sort" for="library-sort">Sort
          <select
            id="library-sort"
            @change=${this.changeLibrarySort}
          >
            ${options.map(([value, label]) => html`<option value=${value} .selected=${value === sort}>${label}</option>`)}
          </select>
        </label>
      </div>
    `;
  }

  private renderOutsideHistory() {
    if (this.storage === null || !this.historyLoaded || this.historyError) {
      return nothing;
    }
    const watchedIds = new Set(this.history.map((entry) => entry.id));
    const outside = this.storage.filter((file) => !watchedIds.has(file.id));
    if (outside.length === 0) {
      return nothing;
    }

    return html`<p class="storage-note">${outside.length} saved ${outside.length === 1 ? "file is" : "files are"} outside watch history (${fileSize(outside.reduce((sum, file) => sum + file.sizeBytes, 0))}).</p>`;
  }

  private renderLibraryEmpty() {
    if (this.libraryView === "history") {
      if (!this.historyLoaded && this.historyError) {
        return nothing;
      }
      return this.history.length === 0
        ? html`<p>Videos you play will appear here.</p>`
        : html`<p>No videos match “${this.libraryQuery.trim()}”. Clear search to see all videos.</p>`;
    }
    if (this.storage === null) {
      return nothing;
    }
    return this.storage.length === 0
      ? html`<p>No saved MP4s. Download a video to save it here.</p>`
      : html`<p>No saved MP4s match “${this.libraryQuery.trim()}”. Clear search to see all saved files.</p>`;
  }

  private renderStorageTable(files: StorageFile[]) {
    const historyById = new Map(this.history.map((entry) => [entry.id, entry]));
    const largestBytes = (this.storage ?? []).reduce(
      (largest, file) => Math.max(largest, file.sizeBytes),
      0,
    );

    return html`
      <table class="storage-table">
        <caption>Saved MP4s, ${this.filesSort === "largest" ? "largest first" : "most recent modification first"}</caption>
        <thead>
          <tr>
            <th scope="col">Title / channel</th>
            <th scope="col" class="size-column">MP4 size</th>
            <th scope="col" class="action-column">Actions</th>
          </tr>
        </thead>
        <tbody>${repeat(
          files,
          (file) => file.id,
          (file) => this.renderStorageFile(file, historyById.get(file.id), largestBytes),
        )}</tbody>
      </table>
    `;
  }

  private renderStorageFile(
    file: StorageFile,
    history: HistoryEntry | undefined,
    largestBytes: number,
  ) {
    const title = savedTitle(file);
    const replay = {
      url: `https://www.youtube.com/watch?v=${file.id}`,
      mp4: { sizeBytes: file.sizeBytes },
    };

    return html`
      <tr class="saved-file-item" data-id=${file.id}>
        <td class="storage-details">
          <strong>${title}</strong>
          <span class="history-meta">${file.channel ?? "Channel unavailable"}</span>
          <time class="history-time" datetime=${file.modifiedAt}>Modified ${new Date(file.modifiedAt).toLocaleString()}</time>
          ${
            !history
              ? html`<span class="history-time">Not in watch history</span>`
              : fullyWatched(history)
                ? html`<span class="history-watched">✓ Fully watched</span>`
                : history.positionSeconds > 0
                  ? html`<span class="history-time">Continue at ${durationLabel(history.positionSeconds)}</span>`
                  : nothing
          }
        </td>
        <td class="size-column">
          <span>${fileSize(file.sizeBytes)}</span>
          <span class="size-track" aria-hidden="true">
            <span class="size-fill" style=${`width: ${(file.sizeBytes / largestBytes) * 100}%`}></span>
          </span>
        </td>
        <td class="action-column">
          <div class="history-actions tool-bar">
            <button
              class="history-play info iconbutton <big>"
              type="button"
              aria-label=${`Play ${title}`}
              title="Play"
              ?disabled=${this.busy}
              @click=${() => this.replay(replay)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#play-icon"></use></svg>
            </button>
            <button
              class="warn iconbutton <big>"
              type="button"
              aria-label=${`Delete downloaded files for ${title}`}
              title="Delete files"
              ?disabled=${this.busy}
              @click=${() => this.deleteEntry({ id: file.id, title }, true)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#delete-file-icon"></use></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }

  private renderHistoryEntry(entry: HistoryEntry) {
    const mp4Available = entry.mp4.sizeBytes !== null;
    const canMarkWatched =
      entry.duration !== null && Number.isFinite(entry.duration) && entry.duration > 0;
    const markWatchedTitle = canMarkWatched
      ? "Mark as fully watched"
      : "Cannot mark as watched: duration unavailable";

    return html`
      <li class="history-item border-block-start" data-id=${entry.id}>
        <div class="history-details">
          <strong>${entry.title}</strong>
          <span class="history-meta">
            ${entry.channel ?? "Channel unavailable"} · ${durationLabel(entry.duration)}
          </span>
          <span class="history-time">Watched ${new Date(entry.lastWatchedAt).toLocaleString()}</span>
          ${
            fullyWatched(entry)
              ? html`<span class="history-watched">✓ Fully watched</span>`
              : entry.positionSeconds > 0
                ? html`
                    <span class="history-time">
                      Continue at ${durationLabel(entry.positionSeconds)}
                    </span>
                  `
                : ""
          }
          <a
            class="original-link"
            href=${entry.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`Open ${entry.title} on YouTube`}
          >
            Open on YouTube ↗
          </a>
          ${
            mp4Available
              ? html`
                  <span class="badges" aria-label="Downloaded files">
                    <chip class="archive">MP4 · ${fileSize(entry.mp4.sizeBytes)}</chip>
                  </span>
                `
              : nothing
          }
        </div>

        <div class="history-actions tool-bar">
          <button
            class="history-play info iconbutton <big>"
            type="button"
            aria-label=${`Play ${entry.title}`}
            title="Play"
            ?disabled=${this.busy}
            @click=${() => this.replay(entry)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#play-icon"></use>
            </svg>
          </button>
          ${
            entry.positionSeconds > 0
              ? html`
                  <button
                    class="plain iconbutton <big>"
                    type="button"
                    aria-label=${`Reset watch progress for ${entry.title}`}
                    title="Reset watch progress"
                    ?disabled=${this.busy}
                    @click=${() => this.setWatchProgress(entry, false)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#reset-progress-icon"></use>
                    </svg>
                  </button>
                `
              : html`
                  <button
                    class="plain iconbutton <big>"
                    type="button"
                    aria-label=${`Mark ${entry.title} as fully watched`}
                    title=${markWatchedTitle}
                    ?disabled=${this.busy || !canMarkWatched}
                    @click=${() => this.setWatchProgress(entry, true)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#mark-watched-icon"></use>
                    </svg>
                  </button>
                `
          }
          ${
            mp4Available
              ? html`
                  <button
                    class="warn iconbutton <big>"
                    type="button"
                    aria-label=${`Delete downloaded files for ${entry.title}`}
                    title="Delete files"
                    ?disabled=${this.busy}
                    @click=${() => this.deleteEntry(entry, true)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#delete-file-icon"></use>
                    </svg>
                  </button>
                `
              : ""
          }
          <button
            class="bad iconbutton <big>"
            type="button"
            aria-label=${`Delete files and history for ${entry.title}`}
            title="Delete files and history"
            ?disabled=${this.busy}
            @click=${() => this.deleteEntry(entry, false)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#delete-history-icon"></use>
            </svg>
          </button>
        </div>
      </li>
    `;
  }
}
