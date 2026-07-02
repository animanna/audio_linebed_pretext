# On-Visualizer All-Lyrics Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every lyric line on the canvas via Pretext, with the active line 15% larger and beat-reactive; selectable on the Display tab as fit-all or scrolling, alongside the existing modal.

**Architecture:** Extract `drawLyrics`' font+layout into a shared `layoutLyricLine` and let `drawLyrics` accept an `opts` object so it can paint the active line at any Y and size. A new `drawAllLyrics` measures all lines with `layoutLyricLine`, paints non-active lines with plain centered `fillText`, and delegates the active line to `drawLyrics`. The render loop chooses modal-vs-on-viz from a persisted `lyricsView`.

**Tech Stack:** Vanilla ES modules, Canvas 2D, `@chenglou/pretext` layout (`getPrepared`, `layoutActiveLyricLines`, `layoutBalancedLines`, `getLineTokens`).

## Global Constraints

- Code style in `src/main.js`: 2-space indent, **semicolons** (this file uses them despite CLAUDE.md), ES modules, double quotes as in surrounding code.
- No test framework — verify manually in the browser via `npm run dev` and `node --check` / `npx vite build`.
- Active-line tokens come from Pretext (`getLineTokens`), never regex-split.
- `lyricsView` values: `'modal' | 'onviz-fit' | 'onviz-scroll'`; default `'modal'`. Persist to `localStorage('lyricsView')`.
- On-viz active line = non-active base × **1.15**. fit-all shrinks all fonts to fit height. scroll anchors active at ~0.45·h, eased.
- Non-active lines: center-aligned, static, distance-dimmed. (Left-align/wobble is backlog, not here.)
- Modal-mode behavior must stay byte-identical after the refactor.

---

### Task 1: Extract `layoutLyricLine` and parameterize `drawLyrics`

Refactor only — modal mode looks unchanged. Pulls the font/layout computation into a reusable helper and lets `drawLyrics` paint at an arbitrary anchor/size while optionally skipping the crossfade.

**Files:**
- Modify: `src/main.js` — `drawLyrics` (lines 3095-3169 region) + add `layoutLyricLine` just above it.

**Interfaces:**
- Produces: `layoutLyricLine(text, emphasis, w, h, baseFontOverride) -> { fontDef, baseFontSize, fontSize, font, maxWidth, lineHeight, prepared, lines, height }`.
- Produces: `drawLyrics(metrics, w, h, time, opts?)` where `opts = { anchorTopY?: number|null, baseFontOverride?: number|null, drawCrossfade?: boolean }`. Defaults reproduce today's behavior.

- [ ] **Step 1: Add `layoutLyricLine` above `drawLyrics`**

Insert immediately before `function drawLyrics(` (line 3095):

```js
// Shared active-line layout: font string + Pretext line breaking. Used by
// drawLyrics (modal mode) and drawAllLyrics (on-viz) so both measure and paint
// the active line identically. baseFontOverride pins an absolute base size
// (on-viz passes a shrunk / spotlight size); null = the default modal size.
function layoutLyricLine(text, emphasis, w, h, baseFontOverride = null) {
  const fontDef = LYRIC_FONTS[lyricFontKey] || LYRIC_FONTS.sans;
  const baseFontSize =
    baseFontOverride != null
      ? baseFontOverride
      : Math.min(w, h) * 0.06 * lyricFontScale;
  const emphasisScale = emphasis ? 1.2 : 1;
  const fontSize = Math.round(baseFontSize * emphasisScale);
  const weight = emphasis ? fontDef.emphasisWeight : fontDef.weight;
  const styPrefix = fontDef.style ? fontDef.style + " " : "";
  const font = `${styPrefix}${weight} ${fontSize}px ${fontDef.family}`;
  const maxWidth = w * 0.66;
  const lineHeight = fontSize * 1.5;
  const prepared = getPrepared(text, font);
  const { lines } = layoutActiveLyricLines(prepared, maxWidth, lineHeight);
  return {
    fontDef,
    baseFontSize,
    fontSize,
    font,
    maxWidth,
    lineHeight,
    prepared,
    lines,
    height: lines.length * lineHeight,
  };
}
```

- [ ] **Step 2: Change the `drawLyrics` signature + destructure opts**

Replace `function drawLyrics(metrics, w, h, time) {` (line 3095) with:

```js
function drawLyrics(metrics, w, h, time, opts = {}) {
  const {
    anchorTopY = null,
    baseFontOverride = null,
    drawCrossfade = anchorTopY == null,
  } = opts;
```

- [ ] **Step 3: Replace the inline font/layout block with `layoutLyricLine`**

Replace the block from `const fontDef = LYRIC_FONTS[...]` (line 3125) through the `layoutActiveLyricLines` call (line 3164) — i.e. lines 3125-3164 — with:

```js
  const fontDef = LYRIC_FONTS[lyricFontKey] || LYRIC_FONTS.sans;
  const L = layoutLyricLine(lyric.text, lyric.emphasis, w, h, baseFontOverride);
  const baseFontSize = L.baseFontSize;
  const fontSize = L.fontSize;
  const font = L.font;
  const maxWidth = L.maxWidth;
  const lineHeight = L.lineHeight;
  const prepared = L.prepared;
  const { lines } = L;

  // Beat pump as a COMPRESSED visual scale (applied as an outer ctx transform,
  // never to the layout size).
  const pumpGain =
    beatEffect === "pump" ? 0.36 : beatEffect === "split" ? 0.12 : 0.03;
  const rawPump =
    (beat.impact * pumpGain + beat.pressure * pumpGain * 0.6) * lyricMotion;
  const knee = 0.06;
  const compressed =
    rawPump <= knee ? rawPump : knee + (rawPump - knee) / (1 + (rawPump - knee) * 7);
  const beatPump = 1 + Math.min(compressed, 0.16);

  const spreadBeat = clamp(
    (beat.impact * 0.6 + beat.pressure * 0.4) * lyricMotion,
    0,
    1,
  );
  const lineSpreadBeat = spreadBeat * 0.16;
  const wordGapBeat = spreadBeat * fontSize * 0.22;
```

(This preserves every pump/spread line that previously sat between the font block and the layout call; only the font/layout lines are folded into `layoutLyricLine`, and `fontDef` is kept because the emphasis draw path reads it.)

- [ ] **Step 4: Anchor `baseY` on the optional override**

Replace `const baseY = h / 2 - totalTextHeight / 2 + verticalBias;` (line 3169) with:

```js
  const baseY =
    anchorTopY != null
      ? anchorTopY
      : h / 2 - totalTextHeight / 2 + verticalBias;
```

- [ ] **Step 5: Gate the crossfade on `drawCrossfade`**

Change the crossfade guard (line 3172) from:

```js
  if (prevLyricFade.text && prevLyricFade.alpha > 0) {
```

to:

```js
  if (drawCrossfade && prevLyricFade.text && prevLyricFade.alpha > 0) {
```

- [ ] **Step 6: Verify refactor is behavior-preserving**

Run: `node --check src/main.js` → expect no output (syntax OK).
Run: `npx vite build` → expect `✓ built`.
Run: `npm run dev`, watch the default track in the default (Modal) view.
Expected: the centered active line, crossfade, per-word beat motion, and vocal-sync all look exactly as before this task.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "refactor(lyrics): extract layoutLyricLine, parameterize drawLyrics anchor"
```

---

### Task 2: Lyrics-view state, Display selector, button + render branch

Adds the 3-way `lyricsView` state, the Display selector, the `≣`-button branch, and the render-loop mode switch. `drawAllLyrics` is a temporary stub so the wiring is testable before the real renderer lands.

**Files:**
- Modify: `index.html` — Display page (after the seek-lead / motion controls added earlier)
- Modify: `src/main.js` — state near other lyric state; `syncDisplayPanel`; `btnLyricsList` handler; the render-loop lyric branch (line ~3695); a `drawAllLyrics` stub near `drawContextLyrics`.

**Interfaces:**
- Consumes: `getCurrentLyricIndex`, `getLyricTime`, `openLyricsModal`, `btnLyricsList`, `syncDisplayPanel` (existing).
- Produces: module vars `lyricsView` (String), `onvizLyricsShown` (Boolean), `onvizScrollY` (Number); DOM id `lyrics-view`; function `drawAllLyrics(metrics, w, h, time, dt)`.

- [ ] **Step 1: Add the Display selector markup**

In `index.html`, inside the Display page `.lb-sliders` (after the `lyric-modal-motion` label added earlier), add:

```html
          <label class="lb-slider"><span>Lyrics view</span>
            <select id="lyrics-view">
              <option value="modal">Modal (button)</option>
              <option value="onviz-fit">On-viz — fit all</option>
              <option value="onviz-scroll">On-viz — scrolling</option>
            </select>
          </label>
```

- [ ] **Step 2: Add state in `src/main.js`**

Next to the `lyricModalMotion` block (added earlier, near `leadMs`), add:

```js
// Lyrics presentation: "modal" (DOM overlay via the ≣ button) or an on-canvas
// all-lyrics layout, either fit-to-screen or scrolling. Persisted.
let lyricsView = "modal";
try {
  const v = localStorage.getItem("lyricsView");
  if (v === "modal" || v === "onviz-fit" || v === "onviz-scroll") lyricsView = v;
} catch {}
// On-viz list visibility (toggled by the ≣ button in on-viz modes). Session-only.
let onvizLyricsShown = true;
// Eased vertical scroll offset for onviz-scroll mode.
let onvizScrollY = 0;
```

- [ ] **Step 3: Sync + persist the selector**

Add a ref near the other Display refs:

```js
const lyricsViewSelect = document.getElementById("lyrics-view");
```

In `syncDisplayPanel`, add:

```js
  lyricsViewSelect.value = lyricsView;
```

After the `modalMotionSelect` change listener, add:

```js
lyricsViewSelect.addEventListener("change", () => {
  lyricsView = lyricsViewSelect.value;
  try { localStorage.setItem("lyricsView", String(lyricsView)); } catch {}
});
```

- [ ] **Step 4: Branch the `≣` button on the view**

Replace the existing `btnLyricsList.addEventListener("click", openLyricsModal);` with:

```js
btnLyricsList.addEventListener("click", () => {
  if (lyricsView === "modal") {
    openLyricsModal();
    return;
  }
  onvizLyricsShown = !onvizLyricsShown;
});
```

- [ ] **Step 5: Add a `drawAllLyrics` stub**

Immediately before `function drawContextLyrics(` (line 3708), add:

```js
// On-canvas all-lyrics renderer (filled in by later tasks).
function drawAllLyrics(metrics, w, h, time, dt) {
  // stub — replaced in the fit-all / scroll tasks
}
```

- [ ] **Step 6: Branch the render loop's lyric draw**

Replace the lyric-draw block in `render()` (currently lines ~3694-3697):

```js
  if (!audio.captureMode || bridge.active) {
    drawContextLyrics(metrics, w, h, fakeTime);
    drawLyrics(metrics, w, h, fakeTime);
  }
```

with:

```js
  if (!audio.captureMode || bridge.active) {
    if (lyricsView === "modal") {
      drawContextLyrics(metrics, w, h, fakeTime);
      drawLyrics(metrics, w, h, fakeTime);
    } else if (onvizLyricsShown) {
      drawAllLyrics(metrics, w, h, fakeTime, dt);
    }
  }
```

- [ ] **Step 7: Verify wiring**

Run: `node --check src/main.js` and `npx vite build` → expect success.
Run: `npm run dev`. In Display, switch Lyrics view to "On-viz — fit all": the modal-style centered lyric disappears (stub draws nothing). Click `≣` — no modal opens (it toggles the invisible on-viz list). Switch back to Modal: centered lyric + `≣`-opens-modal return. Selection persists across reload.

- [ ] **Step 8: Commit**

```bash
git add index.html src/main.js
git commit -m "feat(lyrics): lyrics-view selector, button branch, render switch"
```

---

### Task 3: `drawAllLyrics` — fit-all mode

Fills the stub for `lyricsView === 'onviz-fit'`: lay out every line, shrink to fit the screen height, paint non-active lines static/dim and the active line via `drawLyrics`.

**Files:**
- Modify: `src/main.js` — replace the `drawAllLyrics` stub.

**Interfaces:**
- Consumes: `layoutLyricLine`, `drawLyrics(..., opts)` (Task 1); `getCurrentLyricIndex`, `getLyricTime`, `lyrics`, `palettes`, `getColor` (existing); `lyricsView`, `onvizScrollY` (Task 2).
- Produces: full fit-all rendering. `onviz-scroll` still no-ops until Task 4.

- [ ] **Step 1: Implement fit-all**

Replace the `drawAllLyrics` stub with:

```js
// Base font as a fraction of the smaller viewport side; the active line is 15%
// bigger for a spotlight. In fit-all every line is shrunk uniformly so the whole
// song fits the height; in scroll the block scrolls at a readable size.
const ONVIZ_BASE_SCALE = 0.03;
const ONVIZ_ACTIVE_MULT = 1.15;

function drawAllLyrics(metrics, w, h, time, dt) {
  const activeIdx = getCurrentLyricIndex(lyrics, getLyricTime());
  const items = [];
  for (let i = 0; i < lyrics.length; i++) {
    const text = lyrics[i].text;
    if (text && text.trim()) {
      items.push({ idx: i, text, emphasis: lyrics[i].emphasis, active: i === activeIdx });
    }
  }
  if (items.length === 0) return;

  const palette = palettes[Math.floor(time / 15) % palettes.length];
  const topMargin = h * 0.08;
  const usableH = h - topMargin * 2;
  const gap = Math.min(w, h) * ONVIZ_BASE_SCALE * 0.6;

  const baseSize = Math.min(w, h) * ONVIZ_BASE_SCALE;
  const activeSize = baseSize * ONVIZ_ACTIVE_MULT;

  // Measure once to decide the fit shrink (scroll mode never shrinks here).
  const measure = (item, size) =>
    layoutLyricLine(item.text, item.emphasis, w, h, size);
  let laid = items.map((item) =>
    measure(item, item.active ? activeSize : baseSize),
  );
  let total = laid.reduce((s, l) => s + l.height, 0) + gap * (items.length - 1);

  let shrink = 1;
  if (lyricsView === "onviz-fit" && total > usableH) {
    shrink = usableH / total;
    laid = items.map((item) =>
      measure(item, (item.active ? activeSize : baseSize) * shrink),
    );
    total = laid.reduce((s, l) => s + l.height, 0) + gap * (items.length - 1);
  }

  // Top-aligned block (fit-all is not centered vertically; active isn't centered).
  let y = topMargin;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const l = laid[i];
    if (item.active) {
      // Delegate to the shared active-line painter at this Y and size.
      drawLyrics(metrics, w, h, time, {
        anchorTopY: y,
        baseFontOverride: activeSize * shrink,
        drawCrossfade: false,
      });
    } else {
      const dist = Math.abs(item.idx - activeIdx);
      const alpha = clamp(0.5 - dist * 0.08, 0.14, 0.5);
      ctx.save();
      ctx.globalAlpha = alpha + metrics.overall * 0.04;
      ctx.font = l.font;
      ctx.textBaseline = "top";
      ctx.fillStyle = getColor(palette, (dist + 2) % palette.length, alpha + 0.1);
      for (let li = 0; li < l.lines.length; li++) {
        const x = (w - l.lines[li].width) / 2;
        ctx.fillText(l.lines[li].text, x, y + li * l.lineHeight);
      }
      ctx.restore();
    }
    y += l.height + gap;
  }
}
```

- [ ] **Step 2: Verify fit-all**

Run: `node --check src/main.js` and `npx vite build` → success.
Run: `npm run dev`, Display → Lyrics view = "On-viz — fit all", play the default track.
Expected: all lyric lines appear stacked on the canvas; the active line is visibly larger (×1.15) and pulses/animates to the beat with per-word motion; other lines are smaller, dimmer, static. On a long song the whole set shrinks so it fits the screen height, active still 15% bigger. `≣` toggles the whole list off/on.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat(lyrics): on-viz fit-all all-lyrics rendering"
```

---

### Task 4: `drawAllLyrics` — scrolling mode

Adds the `onviz-scroll` branch: readable base font, the stack scrolls so the active line rests around 45% of the screen, eased, with off-screen lines culled.

**Files:**
- Modify: `src/main.js` — `drawAllLyrics`.

**Interfaces:**
- Consumes: everything from Task 3 plus `onvizScrollY`, `dt`.

- [ ] **Step 1: Add scroll positioning**

In `drawAllLyrics`, after `total` is computed (and after the fit-all shrink block), add the scroll offset computation:

```js
  // Scrolling mode: no fit shrink; scroll the block so the active line rests at
  // ~45% height. Ease onvizScrollY toward the target; cull off-screen lines.
  let scroll = 0;
  if (lyricsView === "onviz-scroll") {
    let activeTop = topMargin;
    for (let i = 0; i < items.length; i++) {
      if (items[i].active) break;
      activeTop += laid[i].height + gap;
    }
    const target = activeIdx < 0 ? 0 : activeTop - h * 0.45;
    const k = Math.min(1, dt * 6);
    onvizScrollY += (target - onvizScrollY) * k;
    scroll = onvizScrollY;
  }
```

- [ ] **Step 2: Apply the scroll offset + cull in the draw loop**

Change the draw loop's `y` initialization and per-line skip. Replace `let y = topMargin;` with:

```js
  let y = topMargin - scroll;
```

Inside the `for` loop, right after `const l = laid[i];`, add a cull check:

```js
    if (y + l.height < 0 || y > h) {
      y += l.height + gap;
      continue;
    }
```

- [ ] **Step 3: Verify scrolling**

Run: `node --check src/main.js` and `npx vite build` → success.
Run: `npm run dev`, Display → Lyrics view = "On-viz — scrolling", play the default track.
Expected: lines at a readable size; as the song advances the block scrolls upward so the active line stays around mid-screen (~45%, not dead center), motion smoothly eased with no jumps; active line larger + beat-reactive; off-screen lines not drawn. `≣` toggles the list. Switching between fit-all / scrolling / modal live works with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat(lyrics): on-viz scrolling all-lyrics mode"
```

---

## Self-Review notes

- **Spec coverage:** 3-way selector (T2) ✓; ≣ toggles on-viz list, opens modal in modal mode (T2) ✓; render branch skips context/active draws in on-viz (T2) ✓; all lines via Pretext, active ×1.15 (T3) ✓; fit-all shrink (T3) ✓; scroll ~45% eased + cull (T4) ✓; active-line beat motion reused via extracted path (T1+T3) ✓; non-active center/static/distance-dimmed (T3) ✓; empty lyrics no-op (T3 guard) ✓; active idx −1 (T3 dist uses idx; T4 targets top) ✓; persistence (T2) ✓; works under both viz modes (render layer, T2) ✓.
- **Type consistency:** `layoutLyricLine(text, emphasis, w, h, baseFontOverride)` and its returned `{ font, lines, lineHeight, height, ... }` are used identically in T1/T3. `drawLyrics(..., { anchorTopY, baseFontOverride, drawCrossfade })` opts match between T1 definition and T3 call. `ONVIZ_BASE_SCALE`/`ONVIZ_ACTIVE_MULT` defined once in T3.
- **Placeholder scan:** T2 ships an intentional `drawAllLyrics` stub, replaced wholesale in T3 — not a lingering placeholder.
- Backlog: left-aligned / wobbling non-active lines deferred (logged in memory todo-backlog).
