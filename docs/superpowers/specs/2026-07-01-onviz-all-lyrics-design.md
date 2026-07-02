# On-Visualizer All-Lyrics Mode — Design

Date: 2026-07-01

## Goal

Add a lyrics presentation that renders **all** lyric lines directly on the
canvas visualizer (not in a DOM modal), laid out with Pretext. The active line
is 15% larger than the others and, along with its individual words, reacts to
the beat. Non-active lines are smaller and static. Two on-canvas variants:
**fit-all** (whole song shrunk to fit the screen) and **scrolling** (readable
size, the block scrolls so the active line stays on-screen). The Display tab
selects between these and the existing modal.

## Decisions (from brainstorming)

- Display "Lyrics view" is a **3-way selector**: `Modal` / `On-viz — fit all` /
  `On-viz — scrolling`. Persisted. Default `Modal` (current behavior).
- In on-viz modes the transport `≣` button **toggles** the on-canvas lyric list
  (show/hide); it does **not** open the modal. In modal mode `≣` opens the modal
  as it does today.
- fit-all: every non-empty line laid out at once; if the stack is taller than the
  usable height, all fonts scale down until it fits. Active line stays 15% bigger
  throughout. Long songs render small — accepted.
- scrolling: fixed readable base font; the stack scrolls vertically so the active
  line sits around 45% of screen height (not centered), eased smoothly. Font
  shrinks only if a single line is too wide for the screen.
- Active line + its words react to the beat exactly as the current `drawLyrics`
  active line does (per-token surge/impact/shimmer). Achieved by extracting the
  active-line word renderer so it can be positioned at any Y.
- Non-active lines: **center-aligned**, **fully static** (no per-word motion),
  dimmed by distance from the active line.
- Deferred (backlog, out of scope): a Display option for left-aligned and/or
  subtly beat-wobbling non-active lines.

## Architecture

The render loop (`render()` in `src/main.js`) currently draws lyrics via
`drawContextLyrics(...)` + `drawLyrics(...)` inside the
`if (!audio.captureMode || bridge.active)` timeline guard. This branch becomes
mode-aware:

- `lyricsView === 'modal'` → unchanged: `drawContextLyrics` + `drawLyrics`.
- `lyricsView` is an on-viz mode **and** `onvizLyricsShown` → new
  `drawAllLyrics(metrics, w, h, time, dt)`; the modal-style context + active
  draws are skipped.
- on-viz mode but hidden → draw no lyrics.

**Active-line renderer extraction.** Today `drawLyrics` computes its own vertical
center and runs the per-token beat-motion word loop. That word loop is extracted
into a reusable helper so both `drawLyrics` and `drawAllLyrics` render the active
line identically at a caller-provided baseline:

```
drawActiveLyricLine(metrics, w, time, opts)
  opts: { prepared, lines, font, fontSize, baseFontSize, topY }
```

`drawLyrics` is refactored to compute its layout as it does now, then delegate
the drawing to `drawActiveLyricLine`. `drawAllLyrics` reuses the same helper for
its active line. This keeps the per-token motion in one place (DRY) and honors
the repo rule that active-line tokens come from Pretext (`getLineTokens`), never
regex splitting.

Because the extraction touches the largest, most delicate function in the file,
it is its own task and is verified (modal mode looks unchanged) before
`drawAllLyrics` is built on top of it.

## Components

### State (`src/main.js`, near other lyric state)

- `lyricsView` (String): `'modal' | 'onviz-fit' | 'onviz-scroll'`. Loaded from
  `localStorage('lyricsView')`, default `'modal'`.
- `onvizLyricsShown` (Boolean): default `true`. Not persisted (session toggle).
- `onvizScrollY` (Number): current eased scroll offset for scrolling mode; module
  state so it can ease frame-to-frame.

### `drawActiveLyricLine` (extracted helper)

- Input: the prepared Pretext text, its laid-out `lines`, the font string, the
  layout `fontSize` and `baseFontSize`, and the top Y to start drawing from.
- Behavior: exactly the current active-line word loop from `drawLyrics` —
  per-token motion from `beat`/`metrics`, reveal, glow, emphasis — but anchored
  at `topY` instead of a self-computed center.
- Output: none (draws to canvas). Returns the total drawn height so callers can
  advance layout if needed.

### `drawAllLyrics(metrics, w, h, time, dt)`

- Compute `activeIdx = getCurrentLyricIndex(lyrics, getLyricTime())`.
- Collect the renderable lines: every entry with non-empty `text`, keeping their
  original index so the active one is identifiable.
- Choose a base font size: `min(w, h) * ONVIZ_BASE_SCALE` (a constant near the
  context-line scale, e.g. 0.026). Active line size = `base * 1.15`.
- Lay out each line with `getPrepared` + `layoutBalancedLines(prepared,
  w * 0.72, lineHeight)` (same wrap approach used elsewhere); cache-friendly.
- **fit-all:** sum every line's stacked height (wrapped lines included) with
  inter-line gaps. If total > usable height (`h` minus top/bottom margin), derive
  `shrink = usableH / total`, multiply all font sizes by `shrink`, and re-lay
  out. Draw the block starting at the top margin. Active line keeps its ×1.15.
- **scroll:** keep the readable base. Compute each line's Y in an un-scrolled
  stack. Target scroll so the active line's Y maps to `~0.45 * h`; ease
  `onvizScrollY` toward the target (e.g. `onvizScrollY += (target - onvizScrollY)
  * min(1, dt * 6)`). Only draw lines whose Y is within the viewport (cull).
- For each **non-active** line: `ctx.fillText` per wrapped Pretext line,
  center-aligned (`x = (w - line.width) / 2`), alpha falling off with
  `abs(idx - activeIdx)` (clamped to a floor), dim palette color. No per-word
  motion.
- For the **active** line: call `drawActiveLyricLine` at that line's computed Y.

### Display tab (`index.html` + `src/main.js`)

- Add a "Lyrics view" `<select>` (`id="lyrics-view"`) with three options:
  `modal`, `onviz-fit`, `onviz-scroll`. Wire in `syncDisplayPanel` +
  `change` listener persisting to `localStorage`.

### Transport `≣` button (`src/main.js`)

- `btnLyricsList` click handler branches on `lyricsView`:
  - `'modal'` → `openLyricsModal()` (existing).
  - on-viz → `onvizLyricsShown = !onvizLyricsShown` (toggle; no modal).

## Data flow (per frame, on-viz mode, list shown)

```
render() timeline guard
  └─ drawAllLyrics(metrics, w, h, time, dt)
       activeIdx = getCurrentLyricIndex(lyrics, getLyricTime())
       layout every non-empty line via Pretext (active ×1.15)
       fit-all → shrink all to fit height | scroll → ease onvizScrollY, cull
       non-active lines → static center fillText, distance-based alpha
       active line → drawActiveLyricLine(... at its Y) → beat-reactive tokens
```

## Edge cases

- Empty / no lyrics: draw nothing (no crash); the viz shows alone.
- Single line: it is the active line, centered-ish, 15% bigger, beat-reactive.
- Active index `-1` (before first timestamp): no line is "active"; render all as
  non-active (dim) until playback reaches the first line. For scroll mode, target
  the top.
- Very long songs in fit-all: fonts can get tiny; acceptable per decision.
- Capture-only (no bridge): lyric layer is skipped by the existing timeline
  guard, same as today.
- Mode switched while playing: next frame simply renders the other path; scroll
  offset re-eases.
- Async race guard untouched — `drawAllLyrics` only reads live state, launches
  nothing.

## Testing (manual — no test suite in repo)

- Display → Lyrics view = "On-viz — fit all": whole song appears on the canvas,
  active line clearly larger and pulsing to the beat; others small and static.
- Long song: fonts shrink so all lines fit; still one active line 15% bigger.
- Lyrics view = "On-viz — scrolling": lines at readable size; as the song plays
  the block scrolls so the active line stays around mid-screen (not dead center),
  motion eased, no jump.
- `≣` button in an on-viz mode toggles the on-canvas list off/on (no modal
  opens).
- `≣` button in Modal mode still opens the modal; modal behavior unchanged.
- Selection persists across reload.
- Switch between all three views live — no errors, active-line beat motion
  identical between Modal active line and on-viz active line.
- Works with both Bars+Wave and Linebed viz.

## Out of scope

- Click-to-seek on the on-canvas lines (that lives in the modal).
- Left-aligned / wobbling non-active lines (backlog todo).
- Per-line color theming beyond the existing palette dimming.
