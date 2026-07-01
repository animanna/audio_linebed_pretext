# Hide-UI Toggle + Resizable Option Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a main-UI toggle that hides all chrome (GH link, capture indicator, player box, settings/capture popovers) with a mouse-move/tap-to-peek reveal, plus a settings tab to configure the auto-reveal duration, plus native corner-resize on the option popover panes.

**Architecture:** Pure CSS-class-driven visibility (`body.ui-hidden`, `body.ui-peek`) toggled by a new transport-bar icon button and a document-level pointermove/touchstart listener with an idle timer — no changes to canvas rendering or any internal panel open/closed state. Resizing uses the native CSS `resize: both` property (no custom drag-resize JS); sizes persist to `localStorage` via `ResizeObserver`, mirroring the existing position-persistence pattern (`makeDraggable`/`pinElement`/`readPos`).

**Tech Stack:** Vanilla ES modules, plain CSS in `index.html`'s `<style>` block, `localStorage` for persistence. No build step changes.

## Global Constraints

- No test suite, linter, or typechecker is configured in this repo (confirmed in `CLAUDE.md`) — every task's "verify" step is a manual check in a browser via `npm run dev`, not an automated test.
- 2-space indent, no semicolons, ES modules, single quotes — match existing `src/main.js` style exactly.
- Follow the existing `localStorage` pattern: wrap every read/write in `try {} catch {}` (see `loadNum`, `readPos` in `src/main.js`).
- Don't touch canvas/rendering code (`render()`, `drawLyrics`, etc.) — this feature only affects DOM overlay elements.

---

### Task 1: Hide-UI toggle button + visibility CSS + click handler

**Files:**
- Modify: `index.html:1243-1245` (icon-row markup — insert new button after `#btn-minimize`)
- Modify: `index.html:427-429` (CSS — insert new visibility + icon-swap rules after `.transport-shell.minimized .icon-chevron`)
- Modify: `src/main.js:90` (DOM ref — insert `btnHideUi` const)
- Modify: `src/main.js:1406-1417` (insert click handler after the existing `btnMinimize` handler)

**Interfaces:**
- Produces: `body.classList.contains('ui-hidden')` — the master hide flag every later task (peek mechanic, Display tab) reads/toggles. `#btn-hide-ui` element and `btnHideUi` JS const.

- [ ] **Step 1: Add the button markup**

In `index.html`, the icon-row currently ends like this (lines 1243-1246):

```html
        <button id="btn-minimize" class="icon-btn" type="button" aria-label="Minimize player" data-tip="Minimize">
          <svg class="icon-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
        </button>
      </div>
```

Change it to add a new button right after `#btn-minimize`:

```html
        <button id="btn-minimize" class="icon-btn" type="button" aria-label="Minimize player" data-tip="Minimize">
          <svg class="icon-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
        </button>
        <button id="btn-hide-ui" class="icon-btn" type="button" aria-label="Hide UI" data-tip="Hide UI" aria-pressed="false">
          <svg class="ico-eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-5.5 0-9.5 4.4-10.6 6.6a1 1 0 0 0 0 .8C2.5 14.6 6.5 19 12 19s9.5-4.4 10.6-6.6a1 1 0 0 0 0-.8C21.5 9.4 17.5 5 12 5zm0 12c-4.4 0-7.9-3.4-9-5C4.1 10.4 7.6 7 12 7s7.9 3.4 9 5c-1.1 1.6-4.6 5-9 5zm0-8.5A3.5 3.5 0 1 0 12 15a3.5 3.5 0 0 0 0-6.5z" /></svg>
          <svg class="ico-eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.3 2.3 2 3.6l3.2 3.2C3.1 8.4 1.6 10.2.9 11.2a1 1 0 0 0 0 .8C2 14.6 6 19 11.5 19c1.7 0 3.3-.4 4.7-1l3.5 3.5 1.3-1.3L3.3 2.3zM11.5 17c-4.4 0-7.9-3.4-9-5 .6-.9 1.9-2.5 3.6-3.8l2 2a3.5 3.5 0 0 0 4.7 4.7l1.6 1.6c-.9.3-1.9.5-2.9.5zm.5-9.9L9.6 4.7C10.2 4.6 10.8 4.5 11.5 4.5c5.5 0 9.5 4.4 10.6 6.6.1.3.1.5 0 .8-.4.8-1.4 2.2-2.8 3.6l-1.4-1.4c1.1-1.1 1.9-2.2 2.3-2.9-1.1-1.6-4.6-5-9-5-.7 0-1.4.1-2 .2z" /></svg>
        </button>
      </div>
```

- [ ] **Step 2: Add icon-swap + visibility CSS**

In `index.html`, find this block (lines 427-429):

```css
    .transport-shell.minimized .icon-chevron {
      transform: rotate(180deg);
    }
```

Insert immediately after it:

```css

    /* Hide-UI toggle: eye icon swaps open/closed by aria-pressed. */
    #btn-hide-ui .ico-eye-closed { display: none; }
    #btn-hide-ui[aria-pressed="true"] .ico-eye-open { display: none; }
    #btn-hide-ui[aria-pressed="true"] .ico-eye-closed { display: block; }

    /* Hide-UI toggle: fades all chrome except the canvas. ui-peek is the
       escape hatch (see main.js) that lets pointer movement/tap temporarily
       reveal everything again while ui-hidden is still set. */
    body.ui-hidden:not(.ui-peek) #gh-link,
    body.ui-hidden:not(.ui-peek) #capture-indicator,
    body.ui-hidden:not(.ui-peek) .transport-shell,
    body.ui-hidden:not(.ui-peek) #settings-panel,
    body.ui-hidden:not(.ui-peek) #capture-panel,
    body.ui-hidden:not(.ui-peek) .settings-window {
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
```

- [ ] **Step 3: Add the DOM ref**

In `src/main.js`, find line 90:

```js
const btnMinimize = document.getElementById("btn-minimize");
```

Add right after it:

```js
const btnHideUi = document.getElementById("btn-hide-ui");
```

- [ ] **Step 4: Add the click handler**

In `src/main.js`, find the existing minimize handler (around line 1406-1417):

```js
btnMinimize.addEventListener("click", () => {
  const minimized = transportShell.classList.toggle("minimized");
  if (minimized) {
    closeSettings();
    closeCapturePanel();
  }
  btnMinimize.dataset.tip = minimized ? "Expand" : "Minimize";
  btnMinimize.setAttribute(
    "aria-label",
    minimized ? "Expand player" : "Minimize player",
  );
});
```

Add right after it:

```js

btnHideUi.addEventListener("click", () => {
  const hidden = document.body.classList.toggle("ui-hidden");
  document.body.classList.remove("ui-peek");
  btnHideUi.setAttribute("aria-pressed", hidden ? "true" : "false");
  btnHideUi.dataset.tip = hidden ? "Show UI" : "Hide UI";
  btnHideUi.setAttribute("aria-label", hidden ? "Show UI" : "Hide UI");
});
```

- [ ] **Step 5: Manually verify**

Run: `npm run dev`, open the printed local URL in a browser.

- Click the new eye icon in the transport bar (rightmost icon).
- Expected: the GH link (top-left), the transport/player box, and (if open) any settings window all fade to invisible and become unclickable within ~0.25s.
- Click the eye icon again (it will be invisible — this only works because Task 2 hasn't landed yet, so for this step alone, toggle via the browser devtools console instead: `document.body.classList.remove('ui-hidden')`).
- Expected: everything fades back in.
- Toggle via the button again normally (click works since UI is visible) to confirm the button itself still works end-to-end.

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.js
git commit -m "feat(ui): add hide-UI toggle button"
```

---

### Task 2: Peek/reveal mechanic (mouse-move / tap reveals hidden UI)

**Files:**
- Modify: `src/main.js` (insert after the `btnHideUi` click handler added in Task 1)

**Interfaces:**
- Consumes: `body.classList.contains('ui-hidden')` (Task 1).
- Produces: `body.classList.contains('ui-peek')` — the CSS escape hatch every visibility rule from Task 1 already checks via `:not(.ui-peek)`. `uiHideDelayMs` (mutable `let`) and `peekUi()` function, both consumed by Task 3's Display-tab slider.

- [ ] **Step 1: Add the peek logic**

In `src/main.js`, immediately after the `btnHideUi` click handler from Task 1, add:

```js

// While ui-hidden is set, any pointer movement or tap "peeks" the UI back in
// for uiHideDelayMs, then it fades out again if the pointer stays idle.
let uiHideDelayMs = loadNum("uiHideDelayMs", 2500, 1000, 8000);
let uiPeekTimer = null;
function peekUi() {
  if (!document.body.classList.contains("ui-hidden")) return;
  document.body.classList.add("ui-peek");
  clearTimeout(uiPeekTimer);
  uiPeekTimer = setTimeout(() => {
    document.body.classList.remove("ui-peek");
  }, uiHideDelayMs);
}
document.addEventListener("pointermove", peekUi);
document.addEventListener("touchstart", peekUi, { passive: true });
```

Note: `loadNum` is defined earlier in the file (around line 918) and is already used by the FFT settings, so it's in scope here.

- [ ] **Step 2: Manually verify**

Run: `npm run dev` (or refresh if already running).

- Click the eye icon to hide the UI.
- Move the mouse anywhere over the page.
- Expected: UI reappears instantly.
- Stop moving the mouse and wait ~2.5 seconds.
- Expected: UI fades out again on its own.
- Move the mouse again, then quickly click the (now-visible) eye icon to turn hide off entirely.
- Expected: UI stays visible even after the mouse stops moving (since `ui-hidden` is no longer set).

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat(ui): reveal hidden UI on pointer movement, auto-hide after idle"
```

---

### Task 3: "Display" settings tab with auto-reveal duration slider

**Files:**
- Modify: `index.html:929` (settings-tabs — add a new tab button after "Vocal Sync")
- Modify: `index.html:1192` (settings-windows — add a new `win-display` pane after `win-vocalsync`, before `capture-panel`)
- Modify: `src/main.js:307` (`PANE_NAMES` — add `"display"`)
- Modify: `src/main.js` (add `syncDisplayPanel` + slider wiring, near the peek logic from Task 2)
- Modify: `src/main.js:451-464` (`openSettings()` — call `syncDisplayPanel()`)

**Interfaces:**
- Consumes: `uiHideDelayMs` (Task 2, mutable `let` in the same module scope).
- Produces: `syncDisplayPanel()` (called from `openSettings()`, same pattern as `syncFftPanel()`).

- [ ] **Step 1: Add the settings tab button**

In `index.html`, find line 929:

```html
        <button class="settings-tab" type="button" data-page="vocalsync" aria-pressed="false">Vocal Sync</button>
```

Add right after it:

```html
        <button class="settings-tab" type="button" data-page="display" aria-pressed="false">Display</button>
```

- [ ] **Step 2: Add the settings window markup**

In `index.html`, find the end of the `win-vocalsync` block (it closes right before `#capture-panel`, around line 1190-1194):

```html
          <div class="cap-hint">Lower threshold / gap = more, faster word pops. Vocal band low/high tighten the stem the onset detector listens to (needs stereo, centre-panned vocals). Pop controls shape the wacky motion per onset.</div>
        </div>
      </div>
    </div>

    <div id="capture-panel" class="linebed-panel capture-panel" role="dialog" aria-label="Audio capture source" hidden>
```

Insert a new window between the two, so it reads:

```html
          <div class="cap-hint">Lower threshold / gap = more, faster word pops. Vocal band low/high tighten the stem the onset detector listens to (needs stereo, centre-panned vocals). Pop controls shape the wacky motion per onset.</div>
        </div>
      </div>
    </div>

    <div class="settings-window" id="win-display" data-page="display" role="dialog" aria-label="Display settings" hidden>
      <div class="win-head">
        <span class="win-grip"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="1.5" /><circle cx="15" cy="7" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="17" r="1.5" /><circle cx="15" cy="17" r="1.5" /></svg></span>
        <span class="win-title">Display</span>
        <button class="win-close" type="button" aria-label="Close" data-close="display"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" /></svg></button>
      </div>
      <div class="settings-page" data-page="display">
        <div class="lb-title">Display</div>
        <div class="lb-sliders">
          <label class="lb-slider"><span id="ui-hide-delay-label">Auto-reveal</span>
            <input type="range" id="ui-hide-delay" min="1000" max="8000" step="500" data-default="2500" />
          </label>
        </div>
        <div class="cap-hint">How long the UI stays visible after you move the mouse or tap, while Hide UI is on.</div>
      </div>
    </div>

    <div id="capture-panel" class="linebed-panel capture-panel" role="dialog" aria-label="Audio capture source" hidden>
```

- [ ] **Step 3: Register the new pane name**

In `src/main.js`, find line 307:

```js
const PANE_NAMES = ["lyrics", "audio", "linebed", "vocalsync"];
```

Change to:

```js
const PANE_NAMES = ["lyrics", "audio", "linebed", "vocalsync", "display"];
```

- [ ] **Step 4: Add slider wiring**

In `src/main.js`, immediately after the peek logic block added in Task 2 (right after the `document.addEventListener("touchstart", peekUi, { passive: true });` line), add:

```js

const uiHideDelayInput = document.getElementById("ui-hide-delay");
const uiHideDelayLabel = document.getElementById("ui-hide-delay-label");

function syncDisplayPanel() {
  uiHideDelayInput.value = uiHideDelayMs;
  uiHideDelayLabel.textContent = `Auto-reveal ${(uiHideDelayMs / 1000).toFixed(1)}s`;
}

uiHideDelayInput.addEventListener("input", () => {
  uiHideDelayMs = parseFloat(uiHideDelayInput.value);
  try { localStorage.setItem("uiHideDelayMs", String(uiHideDelayMs)); } catch {}
  syncDisplayPanel();
});
```

- [ ] **Step 5: Call `syncDisplayPanel()` from `openSettings()`**

In `src/main.js`, find `openSettings()` (around line 451-464):

```js
function openSettings() {
  syncVizPage();
  syncMotionPanel();
  syncFftPanel();
  syncLinebedPanel();
  syncLinebedSpectrumPanel();
  syncLinebedAvailability();
  syncVocalSyncPanel();
  syncVocalSyncAvailability();
  settingsPanel.hidden = false;
  applyLauncherPosition();
  applyWindowVisibility(); // reopen whichever section windows were left open
  btnSettings.setAttribute("aria-expanded", "true");
}
```

Add `syncDisplayPanel();` to the list:

```js
function openSettings() {
  syncVizPage();
  syncMotionPanel();
  syncFftPanel();
  syncLinebedPanel();
  syncLinebedSpectrumPanel();
  syncLinebedAvailability();
  syncVocalSyncPanel();
  syncVocalSyncAvailability();
  syncDisplayPanel();
  settingsPanel.hidden = false;
  applyLauncherPosition();
  applyWindowVisibility(); // reopen whichever section windows were left open
  btnSettings.setAttribute("aria-expanded", "true");
}
```

- [ ] **Step 6: Manually verify**

Run: `npm run dev` (or refresh).

- Click the gear icon to open settings, click the new "Display" tab.
- Expected: a window opens titled "Display" with a slider labeled "Auto-reveal 2.5s".
- Drag the slider to the far right.
- Expected: label updates to "Auto-reveal 8.0s".
- Reload the page, reopen Settings → Display.
- Expected: slider is still at 8.0s (persisted via `localStorage`).
- Click the eye icon to hide the UI, move the mouse to peek it, then stop moving.
- Expected: it now takes ~8 seconds to fade back out (instead of the earlier 2.5s default).

- [ ] **Step 7: Commit**

```bash
git add index.html src/main.js
git commit -m "feat(settings): add Display tab with auto-reveal duration slider"
```

---

### Task 4: Native corner-resize on option panes

**Files:**
- Modify: `index.html:734-749` (`.settings-window` CSS block — add `resize` + size bounds)
- Modify: `index.html:459-463` (insert a new `.capture-panel` CSS rule right after `.linebed-panel:not([hidden])`)

**Interfaces:**
- None (pure CSS; Task 5 depends on this being in place for resize events to fire).

- [ ] **Step 1: Add resize + bounds to `.settings-window`**

In `index.html`, find (around lines 734-749):

```css
    .settings-window {
      position: fixed;
      width: min(300px, calc(100vw - 32px));
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03)),
        rgba(9, 9, 14, 0.9);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(18px);
      z-index: 31;
    }
```

Replace with:

```css
    .settings-window {
      position: fixed;
      width: min(300px, calc(100vw - 32px));
      max-height: min(82vh, 640px);
      min-width: 220px;
      min-height: 160px;
      max-width: min(480px, 92vw);
      resize: both;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03)),
        rgba(9, 9, 14, 0.9);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(18px);
      z-index: 31;
    }
```

- [ ] **Step 2: Add resize + bounds to `.capture-panel`**

In `index.html`, find (around lines 459-463):

```css
    .linebed-panel:not([hidden]) {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(-50%) translateY(0);
    }
```

Insert right after it:

```css

    /* Capture panel gets its own resize + bounds (settings-panel launcher,
       the other .linebed-panel user, stays fixed-size — it's just tabs). */
    .capture-panel {
      resize: both;
      overflow: hidden;
      min-width: 220px;
      min-height: 120px;
      max-width: min(480px, 92vw);
      max-height: min(82vh, 640px);
    }
```

- [ ] **Step 3: Manually verify**

Run: `npm run dev` (or refresh).

- Open Settings, open any tab (e.g. Lyrics).
- Expected: a small diagonal resize grip appears in the bottom-right corner of the window; dragging it resizes the pane, content reflows, and it won't shrink below ~220×160px or grow past ~480px wide / 640px tall.
- Close settings, click the capture/mic icon in the transport bar to open the capture panel.
- Expected: same resize grip behavior on that panel.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(ui): make settings and capture panes corner-resizable"
```

---

### Task 5: Persist pane sizes across sessions

**Files:**
- Modify: `src/main.js:369-375` (insert `readSize`/`applySavedSize`/`watchSize` helpers right after `readPos`)
- Modify: `src/main.js:407-415` (`placeWindow` — apply saved size before positioning)
- Modify: `src/main.js:490-495` (settings-window setup loop — call `watchSize`)
- Modify: `src/main.js:1673-1677` (`openCapturePanel` — apply saved size)
- Modify: `src/main.js` (one-time `watchSize(capturePanel, ...)` call near the settings-window setup loop)

**Interfaces:**
- Consumes: nothing new (uses existing `pinElement`/`readPos` neighbors).
- Produces: `readSize(key)`, `applySavedSize(el, key)`, `watchSize(el, key)` — reusable for any future resizable element.

- [ ] **Step 1: Add the size-persistence helpers**

In `src/main.js`, find `readPos` (lines 369-375):

```js
function readPos(key) {
  try {
    const p = JSON.parse(localStorage.getItem(key));
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch {}
  return null;
}
```

Add right after it:

```js

function readSize(key) {
  try {
    const s = JSON.parse(localStorage.getItem(key));
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) return s;
  } catch {}
  return null;
}

// Apply a previously-saved resize before the element is measured/positioned.
function applySavedSize(el, key) {
  const size = readSize(key);
  if (size) {
    el.style.width = `${size.w}px`;
    el.style.height = `${size.h}px`;
  }
}

// Persist size changes made via the native CSS `resize` handle, debounced.
function watchSize(el, key) {
  let saveTimer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      try {
        localStorage.setItem(
          key,
          JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }),
        );
      } catch {}
    }, 300);
  });
  observer.observe(el);
}
```

- [ ] **Step 2: Apply saved size in `placeWindow`**

In `src/main.js`, find `placeWindow` (lines 407-415):

```js
function placeWindow(name) {
  const el = settingsWindows.get(name);
  if (!el) return;
  const saved = readPos(`settingsWinPos:${name}`);
  const idx = PANE_NAMES.indexOf(name);
  const w = el.offsetWidth || 300;
  const pos = saved || { x: window.innerWidth - w - 24, y: 80 + idx * 46 };
  pinElement(el, pos.x, pos.y);
}
```

Change to:

```js
function placeWindow(name) {
  const el = settingsWindows.get(name);
  if (!el) return;
  applySavedSize(el, `settingsWinSize:${name}`);
  const saved = readPos(`settingsWinPos:${name}`);
  const idx = PANE_NAMES.indexOf(name);
  const w = el.offsetWidth || 300;
  const pos = saved || { x: window.innerWidth - w - 24, y: 80 + idx * 46 };
  pinElement(el, pos.x, pos.y);
}
```

- [ ] **Step 3: Watch each settings window for resize**

In `src/main.js`, find (around lines 490-495):

```js
settingsWindows.forEach((el, name) => {
  el.addEventListener("click", (e) => e.stopPropagation());
  makeDraggable(el, el.querySelector(".win-head"), `settingsWinPos:${name}`);
  const closeBtn = el.querySelector(".win-close");
  if (closeBtn) closeBtn.addEventListener("click", () => togglePane(name));
});
```

Change to:

```js
settingsWindows.forEach((el, name) => {
  el.addEventListener("click", (e) => e.stopPropagation());
  makeDraggable(el, el.querySelector(".win-head"), `settingsWinPos:${name}`);
  watchSize(el, `settingsWinSize:${name}`);
  const closeBtn = el.querySelector(".win-close");
  if (closeBtn) closeBtn.addEventListener("click", () => togglePane(name));
});
watchSize(capturePanel, "capturePanelSize");
```

- [ ] **Step 4: Apply saved size when the capture panel opens**

In `src/main.js`, find `openCapturePanel` (lines 1673-1677):

```js
async function openCapturePanel() {
  capList.replaceChildren();
  capHint.textContent = "";
  capturePanel.hidden = false;
  btnCapture.setAttribute("aria-expanded", "true");
```

Change to:

```js
async function openCapturePanel() {
  capList.replaceChildren();
  capHint.textContent = "";
  applySavedSize(capturePanel, "capturePanelSize");
  capturePanel.hidden = false;
  btnCapture.setAttribute("aria-expanded", "true");
```

- [ ] **Step 5: Manually verify**

Run: `npm run dev` (or refresh).

- Open Settings → Lyrics, drag the bottom-right corner to make it noticeably wider/taller.
- Close the pane (click the × or toggle the Lyrics tab off), reopen it.
- Expected: it reopens at the resized size, not the original 300px-ish default.
- Reload the whole page, reopen Settings → Lyrics.
- Expected: the resized size is still there (confirms `localStorage` persistence survives reload).
- Repeat with the capture panel: open it, resize, close, reopen — expect the resized size to stick.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat(ui): persist resized option-pane sizes across sessions"
```
