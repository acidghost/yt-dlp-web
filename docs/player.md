# Player controls

Media Chrome 4.19.2 supplies the seek control, play/mute/volume controls, time display,
playback-rate menu, and fullscreen button. Assets are bundled locally; there are
no CDN imports. The existing video remains the media engine: hls.js for proxy
HLS, a native `src` for saved MP4, and native HLS where hls.js is unavailable.

Shortcuts remain Space/K, left/right (5 seconds), J/L (10 seconds), </> (speed),
and M (mute). Up/down scroll outside focused sliders and menus. Focused controls
handle their own keys. The rate menu offers 0.25–2× and includes a non-preset
current rate. No new volume/mute preferences are persisted.

The controller reserves a 16:9 frame before metadata loads, capped at 70vh
(85vh with Fill page). Below 768px player width, seek occupies a full-width row
above the action buttons. At 768px and above, it expands between volume and time
in a single row. The same control nodes stay mounted across resizing, Fill page,
and fullscreen. Players below 576px hide only the volume slider. Controls
normally auto-hide during playback, but remain visible for keyboard focus,
focused sliders, and an open rate menu. Reduced-motion menus have no transition.
This installed release moves focus on `transitionend`; when an opening menu has
no animation, the app supplies that completion event so keyboard focus and the
library's one-shot listener are handled even on a fast close/reopen.

## Fullscreen compatibility

On browsers supporting element fullscreen, the controller is the fullscreen
root: video, controls, and rate menu stay together. iOS/native-video
fullscreen may display the operating system's controls instead; custom controls
and the rate menu are not guaranteed in that mode. Desktop Safari, native HLS,
and mobile/fullscreen behavior require manual browser checks.

## Verification

`e2e/client.spec.ts` exercises real Media Chrome elements with the real Lit app,
including synthetic same-origin MP4/HLS [fixtures](../e2e/fixtures/README.md).
API responses are stubbed at the existing network boundary; YouTube is not used
in CI. MP4 playback uses the real server's byte-range endpoint. The e2e server
runs with `NODE_ENV=production`, avoiding Bun's development error overlay when
Media Chrome emits a ResizeObserver notification warning. These warnings are
not globally suppressed. Run `just check`, `just typecheck`, `just test`,
`just test-client`, and `just build` (keep port 3000 free).

Before merging, manually check both real preparation modes, Safari native HLS,
keyboard/pointer menus, buffering/errors, replay/delete, mobile landscape, and
fullscreen entry/exit. Capture screenshots of the normal and compact player.
The user confirmed all 11 initial migration browser tests pass and supplied
normal/compact player screenshots. The responsive inline-seek regression was
added afterward and still needs a browser-capable rerun; Chromium cannot launch
in the implementation's nono sandbox.
