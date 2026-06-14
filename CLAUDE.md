# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (`bun.lock`, `package-lock.json`, and `node_modules/` are all present; either npm or bun works, but the README and scripts assume npm).
- `npm run dev` — start Vite dev server, then open the printed local URL.
- `npm run build` — Vite production build into `dist/`.

There is no test suite, linter, or typechecker configured. `.gitignore` reserves `playwright-report/`, `test-results/`, and `.captures/`, but no Playwright config or tests are committed.

## Architecture

Vanilla ES-module browser app. No framework. `index.html` is the UI shell; everything else is plain JS in `src/`. Canvas 2D rendering, Web Audio API for sound, `@chenglou/pretext` for text layout.

The single most important concept (from the README): **audio analysis decides _how_ text moves; Pretext decides _where text can safely exist before it moves_.** Layout and motion are deliberately separate passes.

### Data flow per frame

`render()` in `src/main.js` (the requestAnimationFrame loop, ~line 1007) drives everything:

1. `AudioEngine.getMetrics()` (`src/audio.js`) → `{ bass, mid, treble, overall, rms, frequencyData, waveformData }`. Bands are slices of the FFT bins (bass ≈ first 2% of bins, mid ≈ up to 18%, treble = rest).
2. `BeatDetector.update(metrics, dt)` (`src/beat-detect.js`) → per-band beats plus decaying motion-state scalars (`surge`, `release`, `pressure`, `impact`, `trebleShimmer`, `splitPulse`). These are time-decayed each frame and re-armed on transients (band energy exceeding a moving average of its history).
3. `getCurrentLyric` / `getLyricProgress` (`src/lyrics.js`) pick the active line for the current playback time.
4. Pretext lays out the active line, then per-token motion is applied and drawn.

### The Pretext layout pipeline (`src/main.js`)

This is the non-obvious core and spans several cooperating helpers. Active-lyric layout goes through `layoutActiveLyricLines` → `layoutBalancedLines` → `getBalancedWrapWidth` (binary-search a tighter width that preserves the line count from a full-width `layoutWithLines` pass) → `layoutShapedLines` (route line-by-line with `layoutNextLine` and `getVariableLineWidth` so middle lines can be narrower for a shaped silhouette).

Rendering does **not** regex-split text. `getLineTokens` reads Pretext's `line.start`/`line.end` cursor ranges against `prepared.segments`, and `sliceSegmentText` slices by grapheme when a line breaks inside a segment. Prepared text is cached via `getPrepared` (keyed by text+font); `setLocale` is called from `syncPretextLocale` when the inferred lyric locale changes (`detectLyricsLocale`), and a locale change must clear the caches (`clearAllTextCaches`, which also calls Pretext's `clearCache`).

### Lyrics sourcing (priority order)

`applyLyricsInput` / `setLyricsState` funnel all sources into the `lyrics` array of `{ time, text, emphasis }`:

- Local files / drag-drop / paste → `parseLyricsFile` (`src/lrc-parser.js`, handles `.lrc` timed and `.txt` plain with auto-timing).
- Embedded tags from audio metadata → `src/id3-reader.js`.
- Remote fallback → `fetchLyrics` (`src/lyrics-fetch.js`) queries lrclib.net with scored candidate matching (needs score ≥ 70).
- `src/lyrics.js` also holds `demoLyrics` used when nothing else is available.

`DEFAULT_TRACK` (top of `src/main.js`) auto-loads on startup via `loadDefaultTrack` → `loadHostedLyrics` → `fetchDefaultLyrics`. Audio is served same-origin from `public/` (`APP_BASE_URL + skyfall.mp3`); a CDN URL would need CORS for `decodeAudioData`.

### Async race guard

Track loads use a monotonic `activeTrackId` / `loadVersion` counter. Any async lyric/audio step re-checks `trackId !== activeTrackId` and bails if a newer load started. Preserve this pattern when adding async load paths.

## Conventions

- 2-space indent, no semicolons, ES modules, single quotes.
- `src/main.js` is large (~1080 lines): state + UI wiring at top, Pretext layout helpers in the middle, drawing functions (`drawLyrics`, `drawContextLyrics`, `drawFrequencyBars`, `drawWaveform`, `drawCircularViz`, particles) below, render loop at the bottom.
