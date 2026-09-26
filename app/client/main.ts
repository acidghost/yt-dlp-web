import Hls from "hls.js";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { HistoryEntry, ResolvedVideo } from "../protocol";
import {
  handoffSearch,
  type PlayerMode,
  parseHandoff,
  resolveKind,
  reuseSource,
} from "./handoff";

type Source = ResolvedVideo & { kind: "proxy" | "download" };
type Phase = "idle" | "extracting" | "downloading" | "ready" | "error";

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
  @state() private phase: Phase = "idle";
  @state() private status = "Paste a public YouTube video URL to get started.";
  @state() private video: Pick<
    ResolvedVideo,
    "title" | "duration" | "channel"
  > | null = null;
  @state() private history: HistoryEntry[] = [];
  @state() private historyError = "";
  @state() private pending = false;
  @state() private deleting = false;
  private source: Source | null = null;
  private watchedThisPlay = false;
  private hls: Hls | null = null;

  // True while any network action blocks new ones.
  private get busy(): boolean {
    return this.pending || this.deleting;
  }

  private fail(message: string): void {
    this.phase = "error";
    this.status = message;
  }

  private attachReady(): void {
    if (this.attachSource()) {
      this.phase = "ready";
      this.status = "Ready. Press play in the video controls.";
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadHistory();
  }

  override firstUpdated(): void {
    const handoff = parseHandoff(window.location.search);
    if (!handoff) return;
    if ("error" in handoff) {
      this.urlInput.value =
        new URLSearchParams(window.location.search).get("url") ?? "";
      this.fail(handoff.error);
      return;
    }
    this.urlInput.value = handoff.url;
    this.mode = handoff.mode;
    // Prepare the selected source, but never start browser playback automatically.
    void this.prepare(false);
  }

  private get urlInput(): HTMLInputElement {
    const input = this.querySelector<HTMLInputElement>("#url");
    if (!input) throw new Error("Missing URL input");
    return input;
  }

  private get player(): HTMLVideoElement {
    const player = this.querySelector("video");
    if (!player) throw new Error("Missing video element");
    return player;
  }

  private async loadHistory(): Promise<void> {
    try {
      const response = await fetch("/api/history");
      if (!response.ok) throw new Error("Could not load history.");
      this.history = await response.json();
      this.historyError = "";
    } catch {
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
  }

  private attachSource(): boolean {
    const source = this.source;
    if (!source) return false;
    if (this.mode === "mp4" && source.stream) {
      this.player.src = source.stream;
      return true;
    }
    if (!source.hls) {
      this.fail(
        "HLS packaging is unavailable. Switch to Native MP4 to play the saved video.",
      );
      return false;
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
    const url = this.urlInput.value.trim();
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

  private async prepare(updateAddress = true): Promise<void> {
    if (this.busy) return;
    const url = this.urlInput.value.trim();
    if (updateAddress) this.updateAddress();
    if (!url) {
      this.fail("Enter a video URL.");
      return;
    }

    const focused = this.ownerDocument.activeElement;
    this.source = null;
    this.resetPlayer();
    this.video = null;

    const kind = resolveKind(this.mode);
    this.phase = kind === "proxy" ? "extracting" : "downloading";
    this.status =
      kind === "proxy"
        ? "Extracting YouTube HLS tracks…"
        : "Checking saved files, downloading if needed, then packaging HLS…";
    this.pending = true;

    try {
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, mode: kind }),
      });
      const data: ResolvedVideo & { error?: string } = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Could not prepare video.");

      this.source = { ...data, kind };
      this.video = {
        title: data.title,
        duration: data.duration,
        channel: data.channel,
      };
      this.attachReady();
      await this.loadHistory();
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : "Could not prepare video.",
      );
    } finally {
      this.pending = false;
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
    if (value !== "proxy" && value !== "hls" && value !== "mp4") return;
    this.mode = value;
    this.updateAddress();
    if (this.busy) return;

    if (!this.source) {
      this.status = "Press Prepare video to use the selected mode.";
      this.phase = "idle";
      return;
    }

    if (reuseSource(this.source.kind, Boolean(this.source.hls), value)) {
      this.resetPlayer();
      this.attachReady();
      return;
    }

    // A proxy switch always extracts new signed URLs. Download mode changes
    // re-use files on disk (and can retry HLS packaging without redownloading).
    void this.prepare(false);
  }

  private replay(entry: HistoryEntry): void {
    if (this.busy) return;
    this.urlInput.value = entry.url;
    this.mode = entry.available.mp4 ? "mp4" : "proxy";
    void this.prepare();
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
      this.video = null;
      this.resetPlayer();
    }

    this.deleting = true;
    try {
      const path = `/api/history/${entry.id}${filesOnly ? "/files" : ""}`;
      const response = await fetch(path, { method: "DELETE" });
      if (!response.ok) {
        const data: { error?: string } = await response.json();
        throw new Error(data.error ?? "Could not delete video.");
      }

      await this.loadHistory();
      this.phase = "idle";
      this.status = filesOnly
        ? "Downloaded files deleted."
        : "Files and history deleted.";
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
  }

  private async playing(): Promise<void> {
    const source = this.source;
    if (!source || this.watchedThisPlay) return;
    this.watchedThisPlay = true;
    try {
      const response = await fetch(`/api/history/${source.id}/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: source.token }),
      });
      if (!response.ok) throw new Error("Could not save watch history.");
      await this.loadHistory();
    } catch {
      if (this.source === source)
        this.status = "Playing, but could not save watch history.";
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
    this.hls?.destroy();
    this.hls = null;
    super.disconnectedCallback();
  }

  override render() {
    const statusColorway =
      this.phase === "error"
        ? "bad color"
        : this.phase === "ready"
          ? "ok color"
          : "info color";

    return html`
      <section class="player-panel box console" aria-labelledby="player-title">
        <h2 id="player-title">Player</h2>
        <form id="resolve" @submit=${this.submit}>
          <label for="url">YouTube video URL</label>
          <div class="url-row">
            <input id="url" type="url" placeholder="https://www.youtube.com/watch?v=…"
              autocomplete="url" required ?disabled=${this.busy}>
            <strong>
              <button class="console <big>" type="submit" aria-label="Prepare video"
                title="Prepare video" ?disabled=${this.busy}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#prepare-icon"></use></svg>
              </button>
            </strong>
          </div>
          <label for="player-mode">Playback mode</label>
          <select id="player-mode" .value=${this.mode} @change=${this.changeMode}
            ?disabled=${this.busy}>
            <option value="proxy">Proxy YouTube HLS (starts sooner)</option>
            <option value="hls">Download + HLS.js</option>
            <option value="mp4">Download + Native MP4</option>
          </select>
        </form>
        <p id="status" class=${statusColorway} data-phase=${this.phase} role="status" aria-live="polite">${this.status}</p>
        ${
          this.phase === "error"
            ? html`<p class="hint">${
                this.mode === "proxy"
                  ? "Retry preparation or choose a download mode."
                  : this.mode === "hls"
                    ? "Try Native MP4; the downloaded video may still be available."
                    : "Retry preparation or try Proxy YouTube HLS."
              }</p>`
            : ""
        }
        ${
          this.video
            ? html`<h3 id="title">${this.video.title}</h3>
          <p class="video-meta">${this.video.channel ? html`${this.video.channel} · ` : ""}${durationLabel(this.video.duration)}</p>`
            : ""
        }
        <!-- biome-ignore lint/a11y/useMediaCaption: Captions are not extracted in this app. -->
        <video id="player" controls playsinline preload="none" aria-label="Video player"
          @play=${this.startedPlay} @playing=${this.playing} @error=${this.playbackError}></video>
      </section>
      <section class="history-panel archive" aria-labelledby="history-title">
        <h2 id="history-title" tabindex="-1">Watch history</h2>
        ${this.historyError ? html`<p class="bad color" role="alert">${this.historyError}</p>` : ""}
        ${
          this.history.length === 0
            ? html`<p>Videos you play will appear here.</p>`
            : html`
          <ul class="history-list">
            ${this.history.map(
              (entry) => html`
              <li class="history-item border-block-start" data-id=${entry.id}>
                <div class="history-details">
                  <strong>${entry.title}</strong>
                  <span class="history-meta">${entry.channel ?? "Channel unavailable"} · ${durationLabel(entry.duration)}</span>
                  <span class="history-time">Watched ${new Date(entry.lastWatchedAt).toLocaleString()}</span>
                  <a class="original-link" href=${entry.url} target="_blank" rel="noopener noreferrer"
                    aria-label=${`Open ${entry.title} on YouTube`}>Open on YouTube ↗</a>
                  <span class="badges" aria-label="Downloaded files">
                    ${entry.available.mp4 ? html`<chip class="archive">MP4 · ${fileSize(entry.sizeBytes.mp4)}</chip>` : ""}
                    ${entry.available.hls ? html`<chip class="archive">HLS · ${fileSize(entry.sizeBytes.hls)}</chip>` : ""}
                    ${!entry.available.mp4 && !entry.available.hls ? html`<chip class="plain">No files</chip>` : ""}
                  </span>
                </div>
                <div class="history-actions tool-bar">
                  <button class="history-play info iconbutton <big>" type="button"
                    aria-label=${`Play ${entry.title}`} title="Play" ?disabled=${this.busy}
                    @click=${() => this.replay(entry)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#play-icon"></use></svg>
                  </button>
                  ${
                    entry.available.mp4 || entry.available.hls
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
            `,
            )}
          </ul>
        `
        }
      </section>
    `;
  }
}
