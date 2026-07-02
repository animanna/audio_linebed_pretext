# Active-Word Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark the currently-sung word in the on-viz lyrics with gradient / glow / pop / tint effects, each a Display-tab switch.

**Architecture:** All in `drawLyrics` (compute an `activeWordIdx`, apply effects to that token when `mono`) plus four `.lb-flip` switches on the Display tab. No new files.

**Tech Stack:** Vanilla ES modules, Canvas 2D.

## Global Constraints

- `src/main.js` style: 2-space indent, semicolons, double quotes.
- No test runner — verify with `node --check`, `npx vite build`, and headless Playwright per the browser-verify recipe.
- Effects apply only when `mono` (on-viz); modal mode untouched.
- Defaults: `awGradient` true, `awGlow` true, `awPop` true, `awTint` false.
- Active word = `vocalFrontWord` under Vocal Sync, else `clamp(floor(evenFront/0.92),0,totalTokens-1)`.

---

### Task 1: Active-word switches (state + Display UI)

**Files:**
- Modify: `index.html` — Display page `.lb-sliders` (after the Lyrics-view select)
- Modify: `src/main.js` — state near `vsFxGradient` (line ~1325); Display `syncDisplayPanel`; toggle listeners

**Interfaces:**
- Produces: module vars `awGradient`, `awGlow`, `awPop`, `awTint` (Boolean); DOM ids `aw-gradient`, `aw-glow`, `aw-pop`, `aw-tint`.

- [ ] **Step 1: Add the switches markup**

In `index.html`, after the `lyrics-view` label in the Display page, add:

```html
          <div class="lb-title" style="margin-top:10px">Active word</div>
          <div class="lb-switch-row">
            <button type="button" id="aw-gradient" class="lb-flip" role="switch" aria-checked="true">Gradient on</button>
            <button type="button" id="aw-glow" class="lb-flip" role="switch" aria-checked="true">Glow on</button>
            <button type="button" id="aw-pop" class="lb-flip" role="switch" aria-checked="true">Pop on</button>
            <button type="button" id="aw-tint" class="lb-flip" role="switch" aria-checked="false">Tint off</button>
          </div>
```

- [ ] **Step 2: Add state**

Near `let vsFxGradient = ...` (line ~1325), add:

```js
// On-viz active-word indicators (see drawLyrics). Each an independent switch.
let awGradient = localStorage.getItem("awGradient") !== "0"; // default on
let awGlow = localStorage.getItem("awGlow") !== "0"; // default on
let awPop = localStorage.getItem("awPop") !== "0"; // default on
let awTint = localStorage.getItem("awTint") === "1"; // default off
```

- [ ] **Step 3: Refs + sync + toggles**

Near the other Display refs, add:

```js
const awGradientBtn = document.getElementById("aw-gradient");
const awGlowBtn = document.getElementById("aw-glow");
const awPopBtn = document.getElementById("aw-pop");
const awTintBtn = document.getElementById("aw-tint");
```

In `syncDisplayPanel`, add:

```js
  awGradientBtn.setAttribute("aria-checked", awGradient ? "true" : "false");
  awGradientBtn.textContent = awGradient ? "Gradient on" : "Gradient off";
  awGlowBtn.setAttribute("aria-checked", awGlow ? "true" : "false");
  awGlowBtn.textContent = awGlow ? "Glow on" : "Glow off";
  awPopBtn.setAttribute("aria-checked", awPop ? "true" : "false");
  awPopBtn.textContent = awPop ? "Pop on" : "Pop off";
  awTintBtn.setAttribute("aria-checked", awTint ? "true" : "false");
  awTintBtn.textContent = awTint ? "Tint on" : "Tint off";
```

After the `lyricsViewSelect` listener, add:

```js
awGradientBtn.addEventListener("click", () => {
  awGradient = !awGradient;
  try { localStorage.setItem("awGradient", awGradient ? "1" : "0"); } catch {}
  syncDisplayPanel();
});
awGlowBtn.addEventListener("click", () => {
  awGlow = !awGlow;
  try { localStorage.setItem("awGlow", awGlow ? "1" : "0"); } catch {}
  syncDisplayPanel();
});
awPopBtn.addEventListener("click", () => {
  awPop = !awPop;
  try { localStorage.setItem("awPop", awPop ? "1" : "0"); } catch {}
  syncDisplayPanel();
});
awTintBtn.addEventListener("click", () => {
  awTint = !awTint;
  try { localStorage.setItem("awTint", awTint ? "1" : "0"); } catch {}
  syncDisplayPanel();
});
```

- [ ] **Step 4: Verify**

Run: `node --check src/main.js` and `npx vite build` → success.
Run: `npm run dev`, Settings → Display: four switches appear (Gradient/Glow/Pop on, Tint off); clicking flips the label; state persists across reload.

---

### Task 2: Active-word detection + effects in `drawLyrics`

**Files:**
- Modify: `src/main.js` — `drawLyrics` (active-word index after the vocal-sync block; effect application in the token draw block ~3653-3699)

**Interfaces:**
- Consumes: `awGradient/awGlow/awPop/awTint` (Task 1); existing `vocalFrontWord`, `evenFront`, `vocalSyncActive`, `totalTokens`, `mono`, `beat`, `state.vocalGlitch`, `colorBase`, `vocalHue`.

- [ ] **Step 1: Compute `activeWordIdx`**

After the `if (vocalSyncActive) { ... }` block closes (just before the `// Apply the compressed beat pump` comment), add:

```js
  // The word currently emerging: the vocal-onset front under Vocal Sync, else
  // the even-clock reveal front. Drives the on-viz active-word effects.
  const activeWordIdx = vocalSyncActive
    ? vocalFrontWord
    : clamp(Math.floor(evenFront / 0.92), 0, Math.max(0, totalTokens - 1));
```

- [ ] **Step 2: Flag the active token + re-enable its gradient**

Replace the block (lines ~3653-3658):

```js
        const isRunningWord = state.globalWordIdx === vocalFrontWord;
        const vocalColorOn =
          vocalSyncActive && (!vsRunningWordOnly || isRunningWord);
        const gradientOn =
          !mono && ((vocalColorOn && vsFxGradient) || lyricEffect === "gradient");
        const neonOn = !mono && vocalColorOn && vsFxNeon;
```

with:

```js
        const isRunningWord = state.globalWordIdx === vocalFrontWord;
        const isActiveWord = mono && state.globalWordIdx === activeWordIdx;
        const vocalColorOn =
          vocalSyncActive && (!vsRunningWordOnly || isRunningWord);
        const gradientOn =
          (!mono && ((vocalColorOn && vsFxGradient) || lyricEffect === "gradient")) ||
          (isActiveWord && awGradient);
        const neonOn = !mono && vocalColorOn && vsFxNeon;
```

- [ ] **Step 3: Solid tint fill fallback**

Immediately after the `if (gradientOn) { ... vocalFill = grad; }` block (after line ~3689), add:

```js
        // Active-word solid tint (only if no gradient already fills it).
        if (!vocalFill && isActiveWord && awTint) {
          vocalFill = colorBase;
        }
```

- [ ] **Step 4: Glow on the active word**

Replace the shadow block (lines ~3691-3699):

```js
        ctx.shadowColor = mono
          ? "rgba(255,255,255,0.5)"
          : gradientOn
            ? `hsl(${vocalHue}, 90%, 62%)`
            : lyric.emphasis
              ? colorBase
              : "rgba(255,255,255,0.52)";
        ctx.shadowBlur =
          state.glow + state.charFreq * 18 + sp * 10 + bm.glow;
```

with:

```js
        const awGlowOn = isActiveWord && awGlow;
        ctx.shadowColor = awGlowOn
          ? gradientOn
            ? `hsl(${vocalHue}, 90%, 62%)`
            : awTint
              ? colorBase
              : "rgba(255,255,255,0.9)"
          : mono
            ? "rgba(255,255,255,0.5)"
            : gradientOn
              ? `hsl(${vocalHue}, 90%, 62%)`
              : lyric.emphasis
                ? colorBase
                : "rgba(255,255,255,0.52)";
        ctx.shadowBlur =
          state.glow +
          state.charFreq * 18 +
          sp * 10 +
          bm.glow +
          (awGlowOn ? 14 + beat.impact * 22 + state.vocalGlitch * 20 : 0);
```

- [ ] **Step 5: Scale pop on the active word**

Replace the scale call (lines ~3640-3643):

```js
        ctx.scale(
          state.scaleX + bm.sx + (sp * 0.12 + state.energy * 0.05) * lyricMotion,
          state.scaleY + bm.sy + (-sp * 0.04 + state.energy * 0.03) * lyricMotion,
        );
```

with:

```js
        const awPopBump =
          mono && awPop && state.globalWordIdx === activeWordIdx
            ? (beat.impact * 0.18 + state.vocalGlitch * 0.25) * lyricMotion
            : 0;
        ctx.scale(
          state.scaleX + bm.sx + (sp * 0.12 + state.energy * 0.05) * lyricMotion + awPopBump,
          state.scaleY + bm.sy + (-sp * 0.04 + state.energy * 0.03) * lyricMotion + awPopBump,
        );
```

(`isActiveWord` is declared later in the block, so this uses the explicit `mono && ... === activeWordIdx` test.)

- [ ] **Step 6: Verify**

Run: `node --check src/main.js` and `npx vite build` → success.
Run headless (per browser-verify recipe): on-viz fit-all, inject synced lyrics, screenshot — the active/emerging word shows a colored gradient + glow among the white line; toggling `aw-*` switches changes it; toggling all off → plain white.

---

## Self-Review notes

- **Spec coverage:** active-word index (T2.1) ✓; gradient restored on active word (T2.2) ✓; glow (T2.4) ✓; pop, vocal + non-vocal (T2.5) ✓; tint fallback (T2.3) ✓; four Display switches + persistence + defaults (T1) ✓; gated on `mono` so modal untouched (T2) ✓; no-active-word / all-off edge cases (white) ✓.
- **Type consistency:** `activeWordIdx` (Number) computed once, used in T2.2/T2.5. Switch vars `awGradient/awGlow/awPop/awTint` identical between T1 and T2. `isActiveWord` used only after its T2.2 declaration; the earlier T2.5 scale uses the explicit `mono && ...===activeWordIdx` form.
- **Placeholder scan:** none.
