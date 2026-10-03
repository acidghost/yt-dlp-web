import Hls from "hls.js";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ApiErrorSchema,
  type HistoryEntry,
  HistoryListSchema,
  OkResponseSchema,
  type ProgressRequest,
  type ResolvedVideo,
  ResolvedVideoSchema,
  type ResolveRequest,
  type WatchRequest,
} from "../protocol";
import {
  handoffSearch,
  type PlayerMode,
  parseHandoff,
  resolveKind,
} from "./handoff";
import { controlPlayer } from "./player-keys";

type Phase = "idle" | "extracting" | "downloading" | "ready" | "error";
type Notice = { phase: Phase; text: string };
const HISTORY_CHUNK_SIZE = 12;
const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function fileSize(bytes: number | null): string {
  if (bytes === null) return "Size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function durationLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0)
    return "Duration unavailable";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

@customElement("video-app")
export class VideoApp extends LitElement {
  // Render into light DOM so missing.css styles the controls.
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
  @state() private history: HistoryEntry[] = [];
  @state() private historyError = "";
  @state() private widePlayer = false;
  @state() private playbackRate = 1;
  @state() private showBackToPlayer = false;
  @state() private visibleHistoryCount = HISTORY_CHUNK_SIZE;
  @state() private deleting = false;
  private historyRequest = 0;
  private watchedThisPlay = false;
  private watchRecorded = false;
  private hls: Hls | null = null;
  private pendingResumeSeconds = 0;
  private lastProgressAt = 0;
  private lastProgressSeconds = -1;
  private progressInFlight = false;
  private pendingProgress: { source: ResolvedVideo; seconds: number } | null =
    null;

  private get busy(): boolean {
    return (
      this.deleting ||
      this.notice.phase === "extracting" ||
      this.notice.phase === "downloading"
    );
  }

  private fail(message: string): void {
    this.notice = { phase: "error", text: message };
  }

  private attachReady(): void {
    this.pendingResumeSeconds = this.source?.positionSeconds ?? 0;
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
    document.addEventListener("visibilitychange", this.saveOnHide);
    document.addEventListener("keydown", this.handlePlayerKey);
    void this.loadHistory();
  }

  override firstUpdated(): void {
    const handoff = parseHandoff(window.location.search);
    if (!handoff) return;
    if ("error" in handoff) {
      this.url = new URLSearchParams(window.location.search).get("url") ?? "";
      this.fail(handoff.error);
      return;
    }
    this.url = handoff.url;
    this.mode = handoff.mode;
    // Prepare the selected source, but never start browser playback automatically.
    void this.prepare(false);
  }

  private get player(): HTMLVideoElement {
    const player = this.querySelector("video");
    if (!player) throw new Error("Missing video element");
    return player;
  }

  private async loadHistory(): Promise<void> {
    const request = ++this.historyRequest;
    try {
      const response = await fetch("/api/history");
      if (!response.ok) throw new Error("Could not load history.");
      const entries = HistoryListSchema.parse(await response.json());
      if (request !== this.historyRequest) return;
      this.history = entries;
      this.historyError = "";
    } catch {
      if (request !== this.historyRequest) return;
      this.historyError =
        "Could not load watch history. Playback is still available.";
    }
  }

  private resetPlayer(): void {
    this.hls?.destroy();
    this.hls = null;
    this.player.pause();
    this.player.removeAttribute("src");
    this.player.load();
    this.watchedThisPlay = false;
    this.watchRecorded = false;
    this.pendingResumeSeconds = 0;
    this.lastProgressAt = 0;
    this.lastProgressSeconds = -1;
  }

  private attachSource(): boolean {
    const source = this.source;
    if (!source) return false;
    if (source.kind === "download") {
      this.player.src = source.stream;
      return true;
    }
    if (Hls.isSupported()) {
      const hls = new Hls();
      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && this.hls === hls)
          this.fail(`HLS playback failed: ${data.details}`);
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
    const search = url ? `?${handoffSearch(url, this.mode)}` : "";
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
  }

  private async prepare(updateAddress = true): Promise<void> {
    if (this.busy) return;
    const url = this.url.trim();
    if (updateAddress) this.updateAddress();
    if (!url) {
      this.fail("Enter a video URL.");
      return;
    }

    const focused = this.ownerDocument.activeElement;
    this.saveProgress(true);
    this.source = null;
    this.resetPlayer();

    const kind = resolveKind(this.mode);
    this.notice =
      kind === "proxy"
        ? { phase: "extracting", text: "Extracting YouTube HLS tracks…" }
        : {
            phase: "downloading",
            text: "Checking saved files, downloading MP4 if needed…",
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
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = ApiErrorSchema.safeParse(payload);
        throw new Error(
          failure.success ? failure.data.error : "Could not prepare video.",
        );
      }
      const result = ResolvedVideoSchema.safeParse(payload);
      if (!result.success || result.data.kind !== kind)
        throw new Error("Server returned an invalid video response.");

      this.source = result.data;
      this.attachReady();
      void this.loadHistory();
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : "Could not prepare video.",
      );
    } finally {
      await this.updateComplete;
      if (
        focused instanceof HTMLElement &&
        focused.isConnected &&
        this.ownerDocument.activeElement === this.ownerDocument.body
      )
        focused.focus();
    }
  }

  private changeMode(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value !== "proxy" && value !== "mp4") return;
    this.mode = value;
    this.updateAddress();
    if (this.busy) return;

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

  private replay(entry: HistoryEntry): void {
    if (this.busy) return;
    this.url = entry.url;
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
    if (player)
      this.showBackToPlayer = player.getBoundingClientRect().bottom <= 0;
  };

  private showMoreHistory(): void {
    this.visibleHistoryCount += HISTORY_CHUNK_SIZE;
  }

  private togglePlayerWidth(): void {
    this.widePlayer = !this.widePlayer;
  }

  private async deleteEntry(
    entry: HistoryEntry,
    filesOnly: boolean,
  ): Promise<void> {
    if (this.busy) return;
    const action = filesOnly
      ? "Delete downloaded files"
      : "Delete files and history";
    if (!window.confirm(`${action} for "${entry.title}"?`)) return;

    if (this.source?.id === entry.id) {
      this.source = null;
      this.resetPlayer();
    }

    this.deleting = true;
    try {
      const path = `/api/history/${entry.id}${filesOnly ? "/files" : ""}`;
      const response = await fetch(path, { method: "DELETE" });
      if (!response.ok) {
        const failure = ApiErrorSchema.safeParse(
          await response.json().catch(() => null),
        );
        throw new Error(
          failure.success ? failure.data.error : "Could not delete video.",
        );
      }

      const payload: unknown = await response.json().catch(() => null);
      if (!OkResponseSchema.safeParse(payload).success)
        throw new Error("Server returned an invalid delete response.");

      await this.loadHistory();
      this.notice = {
        phase: "idle",
        text: filesOnly
          ? "Downloaded files deleted."
          : "Files and history deleted.",
      };
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : "Could not delete video.",
      );
    } finally {
      this.deleting = false;
      await this.updateComplete;
      const item = [
        ...this.querySelectorAll<HTMLLIElement>(".history-item"),
      ].find((element) => element.dataset.id === entry.id);
      if (filesOnly && item)
        item.querySelector<HTMLButtonElement>(".history-play")?.focus();
      else this.querySelector<HTMLElement>("#history-title")?.focus();
    }
  }

  private startedPlay(): void {
    this.watchedThisPlay = false;
    this.watchRecorded = false;
  }

  private resumePlayback(): void {
    if (!this.pendingResumeSeconds) return;
    const position = this.pendingResumeSeconds;
    try {
      this.player.currentTime = position;
      this.pendingResumeSeconds = 0;
    } catch {
      // Some HLS streams do not expose a seekable range immediately.
    }
  }

  private saveProgress(force = false, completed = false): void {
    const source = this.source;
    if (!source || !this.watchRecorded) return;
    const seconds = completed ? 0 : Math.floor(this.player.currentTime);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < 5000) return;
    if (!force && seconds === this.lastProgressSeconds) return;
    this.lastProgressAt = now;
    this.lastProgressSeconds = seconds;
    this.pendingProgress = { source, seconds };
    void this.flushProgress();
  }

  private async flushProgress(): Promise<void> {
    if (this.progressInFlight) return;
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
          await fetch(`/api/history/${source.id}/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
            keepalive: true,
          });
        } catch {
          // A later time update or pause can retry saving the position.
        }
      }
    } finally {
      this.progressInFlight = false;
    }
  }

  private readonly saveOnHide = (): void => {
    if (document.visibilityState === "hidden") this.saveProgress(true);
  };

  private changePlaybackSpeed(event: Event): void {
    const rate = Number((event.currentTarget as HTMLSelectElement).value);
    if (PLAYBACK_SPEEDS.includes(rate)) this.player.playbackRate = rate;
  }

  private syncPlaybackSpeed(): void {
    this.playbackRate = this.player.playbackRate;
  }

  private readonly handlePlayerKey = (event: KeyboardEvent): void => {
    if (!this.source || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest(
        "input, textarea, select, button, a, [contenteditable], [role='textbox'], [role='slider']",
      ) ||
        (target as HTMLElement).isContentEditable)
    )
      return;

    if (controlPlayer(this.player, event)) event.preventDefault();
  };

  private async playing(): Promise<void> {
    const source = this.source;
    if (!source || this.watchedThisPlay) return;
    this.watchedThisPlay = true;
    try {
      const request: WatchRequest = { token: source.token };
      const response = await fetch(`/api/history/${source.id}/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (
        !response.ok ||
        !OkResponseSchema.safeParse(await response.json()).success
      )
        throw new Error("Could not save watch history.");
      if (this.source !== source) return;
      this.watchRecorded = true;
      if (this.player.paused) this.saveProgress(true);
      void this.loadHistory();
    } catch {
      if (this.source === source)
        this.notice = {
          ...this.notice,
          text: "Playing, but could not save watch history.",
        };
    }
  }

  private playbackError(): void {
    if (!this.source || !this.player.currentSrc) return;
    this.fail(
      this.source.kind === "proxy"
        ? "Proxy playback failed. Signed links may have expired; prepare the video again."
        : "Playback failed. Check that the downloaded files still exist.",
    );
  }

  override disconnectedCallback(): void {
    window.removeEventListener("scroll", this.updateBackToPlayer);
    window.removeEventListener("resize", this.updateBackToPlayer);
    document.removeEventListener("visibilitychange", this.saveOnHide);
    document.removeEventListener("keydown", this.handlePlayerKey);
    this.hls?.destroy();
    this.hls = null;
    super.disconnectedCallback();
  }

  override render() {
    return html`
      ${this.renderPlayer()}
      ${
        this.showBackToPlayer
          ? html`<a class="back-to-player plain <button> <big>" href="#player"
              @click=${this.focusPlayer}>Back to player</a>`
          : ""
      }
      ${this.renderHistory()}
    `;
  }

  override updated(): void {
    this.updateBackToPlayer();
    const speed = this.querySelector<HTMLSelectElement>(
      ".speed-control select",
    );
    if (speed) speed.value = String(this.playbackRate);
  }

  private renderPlayer() {
    const statusColorway =
      this.notice.phase === "error"
        ? "bad color"
        : this.notice.phase === "ready"
          ? "ok color"
          : "info color";

    return html`
      <section class=${`player-panel console${this.widePlayer ? " wide-player" : ""}`} aria-labelledby="player-title">
        <h2 id="player-title" class="vh">Player</h2>
        <form id="resolve" @submit=${this.submit}>
          <label class="vh" for="url">YouTube video URL</label>
          <label class="vh" for="player-mode">Playback mode</label>
          <div class="player-controls tool-bar">
            <input id="url" type="url" placeholder="https://www.youtube.com/watch?v=…"
              autocomplete="url" required .value=${this.url} @input=${this.changeUrl}
              ?disabled=${this.busy}>
            <select id="player-mode" .value=${this.mode} @change=${this.changeMode}
              ?disabled=${this.busy}>
              <option value="proxy">Proxy YouTube HLS (starts sooner)</option>
              <option value="mp4">Download + Native MP4</option>
            </select>
            <strong>
              <button class="console <big>" type="submit" aria-label="Prepare video"
                title="Prepare video" ?disabled=${this.busy}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#prepare-icon"></use></svg>
              </button>
            </strong>
            <button class="plain <big>" type="button" aria-pressed=${this.widePlayer}
              @click=${this.togglePlayerWidth}>Fill page</button>
          </div>
        </form>
        <p id="status" class=${statusColorway} data-phase=${this.notice.phase} role="status" aria-live="polite">${this.notice.text}</p>
        ${
          this.notice.phase === "error"
            ? html`<p class="hint">${
                this.mode === "proxy"
                  ? "Retry preparation or choose Download + Native MP4."
                  : "Retry preparation or try Proxy YouTube HLS."
              }</p>`
            : ""
        }
        ${
          this.source
            ? html`<h3 id="title">${this.source.title}</h3>
          <p class="video-meta">${this.source.channel ? html`${this.source.channel} · ` : ""}${durationLabel(this.source.duration)}</p>`
            : ""
        }
        <!-- biome-ignore lint/a11y/useMediaCaption: Captions are not extracted in this app. -->
        <video id="player" controls playsinline preload="none" tabindex="0" aria-label="Video player"
          @play=${this.startedPlay} @playing=${this.playing} @loadedmetadata=${this.resumePlayback}
          @canplay=${this.resumePlayback} @ratechange=${this.syncPlaybackSpeed}
          @timeupdate=${() => this.saveProgress()}
          @pause=${() => this.saveProgress(true)}
          @ended=${() => this.saveProgress(true, true)}
          @error=${this.playbackError}></video>
        <div class="player-tools">
          <p class="hint player-shortcuts">
            Keyboard: <kbd>Space</kbd>/<kbd>K</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> seek 5s
            · <kbd>J</kbd>/<kbd>L</kbd> seek 10s · <kbd>&lt;</kbd>/<kbd>&gt;</kbd> speed · <kbd>M</kbd> mute
          </p>
          <label class="speed-control">Speed
            <select aria-label="Playback speed"
              @change=${this.changePlaybackSpeed} ?disabled=${!this.source}>
              ${PLAYBACK_SPEEDS.map((rate) => html`<option value=${rate}>${rate}×</option>`)}
              ${PLAYBACK_SPEEDS.includes(this.playbackRate) ? "" : html`<option value=${this.playbackRate}>${this.playbackRate}×</option>`}
            </select>
          </label>
        </div>
      </section>
    `;
  }

  private renderHistory() {
    const visibleEntries = this.history.slice(0, this.visibleHistoryCount);
    const remaining = this.history.length - visibleEntries.length;
    return html`
      <section class="history-panel archive" aria-labelledby="history-title">
        <div class="history-heading">
          <h2 id="history-title" tabindex="-1">Watch history</h2>
          ${this.history.length > 0 ? html`<span class="history-count">Showing ${visibleEntries.length} of ${this.history.length} ${this.history.length === 1 ? "video" : "videos"}</span>` : ""}
        </div>
        ${this.historyError ? html`<p class="bad color" role="alert">${this.historyError}</p>` : ""}
        ${
          this.history.length === 0
            ? html`<p>Videos you play will appear here.</p>`
            : html`
          <ul class="history-list">
            ${visibleEntries.map((entry) => this.renderHistoryEntry(entry))}
          </ul>
          ${
            remaining > 0
              ? html`
          <div class="history-navigation tool-bar">
            <button class="plain <big>" type="button"
              @click=${this.showMoreHistory}>
              Show ${Math.min(remaining, HISTORY_CHUNK_SIZE)} more
            </button>
          </div>`
              : ""
          }
        `
        }
      </section>
    `;
  }

  private renderHistoryEntry(entry: HistoryEntry) {
    const mp4Available = entry.mp4.sizeBytes !== null;
    return html`
      <li class="history-item border-block-start" data-id=${entry.id}>
        <div class="history-details">
          <strong>${entry.title}</strong>
          <span class="history-meta">${entry.channel ?? "Channel unavailable"} · ${durationLabel(entry.duration)}</span>
          <span class="history-time">Watched ${new Date(entry.lastWatchedAt).toLocaleString()}</span>
          ${
            entry.positionSeconds > 0
              ? html`<span class="history-time">Continue at ${durationLabel(entry.positionSeconds)}</span>`
              : ""
          }
          <a class="original-link" href=${entry.url} target="_blank" rel="noopener noreferrer"
            aria-label=${`Open ${entry.title} on YouTube`}>Open on YouTube ↗</a>
          <span class="badges" aria-label="Downloaded files">
            ${
              mp4Available
                ? html`<chip class="archive">MP4 · ${fileSize(entry.mp4.sizeBytes)}</chip>`
                : html`<chip class="plain">No files</chip>`
            }
          </span>
        </div>
        <div class="history-actions tool-bar">
          <button class="history-play info iconbutton <big>" type="button"
            aria-label=${`Play ${entry.title}`} title="Play" ?disabled=${this.busy}
            @click=${() => this.replay(entry)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#play-icon"></use></svg>
          </button>
          ${
            mp4Available
              ? html`
            <button class="warn iconbutton <big>" type="button"
              aria-label=${`Delete downloaded files for ${entry.title}`} title="Delete files"
              ?disabled=${this.busy} @click=${() => this.deleteEntry(entry, true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#delete-file-icon"></use></svg>
            </button>
          `
              : ""
          }
          <button class="bad iconbutton <big>" type="button"
            aria-label=${`Delete files and history for ${entry.title}`} title="Delete files and history"
            ?disabled=${this.busy} @click=${() => this.deleteEntry(entry, false)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#delete-history-icon"></use></svg>
          </button>
        </div>
      </li>
    `;
  }
}
