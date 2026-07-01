# Full Lyrics Modal — Design

Date: 2026-07-01

## Goal

Add a button (near the transport / seek bar) that opens a full-screen modal
(80vw × 80vh, centered, dimmed backdrop) listing every fetched lyric line. The
user can click any line to seek playback to slightly before that line's start.
The currently-active line stays animated to the beat while the modal is open.

## Scope / phasing

- **Phase 1 (this spec, ship first):** modal shell, full lyric list,
  click-to-seek with a settable lead offset, active-line highlight + auto-scroll,
  **pulse/glow** beat motion on the active line, Display-tab settings.
- **Phase 2 (deferred):** **per-token** beat motion mode using Pretext
  tokenization. Design captured here for continuity but not built yet.

## Decisions (from brainstorming)

- Presentation: full-screen modal, ~80% × 80%, dimmed backdrop. (Not a side
  drawer or reused option-pane.)
- Open button: near the seek bar / transport controls, `≣`-style icon.
- Dismiss: Esc key **and** backdrop click **and** an `×` close button.
- Untimed lyrics (`lyricsTimed === false`, e.g. auto-timed `.txt` / demo):
  click still seeks to the app-assigned approximate `.time`.
- Active-line motion is user-selectable on the Display tab: **pulse** (Phase 1)
  or **per-token** (Phase 2). Pulse is the default and the only mode shipped in
  Phase 1; the selector still exists but per-token is inert / disabled until
  Phase 2 lands.
- Lead offset before a line's start: settable, default **500 ms**, persisted.

## Architecture

The lyric list is a **DOM** scroll container, not canvas. DOM gives free
scrolling, click targets, and Esc/backdrop/`×` dismissal. The existing beat
pipeline (`drawLyrics`, per-token surge/impact/shimmer) is canvas code and is
**not** reused directly. Instead the modal's active-line motion is driven by the
same shared module-level `beat` / `metrics` state, applied to DOM via a small
update function called from the existing `render()` loop — only when the modal
is open, so no extra `requestAnimationFrame` and zero cost when closed.

Rationale for not stitching a canvas overlay into the scroll list: scroll-sync
and per-line positioning between a canvas layer and a scrolling DOM list is
fragile. DOM-only keeps it simple.

Pretext note: Pretext lays text out into token positions for **canvas** motion.
For a plain scrollable reading list the browser's own text wrapping is correct
and simpler, so the static list does **not** go through Pretext. Pretext
tokenization (`getLineTokens` / `sliceSegmentText`) is used only in Phase 2 to
split the active line into per-token spans — honoring the repo rule that text is
never regex-split.

## Components

### 1. Markup (`index.html`)

- `#btn-lyrics-list`: icon button placed in the transport shell near the seek
  bar / time row. `aria-label="Full lyrics"`.
- `#lyrics-modal`: fixed-position overlay, hidden by default (e.g. `hidden`
  attribute or a `.open` class toggled by JS). Structure:
  - `.lyrics-modal-backdrop` — dimmed, click closes.
  - `.lyrics-modal-panel` — 80vw × 80vh, centered (flex/grid center), rounded,
    matches existing panel chrome/colors.
    - header row: title + `#lyrics-modal-close` (`×`).
    - `#lyrics-modal-body` — vertical scroll container holding line rows.
- CSS follows existing panel styling conventions already in `index.html`
  (settings/capture panels). Respect `prefers-reduced-motion` for the pulse.

### 2. List rendering (`src/main.js`)

- Build (or rebuild) rows whenever the modal opens **and** whenever the `lyrics`
  array changes while open. Rebuild is keyed off the same state that
  `setLyricsState` / `applyLyricsInput` update.
- One row (`<button>` or `<div role="button">`) per lyric entry **with
  non-empty `text`**; empty separator lines are skipped from the list but still
  exist in the array for timing.
- Each row stores its source index (`dataset.idx`) so the click handler reads
  `lyrics[idx].time` without recomputation.
- Row click:
  - `const lead = leadMs / 1000`
  - `const target = Math.max(0, lyrics[idx].time - lead)`
  - Bridge active → `bridge.seek(target).then(syncProgressUI)` then
    `syncProgressUI()`.
  - Local → guard `audio.duration > 0`, then `audio.seekTo(target)` +
    `syncProgressUI()`.
  - Mirrors the existing `seekBar` `input` handler's bridge/local split.

### 3. Active-line tracking

- Each frame the modal is open, compute the active index from
  `getLyricTime()` against `lyrics` (same rule as `getCurrentLyric`, but we need
  the index). Add/reuse a helper returning the index; keep `getCurrentLyric`
  untouched or extend it to also expose the index.
- Toggle `.active` on the corresponding row; remove it from the previous.
- When the active row changes, auto-scroll it into view
  (`scrollIntoView({ block: "center", behavior: "smooth" })`), but suppress
  auto-scroll briefly after the user manually scrolls, so reading isn't yanked.

### 4. Beat motion — Phase 1 (pulse)

- In `render()`, after `beat` / `metrics` are computed, if the modal is open
  call `updateModalActiveLine()`.
- Pulse: on the `.active` row, set a CSS transform `scale(...)` and
  `text-shadow`/`filter` brightness driven by `beat.impact` / `beat.pressure` /
  `metrics.overall` (scaled by `lyricMotion` like the canvas path). Whole-line,
  no per-token.
- No-op (and clear any residual transform) when no row is active or motion is
  reduced.

### 5. Beat motion — Phase 2 (per-token, deferred)

- When mode = per-token, wrap the active line's text in per-token spans built
  from Pretext `getLineTokens(prepared, line, font)` (+ `sliceSegmentText` for
  mid-segment breaks), reusing `getPrepared` caching.
- Apply per-span translate/rotate/opacity from the same beat scalars the canvas
  motion uses (surge/impact/shimmer), ported to DOM transforms.
- Rebuild spans only when the active line changes, not per frame.

### 6. Settings (Display tab, `index.html` + `src/main.js`)

- **Lead offset** slider next to the existing auto-reveal duration slider.
  Range 0–2000 ms, step 50, default 500. State var `leadMs`, persisted to
  `localStorage` (`lyricSeekLeadMs`), loaded on startup with the other
  persisted params, wired through the Display panel sync.
- **Active-line motion** selector (pulse / per-token). State var persisted
  (`lyricModalMotion`). Per-token option present but disabled/inert until
  Phase 2.

## Data flow

```
open button click ─▶ open modal ─▶ build rows from `lyrics` (skip empties)
render() loop (modal open) ─▶ active index from getLyricTime()
                            ─▶ toggle .active + auto-scroll
                            ─▶ pulse transform from beat/metrics
row click ─▶ seek to max(0, line.time - leadMs/1000) via bridge or audio
Esc / backdrop / × ─▶ close modal (clear residual transform, drop Esc listener)
```

## Lifecycle / dismiss

- Opening adds a `keydown` Esc listener; closing removes it.
- Backdrop click and `×` both close. Closing clears the active-row transform and
  stops the `updateModalActiveLine` calls (guarded by an `isModalOpen` flag).
- No new `requestAnimationFrame`; reuse the existing render loop.

## Edge cases

- Empty `lyrics` / demo-only: show all non-empty lines; if none, show a muted
  "No lyrics loaded" state.
- Lyrics change while open (fetch resolves, user loads a file): rebuild rows.
- Async race guard: modal reads the live `lyrics` array; it does not launch its
  own async loads, so the `activeTrackId` guard is unaffected.
- Bridge with `track.length <= 0`: seek guarded, same as existing seek bar.
- `prefers-reduced-motion`: skip the pulse transform.

## Testing (manual — no test suite in repo)

- Open modal via button; list shows all non-empty lines.
- Click a mid-song line → playback jumps to ~500 ms before that line.
- Change lead offset → seek target shifts accordingly; persists across reload.
- Active line highlights + auto-scrolls as song plays; pulses on the beat.
- Esc, backdrop click, and `×` each close; reopening still works.
- Untimed (`.txt`/demo) lyrics: clicking still seeks to approximate time.
- Bridge mode: clicking seeks the system player.

## Out of scope

- Per-token DOM motion (Phase 2).
- Editing / re-timing lyrics from the modal.
- Search / filter within the list.
