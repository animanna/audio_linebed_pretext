# Active-Word Effects (On-Viz Lyrics) — Design

Date: 2026-07-01

## Goal

In the on-visualizer all-lyrics view (mono/white text), mark the **active word**
— the word currently being sung — with a rich, selectable set of effects:
gradient sweep, glow/bloom, scale pop, and color tint. Restores the gradient the
earlier `mono` change disabled, scoped to just the active word, plus three more.

## Decisions (from brainstorming)

- Active word = the word currently emerging: `vocalFrontWord` when Vocal Sync is
  active, otherwise the reveal-front word from the even clock.
- Four effects, each an independent Display-tab on/off switch (`.lb-flip`),
  persisted. Defaults: gradient **on**, glow **on**, pop **on**, tint **off**.
- Effects apply only in `mono` (on-viz) mode; the rest of the line stays white.
- Modal mode is untouched (effects gated on `mono`; its own color pipeline runs).

## Architecture

All changes live in `drawLyrics` (`src/main.js`) plus Display-tab wiring. No new
files. The active-word treatment reuses the existing per-word transform/draw
machinery — it only swaps fill/shadow/scale on the one active token.

### Active-word index

`drawLyrics` already computes `vocalFrontWord` (global index of the emerging word
under Vocal Sync, `-1` otherwise) and `evenFront` (the even-clock reveal front).
Add, before the per-line loop:

```
activeWordIdx = vocalSyncActive
  ? vocalFrontWord
  : clamp(Math.floor(evenFront / 0.92), 0, totalTokens - 1)
```

Per token: `isActiveWord = mono && state.globalWordIdx === activeWordIdx`.

### Effect application (in the token draw block, when `isActiveWord`)

- **Gradient sweep (`awGradient`):** reuse the existing hue-gradient `createLinearGradient`
  path — currently gated off by `mono`. Re-enable it for the active word only:
  `gradientOn = (!mono && ...) || (mono && isActiveWord && awGradient)`. Sweep hue
  over `time`, spread widens with `vocalDetector.level` (Vocal Sync) or
  `metrics.overall`.
- **Glow/bloom (`awGlow`):** when `mono && isActiveWord && awGlow`, boost
  `ctx.shadowBlur` and set a colored `shadowColor` (hue or accent), scaled by
  `beat.impact` + any vocal `pop` energy.
- **Scale pop (`awPop`):** when `mono && isActiveWord && awPop`, add an extra
  scale term. Under Vocal Sync the existing `pop` layer already bumps on onsets;
  additionally add a `beat.impact`-driven bump so it pops without Vocal Sync too.
- **Color tint (`awTint`):** when `mono && isActiveWord && awTint` and no gradient
  is active, fill the active word with a solid palette accent instead of white.

Precedence when multiple are on: gradient fill wins over tint (both set the
fill); glow and pop are additive and independent.

### Settings (Display tab)

Four `.lb-flip` switch buttons (like `vs-fx-gradient`): ids `aw-gradient`,
`aw-glow`, `aw-pop`, `aw-tint`. Module vars `awGradient`, `awGlow`, `awPop`,
`awTint` loaded from `localStorage` (`awGradient`/`awGlow`/`awPop`/`awTint`),
defaults `true/true/true/false`. Synced + toggled in the Display panel wiring,
mirroring the existing switch pattern (`aria-checked`, label text).

## Edge cases

- No active word (`activeWordIdx < 0`, before first word / empty line): no token
  matches; all stay white.
- Vocal Sync off: `activeWordIdx` uses the even-clock front, so a word is still
  highlighted in time with the reveal.
- All four switches off: line renders plain white (current behavior).
- Reduced motion: scale pop is subtle; no separate guard needed (canvas), but pop
  magnitude stays small.

## Testing (manual — no suite)

- On-viz view, Vocal Sync off: the emerging word shows the enabled effects and
  advances word-by-word with the reveal; rest of line white.
- Toggle each Display switch: the corresponding effect appears/disappears; state
  persists across reload.
- Vocal Sync on: the highlighted word tracks vocal onsets; gradient/glow react to
  the vocal stem.
- Modal mode: unchanged (its full color pipeline still runs).

## Out of scope

- Active-word effects in modal mode (its own coloring already exists).
- Per-effect intensity sliders (switches only for now).
