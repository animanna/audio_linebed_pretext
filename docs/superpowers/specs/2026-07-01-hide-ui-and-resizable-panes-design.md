# Hide-UI toggle + resizable option panes

Date: 2026-07-01

## Problem

All UI (GH link, mic/capture indicator, player box, settings/capture popovers) is always on screen, obstructing the visualizer. There's no way to clear the screen for pure viewing. Separately, the settings/capture popover panes are fixed-size and can't be resized to fit more content or a smaller viewport comfortably.

## 1. Hide-UI toggle

- New icon button `#btn-hide-ui` added to `.transport-shell .icon-row`, after `#btn-minimize`. Eye / eye-slash SVG (swap icon or just `aria-pressed`/`data-tip` like the existing minimize button).
- Click handler: `document.body.classList.toggle('ui-hidden')`.
- CSS: while `body.ui-hidden` is present and `body.ui-peek` is not, set `opacity: 0; pointer-events: none;` (with a short transition) on:
  - `#gh-link`
  - `#capture-indicator`
  - `.transport-shell` (covers both minimized and normal states — the class doesn't care which)
  - `#settings-panel`
  - `#capture-panel`
  - `.settings-window` (all open settings panes)
- No JS state coupling: whatever panels are currently open/closed stays as-is internally; only visual opacity/pointer-events change. On reveal, everything reappears exactly as it was.
- `ui-hidden` state is **not** persisted to localStorage — resets to visible on reload, consistent with the existing (also non-persisted) minimize behavior.

## 2. Peek/reveal mechanic

- A single document-level listener pair: `pointermove` and `touchstart`.
- On event: if `body.ui-hidden` is set, add `body.ui-peek` (this immediately satisfies the `:not(.ui-peek)` CSS escape hatch, revealing everything) and (re)start an idle timer.
- Idle timer expiry: remove `ui-peek` (UI fades back out), only while `ui-hidden` is still set.
- Timer duration = the persisted auto-reveal-duration setting (see below), read at listener-setup time and whenever the setting changes.
- The hide-UI button remains clickable during peek (it's visible then) — clicking it while hidden clears `ui-hidden` entirely (no separate "disable auto-hide" control needed).

## 3. New "Display" settings tab

- Add `"display"` to `PANE_NAMES` in `src/main.js`.
- Add `<button class="settings-tab" data-page="display">Display</button>` to `.settings-tabs`.
- Add a `.settings-window#win-display[data-page="display"]` pane (same markup shape as existing panes: `.win-head` with title + close, `.settings-page` body) containing one `.lb-slider`: "Auto-reveal duration" range input, min 1000, max 8000, step 500, default 2500.
- Wire with the existing numeric-setting pattern: read `localStorage.getItem("uiHideDelayMs")` on load (fallback 2500), write on `input`, and a `syncDisplayPanel()` populating the slider position when settings open (mirrors `syncFftPanel`, etc.).
- This slider value is the only thing from this feature that persists across reload.

## 4. Resizable option panes

- Add `resize: both;` plus bounds to `.settings-window` and `.capture-panel`:
  - `min-width: 220px; min-height: 160px;`
  - `max-width: min(480px, 92vw); max-height: min(82vh, 640px);`
- These elements already have `overflow: hidden` (or equivalent) on the outer container, which is required for `resize` to take effect — no structural change needed there.
- Native browser resize grip appears bottom-right only (matches decision — no custom drag-resize JS, no multi-corner handles).
- `#settings-panel` (the small launcher with just the drag handle + tab buttons) is excluded — no scrollable content, resize wouldn't do anything useful.
- Size persistence: a `ResizeObserver` attached to each resizable pane at setup, debounced, saves `{w, h}` to `localStorage` under `settingsWinSize:<name>` (for `.settings-window`, keyed like the existing `settingsWinPos:<name>`) or `capturePanelSize` (for `.capture-panel`). On next open (`placeWindow` / capture-panel's open function), apply saved `w`/`h` via inline `style.width`/`style.height` before positioning — mirrors the existing `readPos`/`pinElement` position-persistence flow.

## Out of scope

- No changes to minimize behavior itself (already hides panels correctly; this feature is orthogonal and layers on top).
- No keyboard shortcut for hide-UI (mouse/touch reveal only, per the approved design).
- No resize for `#settings-panel` launcher.
