# Full Lyrics Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a button near the transport that opens an 80vw×80vh modal listing every fetched lyric line; clicking a line seeks to just before its start, and the active line pulses to the beat.

**Architecture:** The modal is a plain DOM scroll list (not canvas). Click-to-seek reuses the existing bridge/local seek split. The active line is tracked and pulsed each frame from the existing `render()` loop using the shared module-level `beat` singleton and the frame's `metrics` — only while the modal is open, so no new `requestAnimationFrame`.

**Tech Stack:** Vanilla ES modules, Canvas 2D app shell, plain DOM for the modal. No framework, no test runner.

## Global Constraints

- Code style: 2-space indent, **no semicolons**, ES modules, single quotes. (Matches `src/main.js`.)
- No test framework exists — every task is verified manually in the browser via `npm run dev`.
- Preserve the async race guard (`activeTrackId` / `loadVersion`); the modal must not launch async loads.
- Phase 1 ships **pulse** motion only. A per-token option appears in the UI but is disabled/inert (Phase 2, out of scope here).
- Lead offset default: **500 ms**, range 0–2000, step 50.
- Persistence uses the existing `loadNum(key, def, min, max)` helper and `localStorage`.
- Follow existing markup patterns: transport icon buttons use `class="icon-btn"` with `data-tip`; settings panels use `.settings-window` / `.win-close`.

---

### Task 1: Lead-offset setting on the Display tab

Adds the persisted `leadMs` state and its slider next to the existing auto-reveal slider. Foundation for click-to-seek (Task 4).

**Files:**
- Modify: `index.html` (Display page body, ~line 1260-1264)
- Modify: `src/main.js` (state near line 1529; `syncDisplayPanel` ~1545; listener ~1550)

**Interfaces:**
- Produces: module var `leadMs` (Number, milliseconds); DOM ids `lyric-seek-lead`, `lyric-seek-lead-label`.

- [ ] **Step 1: Add the slider markup**

In `index.html`, inside `.lb-sliders` of the Display page (after the `ui-hide-delay` label block, currently lines 1261-1263), add a second slider:

```html
          <label class="lb-slider"><span id="lyric-seek-lead-label">Seek lead</span>
            <input type="range" id="lyric-seek-lead" min="0" max="2000" step="50" data-default="500" />
          </label>
```

- [ ] **Step 2: Add state + element refs in `src/main.js`**

Near the `uiHideDelayMs` declaration (line 1529), add:

```js
let leadMs = loadNum("lyricSeekLeadMs", 500, 0, 2000)
```

Near `uiHideDelayInput` (line 1542), add:

```js
const seekLeadInput = document.getElementById("lyric-seek-lead")
const seekLeadLabel = document.getElementById("lyric-seek-lead-label")
```

- [ ] **Step 3: Sync + persist**

In `syncDisplayPanel` (line 1545), add these two lines before the closing brace:

```js
  seekLeadInput.value = leadMs
  seekLeadLabel.textContent = `Seek lead ${leadMs} ms`
```

After the existing `uiHideDelayInput` listener (ends line 1554), add:

```js
seekLeadInput.addEventListener("input", () => {
  leadMs = parseFloat(seekLeadInput.value)
  try { localStorage.setItem("lyricSeekLeadMs", String(leadMs)) } catch {}
  syncDisplayPanel()
})
```

- [ ] **Step 4: Verify manually**

Run: `npm run dev`, open the printed URL, open Settings → Display.
Expected: a "Seek lead 500 ms" slider appears; dragging updates the label; reload the page and the value persists.

- [ ] **Step 5: Commit**

```bash
git add index.html src/main.js
git commit -m "feat(lyrics): add persisted seek-lead setting on Display tab"
```

---

### Task 2: Modal shell — markup, styles, open/close

Builds the empty modal (80vw×80vh, backdrop, header, `×`, scroll body) and the transport button, wired to open/close via button, Esc, backdrop, and `×`. No list yet.

**Files:**
- Modify: `index.html` (new `<style>` rules; open button in `.icon-row` ~line 1295; modal markup near the other panels, e.g. after `#capture-panel` ~line 1273)
- Modify: `src/main.js` (open/close wiring — add near other UI wiring, e.g. after the seek-bar listener ~line 1568)

**Interfaces:**
- Produces: DOM ids `btn-lyrics-list`, `lyrics-modal`, `lyrics-modal-body`, `lyrics-modal-close`; module var `lyricsModalOpen` (Boolean); functions `openLyricsModal()`, `closeLyricsModal()`.

- [ ] **Step 1: Add modal + backdrop CSS**

In `index.html` add to the `<style>` block (near the other panel styles):

```css
    #lyrics-modal[hidden] { display: none; }
    #lyrics-modal {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .lyrics-modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(6, 6, 10, 0.62);
      backdrop-filter: blur(6px);
    }
    .lyrics-modal-panel {
      position: relative;
      width: 80vw;
      height: 80vh;
      display: flex;
      flex-direction: column;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03)),
        rgba(9, 9, 14, 0.86);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .lyrics-modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      letter-spacing: 0.04em;
    }
    #lyrics-modal-body {
      flex: 1;
      overflow-y: auto;
      padding: 18px 24px 32px;
    }
    .lyric-row {
      display: block;
      width: 100%;
      text-align: left;
      min-width: 0;
      padding: 10px 14px;
      margin: 2px 0;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: rgba(255, 255, 255, 0.62);
      font-family: 'Inter', sans-serif;
      font-size: 20px;
      line-height: 1.4;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .lyric-row:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
    .lyric-row.active {
      color: #fff;
      font-weight: 600;
      will-change: transform, filter;
    }
    .lyrics-modal-empty {
      opacity: 0.5;
      font-family: 'Inter', sans-serif;
      padding: 24px 14px;
    }
    @media (prefers-reduced-motion: reduce) {
      .lyric-row.active { transform: none !important; }
    }
```

- [ ] **Step 2: Add the open button in the transport icon row**

In `index.html`, inside `.icon-row` (after the `btn-settings` button block, which ends at line 1298), add:

```html
        <button id="btn-lyrics-list" class="icon-btn" type="button" aria-label="Full lyrics" data-tip="Full lyrics">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h12v2H4zM4 11h12v2H4zM4 16h8v2H4zM18 7l3 3-3 3z" /></svg>
        </button>
```

- [ ] **Step 3: Add the modal markup**

In `index.html`, after the `#capture-panel` closing `</div>` (line 1273), add:

```html
    <div id="lyrics-modal" role="dialog" aria-modal="true" aria-label="Full lyrics" hidden>
      <div class="lyrics-modal-backdrop" data-close-modal></div>
      <div class="lyrics-modal-panel">
        <div class="lyrics-modal-head">
          <span>Lyrics</span>
          <button id="lyrics-modal-close" class="win-close" type="button" aria-label="Close" data-close-modal>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" /></svg>
          </button>
        </div>
        <div id="lyrics-modal-body"></div>
      </div>
    </div>
```

- [ ] **Step 4: Add open/close wiring in `src/main.js`**

After the `seekBar` `input` listener (ends line 1568), add:

```js
// ── Full lyrics modal ───────────────────────────────────────────────────
const lyricsModal = document.getElementById("lyrics-modal")
const lyricsModalBody = document.getElementById("lyrics-modal-body")
const btnLyricsList = document.getElementById("btn-lyrics-list")
let lyricsModalOpen = false

function onModalKeydown(event) {
  if (event.key === "Escape") closeLyricsModal()
}

function openLyricsModal() {
  lyricsModal.hidden = false
  lyricsModalOpen = true
  document.addEventListener("keydown", onModalKeydown)
}

function closeLyricsModal() {
  lyricsModal.hidden = true
  lyricsModalOpen = false
  document.removeEventListener("keydown", onModalKeydown)
}

btnLyricsList.addEventListener("click", openLyricsModal)
lyricsModal.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-modal]")) closeLyricsModal()
})
```

- [ ] **Step 5: Verify manually**

Run: `npm run dev`, reload the page.
Expected: a "Full lyrics" icon button sits in the transport row. Clicking it shows the empty 80%×80% modal with a dimmed backdrop. Esc, clicking the backdrop, and the `×` each close it. Reopening works.

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.js
git commit -m "feat(lyrics): full-lyrics modal shell with open/close"
```

---

### Task 3: Render the lyric list + active-line tracking

Fills the modal body with one row per non-empty lyric line, highlights the active line each frame, and auto-scrolls it into view. No seeking yet.

**Files:**
- Modify: `src/lyrics.js` (add `getCurrentLyricIndex` after `getCurrentLyric`, ~line 45)
- Modify: `src/main.js` (import; list builder + active tracker near the modal wiring from Task 2; call into `render()` ~line 3700)

**Interfaces:**
- Consumes: `lyricsModalOpen`, `lyricsModalBody`, `openLyricsModal` (Task 2); `lyrics` array (`{ time, text, emphasis }`); `getLyricTime()` (line 994).
- Produces: `getCurrentLyricIndex(lyrics, currentTime) -> Number` (index into `lyrics`, `-1` if none); functions `buildLyricsModalList()`, `updateModalActiveLine(metrics)`; module var `modalActiveIdx` (Number).

- [ ] **Step 1: Add the index helper in `src/lyrics.js`**

After the `getCurrentLyric` function (ends ~line 45), add:

```js
// Same scan as getCurrentLyric, but returns the array index (-1 if the
// timeline hasn't reached any line yet). The modal uses it to mark a row.
export function getCurrentLyricIndex(lyrics, currentTime) {
  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].time) return i
  }
  return -1
}
```

- [ ] **Step 2: Import it in `src/main.js`**

Update the existing lyrics import (line 12):

```js
import { getCurrentLyric, getLyricProgress, getCurrentLyricIndex } from "./lyrics.js"
```

- [ ] **Step 3: Build the list + tracker in `src/main.js`**

Add after the Task 2 modal wiring block:

```js
let modalActiveIdx = -1

function buildLyricsModalList() {
  lyricsModalBody.innerHTML = ""
  modalActiveIdx = -1
  const rows = lyrics.filter((l) => l.text && l.text.trim())
  if (rows.length === 0) {
    const empty = document.createElement("div")
    empty.className = "lyrics-modal-empty"
    empty.textContent = "No lyrics loaded"
    lyricsModalBody.appendChild(empty)
    return
  }
  lyrics.forEach((line, idx) => {
    if (!line.text || !line.text.trim()) return
    const row = document.createElement("button")
    row.type = "button"
    row.className = "lyric-row"
    row.dataset.idx = String(idx)
    row.textContent = line.text
    lyricsModalBody.appendChild(row)
  })
}

function updateModalActiveLine() {
  const idx = getCurrentLyricIndex(lyrics, getLyricTime())
  if (idx === modalActiveIdx) return
  const prev = lyricsModalBody.querySelector(".lyric-row.active")
  if (prev) prev.classList.remove("active")
  modalActiveIdx = idx
  if (idx < 0) return
  const next = lyricsModalBody.querySelector(`.lyric-row[data-idx="${idx}"]`)
  if (next) {
    next.classList.add("active")
    next.scrollIntoView({ block: "center", behavior: "smooth" })
  }
}
```

Then build the list when the modal opens: in `openLyricsModal` (Task 2), add `buildLyricsModalList()` as the first line of the body, and reset `modalActiveIdx = -1`.

- [ ] **Step 4: Drive the tracker from the render loop**

In `render()`, immediately after `syncProgressUI()` (line 3700), add:

```js
  if (lyricsModalOpen) updateModalActiveLine()
```

- [ ] **Step 5: Verify manually**

Run: `npm run dev`, let the default track load, press play, open the modal.
Expected: every non-empty lyric line is listed; as the song plays the current line gets the bright `.active` style and scrolls to center. Loading a plain-text/demo track still lists lines; an empty lyric set shows "No lyrics loaded".

- [ ] **Step 6: Commit**

```bash
git add src/lyrics.js src/main.js
git commit -m "feat(lyrics): render modal line list with active-line tracking"
```

---

### Task 4: Click-to-seek with lead offset

Clicking a row seeks to `line.time - leadMs`, clamped ≥ 0, via the bridge or local audio — mirroring the existing seek-bar handler.

**Files:**
- Modify: `src/main.js` (click handler on `lyricsModalBody`, near the Task 3 code)

**Interfaces:**
- Consumes: `leadMs` (Task 1); `lyrics`; `bridge`, `audio`, `syncProgressUI` (existing); the row `dataset.idx` (Task 3).

- [ ] **Step 1: Add the row click handler**

Add after `buildLyricsModalList` / `updateModalActiveLine`:

```js
function seekToLyricLine(idx) {
  const line = lyrics[idx]
  if (!line) return
  const target = Math.max(0, line.time - leadMs / 1000)
  if (bridge.active && bridge.track && bridge.track.length > 0) {
    bridge.seek(target).then(syncProgressUI)
    syncProgressUI()
    return
  }
  if (audio.duration <= 0) return
  audio.seekTo(target)
  syncProgressUI()
}

lyricsModalBody.addEventListener("click", (event) => {
  const row = event.target.closest(".lyric-row")
  if (!row) return
  seekToLyricLine(Number.parseInt(row.dataset.idx, 10))
})
```

- [ ] **Step 2: Verify manually**

Run: `npm run dev`, load the default track, open the modal, click a mid-song line.
Expected: playback jumps to ~0.5 s before that line's timestamp; the time label and seek bar update. Raise the Display "Seek lead" slider to 2000 ms, click again — playback lands ~2 s earlier. With a plain-text/demo track, clicking still seeks to the approximate time.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat(lyrics): click a modal line to seek before its start"
```

---

### Task 5: Pulse beat motion on the active line

The active row scales and brightens with the beat while the modal is open, driven by the shared `beat` state and the frame `metrics`.

**Files:**
- Modify: `src/main.js` (extend `updateModalActiveLine` to take `metrics` and apply/clear the pulse; update the `render()` call)

**Interfaces:**
- Consumes: `beat` singleton (line 33); frame `metrics` (in `render`); `lyricMotion` (line 976); `.lyric-row.active` element (Task 3).

- [ ] **Step 1: Cache the active element and apply the pulse**

Replace the Task 3 `updateModalActiveLine` with a version that keeps a reference to the active row and pulses it every frame:

```js
let modalActiveEl = null

function updateModalActiveLine(metrics) {
  const idx = getCurrentLyricIndex(lyrics, getLyricTime())
  if (idx !== modalActiveIdx) {
    if (modalActiveEl) {
      modalActiveEl.classList.remove("active")
      modalActiveEl.style.transform = ""
      modalActiveEl.style.filter = ""
    }
    modalActiveIdx = idx
    modalActiveEl = idx < 0
      ? null
      : lyricsModalBody.querySelector(`.lyric-row[data-idx="${idx}"]`)
    if (modalActiveEl) {
      modalActiveEl.classList.add("active")
      modalActiveEl.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }
  if (!modalActiveEl) return
  // Whole-line pulse: sharp transients (impact) drive scale, sustained
  // energy (pressure/overall) drives brightness. Scaled by the global
  // lyric-motion knob so the modal respects the same intensity slider.
  const punch = (beat.impact * 0.9 + beat.pressure * 0.5) * lyricMotion
  const scale = 1 + Math.min(punch, 1) * 0.06
  const bright = 1 + (metrics.overall * 0.4 + beat.impact * 0.4) * lyricMotion
  modalActiveEl.style.transform = `scale(${scale.toFixed(3)})`
  modalActiveEl.style.filter = `brightness(${bright.toFixed(3)})`
}
```

Also set `modalActiveEl = null` in `buildLyricsModalList` (alongside the `modalActiveIdx = -1` reset) so a rebuilt list drops the stale reference.

- [ ] **Step 2: Pass metrics from the render loop**

Update the call added in Task 3 (after `syncProgressUI()`, line ~3700):

```js
  if (lyricsModalOpen) updateModalActiveLine(metrics)
```

- [ ] **Step 3: Clear the pulse on close**

In `closeLyricsModal` (Task 2), before the `hidden` toggle, drop any residual transform:

```js
  if (modalActiveEl) {
    modalActiveEl.style.transform = ""
    modalActiveEl.style.filter = ""
  }
```

- [ ] **Step 4: Verify manually**

Run: `npm run dev`, play the default track, open the modal.
Expected: the active line visibly pulses/brightens on beats; other lines stay still. Lowering the Lyrics-tab Motion slider to 0 stops the pulse. With OS "reduce motion" on, the scale is suppressed (CSS guard) though brightness may remain. Closing mid-song leaves no line stuck enlarged.

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat(lyrics): pulse the active modal line to the beat"
```

---

### Task 6: Active-line motion selector on the Display tab

Adds the pulse/per-token selector. Pulse is the default and only functional mode; per-token is present but disabled (Phase 2).

**Files:**
- Modify: `index.html` (Display page, after the seek-lead slider from Task 1)
- Modify: `src/main.js` (persisted `lyricModalMotion` state; sync in `syncDisplayPanel`; listener)

**Interfaces:**
- Consumes: `syncDisplayPanel` (line 1545); the pulse in `updateModalActiveLine` (Task 5).
- Produces: module var `lyricModalMotion` (`'pulse'`); DOM id `lyric-modal-motion`.

- [ ] **Step 1: Add the selector markup**

In `index.html`, after the seek-lead `<label>` added in Task 1 (still inside `.lb-sliders` or just below it in the Display page body), add:

```html
        <label class="lb-slider"><span>Active-line motion</span>
          <select id="lyric-modal-motion">
            <option value="pulse">Pulse / glow</option>
            <option value="pertoken" disabled>Per-token (coming soon)</option>
          </select>
        </label>
```

- [ ] **Step 2: Add state + ref in `src/main.js`**

Near the `leadMs` declaration (Task 1), add:

```js
let lyricModalMotion = "pulse"
try {
  const m = localStorage.getItem("lyricModalMotion")
  if (m === "pulse" || m === "pertoken") lyricModalMotion = m
} catch {}
```

Near the other Display refs (Task 1), add:

```js
const modalMotionSelect = document.getElementById("lyric-modal-motion")
```

- [ ] **Step 3: Sync + persist**

In `syncDisplayPanel`, add:

```js
  modalMotionSelect.value = lyricModalMotion
```

After the seek-lead listener (Task 1), add:

```js
modalMotionSelect.addEventListener("change", () => {
  lyricModalMotion = modalMotionSelect.value
  try { localStorage.setItem("lyricModalMotion", String(lyricModalMotion)) } catch {}
})
```

- [ ] **Step 4: Gate the pulse on the mode**

In `updateModalActiveLine` (Task 5), guard the pulse math so a future per-token mode can branch. Replace the pulse block's start (`if (!modalActiveEl) return`) with:

```js
  if (!modalActiveEl) return
  if (lyricModalMotion !== "pulse") return
```

- [ ] **Step 5: Verify manually**

Run: `npm run dev`, open Settings → Display.
Expected: an "Active-line motion" dropdown shows "Pulse / glow" selected and a disabled "Per-token (coming soon)" option. The selection persists across reload. Pulse still works in the modal (Task 5 behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.js
git commit -m "feat(lyrics): add active-line motion selector (pulse) on Display tab"
```

---

## Self-Review notes

- **Spec coverage:** open button near transport (T2) ✓; 80×80 modal + backdrop (T2) ✓; Esc/backdrop/× dismiss (T2) ✓; full list, skip empties (T3) ✓; active highlight + auto-scroll (T3/T5) ✓; click-to-seek with lead, bridge+local, untimed seeks anyway (T4) ✓; lead-offset setting default 500 (T1) ✓; pulse motion from shared beat, no new rAF (T5) ✓; motion selector, per-token disabled (T6) ✓; reduced-motion guard (T2 CSS) ✓.
- **Phase 2 (per-token via Pretext `getLineTokens`)** intentionally omitted — out of scope.
- **Type consistency:** `updateModalActiveLine` gains a `metrics` param in T5; the T3 render call is updated in T5 Step 2. `modalActiveIdx`/`modalActiveEl` reset in `buildLyricsModalList`. `getCurrentLyricIndex` signature identical across T3 uses.
