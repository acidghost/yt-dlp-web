# Testing and ownership

## Run the right suite

`just test-all` runs app, process, media-tools and client suites sequentially.
It requires the media tools and Chromium prerequisites; browser installation
may download binaries. Shuffle recipes are separate reproducibility checks.

| Command | Real systems | Controlled boundary |
| --- | --- | --- |
| `just test-app` | HTTP guards/routes, jobs, files, SQLite, media command/stream policy, application lifecycle | Media operations, CDN responses, external process handles, policy time |
| `just test-process` | POSIX groups, actual descendants, TERM/KILL and real-time disappearance | Checked-in shell fixture; no application re-execution |
| `just test-media-tools` | Actual `downloadVideo()`, yt-dlp/ffmpeg, production flags/parsing, ffprobe | Only source extraction: local info JSON/file URLs at the real launcher |
| `just test-client` | Chromium, Lit/Media Chrome/Hls.js and local media | See the two Playwright projects below |

Ordinary tests run `bun test --isolate tests/*.test.ts`. Each file has a fresh
module registry, not a separate application process. Module overrides are not
undone by `mock.restore()`: don't combine these tests with the genuine OS/tools
suites in a non-isolated invocation. Keep shared syscall/module mocks serial,
restore spies after owned work settles, and don't rely on isolation to dispose
resources. A fake process never allocates or signals a PID; deterministic
launcher branch tests intercept **both** spawn and signal operations.

Ordinary servers use ephemeral ports. In a sandbox permitting only port 3000:

```sh
TEST_PORT=3000 just test-app
```

No ordinary test needs yt-dlp, ffmpeg, public YouTube, PATH mutation, generated
executable code, or another copy of our app. Useful handoff/key/watch-boundary
unit tests remain; there is no coverage quota or test-per-module requirement.

### Browser projects

- **`journeys`**: three short real-API flows—native prepare/play/watch/progress/
  reload/replay; default proxy playback with rewritten separate audio/video
  HLS; active cancellation/cleanup/retry. No application API interception,
  invented tokens or fake history. The checked-in `e2e/support/server.ts`
  supplies only external download/extraction/CDN collaborators to the normal
  `startServer()` interface. Files, publication and SQLite remain real.
- **`browser-integration`**: existing route-intercepted regressions for controls,
  focus, player identity, layout/fullscreen, timestamp/clipboard behavior,
  response failures, polling races and pagehide/BFCache. These do not prove a
  complete backend journey. Retain them until verified replacement proof exists.

The host runs serially on port 3000, with fresh owned `tmp/e2e-data` and no
server reuse. It removes that directory only after graceful close. Native
browser-integration specs also install fixture media there. Don't run another
host on that directory. Failure traces/screenshots are retained; no broad
retries mask flakes.

To run only a project after Chromium is installed:

```sh
node_modules/.bin/playwright test --project journeys
node_modules/.bin/playwright test --project browser-integration
```

`tests/browser-host.test.ts` verifies host wiring through actual APIs and real
MPEG-TS fixture bytes, but **does not prove browser decoding or UI wiring**.

## Production resource owners

- `app/index.ts` is a guarded executable adapter. Only it reads ambient argv/env
  and requests application process exit. `runCli()` dispatches explicit input;
  its parsers stay private. Reset uses `resetLibrary()` without binding HTTP.
- `startServer()` returns `{ server, close, forceStopHttp }`, not an augmented
  Bun server. It validates bind/origin/TTL configuration before SQLite/staging
  allocation, disposes maintenance on bind failure, and owns its library,
  registries, download jobs and request work.
- `close()` is idempotent: the same promise closes admission, stops sweeping,
  cancels interruptible jobs, and drains HTTP, handlers and jobs before SQLite.
  Admission is checked again after native-file, extraction and proxy-preparation
  awaits. Force-closing HTTP does not imply a handler has settled.
- Unsafe download termination leaves the ID/slot reserved and staging intact.
  `close()` rejects rather than reporting successful cleanup. Confirm remaining
  writers stopped **before** restarting on that directory or deleting files.
  Concurrent applications on one `DATA_DIR` remain unsupported.
- `createShutdown()` coordinates a five-second graceful/forced/failed outcome;
  it never exits the process. Outstanding close work remains observed after a
  deadline. `registerSignals()` returns an unsubscribe function. Executable
  cleanup failure now exits nonzero instead of claiming success.
- `Library` owns its SQLite connection and data directory, has idempotent
  `close()`, and receives the same clock as its application. `list()` cannot
  accidentally look for media in another directory.
- `media.ts` owns format/options and metadata/HLS policy. `media-process.ts`
  owns bounded pipe/progress/lifecycle policy. `owned-process.ts` alone owns
  download groups and idempotent safe stop. Extraction retains its separate
  bounded ordinary-child semantics. Shared errors have one definition in
  `media-errors.ts`; `instanceof DownloadTerminationError` is a safety fence.

Every new application export has a production consumer: CLI/lifecycle functions
in the executable; runners in media operations; the launcher in the download
runner; shared errors in media/process/proxy code. Builders, parsers, pipe
readers, transitions and escalation helpers remain private. No media factory,
maintenance accessor, fixture flag, repository layer or event bus was added.

`appFixture()` owns the directory/application/gates with awaited async disposal.
Restart fully closes the previous instance. It releases controlled gates before
close and retains data if termination cannot be confirmed. Its explicit
no-external-writers exception is used only by the fake unsafe-termination case,
not by real process/tool fixtures. Policy clocks replace lease/retention/speed/
proxy-TTL/watch-order sleeps; OS liveness remains real time. A small background
sweep case verifies scheduling as well as expiry policy.

## Migration proof and deliberate gaps

The October 4 baseline was **69 passing Bun tests**, checks/typecheck green.
The refactor preserves behavior rather than the old count or placement.

| Previous proof/mechanism | Replacement / primary proof |
| --- | --- |
| Generated yt-dlp executables and inline child Bun imports for metadata/path/channel fallback | `media.test.ts`: actual download operation/runner against controlled process streams |
| Exported format selector / error mapper / pipe-reader tests | Operation-level argv, failure, byte-bound, strict JSON, UTF-8/CRLF and progress assertions in `media.test.ts`; helpers private |
| Generated stdout-progress regression | `stdout transfer progress and stderr postprocessors compose…`; real tools download/merge/metadata contract |
| Generated TERM-resistant child and child-app shutdown | `os/process-group.test.ts` for actual descendants; `shutdown.test.ts` for real HTTP/files/SQLite shutdown with held download cleanup; scoped syscall safety cases |
| Child CLI reset and server-file schema tests | `library.test.ts` direct reset/schema/media/legacy preservation; `cli.test.ts` reset dispatch without startup; import-safe executable test |
| Repeated native saved-file reuse case | `downloads.test.ts` stable ready/reuse/late cancel; server restart/range reuse; history file badges |
| Concurrent native helper-polling case | Shared-token/one-download/cancel integration in `downloads.test.ts`; server deletion/reprepare scenario uses real admission responses |
| Large mixed server file | History and security families retain their real HTTP/SQLite/files assertions; saved-file, proxy, assets and deletion composition remain in `server.test.ts` |
| Multi-second policy sleeps and global fixtures | Instance-local clocks, owned fixtures, explicit readiness, bounded snapshot waits; background sweep proof retained |
| Independently doubled server/media contracts | `media-app.test.ts`: HTTP → actual media operation/runner → controlled process, with real publication/SQLite and stop-before-cleanup fence |
| Generated three-layer smoke harness | `tools/media.test.ts` direct real downloader, source-only launcher adaptation, codecs and separately named cancellation; old script/command removed |
| Route-intercepted browser flows treated as e2e | Separate named projects; genuine journeys added, all 34 existing browser regressions retained |

Startup regressions were observed failing before their fixes: validation before
allocation, bind cleanup, and resource setup before binding. Additional ownership
cases protect late admission and drain behavior. HTTP cases preserve finalization,
deletion reservations, shared leases, worker capacity and unsafe-slot retention.

In-process lifecycle tests do not prove OS signal delivery/executable exit.
The macOS compiled-binary operator check separately exercised reset, actual
HTTP/embedded client assets, SIGTERM delivery and zero exit. Repeat it on target
Linux/container runtimes; the default suite does not re-execute the app.

### Verification recorded October 4, 2026 (Bun 1.4.2, macOS/nono)

- `TEST_PORT=3000 just test-app`: **126 passing tests**, two final runs (about
  1.4–1.6 seconds each; original baseline about 10 seconds).
- `TEST_PORT=3000 just test-app-shuffle`: **126 pass**, seed **424242**.
- Both OS contracts passed: TERM-resistant descendants and prompt leader exit
  (ten repeated process-reaping races).
- Real tools passed normally, individually, and shuffled with seed **42**.
  Each case owns its input/output directory; the stateless launcher adapter maps
  production output to that case's local source JSON. No case-global active input.
- Biome, strict TypeScript, standalone build and `git diff --check` passed.
  The earlier compiled-binary operator check passed on macOS; it was not repeated
  for this test-only review follow-up.
- Playwright discovers **42 tests**: 3 real-API journeys + 39 browser-integration
  cases. The user verified **all tests green**, including the final deletion-route
  corrections. Chromium execution remains unavailable in this agent environment
  per `AGENTS.local.md`; browser execution was user-verified, not rerun here.
- All **six** previously surviving review mutations are now detected. The
  positive audio-default control also remains detected. Evidence is in
  `tmp/review-followup-mutations.log` and `tmp/review-followup-mutation-*.log`.
  The user's original review/artifacts were left intact. The disposable-copy
  harness does not mutate production files in the working tree.
- Both tools cases include the corrected normal Darwin reaping behavior:
  [`killpg1()`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
  skips zombie members and can return `EPERM` when no signalable members remain.
  Signal-zero uncertainty is polled within existing bounds; only `ESRCH` confirms
  disappearance. Persistent uncertainty and actual TERM/KILL failures still fail
  cleanup. Earlier failures were incorrectly attributed to sandbox permissions;
  no profile change was needed.
- Previously retained directories (`media-tools-MfDCb4`, and the user's
  `media-tools-pNdjDS`) were not removed. Confirm old writers stopped before
  removing old files; a passing new run does not prove old groups stopped.

### Review follow-up

| Finding | Replacement proof |
| --- | --- |
| Automatic redirects could escape validation | Fake requires manual redirects; relative rebase, forbidden target never requested, and three-hop budget |
| Stream/body guards untested | Real buffered/chunked HTTP at 2048/2049 UTF-8 bytes, split within a multibyte character; missing/wrong Content-Type; empty/invalid JSON; preparation/history effects checked |
| Tools shared source input | Per-case owned fixtures; seed 42 reproduced the old 120-vs-12 failure, then passed with unchanged assertions |
| Unsafe ID but not slot reservation | Unsafe + live distinct jobs reject a third with 429 without launching; live lease renewed while unsafe lease/retention ages pass; staging/failed close retained |
| Empty output could publish | Missing/zero-byte metadata success produces a specific error, no stream/watch, removes staging, and admits retry while another slot is held |
| Misplaced negative filesystem assertions | Actual publication path plus downloader spy; `DATA_DIR/tmp`, unrelated and saved files survive restart; seeded staging survives invalid configuration |
| Timing mistaken for causal proof | Held download gates prove early admission; helper's 300 ms performance claim replaced with normal 2.5 s HTTP liveness deadline; browser stale replies settle as aborted or delivered; observable inactivity with keyboard focus |

User-verified browser additions include the fetch-boundary keepalive flag,
separate audio/video segment consumption, distinct deletion endpoints/outcomes,
confirmation dismissal, and deletion failure. No existing browser regression was
retired. The short native fixture proves persistence/source replay, **not**
unfinished-video end-to-end resume; intercepted cases retain the seek-policy
proof. Extending real-API resume coverage remains an explicit follow-up.

Linux CI runs ordinary tests, the OS contract, Chromium, checks and build.
The tools suite is opt-in: CI does not provision a pinned yt-dlp runtime.
Public YouTube/deployment/progress-cancel verification remains separate.

### Deferred ownership cuts

Download preparation/deletion still has one owner in the server closure; the
new HTTP integration suite protects a future coordinator extraction. No new
mocked coordinator/library/filesystem layer was introduced. Extract only if it
clarifies ownership enough to justify the move.

Client preparation/progress extraction and aggressive browser-test retirement
remain separate follow-ups; the current browser suite is user-verified green. The Lit/player
implementation is unchanged. Do not mark those steps or the separate
progress/cancel deployment checks complete merely because backend tests pass.
