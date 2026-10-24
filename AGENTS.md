# AGENTS.md

Guidance for agents working in this repo. Read this first to avoid rediscovering the layout.

## Project

Browser-only "speech to birdsong" converter: an Astro static page driving a self-contained
`AudioWorkletProcessor`. No backend, no uploads. Based on windytan's `blackbird.pl`; see
`README.md` for the DSP background and control reference.

- Node `>=22.12.0`, npm.
- Astro static output (`astro.config.mjs` is empty; default static build).
- No UI framework: plain Astro components + one vanilla ES module + one CSS file.

## Commands

```bash
npm install
npm run dev         # http://localhost:4321
npm run build       # static build to dist/
npm run preview     # serve dist/
npm run thumbnails  # regenerate example card thumbnails (add -- --force)
npm run wasm        # rebuild the Rust/WASM DSP core into public/worklets/
```

`predev` and `prebuild` regenerate missing/stale `public/examples/*.jpg` thumbnails with
`ffmpeg` (via `scripts/thumbnails.mjs`) before Astro runs.

Validation is `npm run build` plus manual browser testing. There is **no** lint, typecheck,
or test script. `src/scripts/app.js` starts with `// @ts-nocheck`, so `astro build` does not
typecheck it. Add tests only if the user asks; do not invent a framework.

## File map

| Path                                              | Role                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/index.astro`                           | Page shell and desktop three-column layout: `.playlist` (ExamplePresets, with Dropzone slotted into its grid), `.center` (Player + Transport + EqPanel, then the FAQ/footer closing block), and Controls. Imports `app.css` and `app.js`. |
| `src/components/*.astro`                          | Markup only. IDs here are the contract with `app.js`.                                                                                                                                                                                     |
| `src/scripts/app.js`                              | All client logic (~2000 lines): audio graph, EQ/canvas, transport, export, presets, voice analysis, event wiring.                                                                                                                         |
| `src/styles/app.css`                              | All styles. CSS custom properties in `:root`; dark theme.                                                                                                                                                                                 |
| `wasm/Cargo.toml`, `wasm/Cargo.lock`              | Rust crate definition and pinned dependency lockfile (no external crates currently).                                                                                                                                                      |
| `wasm/src/lib.rs`                                 | Rust DSP core compiled to `wasm32-unknown-unknown`; the primary worklet engine.                                                                                                                                                           |
| `scripts/build-wasm.mjs`                          | Builds the Rust core and copies it to `public/worklets/birdsong-processor.wasm`.                                                                                                                                                          |
| `public/worklets/birdsong-processor.wasm`         | Compiled Rust core. Committed; rebuild with `npm run wasm`.                                                                                                                                                                               |
| `public/worklets/birdsong-processor-wasm.js`      | `AudioWorkletProcessor` wrapper that instantiates the wasm core and copies render-quantum buffers.                                                                                                                                        |
| `public/worklets/birdsong-processor.js`           | Optimized JS fallback `AudioWorkletProcessor`; must stay behaviorally in sync with the Rust core.                                                                                                                                         |
| `public/examples/*.mp4`                           | Demo media referenced by `EXAMPLE_PRESETS`.                                                                                                                                                                                               |
| `public/examples/*.jpg`                           | Card thumbnails extracted from the demo videos by `scripts/thumbnails.mjs`. Commit them as a fallback for builds without ffmpeg.                                                                                                          |
| `public/showcqt-axis.png`                         | Spectrogram axis overlay.                                                                                                                                                                                                                 |
| `dist/`, `.astro/`, `.wrangler/`, `node_modules/` | Generated; do not edit.                                                                                                                                                                                                                   |

## `app.js` orientation

The file is organized loosely top-to-bottom. Search by these names instead of reading it all:

- Constants/state: `state`, `DEFAULT_SETTINGS`, `exporters`, `VOICE_TO_BIRD`.
- Audio: `ensureGraph`, `workletOptions`, `sendParams`, `applyMix`, `makeImpulseResponse`.
- EQ: `buildEqChain`, `applyEq`, `drawEqOverlay`, `setupEqCanvas`.
- Transport/export: `updateTransport`, `seek`, `tick`, `loadFile`, `setExportBtn`,
  `refreshExportButtons`, `resetExporters`, `renderBirdsong`, `encodeWavAsync`,
  `encodeMp3Async`, `startExport`.
- Settings/presets: `bindSlider`, `applySettings`, `currentSettings`, `PRESETS`,
  `randomizeAll`, `applyPreset`.
- Voice analysis: `analyseVoice`, `autoSet`, `updateAutoButtons`.
- Bottom of file: all `addEventListener` wiring and `window.dumpSettings`/`copySettings`.

## How wiring works

- Markup IDs are referenced directly with `$("id")` in `app.js`. If you rename or add an ID,
  update both files. No data-binding layer.
- Sliders use `bindSlider(id, labelId, stateKey, format, onChange, markDirty)`. The ID and
  state key are not always identical (e.g. `pitchresp` -> `pitchResp`). `bindSlider` also sets
  the range input's `--fill` custom property used by the compact track fill.
- `applySettings()` sets controls by dispatching `input`/`change`, so it relies on the
  bindings already being registered (they are at module load).
- Any sound-setting change should invalidate cached exports via `resetExporters()`; most
  paths already do this through `sendParams()` or EQ handlers.
- Live playback and offline export share `workletOptions()`; keep them in sync. Both use
  `loadWorkletModule()`, which prefers the Rust/WASM engine and falls back to the JS worklet
  if the wasm cannot be fetched or compiled.
- Audio is created lazily in `ensureGraph()` on the first file load/play, because browsers
  require a user gesture. Do not construct `AudioContext` at module load.

## Edit recipes

- **Add/change a control:** add markup in `src/components/Controls.astro` (or `Transport.astro`),
  add a `bindSlider` call and state handling in `app.js`, extend `DEFAULT_SETTINGS`,
  `currentSettings`, `applySettings`, and `randomizeAll` if it should be randomized.
- **Add a bird preset:** extend `PRESETS`; visible preset buttons are `[data-preset]` in
  `src/components/Controls.astro`.
- **Add a demo file:** put it in `public/examples/`, then extend `EXAMPLE_PRESETS` and the
  `examples` list in `src/components/ExamplePresets.astro`; buttons use `[data-example]`.
  Run `npm run thumbnails` to create its `.jpg` card image.
- **Change DSP:** edit `wasm/src/lib.rs`, mirror the change in
  `public/worklets/birdsong-processor.js` (the fallback), expose tunables through
  `workletOptions()` / processor options, and keep preset values in the same units as the UI.
  Run `npm run wasm` and commit the regenerated `public/worklets/birdsong-processor.wasm`.
  The tracker path runs at `sampleRate / DECIM` (8); keep the low-rate 70 Hz filters sized
  from `N / DECIM` and interpolate their outputs back to the audio rate.
- **Change transport/export:** `Transport.astro` holds the play button, scrub row,
  volume, and the split WAV/MP3 block; playback always loops. `setExportBtn()` drives export progress through the
  `--p` CSS custom property (left-to-right fill); `.ready` inverts the button to white.

## Conventions and pitfalls

- Match existing style: tabs, double quotes, semicolons, trailing commas, Prettier-like
  wrapping. Avoid adding comments unless they explain non-obvious DSP or invariants.
- `BASE = import.meta.env.BASE_URL || "/"`; build asset URLs as `${BASE}...` (worklet,
  examples, axis image).
- Desktop layout is a CSS grid in `.workspace`. Below 1080px, `.center` and `.stage` switch to
  `display: contents` so `.playlist` can be ordered between the transport and the EQ panel and
  the FAQ/footer closing block stays last; keep those order rules in sync with the markup.
- The worklet path must stay correct for subpath deployments.
- `setExportBtn(exp, fill, ready)` keeps visible labels fixed ("WAV"/"MP3"); state is shown by
  the linear fill, the `.ready` color, and updated `title`/`aria-label`. Do not put percentages
  back into the label without asking.
- Pause/play uses inline SVG icons toggled by `.playing`; update `updateTransport()` and the
  accessibility labels together with any icon changes.
- EQ and CQT canvases draw imperatively; CSS size and `canvas.width/height` are managed in JS.
  Keep device-pixel-ratio handling consistent with existing helpers. The input EQ canvas is
  shared with the input CQT: `renderCqtSurface()` must reset the 2D transform to identity and
  clear the canvas, because `drawEqOverlay()` leaves a dpr transform behind. CQT columns advance
  on a wall-clock accumulator (60/s), not once per animation frame.
- Presets deliberately do not change Voice range (`shift`); preserve that if editing presets.
- Master volume is monitoring-only and never exported or randomized.
- README is the user-facing source of truth for controls; update it when behavior changes.

