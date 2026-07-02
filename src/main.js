import {
  clearCache as clearPretextCache,
  layoutNextLine,
  layoutWithLines,
  prepareWithSegments,
  setLocale as setPretextLocale,
  walkLineRanges,
} from "@chenglou/pretext";
import { AudioEngine } from "./audio.js";
import { BeatDetector } from "./beat-detect.js";
import { VocalOnsetDetector } from "./vocal-sync.js";
import { getCurrentLyric, getLyricProgress, getCurrentLyricIndex } from "./lyrics.js";
import { parseLyricsFile } from "./lrc-parser.js";
import { fetchLyricsCached as fetchLyrics } from "./lyrics-store.js";
import { readID3Tags } from "./id3-reader.js";
import { NowPlayingBridge } from "./now-playing-bridge.js";
import { serviceIcon, serviceLabel } from "./service-icons.js";

// ── State ──────────────────────────────────────────────────────────────
const APP_BASE_URL = import.meta.env.BASE_URL || "/";
const DEFAULT_TRACK = {
  title: "Skyfall",
  artist: "Adele",
  fileName: "skyfall.mp3",
  // Keep this same-origin by default so the deployed app serves the audio itself.
  // If you switch to a CDN URL later, it must allow cross-origin fetches.
  audioUrl: `${APP_BASE_URL}skyfall.mp3`,
  lyricsUrl: "",
};

const EMPTY_LYRICS = [{ time: 0, text: "", emphasis: false }];
const audio = new AudioEngine();
const beat = new BeatDetector();
const vocalDetector = new VocalOnsetDetector();
const bridge = new NowPlayingBridge();
let bridgeVersion = 0; // guards async lyric fetches against track changes
let lyrics = EMPTY_LYRICS;
// True only when the active lyrics carry real per-line timestamps (LRC / lrclib
// synced). Vocal Sync reveal-gating requires this; auto-timed plain text falls
// back to the default time-curve reveal.
let lyricsTimed = false;
// Vocal Sync mode (🎤): reveal words on detected vocal onsets with the wacky
// pop motion, instead of the calm 🖊️ time-curve engine. Persisted below.
let vocalSyncMode = false;
try {
  vocalSyncMode = localStorage.getItem("vocalSyncMode") === "1";
} catch {}
// Per-active-entry onset reveal bookkeeping (see drawLyrics).
let vocalEntryKey = null;
let vocalRevealCursor = 0;
let vocalSeenOnsetId = 0;
let vocalStarted = false; // has the active line's vocal actually started?
let vocalLineT0 = 0; // render time the active line became current (grace timer)
const VS_GRACE = 1.2; // s: if no vocal detected by now, even-clock takes over
const vocalPops = new Map(); // globalWordIdx → { t0, strength, band }
let animFrame = null;
let lastTimestamp = 0;
let activeTrackId = 0;
let currentPretextLocale = undefined;

// Canvas setup
const canvas = document.getElementById("viz-canvas");
const ctx = canvas.getContext("2d");

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
resize();
window.addEventListener("resize", resize);

// ── UI wiring ──────────────────────────────────────────────────────────
const btnPlayPause = document.getElementById("btn-playpause");
const btnPrev = document.getElementById("btn-prev");
const btnNext = document.getElementById("btn-next");
const nowPlaying = document.getElementById("now-playing");
const npService = document.getElementById("np-service");
const lyricsStatus = document.getElementById("lyrics-status");
const seekBar = document.getElementById("seek-bar");
const currentTimeLabel = document.getElementById("current-time");
const durationLabel = document.getElementById("duration");
const btnLoad = document.getElementById("btn-load");
const btnCapture = document.getElementById("btn-capture");
const captureIndicator = document.getElementById("capture-indicator");
const ghLink = document.getElementById("gh-link");
const capturePanel = document.getElementById("capture-panel");
const capList = document.getElementById("cap-list");
const capHint = document.getElementById("cap-hint");
const btnMinimize = document.getElementById("btn-minimize");
const btnHideUi = document.getElementById("btn-hide-ui");
const btnVocalSync = document.getElementById("btn-vocalsync");
const transportShell = document.querySelector(".transport-shell");
const fileInput = document.getElementById("file-input");
const dropOverlay = document.getElementById("drop-overlay");

function updateLyricsStatus(msg) {
  lyricsStatus.textContent = msg;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function updateSeekBarProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  seekBar.style.setProperty("--seek-progress", `${clamped}%`);
}

function syncProgressUI() {
  const onBridge = bridge.active && bridge.track;
  const duration = onBridge ? bridge.track.length || 0 : audio.duration || 0;
  const currentTime = onBridge ? getPlaybackTime() : audio.currentTime || 0;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  seekBar.disabled = duration <= 0;
  seekBar.value = String(Math.round(progress * 10));
  updateSeekBarProgress(progress);
  currentTimeLabel.textContent = formatTime(currentTime);
  durationLabel.textContent = formatTime(duration);
}

function syncPlaybackControls() {
  let playing, ready;
  if (bridge.active && bridge.track) {
    // Controlling the system player: state comes from its reported status.
    playing = bridge.track.status === "Playing";
    ready = true;
  } else {
    ready = audio.duration > 0;
    playing = audio.playing;
  }
  // One toggle button: enabled when there's something to play, icon + label
  // follow the live state (the .ico-play / .ico-pause swap is CSS-driven).
  btnPlayPause.disabled = !ready;
  btnPlayPause.dataset.playing = playing ? "true" : "false";
  const label = playing ? "Pause" : "Play";
  btnPlayPause.setAttribute("aria-label", label);
  btnPlayPause.dataset.tip = label;
  syncProgressUI();
}

function getPlaybackTime() {
  if (bridge.active) {
    const t = bridge.getTime();
    if (t !== null) return t;
  }
  return audio.currentTime;
}

function resetLyricVisualState() {
  clearLocalTextCaches();
  prevLyricText = "";
  prevLyricFade = { text: "", alpha: 1, y: 0 };
  lyricRevealT = 0;
  lyricTransitionT = 0;
}

function setLyricsState(nextLyrics, timed = false) {
  lyrics = nextLyrics.length > 0 ? nextLyrics : EMPTY_LYRICS;
  lyricsTimed = lyrics === EMPTY_LYRICS ? false : timed;
  syncPretextLocale(lyrics);
  resetLyricVisualState();
}

function formatLyricsLabel(metadata, fallback) {
  if (!metadata?.ti) return fallback;
  return metadata.ar ? `${metadata.ar} — ${metadata.ti}` : metadata.ti;
}

function applyLyricsInput(text, filename) {
  const { lyrics: parsed, metadata } = parseLyricsFile(
    text,
    filename,
    audio.duration || 180,
  );
  if (parsed.length === 0) return false;

  const isLRC = filename.toLowerCase().endsWith(".lrc");
  setLyricsState(parsed, isLRC);

  const count = parsed.filter((line) => line.text).length;
  const label = formatLyricsLabel(metadata, ``);
  updateLyricsStatus(`${label} (${count} lines, ${isLRC ? "LRC" : "PLAIN"})`);
  return true;
}

async function loadHostedLyrics(trackId) {
  if (!DEFAULT_TRACK.lyricsUrl) return false;

  try {
    const response = await fetch(DEFAULT_TRACK.lyricsUrl);
    if (!response.ok)
      throw new Error(`lyrics request failed: ${response.status}`);
    const text = await response.text();
    if (trackId !== activeTrackId) return false;

    const filename = DEFAULT_TRACK.lyricsUrl.toLowerCase().endsWith(".txt")
      ? "skyfall.txt"
      : "skyfall.lrc";

    return applyLyricsInput(text, filename);
  } catch (error) {
    console.warn("Hosted lyrics failed to load:", error);
    return false;
  }
}

async function fetchDefaultLyrics(trackId) {
  updateLyricsStatus(`Searching lyrics for "${DEFAULT_TRACK.title}"...`);

  try {
    const fetched = await fetchLyrics({
      title: DEFAULT_TRACK.title,
      artist: DEFAULT_TRACK.artist,
      fileName: DEFAULT_TRACK.fileName,
      audioDuration: audio.duration,
    });

    if (trackId !== activeTrackId) return false;

    if (fetched && fetched.lyrics.length > 2) {
      setLyricsState(fetched.lyrics, !!fetched.source?.includes("synced"));
      const meta = fetched.meta;
      const desc = meta.artist ? `${meta.artist} — ${meta.title}` : meta.title;
      updateLyricsStatus(desc);
      return true;
    }
  } catch (error) {
    console.warn("Default lyrics fetch failed:", error);
  }

  return false;
}

async function loadDefaultTrack() {
  const trackId = ++activeTrackId;
  clearAllTextCaches();
  setLyricsState(EMPTY_LYRICS);
  nowPlaying.textContent = `${DEFAULT_TRACK.artist} — ${DEFAULT_TRACK.title}`;
  updateLyricsStatus("Loading audio...");
  syncPlaybackControls();

  const loaded = await audio.loadUrl(DEFAULT_TRACK.audioUrl);
  if (!loaded || trackId !== activeTrackId) {
    updateLyricsStatus("Unable to load the default track");
    syncPlaybackControls();
    return;
  }

  syncPlaybackControls();

  const loadedHostedLyrics = await loadHostedLyrics(trackId);
  if (loadedHostedLyrics || trackId !== activeTrackId) return;

  const fetchedLyrics = await fetchDefaultLyrics(trackId);
  if (!fetchedLyrics && trackId === activeTrackId) {
    updateLyricsStatus("Audio ready, lyrics unavailable");
  }
}

audio.onStateChange = () => {
  syncPlaybackControls();
  syncCaptureUI();
};

btnPlayPause.addEventListener("click", () => {
  const playing = btnPlayPause.dataset.playing === "true";
  if (playing) {
    if (bridge.active) bridge.control("pause").then(syncPlaybackControls);
    else audio.pause();
  } else {
    if (bridge.active) bridge.control("play").then(syncPlaybackControls);
    else audio.play();
    startLoop();
  }
  syncPlaybackControls();
});

// ── Visualizer selection ────────────────────────────────────────────────
// Linebed is the landing default; the bars+wave mode is the alternate.
const VIZ_MODES = ["linebed", "default"];
let vizMode = "linebed";
try {
  const saved = localStorage.getItem("vizMode");
  if (saved && VIZ_MODES.includes(saved)) vizMode = saved;
} catch {}

// ── Settings popover (paginated: Visualizer / Lyrics / Linebed) ──────────
// One gear button opens a tabbed popover. The Visualizer page replaces the
// old cycle button; the Lyrics and Linebed pages host the controls defined in
// their sections below (their sync/input wiring stays there). syncMotionPanel
// and syncLinebedPanel are hoisted, so openSettings can call them safely.
const btnSettings = document.getElementById("btn-settings");
const settingsPanel = document.getElementById("settings-panel");
const settingsTabs = settingsPanel.querySelectorAll(".settings-tab");
const settingsHandle = document.getElementById("settings-handle");
const vizModeBtns = document.querySelectorAll(".viz-mode");
const lbInactiveHint = document.getElementById("lb-inactive-hint");

// Each settings section is its OWN floating window, so opening Audio while
// Lyrics is open spawns a second popover instead of growing one giant panel
// off-screen. The launcher (#settings-panel) only holds the section toggles.
const PANE_NAMES = ["lyrics", "audio", "linebed", "vocalsync", "display"];
const settingsWindows = new Map();
PANE_NAMES.forEach((name) => {
  const el = document.getElementById(`win-${name}`);
  if (el) settingsWindows.set(name, el);
});

function syncVizPage() {
  vizModeBtns.forEach((b) =>
    b.setAttribute("aria-checked", b.dataset.viz === vizMode ? "true" : "false"),
  );
}

// Linebed params only affect the linebed visualizer; dim the param body (NOT the
// mode switch above it) when another viz is active, but keep it reachable.
function syncLinebedAvailability() {
  const on = vizMode === "linebed";
  const tab = settingsPanel.querySelector('.settings-tab[data-page="linebed"]');
  const body = document.getElementById("lb-body");
  if (tab) tab.dataset.inactive = on ? "false" : "true";
  if (body) body.classList.toggle("page-dim", !on);
  lbInactiveHint.hidden = on;
}

// Vocal Sync params only bite when 🎤 is on; dim the body (not the tab) and show
// a hint otherwise, mirroring the linebed availability gate.
function syncVocalSyncAvailability() {
  const on = vocalSyncMode;
  const tab = settingsPanel.querySelector('.settings-tab[data-page="vocalsync"]');
  const body = document.getElementById("vs-body");
  const hint = document.getElementById("vs-inactive-hint");
  if (tab) tab.dataset.inactive = on ? "false" : "true";
  if (body) body.classList.toggle("page-dim", !on);
  if (hint) hint.hidden = on;
}

function loadOpenPanes() {
  try {
    const a = JSON.parse(localStorage.getItem("settingsOpenPanes"));
    if (Array.isArray(a)) {
      const valid = a.filter((p) => PANE_NAMES.includes(p));
      if (valid.length) return new Set(valid);
    }
  } catch {}
  return new Set(["lyrics"]);
}
const openPanes = loadOpenPanes();

// Pin an element to a free (fixed) position, clamped to the viewport.
function pinElement(el, x, y) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
  y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
  el.style.position = "fixed";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.transform = "none";
}

function readPos(key) {
  try {
    const p = JSON.parse(localStorage.getItem(key));
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch {}
  return null;
}

function readSize(key) {
  try {
    const s = JSON.parse(localStorage.getItem(key));
    // Reject degenerate sizes (e.g. captured while the element was hidden/
    // display:none, which reports a 0x0 content rect) so a stale save can't
    // pin the element's specified width/height at 0 under the CSS min-*
    // floor — that leaves the native resize handle needing to "catch up"
    // past the floor before any visible movement appears.
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0) return s;
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
      // Skip saves while hidden (display:none elements report an empty
      // content rect) — otherwise this poisons the saved size to 0x0 on
      // every page load, before the user ever resizes anything.
      if (el.hidden) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
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

// Make `panel` draggable by `handle`, remembering where it's dropped.
function makeDraggable(panel, handle, key) {
  if (!panel || !handle) return;
  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".win-close")) return; // close icon isn't a drag grip
    const rect = panel.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    pinElement(panel, rect.left, rect.top);
    panel.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    pinElement(panel, e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    panel.classList.remove("dragging");
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    const r = panel.getBoundingClientRect();
    try { localStorage.setItem(key, JSON.stringify({ x: r.left, y: r.top })); } catch {}
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

// Cascade fresh windows down the right edge so they don't stack exactly.
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

// Show/hide each section window from (gear visible) AND (section toggled on).
function applyWindowVisibility() {
  const masterOn = !settingsPanel.hidden;
  settingsWindows.forEach((el, name) => {
    const show = masterOn && openPanes.has(name);
    if (show) {
      if (el.hidden) {
        el.hidden = false;
        placeWindow(name); // measure + position only once visible
      }
    } else {
      el.hidden = true;
    }
  });
  settingsTabs.forEach((t) =>
    t.setAttribute("aria-pressed", openPanes.has(t.dataset.page) ? "true" : "false"),
  );
}

function togglePane(name) {
  if (!PANE_NAMES.includes(name)) return;
  if (openPanes.has(name)) openPanes.delete(name);
  else openPanes.add(name);
  try {
    localStorage.setItem("settingsOpenPanes", JSON.stringify([...openPanes]));
  } catch {}
  applyWindowVisibility();
}

function applyLauncherPosition() {
  const pos = readPos("settingsPanelPos");
  if (pos) pinElement(settingsPanel, pos.x, pos.y);
}

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

function closeSettings() {
  settingsPanel.hidden = true;
  applyWindowVisibility(); // hide the section windows along with the launcher
  btnSettings.setAttribute("aria-expanded", "false");
}

// Gear button shows/hides the launcher + its open section windows together.
btnSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  if (settingsPanel.hidden) openSettings();
  else closeSettings();
});

settingsPanel.addEventListener("click", (e) => e.stopPropagation());
settingsTabs.forEach((t) =>
  t.addEventListener("click", () => togglePane(t.dataset.page)),
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsPanel.hidden) closeSettings();
});

// Launcher drags by its grip; each section window drags by its header and has a
// close (×) that just toggles the section off.
makeDraggable(settingsPanel, settingsHandle, "settingsPanelPos");
settingsWindows.forEach((el, name) => {
  el.addEventListener("click", (e) => e.stopPropagation());
  makeDraggable(el, el.querySelector(".win-head"), `settingsWinPos:${name}`);
  watchSize(el, `settingsWinSize:${name}`);
  const closeBtn = el.querySelector(".win-close");
  if (closeBtn) closeBtn.addEventListener("click", () => togglePane(name));
});
watchSize(capturePanel, "capturePanelSize");

vizModeBtns.forEach((b) => {
  b.addEventListener("click", () => {
    if (!VIZ_MODES.includes(b.dataset.viz)) return;
    vizMode = b.dataset.viz;
    try {
      localStorage.setItem("vizMode", vizMode);
    } catch {}
    syncVizPage();
    syncLinebedAvailability();
  });
});

// ── Linebed presets ─────────────────────────────────────────────────────
// Two fixed presets plus an editable Custom one. Params drive both the
// per-row spectrum mapping (contrast/gate/velocity) and the draw amplitude.
//   amplitude — vertical height scale of every ridge
//   contrast  — gamma on each column; >1 flattens quiet and spikes loud
//   velocity  — boosts rising energy frame-to-frame so attacks punch
//   gate      — floor that flattens low-level noise into silence
const LINEBED_PRESETS = {
  smooth: { amplitude: 1.0, contrast: 0.85, velocity: 0.0, gate: 0.0, flip: true },
  dynamic: { amplitude: 1.55, contrast: 1.9, velocity: 0.95, gate: 0.13, flip: true },
};
const LINEBED_CUSTOM_DEFAULT = { amplitude: 1.55, contrast: 1.9, velocity: 0.95, gate: 0.13, flip: true };
let linebedPreset = "dynamic";
let linebedCustom = { ...LINEBED_CUSTOM_DEFAULT };
let linebedOpacity = 0.85; // global ridge opacity, applies across all presets
let linebedDuration = 1.6; // seconds the row stack spans top→bottom (history depth)
let linebedFlow = "log"; // log (present dense) | linear | original (stepped)
let linebedLockMs = 90; // ms before the live ridge freezes into history (25–300)
let linebedPeakHold = false; // hold per-column peaks (instant rise, slow fall)
try {
  const p = localStorage.getItem("linebedPreset");
  if (p && (p === "smooth" || p === "dynamic" || p === "custom")) linebedPreset = p;
  const c = JSON.parse(localStorage.getItem("linebedCustom") || "null");
  if (c && typeof c === "object") linebedCustom = { ...LINEBED_CUSTOM_DEFAULT, ...c };
  const o = parseFloat(localStorage.getItem("linebedOpacity"));
  if (Number.isFinite(o)) linebedOpacity = Math.max(0, Math.min(1, o));
  const d = parseFloat(localStorage.getItem("linebedDuration"));
  if (Number.isFinite(d)) linebedDuration = Math.max(0.8, Math.min(12, d));
  const fl = localStorage.getItem("linebedFlow");
  if (fl === "log" || fl === "linear" || fl === "original") linebedFlow = fl;
  const lk = parseFloat(localStorage.getItem("linebedLockMs"));
  if (Number.isFinite(lk)) linebedLockMs = Math.max(25, Math.min(300, lk));
  linebedPeakHold = localStorage.getItem("linebedPeakHold") === "1";
} catch {}

function getLinebedParams() {
  if (linebedPreset === "custom") return linebedCustom;
  return LINEBED_PRESETS[linebedPreset] || LINEBED_PRESETS.smooth;
}

const lbPresets = document.getElementById("lb-presets");
const lbSliders = document.getElementById("lb-sliders");
const lbInputs = {
  amplitude: document.getElementById("lb-amplitude"),
  contrast: document.getElementById("lb-contrast"),
  velocity: document.getElementById("lb-velocity"),
  gate: document.getElementById("lb-gate"),
};
const lbFlip = document.getElementById("lb-flip");
const lbOpacity = document.getElementById("lb-opacity");
const lbDuration = document.getElementById("lb-duration");
const lbDurationLabel = document.getElementById("lb-duration-label");
const lbFlow = document.getElementById("lb-flow");
const lbLock = document.getElementById("lb-lock");
const lbLockLabel = document.getElementById("lb-lock-label");
const lbPeak = document.getElementById("lb-peak");

// Renders the Linebed settings page; called by openSettings and on edits.
function syncLinebedPanel() {
  lbPresets.querySelectorAll(".lb-preset").forEach((b) => {
    const sel = b.dataset.preset === linebedPreset;
    b.setAttribute("aria-checked", sel ? "true" : "false");
  });
  lbSliders.classList.toggle("disabled", linebedPreset !== "custom");
  const vals = getLinebedParams();
  for (const k in lbInputs) lbInputs[k].value = vals[k];
  const flip = vals.flip !== false;
  lbFlip.setAttribute("aria-checked", flip ? "true" : "false");
  lbFlip.textContent = flip ? "Newest at bottom" : "Newest at top";
  lbOpacity.value = linebedOpacity;
  lbDuration.value = linebedDuration;
  lbDurationLabel.textContent = `History ${linebedDuration.toFixed(1)}s`;
  lbFlow.value = linebedFlow;
  lbLock.value = linebedLockMs;
  lbLockLabel.textContent = `Lock ${Math.round(linebedLockMs)}ms`;
  // Lock interval only matters for the live (log/linear) modes.
  lbLock.closest(".lb-slider").classList.toggle("disabled", linebedFlow === "original");
  lbPeak.setAttribute("aria-checked", linebedPeakHold ? "true" : "false");
  lbPeak.textContent = linebedPeakHold ? "Peak hold on" : "Peak hold off";
}

lbPresets.querySelectorAll(".lb-preset").forEach((b) => {
  b.addEventListener("click", () => {
    linebedPreset = b.dataset.preset;
    try { localStorage.setItem("linebedPreset", linebedPreset); } catch {}
    linebedLocked.length = 0; // restart so new dynamics apply at once
    linebedPrevRow = null;
    syncLinebedPanel();
  });
});

function adoptCustom() {
  if (linebedPreset !== "custom") {
    // Seed Custom from whatever fixed preset was active, then switch to it.
    linebedCustom = { ...getLinebedParams() };
    linebedPreset = "custom";
    try { localStorage.setItem("linebedPreset", linebedPreset); } catch {}
  }
}

for (const k in lbInputs) {
  lbInputs[k].addEventListener("input", () => {
    adoptCustom();
    linebedCustom[k] = parseFloat(lbInputs[k].value);
    try { localStorage.setItem("linebedCustom", JSON.stringify(linebedCustom)); } catch {}
    syncLinebedPanel();
  });
}

lbOpacity.addEventListener("input", () => {
  linebedOpacity = Math.max(0, Math.min(1, parseFloat(lbOpacity.value)));
  try { localStorage.setItem("linebedOpacity", linebedOpacity); } catch {}
});

lbDuration.addEventListener("input", () => {
  linebedDuration = Math.max(0.8, Math.min(12, parseFloat(lbDuration.value)));
  try { localStorage.setItem("linebedDuration", linebedDuration); } catch {}
  syncLinebedPanel();
});

lbFlow.addEventListener("change", () => {
  const v = lbFlow.value;
  linebedFlow = v === "linear" || v === "original" ? v : "log";
  try { localStorage.setItem("linebedFlow", linebedFlow); } catch {}
  linebedLocked.length = 0; // row semantics differ per mode — restart clean
  linebedAccum = 0;
  linebedPrevRow = null;
  syncLinebedPanel();
});

lbLock.addEventListener("input", () => {
  linebedLockMs = Math.max(25, Math.min(300, parseFloat(lbLock.value)));
  try { localStorage.setItem("linebedLockMs", linebedLockMs); } catch {}
  syncLinebedPanel();
});

lbPeak.addEventListener("click", () => {
  linebedPeakHold = !linebedPeakHold;
  try { localStorage.setItem("linebedPeakHold", linebedPeakHold ? "1" : "0"); } catch {}
  linebedPeak = null; // restart the held envelope
  syncLinebedPanel();
});

lbFlip.addEventListener("click", () => {
  adoptCustom();
  linebedCustom.flip = !(linebedCustom.flip !== false);
  try { localStorage.setItem("linebedCustom", JSON.stringify(linebedCustom)); } catch {}
  syncLinebedPanel();
});

// ── Linebed spectrum base (frequency mapping, range, resolution) ─────────
// Global (not per-preset) controls for how columns map to frequency and how
// magnitude is scaled. linebedSpectrum + buildLinebedBands live in the draw
// section; these just edit/persist and rebuild the band table.
const lsMode = document.getElementById("ls-mode");
const lsMag = document.getElementById("ls-mag");
const lsFMin = document.getElementById("ls-fmin");
const lsFMax = document.getElementById("ls-fmax");
const lsRange = document.getElementById("ls-range-label");
const lsRes = document.getElementById("ls-res");
const lsResLabel = document.getElementById("ls-res-label");
const lsBlend = document.getElementById("ls-blend");
const lsBlendLabel = document.getElementById("ls-blend-label");

// Dual-thumb Hz range: two overlaid sliders (low + high handle). Travel is
// musically logarithmic — each octave gets equal slider width — so the bass
// gets room for definition instead of squashing into the first millimetre.
const SPEC_GAP = 1.06; // min ratio between the two handles (~one semitone-ish)
const SPEC_POS_MAX = 1000; // slider integer resolution
function specPosToHz(pos) {
  const lo = LINEBED_SPECTRUM_LIMITS.fLo;
  const hi = LINEBED_SPECTRUM_LIMITS.fHi;
  const t = Math.max(0, Math.min(1, pos / SPEC_POS_MAX));
  return lo * Math.pow(hi / lo, t);
}
function specHzToPos(hz) {
  const lo = LINEBED_SPECTRUM_LIMITS.fLo;
  const hi = LINEBED_SPECTRUM_LIMITS.fHi;
  const c = Math.max(lo, Math.min(hi, hz));
  return Math.round((Math.log(c / lo) / Math.log(hi / lo)) * SPEC_POS_MAX);
}
// Round to readable Hz steps that get coarser as frequency climbs.
function specRoundHz(hz) {
  if (hz < 100) return Math.round(hz);
  if (hz < 1000) return Math.round(hz / 5) * 5;
  return Math.round(hz / 50) * 50;
}

function persistSpectrum() {
  try { localStorage.setItem("linebedSpectrum", JSON.stringify(linebedSpectrum)); } catch {}
}

function syncLinebedSpectrumPanel() {
  const s = linebedSpectrum;
  lsMode.value = s.mode;
  lsMag.value = s.mag;
  lsFMin.value = specHzToPos(s.fMin);
  lsFMax.value = specHzToPos(s.fMax);
  lsRange.textContent = `Range ${Math.round(s.fMin)}–${Math.round(s.fMax)} Hz`;
  const chromatic = s.mode === "chromatic";
  lsResLabel.textContent = chromatic ? `Per octave ${s.divPerOctave}` : `Columns ${s.cols}`;
  lsRes.min = chromatic ? "6" : "16";
  lsRes.max = chromatic ? "72" : String(LINEBED_SPECTRUM_LIMITS.colsMax);
  lsRes.step = chromatic ? "1" : "4";
  lsRes.value = chromatic ? s.divPerOctave : s.cols;
  lsBlend.value = s.blend;
  lsBlendLabel.textContent = `Peak↔Avg ${Math.round(s.blend * 100)}%`;
}

function commitSpectrum() {
  persistSpectrum();
  buildLinebedBands();
  syncLinebedSpectrumPanel();
}

lsMode.addEventListener("change", () => {
  if (["chromatic", "log", "linear", "mel"].includes(lsMode.value)) {
    linebedSpectrum.mode = lsMode.value;
    commitSpectrum();
  }
});

lsMag.addEventListener("change", () => {
  if (["db", "linear"].includes(lsMag.value)) {
    linebedSpectrum.mag = lsMag.value;
    persistSpectrum(); // no rebuild needed; mapping unchanged
    syncLinebedSpectrumPanel();
  }
});

lsFMin.addEventListener("input", () => {
  const hz = specRoundHz(specPosToHz(parseFloat(lsFMin.value)));
  linebedSpectrum.fMin = Math.min(hz, linebedSpectrum.fMax / SPEC_GAP);
  commitSpectrum();
});

lsFMax.addEventListener("input", () => {
  const hz = specRoundHz(specPosToHz(parseFloat(lsFMax.value)));
  linebedSpectrum.fMax = Math.max(hz, linebedSpectrum.fMin * SPEC_GAP);
  commitSpectrum();
});

lsRes.addEventListener("input", () => {
  const v = Math.round(parseFloat(lsRes.value));
  if (linebedSpectrum.mode === "chromatic") linebedSpectrum.divPerOctave = v;
  else linebedSpectrum.cols = v;
  commitSpectrum();
});

lsBlend.addEventListener("input", () => {
  linebedSpectrum.blend = Math.max(0, Math.min(1, parseFloat(lsBlend.value)));
  persistSpectrum(); // no rebuild; only aggregation weight changes
  syncLinebedSpectrumPanel();
});

// ── Lyrics styling + motion controls ────────────────────────────────────
// Font, size, effect, timing offset, and a global motion multiplier (0 = still
// text — accessibility). All persisted; the render loop reads them live.
const LYRIC_FONTS = {
  sans: { label: "Sans", family: "Inter", weight: 600, emphasisWeight: 800 },
  serif: { label: "Serif", family: '"Playfair Display"', weight: 600, emphasisWeight: 800 },
  cursive: { label: "Cursive", family: '"Dancing Script"', weight: 600, emphasisWeight: 700 },
  mono: { label: "Mono", family: '"Space Mono"', weight: 400, emphasisWeight: 700 },
  // Themed display faces. Mostly single-weight, so emphasisWeight matches weight
  // to avoid faux-bold synthesis (Orbitron is the one variable face here).
  western: { label: "Western", family: '"Rye"', weight: 400, emphasisWeight: 400 },
  cyberpunk: { label: "Cyberpunk", family: '"Orbitron"', weight: 700, emphasisWeight: 900 },
  neon: { label: "Neon", family: '"Monoton"', weight: 400, emphasisWeight: 400 },
  retro: { label: "Retro", family: '"Righteous"', weight: 400, emphasisWeight: 400 },
  vintage: { label: "Vintage", family: '"Special Elite"', weight: 400, emphasisWeight: 400 },
  // Mood faces. Single-weight unless noted, so emphasisWeight matches weight.
  girly: { label: "Girly", family: '"Pacifico"', weight: 400, emphasisWeight: 400 },
  anime: { label: "Anime", family: '"Reggae One"', weight: 400, emphasisWeight: 400 },
  mystical: { label: "Mystical", family: '"Cinzel Decorative"', weight: 700, emphasisWeight: 900 },
  horror: { label: "Horror", family: '"Creepster"', weight: 400, emphasisWeight: 400 },
  metal: { label: "Metal Band", family: '"Metal Mania"', weight: 400, emphasisWeight: 400 },
  excited: { label: "Excited", family: '"Bangers"', weight: 400, emphasisWeight: 400 },
  calm: { label: "Calm", family: '"Comfortaa"', weight: 400, emphasisWeight: 700 },
  // COLRv1 color font: glyphs paint their own gradient, fill color is ignored.
  spice: { label: "Spice", family: '"Bungee Spice"', weight: 400, emphasisWeight: 400 },
};

// User-imported Google Fonts. Persisted as an array of
// { key, label, family, weight, emphasisWeight, href }; restored into
// LYRIC_FONTS on boot and re-injected as <link> stylesheets.
const CUSTOM_FONTS_KEY = "lyricCustomFonts";

// Inject the Google Fonts stylesheet and resolve once it has actually loaded —
// callers need the @font-face registered before they can read its style/weight.
function injectFontStylesheet(href) {
  const existing = document.querySelector(`link[data-fontimport="${CSS.escape(href)}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.fontimport = href;
    link.addEventListener("load", () => resolve());
    link.addEventListener("error", () => resolve());
    document.head.appendChild(link);
  });
}

// Build the CSS API URL for a family name WITHOUT forcing weights — many display
// fonts are single-weight or italic-only (e.g. Molle has no upright 400 and no
// 700), and requesting an absent weight makes Google 400 the whole stylesheet,
// so the face never loads. Bare `family=Name` returns whatever the font ships.
function googleFontHref(familyName) {
  return `https://fonts.googleapis.com/css2?family=${familyName.replace(/ /g, "+")}&display=swap`;
}

// Accepts a bare family name ("Molle"), a fonts.googleapis.com CSS URL, or a
// fonts.google.com/specimen/<Name> preview-page link (what the Google Fonts
// site shows in the address bar). Returns { key, label, family, href } or throws.
function parseCustomFontInput(raw) {
  const input = String(raw || "").trim();
  if (!input) throw new Error("Type a font name or link");
  let familyName, href;
  if (/^https?:\/\//i.test(input)) {
    let url;
    try { url = new URL(input); } catch { throw new Error("That link looks broken"); }
    if (url.hostname === "fonts.googleapis.com") {
      const fam = url.searchParams.get("family");
      if (!fam) throw new Error("Link has no font in it");
      familyName = fam.split(":")[0].replace(/\+/g, " ").trim();
      href = url.toString();
    } else if (url.hostname === "fonts.google.com" && /\/specimen\//.test(url.pathname)) {
      // .../specimen/Molle  →  "Molle"
      const seg = url.pathname.split("/specimen/")[1] || "";
      familyName = decodeURIComponent(seg.split("/")[0]).replace(/\+/g, " ").trim();
      if (!familyName) throw new Error("Couldn't read the font name from that link");
      href = googleFontHref(familyName);
    } else {
      throw new Error("Use a fonts.google.com or fonts.googleapis.com link");
    }
  } else {
    // Bare name. Keep letters/numbers/spaces only, then build the CSS URL.
    familyName = input.replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
    if (!familyName) throw new Error("That's not a usable font name");
    href = googleFontHref(familyName);
  }
  return {
    key: `custom:${familyName.toLowerCase()}`,
    label: familyName,
    family: `"${familyName}"`,
    href,
  };
}

function registerCustomFont(def) {
  LYRIC_FONTS[def.key] = {
    label: def.label,
    family: def.family,
    weight: def.weight || 400,
    emphasisWeight: def.emphasisWeight || 400,
    style: def.style || "",
  };
  injectFontStylesheet(def.href).then(() =>
    resolveCustomFontFace(def.key, def.label),
  );
}

// Inspect the @font-face the stylesheet registered and copy its real style and
// weight onto the LYRIC_FONTS entry. Fixes fonts that ship only italic (Molle)
// or a non-400 weight, which a plain "400 …px" canvas request would miss and
// fall back to serif. Then load the actual face and re-layout if it's active.
function resolveCustomFontFace(key, familyName) {
  if (typeof document.fonts === "undefined") return;
  const want = familyName.toLowerCase();
  document.fonts.ready.then(() => {
    let face = null;
    document.fonts.forEach((f) => {
      if (f.family.replace(/['"]/g, "").toLowerCase() !== want) return;
      // Prefer a weight-400 face when several exist, else take the first.
      if (!face || String(f.weight).startsWith("400")) face = f;
    });
    const entry = LYRIC_FONTS[key];
    if (!entry) return;
    if (face) {
      entry.style = face.style && face.style !== "normal" ? face.style : "";
      const w = parseInt(String(face.weight).split(/\s+/)[0], 10);
      if (Number.isFinite(w)) {
        entry.weight = w;
        entry.emphasisWeight = w;
      }
    }
    const probe = `${entry.style ? entry.style + " " : ""}${entry.weight} 40px ${entry.family}`;
    document.fonts.load(probe).then(() => {
      if (lyricFontKey === key) reflowForFontKey(key);
    });
  });
}

function loadCustomFonts() {
  try {
    const arr = JSON.parse(localStorage.getItem(CUSTOM_FONTS_KEY) || "[]");
    if (Array.isArray(arr)) {
      for (const def of arr) {
        if (def && def.key && def.family && def.href) registerCustomFont(def);
      }
    }
  } catch {}
}

loadCustomFonts(); // restore before lyricFontKey is read below
const LYRIC_EFFECTS = ["wordwave", "reveal", "fade", "rise", "zoom", "cascade"];
// How the text reacts on each detected beat (independent of the entrance effect).
const BEAT_EFFECTS = ["split", "pump", "shake", "bounce", "swing", "jelly", "flash"];

function loadNum(key, def, lo, hi) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    if (Number.isFinite(v)) return Math.max(lo, Math.min(hi, v));
  } catch {}
  return def;
}

let lyricMotion = loadNum("lyricMotion", 1, 0, 1.4);
let lyricFontScale = loadNum("lyricFontScale", 1, 0.6, 1.6);
let lyricOffset = loadNum("lyricOffset", 0, -3, 3);
let lyricWarp = loadNum("lyricWarp", 0, -1, 1);
let lyricFontKey = "sans";
let lyricEffect = "wordwave";
let beatEffect = "split";
try {
  const f = localStorage.getItem("lyricFontKey");
  if (f && LYRIC_FONTS[f]) lyricFontKey = f;
  const e = localStorage.getItem("lyricEffect");
  if (e && LYRIC_EFFECTS.includes(e)) lyricEffect = e;
  const b = localStorage.getItem("beatEffect");
  if (b && BEAT_EFFECTS.includes(b)) beatEffect = b;
} catch {}
if (ghLink) ghLink.dataset.anim = lyricEffect; // seed before settings ever open

// Playback time the lyrics follow, with the user's sync offset applied.
function getLyricTime() {
  return getPlaybackTime() + lyricOffset;
}

// Warp the linear within-line progress so the word-by-word reveal can run ahead
// of or behind the line clock — lrclib only stamps lines, so this is the knob
// for vocals that rush or drag inside a line. A gamma bias: warp<0 front-loads
// (words rush early = "squish"), warp>0 back-loads (words drag = "expand"),
// warp=0 is the original linear pacing. Monotonic, so words never un-reveal.
function warpLyricProgress(p) {
  if (!lyricWarp) return p;
  const g = Math.exp(lyricWarp * 1.8); // ~0.16 … 6.0 across the slider
  return Math.pow(clamp(p, 0, 1), g);
}

const lmMotion = document.getElementById("lm-motion");
const lmLabel = document.getElementById("lm-label");
const lmFont = document.getElementById("lm-font");
const lmSize = document.getElementById("lm-size");
const lmSizeLabel = document.getElementById("lm-size-label");
const lmEffect = document.getElementById("lm-effect");
const lmBeat = document.getElementById("lm-beat");
const lmOffset = document.getElementById("lm-offset");
const lmOffsetLabel = document.getElementById("lm-offset-label");
const lmWarp = document.getElementById("lm-warp");
const lmWarpLabel = document.getElementById("lm-warp-label");
const lmCustomFontInput = document.getElementById("lm-customfont-input");
const lmCustomFontAdd = document.getElementById("lm-customfont-add");

// Add a font <option> to the picker if it isn't already there.
function ensureFontOption(key, label) {
  if (!lmFont || lmFont.querySelector(`option[value="${CSS.escape(key)}"]`)) return;
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = label;
  lmFont.appendChild(opt);
}

// Surface every registered custom font (key starts with "custom:") in the picker.
for (const [key, def] of Object.entries(LYRIC_FONTS)) {
  if (key.startsWith("custom:")) ensureFontOption(key, def.label);
}

// Webfonts download async; clearing the cache now lays out with the swap
// fallback, and clearing again once the real face is ready fixes the metrics.
function reflowForFontKey(key) {
  clearLocalTextCaches();
  const def = LYRIC_FONTS[key];
  if (!def || typeof document.fonts === "undefined") return;
  const sty = def.style ? def.style + " " : "";
  const probes = [
    document.fonts.load(`${sty}${def.weight} 40px ${def.family}`),
    document.fonts.load(`${sty}${def.emphasisWeight} 40px ${def.family}`),
  ];
  Promise.allSettled(probes).then(() => clearLocalTextCaches());
}

function syncMotionPanel() {
  lmMotion.value = lyricMotion;
  lmLabel.textContent = `Motion ${Math.round(lyricMotion * 100)}%`;
  lmFont.value = lyricFontKey;
  lmSize.value = lyricFontScale;
  lmSizeLabel.textContent = `Size ${Math.round(lyricFontScale * 100)}%`;
  lmEffect.value = lyricEffect;
  if (ghLink) ghLink.dataset.anim = lyricEffect; // label hover reuses lyric effect
  lmBeat.value = beatEffect;
  lmOffset.value = lyricOffset;
  lmOffsetLabel.textContent = `Offset ${lyricOffset > 0 ? "+" : ""}${lyricOffset.toFixed(1)}s`;
  lmWarp.value = lyricWarp;
  lmWarpLabel.textContent =
    lyricWarp === 0
      ? "Warp linear"
      : `Warp ${lyricWarp < 0 ? "squish" : "expand"} ${Math.abs(lyricWarp).toFixed(2)}`;
}

lmMotion.addEventListener("input", () => {
  lyricMotion = parseFloat(lmMotion.value);
  try { localStorage.setItem("lyricMotion", String(lyricMotion)); } catch {}
  syncMotionPanel();
});

lmFont.addEventListener("change", () => {
  if (LYRIC_FONTS[lmFont.value]) lyricFontKey = lmFont.value;
  try { localStorage.setItem("lyricFontKey", lyricFontKey); } catch {}
  reflowForFontKey(lyricFontKey); // re-layout under the new face
  syncMotionPanel();
});

const lmCustomFontHint = document.getElementById("lm-customfont-hint");
const CUSTOM_FONT_HINT_DEFAULT = lmCustomFontHint ? lmCustomFontHint.textContent : "";

function setCustomFontHint(msg, isError) {
  if (!lmCustomFontHint) return;
  lmCustomFontHint.textContent = msg || CUSTOM_FONT_HINT_DEFAULT;
  lmCustomFontHint.classList.toggle("error", !!isError);
}

function addCustomFontFromInput() {
  if (!lmCustomFontInput) return;
  let def;
  try {
    def = parseCustomFontInput(lmCustomFontInput.value);
  } catch (err) {
    setCustomFontHint(err.message, true);
    return;
  }
  registerCustomFont(def);
  ensureFontOption(def.key, def.label);
  // Persist the full list of custom fonts (de-duped by key).
  try {
    const arr = JSON.parse(localStorage.getItem(CUSTOM_FONTS_KEY) || "[]");
    const list = Array.isArray(arr) ? arr.filter((d) => d && d.key !== def.key) : [];
    list.push({ key: def.key, label: def.label, family: def.family, href: def.href });
    localStorage.setItem(CUSTOM_FONTS_KEY, JSON.stringify(list));
  } catch {}
  // Select it immediately.
  lyricFontKey = def.key;
  try { localStorage.setItem("lyricFontKey", lyricFontKey); } catch {}
  reflowForFontKey(lyricFontKey);
  lmCustomFontInput.value = "";
  setCustomFontHint(`Added “${def.label}” — applied to lyrics`, false);
  syncMotionPanel();
}

if (lmCustomFontAdd) {
  lmCustomFontAdd.addEventListener("click", addCustomFontFromInput);
  lmCustomFontAdd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addCustomFontFromInput(); }
  });
}
if (lmCustomFontInput) {
  lmCustomFontInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustomFontFromInput(); }
    else if (lmCustomFontHint && lmCustomFontHint.classList.contains("error")) {
      setCustomFontHint("", false);
    }
  });
}

lmSize.addEventListener("input", () => {
  lyricFontScale = parseFloat(lmSize.value);
  try { localStorage.setItem("lyricFontScale", String(lyricFontScale)); } catch {}
  syncMotionPanel();
});

lmEffect.addEventListener("change", () => {
  if (LYRIC_EFFECTS.includes(lmEffect.value)) lyricEffect = lmEffect.value;
  try { localStorage.setItem("lyricEffect", lyricEffect); } catch {}
  syncMotionPanel();
});

lmBeat.addEventListener("change", () => {
  if (BEAT_EFFECTS.includes(lmBeat.value)) beatEffect = lmBeat.value;
  try { localStorage.setItem("beatEffect", beatEffect); } catch {}
  syncMotionPanel();
});

lmOffset.addEventListener("input", () => {
  lyricOffset = parseFloat(lmOffset.value);
  try { localStorage.setItem("lyricOffset", String(lyricOffset)); } catch {}
  syncMotionPanel();
});

lmWarp.addEventListener("input", () => {
  lyricWarp = parseFloat(lmWarp.value);
  try { localStorage.setItem("lyricWarp", String(lyricWarp)); } catch {}
  syncMotionPanel();
});

// Default reset: each range slider carrying a data-default makes its keyword
// label clickable (with a small dot cue). Clicking snaps the slider back to its
// factory value and fires the same input/change events a drag would, so every
// control's existing handler (persist + redraw) runs unchanged.
function installSliderDefaults(root) {
  for (const input of root.querySelectorAll("input[type=range][data-default]")) {
    const def = parseFloat(input.dataset.default);
    if (!Number.isFinite(def)) continue;
    const label = input.closest(".lb-slider")?.querySelector("span");
    if (!label) continue;
    label.dataset.reset = "";
    label.title = `Reset to default (${def})`;
    label.addEventListener("click", (e) => {
      e.preventDefault();
      if (parseFloat(input.value) === def) return;
      input.value = String(def);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
}

installSliderDefaults(document);

// ── FFT / audio-analysis controls ───────────────────────────────────────
// Expose the AudioEngine analysis params as live sliders. Persisted; pushed to
// the engine via its setters (which also seed lazy init()). Lowering fftSize
// blurs the linebed's per-semitone resolution — that trade-off is the user's.
// Band crossovers in Hz. Caps reflect what's musically useful: bass tops out
// ~2 kHz, mids ~10 kHz (above that is mostly inaudible air / often empty).
const FFT_DEFAULTS = { fftSize: 16384, smoothing: 0.65, gain: 1, bassHz: 250, midHz: 4000 };
const FFT_SIZES = [2048, 4096, 8192, 16384, 32768];
const FFT_BASS_RANGE = [100, 2000];
const FFT_MID_RANGE = [400, 10000];

let fftSize = FFT_DEFAULTS.fftSize;
try {
  const v = parseInt(localStorage.getItem("fftSize"), 10);
  if (FFT_SIZES.includes(v)) fftSize = v;
} catch {}
let fftSmoothing = loadNum("fftSmoothing", FFT_DEFAULTS.smoothing, 0, 0.95);
let fftGain = loadNum("fftGain", FFT_DEFAULTS.gain, 0.2, 4);
let fftBassHz = loadNum("fftBassHz", FFT_DEFAULTS.bassHz, ...FFT_BASS_RANGE);
let fftMidHz = loadNum("fftMidHz", FFT_DEFAULTS.midHz, ...FFT_MID_RANGE);

// Push current params into the engine. midHz is clamped above bassHz so the
// mid band can never invert.
function applyFftParams() {
  audio.setFftSize(fftSize);
  audio.setSmoothing(fftSmoothing);
  audio.setGain(fftGain);
  audio.setBandSplits(fftBassHz, Math.max(fftMidHz, fftBassHz + 50));
}
applyFftParams();

const fftSizeSel = document.getElementById("ft-size");
const fftSmoothInput = document.getElementById("ft-smooth");
const fftSmoothLabel = document.getElementById("ft-smooth-label");
const fftGainInput = document.getElementById("ft-gain");
const fftGainLabel = document.getElementById("ft-gain-label");
const fftBassInput = document.getElementById("ft-bass");
const fftBassLabel = document.getElementById("ft-bass-label");
const fftMidInput = document.getElementById("ft-mid");
const fftMidLabel = document.getElementById("ft-mid-label");

function syncFftPanel() {
  fftSizeSel.value = String(fftSize);
  fftSmoothInput.value = fftSmoothing;
  fftSmoothLabel.textContent = `Smoothing ${Math.round(fftSmoothing * 100)}%`;
  fftGainInput.value = fftGain;
  fftGainLabel.textContent = `Gain ${fftGain.toFixed(2)}×`;
  fftBassInput.value = fftBassHz;
  fftBassLabel.textContent = `Bass < ${Math.round(fftBassHz)} Hz`;
  fftMidInput.value = fftMidHz;
  fftMidLabel.textContent = `Mid < ${Math.round(fftMidHz)} Hz`;
}

fftSizeSel.addEventListener("change", () => {
  const v = parseInt(fftSizeSel.value, 10);
  if (!FFT_SIZES.includes(v)) return;
  fftSize = v;
  try { localStorage.setItem("fftSize", String(fftSize)); } catch {}
  audio.setFftSize(fftSize);
  linebedLocked.length = 0; // bin count changed — drop stale rows
  linebedPrevRow = null;
});

fftSmoothInput.addEventListener("input", () => {
  fftSmoothing = parseFloat(fftSmoothInput.value);
  try { localStorage.setItem("fftSmoothing", String(fftSmoothing)); } catch {}
  audio.setSmoothing(fftSmoothing);
  syncFftPanel();
});

fftGainInput.addEventListener("input", () => {
  fftGain = parseFloat(fftGainInput.value);
  try { localStorage.setItem("fftGain", String(fftGain)); } catch {}
  audio.setGain(fftGain);
  syncFftPanel();
});

fftBassInput.addEventListener("input", () => {
  fftBassHz = parseFloat(fftBassInput.value);
  try { localStorage.setItem("fftBassHz", String(fftBassHz)); } catch {}
  applyFftParams();
  syncFftPanel();
});

fftMidInput.addEventListener("input", () => {
  fftMidHz = parseFloat(fftMidInput.value);
  try { localStorage.setItem("fftMidHz", String(fftMidHz)); } catch {}
  applyFftParams();
  syncFftPanel();
});

document.getElementById("ft-reset").addEventListener("click", () => {
  fftSize = FFT_DEFAULTS.fftSize;
  fftSmoothing = FFT_DEFAULTS.smoothing;
  fftGain = FFT_DEFAULTS.gain;
  fftBassHz = FFT_DEFAULTS.bassHz;
  fftMidHz = FFT_DEFAULTS.midHz;
  try {
    localStorage.removeItem("fftSize");
    localStorage.removeItem("fftSmoothing");
    localStorage.removeItem("fftGain");
    localStorage.removeItem("fftBassHz");
    localStorage.removeItem("fftMidHz");
  } catch {}
  applyFftParams();
  linebedLocked.length = 0;
  linebedPrevRow = null;
  syncFftPanel();
});

// ── Vocal Sync controls ─────────────────────────────────────────────────
// Live knobs for the 🎤 onset engine. Detector params push into the shared
// VocalOnsetDetector; band cutoffs into the AudioEngine vocal stem; the pop
// motion params are read straight from these module vars in drawLyrics.
const VOCALSYNC_DEFAULTS = {
  threshold: 1.6,
  minGapMs: 120,
  gate: 0.4,
  lead: 2,
  smoothing: 0.5,
  bandLowHz: 250,
  bandHighHz: 4000,
  popIntensity: 1,
  popDecayMs: 500,
  glitch: 1,
};
let vsThreshold = loadNum("vsThreshold", VOCALSYNC_DEFAULTS.threshold, 1, 3);
let vsMinGapMs = loadNum("vsMinGapMs", VOCALSYNC_DEFAULTS.minGapMs, 60, 300);
let vsGate = loadNum("vsGate", VOCALSYNC_DEFAULTS.gate, 0, 1);
let vsLead = loadNum("vsLead", VOCALSYNC_DEFAULTS.lead, 0, 5);
let vsSmoothing = loadNum("vsSmoothing", VOCALSYNC_DEFAULTS.smoothing, 0, 0.95);
let vsBandLowHz = loadNum("vsBandLowHz", VOCALSYNC_DEFAULTS.bandLowHz, 120, 500);
let vsBandHighHz = loadNum("vsBandHighHz", VOCALSYNC_DEFAULTS.bandHighHz, 2500, 8000);
let vsPopIntensity = loadNum("vsPopIntensity", VOCALSYNC_DEFAULTS.popIntensity, 0, 2);
let vsPopDecayMs = loadNum("vsPopDecayMs", VOCALSYNC_DEFAULTS.popDecayMs, 200, 1000);
let vsGlitch = loadNum("vsGlitch", VOCALSYNC_DEFAULTS.glitch, 0, 1);

function applyVocalSyncParams() {
  vocalDetector.thresholdMult = vsThreshold;
  vocalDetector.refractory = vsMinGapMs / 1000;
  vocalDetector.gate = vsGate;
  audio.setVocalBand(vsBandLowHz, vsBandHighHz);
  audio.setVocalSmoothing(vsSmoothing);
}
applyVocalSyncParams();

const vsThreshInput = document.getElementById("vs-threshold");
const vsThreshLabel = document.getElementById("vs-threshold-label");
const vsGapInput = document.getElementById("vs-gap");
const vsGapLabel = document.getElementById("vs-gap-label");
const vsGateInput = document.getElementById("vs-gate");
const vsGateLabel = document.getElementById("vs-gate-label");
const vsLeadInput = document.getElementById("vs-lead");
const vsLeadLabel = document.getElementById("vs-lead-label");
const vsSmoothInput = document.getElementById("vs-smooth");
const vsSmoothLabel = document.getElementById("vs-smooth-label");
const vsLowInput = document.getElementById("vs-low");
const vsLowLabel = document.getElementById("vs-low-label");
const vsHighInput = document.getElementById("vs-high");
const vsHighLabel = document.getElementById("vs-high-label");
const vsPopInput = document.getElementById("vs-pop");
const vsPopLabel = document.getElementById("vs-pop-label");
const vsDecayInput = document.getElementById("vs-decay");
const vsDecayLabel = document.getElementById("vs-decay-label");
const vsGlitchInput = document.getElementById("vs-glitch");
const vsGlitchLabel = document.getElementById("vs-glitch-label");

function syncVocalSyncPanel() {
  if (!vsThreshInput) return;
  vsThreshInput.value = vsThreshold;
  vsThreshLabel.textContent = `Onset threshold ${vsThreshold.toFixed(2)}× (lower = more)`;
  vsGapInput.value = vsMinGapMs;
  vsGapLabel.textContent = `Min word gap ${Math.round(vsMinGapMs)} ms`;
  vsGateInput.value = vsGate;
  vsGateLabel.textContent = `Vocal gate ${Math.round(vsGate * 100)}% (higher = stricter)`;
  vsLeadInput.value = vsLead;
  vsLeadLabel.textContent = `Reveal tightness ${vsLead.toFixed(0)} word lead`;
  vsSmoothInput.value = vsSmoothing;
  vsSmoothLabel.textContent = `Smoothing ${Math.round(vsSmoothing * 100)}% (lower = sharper)`;
  vsLowInput.value = vsBandLowHz;
  vsLowLabel.textContent = `Vocal band low ${Math.round(vsBandLowHz)} Hz`;
  vsHighInput.value = vsBandHighHz;
  vsHighLabel.textContent = `Vocal band high ${Math.round(vsBandHighHz)} Hz`;
  vsPopInput.value = vsPopIntensity;
  vsPopLabel.textContent = `Pop intensity ${vsPopIntensity.toFixed(2)}×`;
  vsDecayInput.value = vsPopDecayMs;
  vsDecayLabel.textContent = `Pop decay ${Math.round(vsPopDecayMs)} ms`;
  vsGlitchInput.value = vsGlitch;
  vsGlitchLabel.textContent = `Glitch amount ${Math.round(vsGlitch * 100)}%`;
}

function bindVsSlider(input, apply) {
  if (!input) return;
  input.addEventListener("input", () => {
    apply(parseFloat(input.value));
    syncVocalSyncPanel();
  });
}
bindVsSlider(vsThreshInput, (v) => {
  vsThreshold = v;
  try { localStorage.setItem("vsThreshold", String(v)); } catch {}
  applyVocalSyncParams();
});
bindVsSlider(vsGapInput, (v) => {
  vsMinGapMs = v;
  try { localStorage.setItem("vsMinGapMs", String(v)); } catch {}
  applyVocalSyncParams();
});
bindVsSlider(vsGateInput, (v) => {
  vsGate = v;
  try { localStorage.setItem("vsGate", String(v)); } catch {}
  applyVocalSyncParams();
});
bindVsSlider(vsLeadInput, (v) => {
  vsLead = v;
  try { localStorage.setItem("vsLead", String(v)); } catch {}
});
bindVsSlider(vsSmoothInput, (v) => {
  vsSmoothing = v;
  try { localStorage.setItem("vsSmoothing", String(v)); } catch {}
  applyVocalSyncParams();
});
bindVsSlider(vsLowInput, (v) => {
  vsBandLowHz = v;
  try { localStorage.setItem("vsBandLowHz", String(v)); } catch {}
  applyVocalSyncParams();
});
bindVsSlider(vsHighInput, (v) => {
  vsBandHighHz = v;
  try { localStorage.setItem("vsBandHighHz", String(v)); } catch {}
  applyVocalSyncParams();
});
bindVsSlider(vsPopInput, (v) => {
  vsPopIntensity = v;
  try { localStorage.setItem("vsPopIntensity", String(v)); } catch {}
});
bindVsSlider(vsDecayInput, (v) => {
  vsPopDecayMs = v;
  try { localStorage.setItem("vsPopDecayMs", String(v)); } catch {}
});
bindVsSlider(vsGlitchInput, (v) => {
  vsGlitch = v;
  try { localStorage.setItem("vsGlitch", String(v)); } catch {}
});

const vsResetBtn = document.getElementById("vs-reset");
if (vsResetBtn) {
  vsResetBtn.addEventListener("click", () => {
    vsThreshold = VOCALSYNC_DEFAULTS.threshold;
    vsMinGapMs = VOCALSYNC_DEFAULTS.minGapMs;
    vsGate = VOCALSYNC_DEFAULTS.gate;
    vsLead = VOCALSYNC_DEFAULTS.lead;
    vsSmoothing = VOCALSYNC_DEFAULTS.smoothing;
    vsBandLowHz = VOCALSYNC_DEFAULTS.bandLowHz;
    vsBandHighHz = VOCALSYNC_DEFAULTS.bandHighHz;
    vsPopIntensity = VOCALSYNC_DEFAULTS.popIntensity;
    vsPopDecayMs = VOCALSYNC_DEFAULTS.popDecayMs;
    vsGlitch = VOCALSYNC_DEFAULTS.glitch;
    try {
      for (const k of [
        "vsThreshold", "vsMinGapMs", "vsGate", "vsLead", "vsSmoothing",
        "vsBandLowHz", "vsBandHighHz", "vsPopIntensity", "vsPopDecayMs", "vsGlitch",
      ]) localStorage.removeItem(k);
    } catch {}
    applyVocalSyncParams();
    syncVocalSyncPanel();
  });
}

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

btnHideUi.addEventListener("click", () => {
  const hidden = document.body.classList.toggle("ui-hidden");
  document.body.classList.remove("ui-peek");
  btnHideUi.setAttribute("aria-pressed", hidden ? "true" : "false");
  btnHideUi.dataset.tip = hidden ? "Show UI" : "Hide UI";
  btnHideUi.setAttribute("aria-label", hidden ? "Show UI" : "Hide UI");
});

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

seekBar.addEventListener("input", (event) => {
  const progress = Number.parseFloat(event.currentTarget.value) / 1000;
  // Bridge track → seek the system player via MPRIS/SMTC; otherwise seek the
  // locally decoded buffer.
  if (bridge.active && bridge.track && bridge.track.length > 0) {
    bridge.seek(progress * bridge.track.length).then(syncProgressUI);
    syncProgressUI();
    return;
  }
  if (audio.duration <= 0) return;
  audio.seekTo(progress * audio.duration);
  syncProgressUI();
});

// ── Local file loading (drag-drop + file picker) ────────────────────────
const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
  ".opus",
  ".weba",
];
const LYRIC_EXTENSIONS = [".lrc", ".txt"];

function hasExtension(name, extensions) {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function isAudioFile(file) {
  return (
    file.type.startsWith("audio/") || hasExtension(file.name, AUDIO_EXTENSIONS)
  );
}

function isLyricFile(file) {
  return hasExtension(file.name, LYRIC_EXTENSIONS);
}

// USLT embedded lyrics may be timed (LRC) or plain; pick a filename so the
// parser routes them correctly.
function embeddedLyricFilename(text) {
  return /\[\d{1,2}:\d{2}/.test(text) ? "embedded.lrc" : "embedded.txt";
}

async function fetchLyricsFor(trackId, info) {
  updateLyricsStatus(`Searching lyrics for "${info.title}"...`);
  try {
    const fetched = await fetchLyrics({
      title: info.title,
      artist: info.artist,
      fileName: info.fileName,
      audioDuration: audio.duration,
    });
    if (trackId !== activeTrackId) return false;
    if (fetched && fetched.lyrics.length > 2) {
      setLyricsState(fetched.lyrics, !!fetched.source?.includes("synced"));
      const meta = fetched.meta;
      updateLyricsStatus(
        meta.artist ? `${meta.artist} — ${meta.title}` : meta.title,
      );
      return true;
    }
  } catch (error) {
    console.warn("Lyrics fetch failed:", error);
  }
  return false;
}

async function loadLocalAudio(file, lyricFile = null) {
  const trackId = ++activeTrackId;
  clearAllTextCaches();
  setLyricsState(EMPTY_LYRICS);
  updateLyricsStatus("Loading audio...");

  let tags = { title: "", artist: "", lyrics: "" };
  try {
    tags = await readID3Tags(file);
  } catch (error) {
    console.warn("Tag read failed:", error);
  }
  if (trackId !== activeTrackId) return;

  const title = tags.title || stripExtension(file.name);
  const artist = tags.artist || "";
  nowPlaying.textContent = artist ? `${artist} — ${title}` : title;
  syncPlaybackControls();

  let loaded = false;
  try {
    loaded = await audio.loadFile(file);
  } catch (error) {
    console.warn("Audio decode failed:", error);
  }
  if (trackId !== activeTrackId) return;
  if (!loaded) {
    updateLyricsStatus("Unable to decode this audio file");
    syncPlaybackControls();
    return;
  }
  syncPlaybackControls();

  // A sidecar lyric file (selected/dropped alongside the audio) wins over both
  // embedded tags and the remote fetch.
  if (lyricFile) {
    await loadLyricsFromFile(lyricFile, trackId);
    return;
  }

  if (
    tags.lyrics &&
    applyLyricsInput(tags.lyrics, embeddedLyricFilename(tags.lyrics))
  )
    return;

  const fetched = await fetchLyricsFor(trackId, {
    title,
    artist,
    fileName: file.name,
  });
  if (!fetched && trackId === activeTrackId) {
    updateLyricsStatus("Audio ready, lyrics unavailable");
  }
}

async function loadLyricsFromFile(file, trackId = null) {
  try {
    const text = await file.text();
    // When loaded as a sidecar, bail if a newer track load has started.
    if (trackId !== null && trackId !== activeTrackId) return;
    if (!applyLyricsInput(text, file.name)) {
      updateLyricsStatus("Could not parse that lyrics file");
    }
  } catch (error) {
    console.warn("Lyrics file read failed:", error);
    updateLyricsStatus("Could not read that lyrics file");
  }
}

function routeFiles(fileList) {
  const files = Array.from(fileList || []);
  const audioFile = files.find(isAudioFile);
  const lyricFile = files.find(isLyricFile);
  if (audioFile) {
    loadLocalAudio(audioFile, lyricFile || null);
  } else if (lyricFile) {
    loadLyricsFromFile(lyricFile);
  } else if (files.length > 0) {
    updateLyricsStatus("Unsupported file. Use audio or .lrc/.txt");
  }
}

// One smart button: routeFiles sniffs audio vs .lrc/.txt and dispatches.
btnLoad.addEventListener("click", () => fileInput.click());

// ── Live audio capture (tab share OR system input device) ───────────────
function syncCaptureUI() {
  const on = audio.captureMode;
  btnCapture.setAttribute("aria-pressed", on ? "true" : "false");
  btnCapture.dataset.tip = on ? "Stop capture" : "Capture tab/system audio";
  // Capture is shown only as a faint top-left icon. The transport title is
  // reserved for real metadata (bridge track or loaded file), never overwritten
  // with "Live capture".
  captureIndicator.classList.toggle("active", on);
  // Capture owns the top-left; move the source link to the right so its label
  // has room to expand without colliding with the capture indicator.
  if (ghLink) ghLink.classList.toggle("shift-right", on);
}

function closeCapturePanel() {
  capturePanel.hidden = true;
  btnCapture.setAttribute("aria-expanded", "false");
}

// True when the page's Permissions-Policy forbids the microphone (e.g. the
// here.now host sends `microphone=()`). Then getUserMedia can't work at all and
// device enumeration is pointless — steer to tab-share or the local bridge.
function micPolicyBlocked() {
  try {
    const fp = document.featurePolicy;
    if (fp && typeof fp.allowsFeature === "function") {
      return !fp.allowsFeature("microphone");
    }
  } catch {}
  return false;
}

function reportCaptureError(err) {
  if (err && err.name === "NotAllowedError") {
    updateLyricsStatus(
      micPolicyBlocked()
        ? "This host blocks the mic — use tab share or the local bridge"
        : "Capture permission denied",
    );
  } else if (err && err.message === "NO_AUDIO") {
    updateLyricsStatus("No audio in that source — tick 'Share tab audio'");
  } else if (!window.isSecureContext) {
    updateLyricsStatus("Capture needs https or localhost");
  } else if (err && err.name === "NotFoundError") {
    updateLyricsStatus("That input device is unavailable");
  } else {
    updateLyricsStatus("Capture failed");
  }
}

// A device is a "system loopback" if it monitors an output sink. Linux
// PipeWire/Pulse expose these as "Monitor of …"; macOS uses BlackHole/Loopback;
// Windows uses Stereo Mix / VB-Cable. These carry native-app audio.
function isSystemLoopback(label) {
  return /monitor|loopback|stereo mix|blackhole|vb-?cable|cable output|what u hear/i.test(
    label || "",
  );
}

async function startCaptureSource(fn) {
  closeCapturePanel();
  btnCapture.disabled = true;
  try {
    await fn();
    if (!bridge.active) {
      updateLyricsStatus("Visualizing captured audio · lyrics off");
    }
  } catch (err) {
    reportCaptureError(err);
  } finally {
    btnCapture.disabled = false;
    syncCaptureUI();
  }
}

function makeCaptureItem({ title, sub, system, onClick }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cap-item" + (system ? " cap-system" : "");
  const t = document.createElement("span");
  t.textContent = title;
  btn.appendChild(t);
  if (sub) {
    const s = document.createElement("span");
    s.className = "cap-sub";
    s.textContent = sub;
    btn.appendChild(s);
  }
  btn.addEventListener("click", onClick);
  return btn;
}

async function openCapturePanel() {
  capList.replaceChildren();
  capHint.textContent = "";
  applySavedSize(capturePanel, "capturePanelSize");
  capturePanel.hidden = false;
  btnCapture.setAttribute("aria-expanded", "true");

  // Best path when the bridge is serving us on Linux: it taps the system
  // output monitor directly, so ALL native-app audio is captured regardless of
  // what the browser will or won't enumerate.
  if (bridge.active && bridge.audioStream) {
    capList.appendChild(
      makeCaptureItem({
        title: "System output (bridge)",
        sub: "all apps · monitor of default output",
        system: true,
        onClick: () => startCaptureSource(() => audio.startBridgeStream()),
      }),
    );
  }

  // Tab/window share is always available (browser tabs only on most setups).
  capList.appendChild(
    makeCaptureItem({
      title: "Browser tab / window",
      sub: "pick a surface · tick “Share tab audio”",
      onClick: () => startCaptureSource(() => audio.startCapture()),
    }),
  );

  // If the host blocks the microphone via Permissions-Policy, getUserMedia is
  // dead on arrival — don't offer it; explain the working alternatives instead.
  if (micPolicyBlocked()) {
    capHint.textContent = bridge.active
      ? "Mic blocked by host. Use “System output (bridge)” above for native-app audio."
      : "This host blocks microphone access, so input devices aren't available. Use “Browser tab / window” above, or run the local bridge (npm run bridge) for full system audio.";
    return;
  }

  // Listing input devices forces a mic-permission prompt and only surfaces
  // monitors the browser bothers to expose — so it's opt-in, not automatic.
  const moreBtn = makeCaptureItem({
    title: "Input devices…",
    sub: "monitors / line-in (needs mic permission)",
    onClick: async () => {
      moreBtn.remove();
      let devices = [];
      try {
        await audio.ensureInputPermission();
        devices = await audio.listInputDevices();
      } catch {
        capHint.textContent = "Microphone access denied — can't list devices.";
        return;
      }
      const loopbacks = devices.filter((d) => isSystemLoopback(d.label));
      const others = devices.filter((d) => !isSystemLoopback(d.label));
      for (const d of [...loopbacks, ...others]) {
        const system = isSystemLoopback(d.label);
        capList.appendChild(
          makeCaptureItem({
            title: d.label || (system ? "System monitor" : "Audio input"),
            sub: system ? "system audio · native apps" : "input device",
            system,
            onClick: () =>
              startCaptureSource(() => audio.startDeviceCapture(d.deviceId)),
          }),
        );
      }
      if (!loopbacks.length) {
        capHint.textContent =
          "No monitor exposed by the browser. Linux: use “System output (bridge)” above. macOS: install BlackHole. Windows: enable Stereo Mix / VB-Cable.";
      }
    },
  });
  capList.appendChild(moreBtn);
}

btnCapture.addEventListener("click", (e) => {
  e.stopPropagation();
  if (audio.captureMode) {
    audio.stopCapture();
    updateLyricsStatus("Capture stopped");
    closeCapturePanel();
    return;
  }
  if (capturePanel.hidden) openCapturePanel();
  else closeCapturePanel();
});

// Vocal Sync toggle: 🖊️ (default time-curve engine) ↔ 🎤 (onset-driven reveal).
function syncVocalSyncButton() {
  if (!btnVocalSync) return;
  btnVocalSync.setAttribute("aria-pressed", vocalSyncMode ? "true" : "false");
  const glyph = btnVocalSync.querySelector(".emoji-glyph");
  if (glyph) glyph.textContent = vocalSyncMode ? "🎤" : "🖊️";
  btnVocalSync.dataset.tip = vocalSyncMode
    ? "Vocal Sync ON — words pop on vocal onsets"
    : "Vocal Sync OFF — steady word reveal";
}
if (btnVocalSync) {
  syncVocalSyncButton();
  btnVocalSync.addEventListener("click", (e) => {
    e.stopPropagation();
    vocalSyncMode = !vocalSyncMode;
    try {
      localStorage.setItem("vocalSyncMode", vocalSyncMode ? "1" : "0");
    } catch {}
    // Drop stale onset bookkeeping so re-enabling starts clean on the next line.
    vocalEntryKey = null;
    vocalRevealCursor = 0;
    vocalPops.clear();
    syncVocalSyncButton();
    syncVocalSyncAvailability();
  });
}

capturePanel.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => closeCapturePanel());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !capturePanel.hidden) closeCapturePanel();
});

fileInput.addEventListener("change", (event) => {
  routeFiles(event.currentTarget.files);
  event.currentTarget.value = "";
});

// Drag-and-drop over the whole window. dragenter/dragover must call
// preventDefault or the browser navigates to the dropped file instead.
let dragDepth = 0;

function showDropOverlay(show) {
  dropOverlay.classList.toggle("active", show);
}

window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  showDropOverlay(true);
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropOverlay(false);
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  showDropOverlay(false);
  if (event.dataTransfer?.files?.length) routeFiles(event.dataTransfer.files);
});

// ── Pretext integration ────────────────────────────────────────────────
const preparedCache = new Map();
const segmentWidthCache = new Map();
const graphemeCache = new Map();
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const measureCanvas = document.createElement("canvas").getContext("2d");

function clearLocalTextCaches() {
  preparedCache.clear();
  segmentWidthCache.clear();
  graphemeCache.clear();
}

function clearAllTextCaches() {
  clearLocalTextCaches();
  clearPretextCache();
}

function detectLyricsLocale(entries) {
  const sample = entries
    .filter((entry) => entry.text)
    .slice(0, 8)
    .map((entry) => entry.text)
    .join(" ");

  if (!sample) return undefined;
  if (/[\u0E00-\u0E7F]/.test(sample)) return "th";
  if (/[\u3040-\u30FF]/.test(sample)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(sample)) return "ko";
  if (/[\u0600-\u06FF]/.test(sample)) return "ar";
  if (/[\u0590-\u05FF]/.test(sample)) return "he";
  if (/[\u0900-\u097F]/.test(sample)) return "hi";
  if (/[\u4E00-\u9FFF]/.test(sample)) return "zh";
  return undefined;
}

function syncPretextLocale(entries) {
  const nextLocale = detectLyricsLocale(entries);
  if (nextLocale === currentPretextLocale) return;
  currentPretextLocale = nextLocale;
  setPretextLocale(nextLocale);
  clearLocalTextCaches();
}

function getPrepared(text, font) {
  const key = text + "||" + font;
  if (preparedCache.has(key)) return preparedCache.get(key);
  const p = prepareWithSegments(text, font);
  preparedCache.set(key, p);
  return p;
}

function getGraphemes(text) {
  if (graphemeCache.has(text)) return graphemeCache.get(text);
  const graphemes = Array.from(
    graphemeSegmenter.segment(text),
    (item) => item.segment,
  );
  graphemeCache.set(text, graphemes);
  return graphemes;
}

function sliceSegmentText(text, startGrapheme = 0, endGrapheme) {
  if (
    startGrapheme === 0 &&
    (endGrapheme === undefined || endGrapheme >= getGraphemes(text).length)
  ) {
    return text;
  }
  return getGraphemes(text).slice(startGrapheme, endGrapheme).join("");
}

function measureSegment(text, font) {
  const key = text + "||" + font;
  if (segmentWidthCache.has(key)) return segmentWidthCache.get(key);
  if (text.trim() === "") {
    measureCanvas.font = font;
    const w = measureCanvas.measureText(text).width;
    segmentWidthCache.set(key, w);
    return w;
  }
  const p = getPrepared(text, font);
  const { lines } = layoutWithLines(p, 9999, 100);
  const w = lines.length > 0 ? lines[0].width : 0;
  segmentWidthCache.set(key, w);
  return w;
}

function getPreparedSliceWidth(
  prepared,
  segmentIndex,
  text,
  font,
  startGrapheme,
  endGrapheme,
) {
  const source = prepared.segments[segmentIndex];
  const graphemeCount = getGraphemes(source).length;
  const isFullSegment =
    startGrapheme === 0 &&
    (endGrapheme === undefined || endGrapheme >= graphemeCount);
  return isFullSegment
    ? (prepared.widths[segmentIndex] ?? measureSegment(text, font))
    : measureSegment(text, font);
}

function getLineTokens(prepared, line, font) {
  const tokens = [];
  const lastSegmentIndex =
    line.end.graphemeIndex === 0
      ? line.end.segmentIndex - 1
      : line.end.segmentIndex;

  for (
    let segmentIndex = line.start.segmentIndex;
    segmentIndex <= lastSegmentIndex;
    segmentIndex++
  ) {
    const source = prepared.segments[segmentIndex];
    if (source === undefined) continue;

    const startGrapheme =
      segmentIndex === line.start.segmentIndex ? line.start.graphemeIndex : 0;
    const endGrapheme =
      segmentIndex === line.end.segmentIndex
        ? line.end.graphemeIndex
        : undefined;
    const text = sliceSegmentText(source, startGrapheme, endGrapheme);
    if (!text) continue;

    tokens.push({
      text,
      isSpace: text.trim() === "",
      baseWidth: getPreparedSliceWidth(
        prepared,
        segmentIndex,
        text,
        font,
        startGrapheme,
        endGrapheme,
      ),
    });
  }

  return tokens;
}

function getBalancedWrapWidth(prepared, maxWidth, targetLineCount) {
  let low = 0;
  walkLineRanges(prepared, maxWidth, (line) => {
    low = Math.max(low, line.width);
  });

  if (targetLineCount <= 1) return low || maxWidth;

  let high = maxWidth;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const lineCount = walkLineRanges(prepared, mid, () => {});
    if (lineCount > targetLineCount) low = mid;
    else high = mid;
  }

  return high;
}

function layoutBalancedLines(prepared, maxWidth, lineHeight) {
  const base = layoutWithLines(prepared, maxWidth, lineHeight);
  if (base.lineCount <= 1) {
    return {
      lines: base.lines,
      lineCount: base.lineCount,
      width: base.lines[0]?.width || maxWidth,
    };
  }

  const width = getBalancedWrapWidth(prepared, maxWidth, base.lineCount);
  const balanced = layoutWithLines(prepared, width, lineHeight);
  return { lines: balanced.lines, lineCount: balanced.lineCount, width };
}

function getVariableLineWidth(baseWidth, lineIdx, lineCount) {
  if (lineCount <= 2) return baseWidth;
  const t = lineCount <= 1 ? 0.5 : lineIdx / (lineCount - 1);
  const centerBias = 1 - Math.abs(t * 2 - 1);
  const waist = Math.min(baseWidth * 0.14, 22 + lineCount * 6);
  return clamp(
    baseWidth - waist * centerBias * centerBias,
    baseWidth * 0.76,
    baseWidth,
  );
}

function layoutShapedLines(prepared, width, lineCount) {
  const lines = [];
  let cursor = { segmentIndex: 0, graphemeIndex: 0 };

  for (let lineIdx = 0; lineIdx < lineCount + 3; lineIdx++) {
    const nextLine = layoutNextLine(
      prepared,
      cursor,
      getVariableLineWidth(width, lineIdx, lineCount),
    );
    if (!nextLine) break;
    lines.push(nextLine);
    cursor = nextLine.end;
  }

  return lines;
}

function layoutActiveLyricLines(prepared, maxWidth, lineHeight) {
  const balanced = layoutBalancedLines(prepared, maxWidth, lineHeight);
  if (balanced.lineCount <= 1) return balanced;

  let shapedLines = layoutShapedLines(
    prepared,
    balanced.width,
    balanced.lineCount,
  );
  if (shapedLines.length === 0 || shapedLines.length > balanced.lineCount + 1)
    return balanced;

  if (shapedLines.length !== balanced.lineCount) {
    const rerun = layoutShapedLines(
      prepared,
      balanced.width,
      shapedLines.length,
    );
    if (rerun.length > 0 && rerun.length <= balanced.lineCount + 1) {
      shapedLines = rerun;
    }
  }

  return {
    lines: shapedLines,
    lineCount: shapedLines.length,
    width: balanced.width,
  };
}

// ── Color palettes ─────────────────────────────────────────────────────
const palettes = [
  ["#ff006e", "#fb5607", "#ffbe0b", "#8338ec", "#3a86ff"],
  ["#06d6a0", "#118ab2", "#073b4c", "#ef476f", "#ffd166"],
  ["#7400b8", "#6930c3", "#5390d9", "#4ea8de", "#48bfe3"],
  ["#f72585", "#b5179e", "#7209b7", "#560bad", "#480ca8"],
];

function getColor(palette, index, alpha = 1) {
  const c = palette[index % palette.length];
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function lerpColor(hex1, hex2, t) {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${b})`;
}

// ── Particle system ────────────────────────────────────────────────────
const particles = [];
const MAX_PARTICLES = 200;

function spawnParticles(x, y, count, metrics, hueBase) {
  for (let i = 0; i < count; i++) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 4 * (1 + metrics.bass * 2);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1,
      life: 1,
      decay: 0.006 + Math.random() * 0.012,
      size: 2 + Math.random() * 5 * (1 + metrics.treble),
      hue: (hueBase + Math.random() * 60) % 360,
    });
  }
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.015;
    p.vx *= 0.995;
    p.life -= p.decay;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 85%, 65%, ${p.life * 0.7})`;
    ctx.fill();
  }
}

// ── Background visualizations ──────────────────────────────────────────
function drawFrequencyBars(metrics, w, h, time) {
  const freq = metrics.frequencyData;
  const barCount = 64;
  const step = Math.floor(freq.length / barCount);
  const barWidth = w / barCount;
  const palette = palettes[Math.floor(time / 15) % palettes.length];

  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += freq[i * step + j];
    const avg = sum / (step * 255);
    const barH = avg * h * 0.4;

    const x = i * barWidth;
    const gradient = ctx.createLinearGradient(x, h, x, h - barH);
    gradient.addColorStop(0, getColor(palette, i, 0.6));
    gradient.addColorStop(1, getColor(palette, i, 0.05));
    ctx.fillStyle = gradient;
    ctx.fillRect(x, h - barH, barWidth - 1, barH);

    const mirrorGradient = ctx.createLinearGradient(x, 0, x, barH * 0.3);
    mirrorGradient.addColorStop(0, getColor(palette, i, 0.15));
    mirrorGradient.addColorStop(1, getColor(palette, i, 0));
    ctx.fillStyle = mirrorGradient;
    ctx.fillRect(x, 0, barWidth - 1, barH * 0.3);
  }
}

function drawWaveform(metrics, w, h, time) {
  const wave = metrics.waveformData;
  const palette = palettes[(Math.floor(time / 15) + 1) % palettes.length];

  ctx.beginPath();
  ctx.lineWidth = 2 + metrics.bass * 4;
  ctx.strokeStyle = getColor(palette, 0, 0.3 + metrics.rms * 0.5);

  const sliceWidth = w / wave.length;
  let x = 0;
  for (let i = 0; i < wave.length; i++) {
    const v = wave[i] / 128.0;
    const y = (v * h) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.stroke();
}

// Disabled: central blob + bass spike read as noise behind the lyrics.
// function drawCircularViz(metrics, w, h, time) {
//   const freq = metrics.frequencyData
//   const cx = w / 2
//   const cy = h / 2
//   const baseRadius = Math.min(w, h) * 0.15
//   const palette = palettes[(Math.floor(time / 15) + 2) % palettes.length]
//   const points = 128
//   const step = Math.floor(freq.length / points)
//
//   ctx.beginPath()
//   for (let i = 0; i <= points; i++) {
//     const idx = i % points
//     let sum = 0
//     for (let j = 0; j < step; j++) sum += freq[idx * step + j]
//     const avg = sum / (step * 255)
//     const angle = (idx / points) * Math.PI * 2 - Math.PI / 2
//     const radius = baseRadius + avg * baseRadius * 1.5 * (1 + metrics.bass * 0.5)
//     const x = cx + Math.cos(angle) * radius
//     const y = cy + Math.sin(angle) * radius
//     if (i === 0) ctx.moveTo(x, y)
//     else ctx.lineTo(x, y)
//   }
//   ctx.closePath()
//   ctx.strokeStyle = getColor(palette, 2, 0.4 + metrics.overall * 0.4)
//   ctx.lineWidth = 1.5 + metrics.treble * 3
//   ctx.stroke()
//
//   const pulseR = baseRadius * (0.6 + metrics.bass * 0.5)
//   const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, pulseR)
//   grd.addColorStop(0, getColor(palette, 3, 0.15 + metrics.overall * 0.15))
//   grd.addColorStop(1, getColor(palette, 3, 0))
//   ctx.fillStyle = grd
//   ctx.beginPath()
//   ctx.arc(cx, cy, pulseR, 0, Math.PI * 2)
//   ctx.fill()
// }

// ── Linebed (waterfall / Joy-Division-style) visualization ──────────────
// A scrolling stack of spectrum snapshots drawn in fake 3D perspective.
// Newest row enters far/top and scrolls toward near/bottom. Each row fills the
// area beneath its curve with the background colour before stroking, so nearer
// (lower) ridges occlude the rows behind them — the classic hidden-line look.
const LINEBED_ROWS = 80; // ridge count = vertical render resolution
const LINEBED_BG = "#0a0a0f";
const LINEBED_MAX_SAMPLES = 2048; // hard cap on committed rows (memory + pause)
// Committed (frozen) past rows, newest at index 0: { t, data: Float32Array }.
// Only the live front ridge is recomputed each frame; a snapshot is locked in
// here every linebedLockMs and then never changes — it just scrolls back by
// real elapsed time. So the present is fluid while the past holds still
// (no inter-row morphing/ghosting).
let linebedLocked = [];
let linebedAccum = 0; // seconds since the last committed row
let linebedClock = 0; // monotonic timeline seconds (sums dt)
let linebedPrevRow = null; // last pre-velocity baseline, for transient boost
let linebedPeak = null; // per-column held peaks (when linebedPeakHold)
const LINEBED_PEAK_FALL = 0.85; // peak sink rate per second (lower = longer hold)

// Spectrum layout: per-column frequency bands [fLoHz, fHiHz], rebuilt by
// buildLinebedBands() whenever a spectrum setting changes. Column count is
// linebedBands.length (no longer a fixed constant). Defaults reproduce the
// original chromatic C1→C8 layout (12 divisions/octave, ~32 Hz–4 kHz).
const LINEBED_SPECTRUM_DEFAULTS = {
  mode: "chromatic", // chromatic | log | linear | mel
  mag: "db", // db (perceptual) | linear (true amplitude)
  fMin: 32, // Hz
  fMax: 16000, // Hz — full audible span so treble detail shows by default
  divPerOctave: 12, // chromatic resolution (12 = semitones; higher = microtonal)
  cols: 84, // column count for log/linear/mel modes
  blend: 0.72, // per-band peak↔average mix (1 = peak only, 0 = average only)
};
const LINEBED_SPECTRUM_LIMITS = { fLo: 20, fHi: 26000, colsMax: 240 };
let linebedSpectrum = { ...LINEBED_SPECTRUM_DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem("linebedSpectrum") || "null");
  if (saved && typeof saved === "object") {
    linebedSpectrum = { ...LINEBED_SPECTRUM_DEFAULTS, ...saved };
  }
} catch {}
let linebedBands = [];

function melOf(f) {
  return 2595 * Math.log10(1 + f / 700);
}
function melInv(m) {
  return 700 * (Math.pow(10, m / 2595) - 1);
}

// Recompute the per-column [fLo, fHi] band table from linebedSpectrum, and
// reset the scroll history (column count / mapping has changed).
function buildLinebedBands() {
  const s = linebedSpectrum;
  const fMin = Math.max(LINEBED_SPECTRUM_LIMITS.fLo, Math.min(s.fMin, s.fMax - 1));
  const fMax = Math.min(LINEBED_SPECTRUM_LIMITS.fHi, Math.max(s.fMax, fMin + 1));
  const bands = [];
  if (s.mode === "chromatic") {
    const div = Math.max(1, Math.round(s.divPerOctave));
    const ratio = Math.pow(2, 1 / div); // width of one division
    const halfLo = Math.pow(2, -0.5 / div);
    const halfHi = Math.pow(2, 0.5 / div);
    const steps = Math.min(
      LINEBED_SPECTRUM_LIMITS.colsMax,
      Math.floor(Math.log2(fMax / fMin) * div) + 1,
    );
    let fc = fMin;
    for (let k = 0; k < steps; k++) {
      bands.push([fc * halfLo, fc * halfHi]);
      fc *= ratio;
    }
  } else {
    const n = Math.min(LINEBED_SPECTRUM_LIMITS.colsMax, Math.max(8, Math.round(s.cols)));
    for (let k = 0; k < n; k++) {
      let lo, hi;
      if (s.mode === "linear") {
        lo = fMin + ((fMax - fMin) * k) / n;
        hi = fMin + ((fMax - fMin) * (k + 1)) / n;
      } else if (s.mode === "mel") {
        const mLo = melOf(fMin),
          mHi = melOf(fMax);
        lo = melInv(mLo + ((mHi - mLo) * k) / n);
        hi = melInv(mLo + ((mHi - mLo) * (k + 1)) / n);
      } else {
        // log
        const r = fMax / fMin;
        lo = fMin * Math.pow(r, k / n);
        hi = fMin * Math.pow(r, (k + 1) / n);
      }
      bands.push([lo, hi]);
    }
  }
  linebedBands = bands;
  linebedLocked.length = 0;
  linebedPrevRow = null;
  linebedPeak = null;
}
buildLinebedBands();

// Compute one spectrum ridge from the current audio frame. Returns a fresh
// Float32Array (no storage) — the caller decides whether to draw it live or
// freeze it into the committed history.
function computeLinebedRow(metrics, params, dt) {
  const bands = linebedBands;
  const cols = bands.length;
  const sr = metrics.sampleRate || 44100;
  const linear = linebedSpectrum.mag === "linear";
  // dB source for linear amplitude, byte (0-255, perceptual) otherwise.
  const freq = linear ? audio.getFloatFrequencyData() : metrics.frequencyData;
  const binFreq = freq.length > 0 ? sr / 2 / freq.length : 1;
  // Normalize each bin to 0..1 up front so peak/avg aggregate cleanly.
  const maxDb = audio.analyser ? audio.analyser.maxDecibels : -30;
  const minDb = audio.analyser ? audio.analyser.minDecibels : -100;
  const norm = (i) => {
    if (!linear) return freq[i] / 255;
    const d = freq[i];
    if (!Number.isFinite(d) || d <= minDb) return 0;
    return Math.min(1, Math.pow(10, (d - maxDb) / 20)); // linear amp vs full scale
  };
  const blend = linebedSpectrum.blend;
  const gate = params.gate;
  const gamma = params.contrast;
  const velocity = params.velocity;
  const base = new Float32Array(cols); // post-gate/gamma, pre-velocity
  const row = new Float32Array(cols); // what we store/draw

  for (let c = 0; c < cols; c++) {
    const fLo = bands[c][0];
    const fHi = bands[c][1];
    let lo = Math.floor(fLo / binFreq);
    let hi = Math.ceil(fHi / binFreq);
    lo = Math.max(0, Math.min(lo, freq.length - 1));
    hi = Math.max(lo + 1, Math.min(hi, freq.length));

    let peak = 0;
    let sum = 0;
    for (let i = lo; i < hi; i++) {
      const v = norm(i);
      sum += v;
      if (v > peak) peak = v;
    }
    // Blend the dominant bin (intonation reads) with the band average (body).
    let val = peak * blend + (sum / (hi - lo)) * (1 - blend);
    // Gate: lift the noise floor away so quiet passages read as flat silence
    // instead of constant sea-wave ripple.
    if (gate > 0) val = val > gate ? (val - gate) / (1 - gate) : 0;
    // Contrast: gamma separates loud from quiet (>1 spikes dynamics).
    base[c] = Math.min(1, Math.pow(val, gamma));
  }

  for (let c = 0; c < cols; c++) {
    let v = base[c];
    // Velocity: a column rising vs the previous snapshot punches taller, so
    // attacks and onsets are visible rather than smoothed away.
    if (velocity > 0 && linebedPrevRow) {
      const d = base[c] - linebedPrevRow[c];
      if (d > 0) v = Math.min(1, v + d * velocity * 1.6);
    }
    row[c] = v;
  }
  linebedPrevRow = base;

  // Peak hold: each column snaps up to a new peak instantly but only sinks
  // back at a fixed rate, so peaks "lock" in place instead of flickering.
  if (linebedPeakHold) {
    if (!linebedPeak || linebedPeak.length !== cols) linebedPeak = new Float32Array(cols);
    const fall = LINEBED_PEAK_FALL * (dt > 0 ? dt : 0.016);
    for (let c = 0; c < cols; c++) {
      const held = linebedPeak[c] - fall;
      const nv = row[c] > held ? row[c] : held > 0 ? held : 0;
      linebedPeak[c] = nv;
      row[c] = nv;
    }
  }
  return row;
}

// Depth fraction (0 = front/present, 1 = deepest) → seconds into the past.
// log packs recent history near the front (a fluid present) and compresses the
// distant past; linear spaces time evenly across the stack.
const LINEBED_FLOW_BASE = Math.exp(2.2); // log curve strength
function linebedCurve(p) {
  if (linebedFlow === "linear") return p;
  return (Math.pow(LINEBED_FLOW_BASE, p) - 1) / (LINEBED_FLOW_BASE - 1);
}

// Per-frame perspective constants shared by every ridge.
function linebedGeometry(w, h, params) {
  const shellH = transportShell ? transportShell.offsetHeight : 0;
  // Keep the front rows clear of the transport (its height + offset + gap).
  const reserved = shellH > 0 ? shellH + 28 + 20 : 0;
  return {
    cx: w / 2,
    yFar: h * 0.12,
    yNear: Math.min(h * 1.0, h - reserved),
    wNear: w * 1.12, // bleed past the edges so the front fills the screen
    wFar: w * 0.52,
    ampNear: h * 0.17 * params.amplitude,
    ampFar: h * 0.085 * params.amplitude,
    // Thinner ridges on narrow/mobile screens so lines don't read as heavy.
    lineScale: w >= 900 ? 1 : w <= 420 ? 0.6 : 0.6 + ((w - 420) / 480) * 0.4,
  };
}

// Draw a single ridge at depth d (0 = front/near, 1 = far). Fills beneath the
// curve to occlude rows behind, then strokes it brighter/thicker when nearer.
function drawLinebedRidge(g, data, d, h) {
  const yBase = g.yNear + (g.yFar - g.yNear) * d;
  const rowW = g.wNear + (g.wFar - g.wNear) * d;
  const amp = g.ampNear + (g.ampFar - g.ampNear) * d;
  const left = g.cx - rowW / 2;
  const n = data.length;
  const colStep = rowW / Math.max(1, n - 1);
  const trace = () => {
    for (let c = 0; c < n; c++) {
      const x = left + c * colStep;
      const y = yBase - data[c] * amp;
      if (c === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  };
  ctx.beginPath();
  trace();
  ctx.lineTo(left + rowW, h);
  ctx.lineTo(left, h);
  ctx.closePath();
  ctx.fillStyle = LINEBED_BG;
  ctx.fill();

  const nearness = 1 - d;
  ctx.beginPath();
  trace();
  ctx.strokeStyle = `rgba(234, 238, 247, ${0.16 + nearness * 0.66})`;
  ctx.lineWidth = (1 + nearness * 0.7) * g.lineScale;
  ctx.stroke();
}

function drawLinebed(metrics, w, h, time, dt) {
  const params = getLinebedParams();
  linebedClock += Math.max(0, dt);
  const g = linebedGeometry(w, h, params);
  const flip = params.flip !== false; // true = present sits near/bottom
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * linebedOpacity;

  if (linebedFlow === "original") {
    // Original behaviour: a fixed stack of LINEBED_ROWS rows pushed at a steady
    // cadence and placed by index (no live front, no time curve).
    const stepInterval = linebedDuration / LINEBED_ROWS;
    if (dt > 0) linebedAccum += dt;
    let pushed = 0;
    while (linebedAccum >= stepInterval && pushed < 8) {
      linebedLocked.unshift({ t: linebedClock, data: computeLinebedRow(metrics, params, dt) });
      linebedAccum -= stepInterval;
      pushed++;
    }
    if (linebedLocked.length === 0)
      linebedLocked.unshift({ t: linebedClock, data: computeLinebedRow(metrics, params, dt) });
    if (linebedLocked.length > LINEBED_ROWS) linebedLocked.length = LINEBED_ROWS;
    const rows = linebedLocked.length;
    for (let k = 0; k < rows; k++) {
      const i = flip ? rows - 1 - k : k; // oldest→newest draw order
      const d = rows <= 1 ? 1 : flip ? i / (rows - 1) : 1 - i / (rows - 1);
      drawLinebedRidge(g, linebedLocked[i].data, d, h);
    }
    ctx.globalAlpha = prevAlpha;
    return;
  }

  // Locked modes (log / linear): the live front ridge is recomputed every
  // frame (fluid present); a snapshot is frozen into the history every
  // linebedLockMs and only ever scrolls back by real elapsed time.
  const live = computeLinebedRow(metrics, params, dt);
  const lockSec = Math.max(0.005, linebedLockMs / 1000);
  if (dt > 0) linebedAccum += dt;
  let committed = 0;
  while (linebedAccum >= lockSec && committed < 32) {
    linebedLocked.unshift({ t: linebedClock, data: live });
    linebedAccum -= lockSec;
    committed++;
  }
  // Trim rows past the visible span; cap the count for memory/pause safety.
  const maxAge = linebedDuration + 0.5;
  while (
    linebedLocked.length > 1 &&
    (linebedClock - linebedLocked[linebedLocked.length - 1].t > maxAge ||
      linebedLocked.length > LINEBED_MAX_SAMPLES)
  )
    linebedLocked.pop();

  // Draw far→near so nearer fills occlude the rows behind: oldest committed
  // first, then the live present ridge on top.
  for (let j = linebedLocked.length - 1; j >= 0; j--) {
    const timeAgo = linebedClock - linebedLocked[j].t;
    if (timeAgo > linebedDuration) continue;
    const sc = linebedCurve(Math.min(1, timeAgo / linebedDuration));
    drawLinebedRidge(g, linebedLocked[j].data, flip ? sc : 1 - sc, h);
  }
  drawLinebedRidge(g, live, flip ? 0 : 1, h);
  ctx.globalAlpha = prevAlpha;
}

// ── Per-word/per-char lyrics rendering with real-time audio mapping ─────
let prevLyricText = "";
let lyricRevealT = 0;
let lyricTransitionT = 0; // tracks how long current lyric has been active
let prevLyricFade = { text: "", alpha: 1, y: 0 };

let currentMotionMode = "drift";
let motionModeHold = 0;

function updateMotionMode(metrics, dt) {
  motionModeHold = Math.max(0, motionModeHold - dt);

  let nextMode = "drift";
  if (beat.surge > 0.28 || beat.bassBeat > 0.65) nextMode = "surge";
  else if (beat.pressure > 0.42 && metrics.bass > 0.18) nextMode = "pressure";
  else if (beat.release > 0.22) nextMode = "release";
  else if (beat.trebleShimmer > 0.22 || beat.trebleBeat > 0.3)
    nextMode = "shimmer";

  if (motionModeHold <= 0 || nextMode === currentMotionMode) {
    if (nextMode !== currentMotionMode) {
      currentMotionMode = nextMode;
      motionModeHold = nextMode === "drift" ? 0.06 : 0.18;
    } else if (nextMode !== "drift") {
      motionModeHold = Math.max(motionModeHold, 0.08);
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function springOut(t) {
  const clamped = clamp(t, 0, 1);
  const overshoot = 1.70158;
  const x = clamped - 1;
  return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
}

function getMotionBias(mode) {
  switch (mode) {
    case "surge":
      return {
        spread: 1.22,
        compression: 0.82,
        release: 0.72,
        shimmer: 0.85,
        curve: 1.05,
      };
    case "pressure":
      return {
        spread: 0.8,
        compression: 1.25,
        release: 0.78,
        shimmer: 0.72,
        curve: 0.9,
      };
    case "release":
      return {
        spread: 0.82,
        compression: 0.86,
        release: 1.28,
        shimmer: 0.78,
        curve: 0.95,
      };
    case "shimmer":
      return {
        spread: 0.88,
        compression: 0.82,
        release: 0.82,
        shimmer: 1.35,
        curve: 1.08,
      };
    default:
      return { spread: 1, compression: 1, release: 1, shimmer: 1, curve: 1 };
  }
}

// Per-token beat reaction. Returns extra transforms layered on top of the
// entrance/motion state at draw time, selected by `beatEffect`. "split" is the
// original contour push (handled inline in the draw loop), so it returns zeros
// here. Everything else is a distinct, exaggerated hit-driven move.
function getBeatTransform(state, tokenIdx, time) {
  const m = lyricMotion;
  const e = state.energy;
  const hit = beat.impact; // sharp broadband transient, 0..1
  const bass = beat.bassBeat; // low-end kick, 0..1
  switch (beatEffect) {
    case "pump":
      // Big uniform punch-in on the hit (also rides the stronger global beatPump).
      return { dx: 0, dy: 0, rot: 0, sx: hit * 0.22 * m, sy: hit * 0.22 * m, glow: hit * 12 };
    case "shake": {
      const amp = (bass * 0.8 + hit * 0.6) * (10 + e * 12) * m;
      return {
        dx: (Math.random() - 0.5) * 2 * amp,
        dy: (Math.random() - 0.5) * 1.6 * amp,
        rot: (Math.random() - 0.5) * 0.12 * (bass + hit) * m,
        sx: 0,
        sy: 0,
        glow: hit * 8,
      };
    }
    case "bounce": {
      // Staggered upward hop riding the kick — a wave travels across the line.
      const stagger = Math.max(0, Math.sin(time * 9 - tokenIdx * 0.7));
      const hop = (bass * 0.9 + hit * 0.4) * (26 + e * 26) * m * stagger;
      return { dx: 0, dy: -hop, rot: 0, sx: 0, sy: hop * 0.006, glow: bass * 7 };
    }
    case "swing": {
      const dir = tokenIdx % 2 === 0 ? 1 : -1;
      return { dx: 0, dy: 0, rot: dir * (bass * 0.32 + hit * 0.24) * m, sx: 0, sy: 0, glow: hit * 5 };
    }
    case "jelly": {
      // Squash & stretch — widen and flatten on the hit, settle back.
      const sq = (bass * 0.7 + hit * 0.6) * m;
      return { dx: 0, dy: 0, rot: 0, sx: sq * 0.5, sy: -sq * 0.36, glow: hit * 6 };
    }
    case "flash": {
      // Stays mostly still; the beat reads as a sharp brightness burst. `bright`
      // drives an additive white overdraw in the draw loop.
      const f = clamp(hit * 1.1 + bass * 0.5, 0, 1);
      return {
        dx: 0,
        dy: 0,
        rot: 0,
        sx: f * 0.08,
        sy: f * 0.08,
        glow: hit * 30 + e * 8,
        bright: f,
      };
    }
    default:
      return { dx: 0, dy: 0, rot: 0, sx: 0, sy: 0, glow: 0, bright: 0 };
  }
}

function getWordMotionState({
  wordIdx,
  totalWords,
  lineIdx,
  metrics,
  time,
  wordEnergy,
  reveal,
}) {
  const position = totalWords <= 1 ? 0 : (wordIdx / (totalWords - 1)) * 2 - 1;
  const edgeBias = Math.abs(position);
  const bias = getMotionBias(currentMotionMode);

  const spread = clamp(
    (metrics.bass * 0.45 + beat.surge * 0.95 + beat.bassBeat * 0.4) *
      bias.spread,
    0,
    1.25,
  );
  const compression = clamp(
    (beat.pressure * 0.9 + metrics.overall * 0.18) * bias.compression,
    0,
    1.15,
  );
  const release = clamp(beat.release * bias.release, 0, 1.15);
  const shimmer = clamp(
    (metrics.treble * 0.35 +
      beat.trebleShimmer * 0.95 +
      beat.trebleBeat * 0.35) *
      bias.shimmer,
    0,
    1.2,
  );
  const curve = clamp(
    (metrics.mid * 0.5 + beat.midBeat * 0.45) * bias.curve,
    0,
    1,
  );

  const lineArc = -curve * (1 - position * position) * 12;
  const offsetY =
    lineArc -
    spread * (7 + wordEnergy * 10) +
    release * (8 + edgeBias * 10) +
    Math.sin(time * 3.0 + wordIdx * 0.9 + lineIdx * 0.45) * shimmer * 2.2;
  const offsetX =
    Math.sin(time * 1.8 + wordIdx * 0.55 + lineIdx * 0.2) * shimmer * 1.0;

  const scaleX = clamp(
    1 +
      spread * (0.09 + edgeBias * 0.16) -
      compression * (0.05 + (1 - edgeBias) * 0.04) +
      shimmer * 0.03,
    0.9,
    1.35,
  );
  const scaleY = clamp(
    1 -
      spread * 0.04 +
      compression * (0.09 + (1 - edgeBias) * 0.05) +
      release * 0.08,
    0.9,
    1.32,
  );

  const rotation =
    position * (spread * 0.04 - release * 0.03) +
    Math.sin(time * 2.2 + wordIdx) * shimmer * 0.012;
  const alpha =
    reveal * clamp(0.84 + beat.impact * 0.16 + shimmer * 0.06, 0, 1);
  const glow = 6 + beat.impact * 10 + shimmer * 12 + wordEnergy * 6;
  const layoutPadding =
    4 + beat.impact * 4 + shimmer * 3 + Math.abs(rotation) * 28;
  const charMode =
    (shimmer > 0.25 || (beat.impact > 0.45 && wordEnergy > 0.25)) &&
    reveal > 0.55;

  return {
    spread,
    compression,
    release,
    shimmer,
    offsetX,
    offsetY,
    scaleX,
    scaleY,
    rotation,
    alpha,
    glow,
    layoutPadding,
    charMode,
  };
}

function getContourSample({
  t,
  lineIdx,
  lineCount,
  totalWidth,
  metrics,
  time,
}) {
  const clampedT = clamp(t, 0, 1);
  const archAmplitude = 10 + metrics.bass * 20 + beat.pressure * 14;
  const waveAmplitude = 4 + metrics.mid * 10 + beat.surge * 14;
  const rippleAmplitude = metrics.treble * 3 + beat.trebleShimmer * 6;
  const lineBias = lineCount <= 1 ? 0 : (lineIdx / (lineCount - 1) - 0.5) * 10;

  const sampleY = (progress) => {
    const p = clamp(progress, 0, 1);
    const arch = -Math.sin(p * Math.PI) * archAmplitude;
    const wave =
      Math.sin(
        p * Math.PI * (1.6 + metrics.mid * 1.8) + time * 3.4 + lineIdx * 0.65,
      ) * waveAmplitude;
    const ripple =
      Math.sin(p * Math.PI * 9 + time * 8.4 + lineIdx * 1.2) * rippleAmplitude;
    const sway = Math.sin(time * 1.6 + lineIdx * 0.7) * lineBias;
    // arch is the static silhouette; the time-varying parts scale with the
    // user's lyric-motion setting (0 = calm, readable).
    return arch + (wave + ripple + sway) * lyricMotion;
  };

  const deltaT = clamp(18 / Math.max(totalWidth, 1), 0.008, 0.03);
  const leftT = Math.max(0, clampedT - deltaT);
  const rightT = Math.min(1, clampedT + deltaT);
  const y = sampleY(clampedT);
  const leftY = sampleY(leftT);
  const rightY = sampleY(rightT);
  const dx = Math.max((rightT - leftT) * totalWidth, 1);
  const angle = Math.atan2(rightY - leftY, dx);

  return {
    y,
    angle,
    tangentX: Math.cos(angle),
    tangentY: Math.sin(angle),
    normalX: -Math.sin(angle),
    normalY: Math.cos(angle),
  };
}

function drawLyrics(metrics, w, h, time) {
  const currentTime = getLyricTime();
  const lyric = getCurrentLyric(lyrics, currentTime);
  const progress = getLyricProgress(lyrics, currentTime);

  if (!lyric.text) {
    prevLyricText = "";
    return;
  }

  // Track lyric transitions
  if (lyric.text !== prevLyricText) {
    // Store previous for crossfade
    if (prevLyricText) {
      prevLyricFade = { text: prevLyricText, alpha: 1, y: 0 };
    }
    prevLyricText = lyric.text;
    lyricRevealT = 0;
    lyricTransitionT = 0;
  }
  lyricRevealT = Math.min(1, lyricRevealT + 0.03);
  lyricTransitionT += 1 / 60;

  const palette = palettes[Math.floor(time / 15) % palettes.length];

  // LAYOUT font size is frozen — it carries NO beat pump. Line breaking is a
  // pure function of (text, font size, maxWidth), so a beat-pulsed size used to
  // re-wrap every frame and flip words between lines near a wrap boundary
  // (the jitter/seizure bug). The pump is reintroduced below as a purely visual
  // scale that never touches layout, so breaks stay locked for the whole line.
  const fontDef = LYRIC_FONTS[lyricFontKey] || LYRIC_FONTS.sans;
  const baseFontSize = Math.min(w, h) * 0.06 * lyricFontScale;
  const emphasisScale = lyric.emphasis ? 1.2 : 1;
  const fontSize = Math.round(baseFontSize * emphasisScale);
  const weight = lyric.emphasis ? fontDef.emphasisWeight : fontDef.weight;
  // Some custom faces are italic-only (e.g. Molle); fontDef.style carries that
  // so the canvas request matches the loaded @font-face instead of falling back.
  const styPrefix = fontDef.style ? fontDef.style + " " : "";
  const font = `${styPrefix}${weight} ${fontSize}px ${fontDef.family}`;
  const maxWidth = w * 0.66; // narrower wrap target → more side breathing room
  const lineHeight = fontSize * 1.5; // taller lines so wrapped lines don't crowd

  // Beat pump as a COMPRESSED visual scale (applied as an outer ctx transform,
  // never to the layout size). "pump" leans into it; "split" keeps the original
  // feel; other effects pump mildly so they own the motion themselves.
  const pumpGain =
    beatEffect === "pump" ? 0.36 : beatEffect === "split" ? 0.12 : 0.03;
  const rawPump =
    (beat.impact * pumpGain + beat.pressure * pumpGain * 0.6) * lyricMotion;
  // Soft-knee compressor: 1:1 up to the knee, then strongly diminishing, with a
  // hard ceiling. Keeps loud transients from inflating text past the margins.
  const knee = 0.06;
  const compressed =
    rawPump <= knee ? rawPump : knee + (rawPump - knee) / (1 + (rawPump - knee) * 7);
  const beatPump = 1 + Math.min(compressed, 0.16);

  // Beat "spread": on a hit the lines push apart vertically and words breathe
  // apart horizontally — applied as render offsets only (never layout), so the
  // line breaks stay locked. Capped so it opens up reasonably, not violently.
  const spreadBeat = clamp(
    (beat.impact * 0.6 + beat.pressure * 0.4) * lyricMotion,
    0,
    1,
  );
  const lineSpreadBeat = spreadBeat * 0.16; // extra inter-line gap (× lineHeight)
  const wordGapBeat = spreadBeat * fontSize * 0.22; // extra px between words

  // Use pretext for line layout
  const prepared = getPrepared(lyric.text, font);
  const { lines } = layoutActiveLyricLines(prepared, maxWidth, lineHeight);

  const totalTextHeight = lines.length * lineHeight;
  const verticalBias =
    -beat.surge * 18 - beat.pressure * 10 + beat.release * 12;
  const baseY = h / 2 - totalTextHeight / 2 + verticalBias;

  // Draw fading previous lyric (crossfade)
  if (prevLyricFade.text && prevLyricFade.alpha > 0) {
    prevLyricFade.alpha -= 0.04;
    prevLyricFade.y -= 1.5;
    const fadeFont = `400 ${Math.round(baseFontSize * 0.7)}px Inter`;
    const fadePrepared = getPrepared(prevLyricFade.text, fadeFont);
    const fadeLayout = layoutBalancedLines(
      fadePrepared,
      maxWidth,
      baseFontSize * 0.9,
    );
    ctx.save();
    ctx.globalAlpha = Math.max(0, prevLyricFade.alpha) * 0.4;
    ctx.font = fadeFont;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    for (let i = 0; i < fadeLayout.lines.length; i++) {
      const x = (w - fadeLayout.lines[i].width) / 2;
      ctx.fillText(
        fadeLayout.lines[i].text,
        x,
        baseY - 60 + prevLyricFade.y + i * baseFontSize * 0.9,
      );
    }
    ctx.restore();
  }

  const ease = (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  // Reveal progresses across every word of the active lyric, line after line,
  // so a multi-line entry surfaces linearly instead of all lines at once.
  let totalTokens = 0;
  for (const ln of lines) {
    totalTokens += getLineTokens(prepared, ln, font).filter(
      (token) => !token.isSpace,
    ).length;
  }
  let globalWordBase = 0;

  // ── Vocal Sync reveal engine ──
  // When 🎤 is on and lyrics carry real timestamps, words reveal on detected
  // vocal onsets — but bounded by guardrails so instruments / melisma / uneven
  // singing can't trigger words unnaturally. Everything is computed in "front"
  // units (the same space as the per-word phase math below): word i reveals once
  // the front passes ~i·0.92.
  const vocalSyncActive = vocalSyncMode && lyricsTimed && totalTokens > 0;
  const evenFront = warpLyricProgress(progress) * (totalTokens + 0.8);
  let vocalFront = 0;
  if (vocalSyncActive) {
    const entryKey = lyric.time;
    if (entryKey !== vocalEntryKey) {
      // New LRC line → hard resync: drop the cursor, ignore stale onsets, and
      // re-arm the per-line vocal-start gate.
      vocalEntryKey = entryKey;
      vocalRevealCursor = 0;
      vocalSeenOnsetId = vocalDetector.onsetId;
      vocalPops.clear();
      vocalStarted = false;
      vocalLineT0 = time;
    }

    // Start gate: hold the whole reveal until the singer is actually present, so
    // an instrumental intro under the first line can't creep words in. A grace
    // cap flips it on regardless, so a missed detection never stalls the line.
    if (vocalDetector.vocalPresent) vocalStarted = true;
    if (time - vocalLineT0 > VS_GRACE) vocalStarted = true;

    // Count onsets only after the line's vocals have started.
    const newOnsets = vocalDetector.onsetId - vocalSeenOnsetId;
    vocalSeenOnsetId = vocalDetector.onsetId;
    if (vocalStarted && newOnsets > 0) {
      vocalRevealCursor = Math.min(totalTokens, vocalRevealCursor + newOnsets);
      // Stamp the freshly-revealed word so it pops with this onset's energy.
      const idx = Math.min(vocalRevealCursor - 1, totalTokens - 1);
      if (idx >= 0) {
        vocalPops.set(idx, {
          t0: time,
          strength: vocalDetector.onset,
          band: vocalDetector.onsetBand,
        });
      }
    }

    const onsetFront = vocalRevealCursor * 0.92;
    // Even-clock fallback (only after vocals start): keeps words moving when
    // onsets are sparse, so nothing gets stuck.
    const fallbackFront = vocalStarted ? evenFront : 0;
    // Lead-cap: onsets may lead the even pace by at most vsLead words, so a fast
    // / melismatic half can't dump the whole line and starve the slow half.
    const leadFront = evenFront + vsLead * 0.92;
    const capped = Math.min(Math.max(onsetFront, fallbackFront), leadFront);
    // Back-loaded safety net: 0 until mid-line, ramps to full by the line's end,
    // guaranteeing completion without pacing mid-line.
    const backload = Math.pow(Math.max(0, (progress - 0.5) / 0.5), 1.5);
    const netFront = backload * (totalTokens + 0.8);
    vocalFront = Math.max(capped, netFront);
  }

  // Apply the compressed beat pump as a single uniform scale about the text
  // block centre. Because it wraps the whole render (and never the layout), the
  // text breathes on the beat while every line break stays exactly where it was.
  ctx.save();
  const pumpCx = w / 2;
  const pumpCy = baseY + totalTextHeight / 2;
  ctx.translate(pumpCx, pumpCy);
  ctx.scale(beatPump, beatPump);
  ctx.translate(-pumpCx, -pumpCy);

  // ── Per-word drop rendering with audio-reactive transforms ──
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const tokens = getLineTokens(prepared, line, font);
    const tokenCount = tokens.filter((token) => !token.isSpace).length;
    if (tokenCount === 0) continue;

    // Beat opens the inter-line gaps symmetrically about the block centre, so
    // the text stays centred while the lines push apart.
    const lineSpread =
      (lineIdx - (lines.length - 1) / 2) * lineHeight * lineSpreadBeat;
    const lineY = baseY + lineIdx * lineHeight + lineSpread;
    const lineDelay = lineIdx * 0.1;
    const lineReveal = ease(
      Math.max(0, Math.min(1, (lyricRevealT - lineDelay) * 2.5)),
    );
    const lineLift =
      -beat.surge * 28 +
      beat.release * 16 +
      Math.sin(time * 2.2 + lineIdx * 0.75) * metrics.mid * 7;
    const lineTilt =
      Math.sin(time * 1.8 + lineIdx * 0.7) * metrics.mid * 0.015 +
      (lineIdx % 2 === 0 ? 1 : -1) * beat.surge * 0.05;

    let seenWords = 0;
    const tokenStates = tokens.map((token) => {
      if (token.isSpace) {
        // Layout is frozen elsewhere, so a beat term here widens the gap between
        // words without ever changing the line breaks. Centring/fit absorb it.
        return { ...token, reserveWidth: token.baseWidth + wordGapBeat };
      }

      const wordIdx = seenWords++;
      const globalWordIdx = globalWordBase + wordIdx;
      // Vocal Sync: vocalFront already folds the even-clock fallback, lead-cap
      // and safety net into a single guardrailed front. 🖊️ default keeps the
      // plain even-clock reveal.
      const timingFront = vocalSyncActive ? vocalFront : evenFront;
      const phase = clamp(timingFront - globalWordIdx * 0.92, 0, 1);
      const settle = springOut(phase);
      const charFreq = beat.getCharFrequency(
        wordIdx,
        tokenCount,
        metrics.frequencyData,
      );
      const wordEnergy = clamp(
        charFreq * 0.45 + beat.getWordEnergy(wordIdx, tokenCount) * 0.55,
        0,
        1,
      );
      const motion = getWordMotionState({
        wordIdx,
        totalWords: tokenCount,
        lineIdx,
        metrics,
        time,
        wordEnergy,
        reveal: clamp(phase * 1.3, 0, 1) * (0.82 + lineReveal * 0.18),
      });

      const position =
        tokenCount <= 1 ? 0 : (wordIdx / (tokenCount - 1)) * 2 - 1;
      const edgeBias = Math.abs(position);
      let dropHeight =
        (1 - settle) * (78 + beat.surge * 56 + wordEnergy * 26 + edgeBias * 12);
      let bounce =
        beat.bassBeat * clamp(phase * 1.25, 0, 1) * (8 + wordEnergy * 10);
      // Effect shaping: only the default wordwave drops/bounces per word.
      // reveal = calm left-to-right wipe; fade = whole line eases in together;
      // rise = gentle upward slide; zoom = scale-in; cascade = alternating drop.
      let revealAlpha = clamp(phase * 1.35, 0, 1);
      let enterScale = 1;
      const calmFactor = lyricEffect === "wordwave" ? 1 : 0.35;
      if (lyricEffect !== "wordwave") {
        dropHeight = 0;
        bounce = 0;
      }
      if (lyricEffect === "fade") revealAlpha = clamp(lineReveal * 1.1, 0, 1);
      else if (lyricEffect === "rise") dropHeight = (1 - settle) * 44;
      else if (lyricEffect === "cascade")
        dropHeight = (1 - settle) * 52 * (wordIdx % 2 === 0 ? 1 : -1);
      else if (lyricEffect === "zoom")
        enterScale = 0.6 + clamp(phase * 1.3, 0, 1) * 0.4;
      const swingX =
        position *
        (motion.spread * (18 + edgeBias * 12) - motion.compression * 6);
      const rippleX =
        Math.sin(time * 3.0 + wordIdx * 0.8 + lineIdx * 0.35) *
        (motion.shimmer * 1.2 + wordEnergy * 0.8);
      // The per-beat scale pulse belongs to the "split" beat effect only — other
      // effects own the beat reaction themselves (see getBeatTransform), so it's
      // gated here to keep them visibly distinct.
      const beatSplit = beatEffect === "split" ? beat.splitPulse : 0;
      const scaleX =
        clamp(
          1 +
            (motion.spread * 0.1 + beatSplit * 0.08 + wordEnergy * 0.06) *
              lyricMotion,
          0.92,
          1.38,
        ) * enterScale;
      const scaleY =
        clamp(
          1 +
            ((1 - clamp(phase, 0, 1)) * 0.18 -
              beatSplit * 0.035 +
              motion.release * 0.05) *
              lyricMotion,
          0.9,
          1.34,
        ) * enterScale;
      const rotation =
        (motion.rotation * 1.2 +
          lineTilt * position +
          (1 - clamp(phase, 0, 1)) * position * 0.18 +
          Math.sin(time * 2 + wordIdx * 0.8) * motion.shimmer * 0.015) *
        lyricMotion *
        calmFactor;
      const offsetX =
        (motion.offsetX * 0.55 + swingX + rippleX) * lyricMotion * calmFactor;
      const offsetY =
        (lineLift + motion.offsetY * 0.5 - dropHeight + bounce) * lyricMotion;
      // Static reserve width (baseWidth + fixed pad) → stable line, no reflow.
      const reserveWidth = token.baseWidth + 14;

      // ── Vocal Sync pop layer ──
      // An onset-driven burst layered over the base transform: spring overshoot
      // + liquid wobble, scaled by onset strength and routed by sub-band (body =
      // heavy slam, sibilance = sharp glitch jitter). `vocalGlitch` flags the
      // RGB-split draw pass below. Decays over ~0.5s from the onset moment.
      let popScaleX = 0;
      let popScaleY = 0;
      let popOffX = 0;
      let popOffY = 0;
      let popRot = 0;
      let popGlow = 0;
      let vocalGlitch = 0;
      if (vocalSyncActive) {
        const pop = vocalPops.get(globalWordIdx);
        if (pop) {
          const env = Math.max(0, 1 - (time - pop.t0) / (vsPopDecayMs / 1000));
          if (env > 0) {
            const s = pop.strength * env * lyricMotion * vsPopIntensity;
            const sharp = pop.band === "sibilance";
            const heavy = pop.band === "body";
            const overshoot = springOut(1 - env); // ~1 at fire, eases out
            popScaleX += s * (heavy ? 0.5 : 0.32) * (0.4 + overshoot * 0.6);
            popScaleY += s * (heavy ? 0.55 : 0.3) * (0.4 + overshoot * 0.6);
            // Liquid stretch: taffy wobble sustained by the live vocal level.
            const wob =
              Math.sin(time * 22 + globalWordIdx) *
              s *
              (0.12 + vocalDetector.level * 0.5);
            popScaleX += wob;
            popScaleY -= wob * 0.8;
            // Glitch jitter: sharpest on sibilants.
            const jitter = sharp ? s : s * 0.35;
            popOffX += (Math.random() * 2 - 1) * jitter * (sharp ? 14 : 6);
            popOffY += (Math.random() * 2 - 1) * jitter * (sharp ? 10 : 4);
            popRot += (Math.random() * 2 - 1) * jitter * 0.12;
            popGlow += s * 18;
            vocalGlitch = sharp ? env * pop.strength * vsGlitch : 0;
          }
        }
      }

      return {
        ...token,
        wordIdx,
        charFreq,
        energy: wordEnergy,
        phase,
        settle,
        reserveWidth,
        scaleX: scaleX + popScaleX,
        scaleY: scaleY + popScaleY,
        offsetX: offsetX + popOffX,
        offsetY: offsetY + popOffY,
        rotation: rotation + popRot,
        alpha: revealAlpha * (0.84 + beat.impact * 0.16 * lyricMotion),
        glow: motion.glow + wordEnergy * 10 + popGlow,
        vocalGlitch,
        position,
      };
    });

    const totalTokenWidth = tokenStates.reduce(
      (sum, state) => sum + state.reserveWidth,
      0,
    );
    // Shrink-to-fit: keep the whole line inside a visible side margin so the
    // first/last words never run off-screen. Gutter ≈8%, capped at 10%.
    const margin = Math.min(w * 0.13, Math.max(28, w * 0.1));
    const safeWidth = w - margin * 2;
    const fit = totalTokenWidth > safeWidth ? safeWidth / totalTokenWidth : 1;
    const lineStartX = (w - totalTokenWidth * fit) / 2;
    let cursorX = lineStartX;

    for (let tokenIdx = 0; tokenIdx < tokenStates.length; tokenIdx++) {
      const state = tokenStates[tokenIdx];
      const tokenBaseX = cursorX + (state.reserveWidth * fit) / 2;
      const curveT =
        totalTokenWidth > 0
          ? (tokenBaseX - lineStartX) / (totalTokenWidth * fit)
          : 0.5;
      const contour = getContourSample({
        t: curveT,
        lineIdx,
        lineCount: lines.length,
        totalWidth: totalTokenWidth,
        metrics,
        time,
      });

      if (!state.isSpace) {
        // Selected beat reaction. `sp` keeps the original contour-split move
        // exclusive to the "split" effect; `bm` carries every other effect.
        const bm = getBeatTransform(state, tokenIdx, time);
        const sp = beatEffect === "split" ? beat.splitPulse : 0;
        const splitDirection =
          state.position === 0
            ? tokenIdx % 2 === 0
              ? -1
              : 1
            : Math.sign(state.position);
        const splitStrength =
          sp *
          (0.4 + state.energy * 0.9) *
          (0.55 + Math.abs(state.position) * 0.85) *
          lyricMotion;
        const splitNormal = splitStrength * (12 + state.energy * 18);
        const splitTangent =
          splitDirection * splitStrength * (10 + Math.abs(state.position) * 14);
        const drawX = clamp(
          tokenBaseX +
            (state.offsetX +
              bm.dx +
              contour.normalX * splitNormal +
              contour.tangentX * splitTangent) *
              fit,
          margin,
          w - margin,
        );
        const drawY =
          lineY +
          contour.y +
          state.offsetY +
          bm.dy +
          contour.normalY * splitNormal +
          contour.tangentY * splitTangent;
        const drawRotation =
          contour.angle * 0.88 +
          state.rotation +
          bm.rot +
          splitDirection * sp * 0.06 * lyricMotion;

        const colorIdx = (state.wordIdx + lineIdx * 2) % palette.length;
        const colorBase = palette[colorIdx];
        const colorNext = palette[(colorIdx + 1) % palette.length];
        const charColor = lyric.emphasis
          ? lerpColor(colorBase, colorNext, state.charFreq)
          : `rgba(255, 255, 255, ${state.alpha * (0.82 + state.charFreq * 0.3)})`;

        if (state.phase < 1) {
          ctx.save();
          ctx.globalAlpha = state.alpha * 0.16;
          ctx.font = font;
          ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(255,255,255,0.28)";
          ctx.fillText(
            state.text,
            tokenBaseX - state.baseWidth / 2,
            lineY + contour.y + fontSize / 2 - fontSize / 2,
          );
          ctx.restore();
        }

        ctx.save();
        ctx.translate(drawX, drawY + fontSize / 2);
        ctx.rotate(drawRotation);
        ctx.scale(
          state.scaleX + bm.sx + (sp * 0.12 + state.energy * 0.05) * lyricMotion,
          state.scaleY + bm.sy + (-sp * 0.04 + state.energy * 0.03) * lyricMotion,
        );
        ctx.globalAlpha = state.alpha;
        ctx.font = font;
        ctx.textBaseline = "top";
        ctx.shadowColor = lyric.emphasis ? colorBase : "rgba(255,255,255,0.52)";
        ctx.shadowBlur =
          state.glow + state.charFreq * 18 + sp * 10 + bm.glow;

        // Vocal Sync glitch: RGB-split ghosts behind the crisp word on sibilant
        // onsets, settling as the pop decays.
        if (state.vocalGlitch > 0.05) {
          const gx = state.vocalGlitch * 6;
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = state.alpha * state.vocalGlitch * 0.6;
          ctx.shadowBlur = 0;
          ctx.fillStyle = "rgba(255,0,80,0.9)";
          ctx.fillText(state.text, -state.baseWidth / 2 - gx, -fontSize / 2);
          ctx.fillStyle = "rgba(0,220,255,0.9)";
          ctx.fillText(state.text, -state.baseWidth / 2 + gx, -fontSize / 2);
          ctx.restore();
        }

        ctx.fillStyle = charColor;
        ctx.fillText(state.text, -state.baseWidth / 2, -fontSize / 2);

        // Flash effect: additive white burst on the beat, so the word visibly
        // lights up rather than just gaining a soft glow.
        const bright = bm.bright || 0;
        if (bright > 0.02) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = Math.min(1, bright) * state.alpha;
          ctx.shadowBlur = state.glow + bm.glow;
          ctx.shadowColor = "rgba(255,255,255,0.9)";
          ctx.fillStyle = "#ffffff";
          ctx.fillText(state.text, -state.baseWidth / 2, -fontSize / 2);
          ctx.restore();
        }

        if (lyric.emphasis && (state.energy > 0.45 || beat.surge > 0.35)) {
          ctx.shadowBlur *= 1.18 + beat.impact * 0.18;
          ctx.fillText(state.text, -state.baseWidth / 2, -fontSize / 2);
        }

        ctx.restore();

        if (state.energy > 0.62 && beat.impact > 0.35 && Math.random() > 0.88) {
          spawnParticles(
            drawX,
            drawY + fontSize / 2,
            1 + Math.round(beat.splitPulse * 1.5),
            metrics,
            (state.wordIdx * 48 + lineIdx * 55) % 360,
          );
        }
      }

      cursorX += state.reserveWidth * fit;
    }

    globalWordBase += tokenCount;
  }

  ctx.restore(); // pop the beat-pump scale
}

// ── Context lyrics ─────────────────────────────────────────────────────
function drawContextLyrics(metrics, w, h, time) {
  const currentTime = getLyricTime();
  const fontSize = Math.min(w, h) * 0.02;
  const font = `300 ${Math.round(fontSize)}px Inter`;
  const lineHeight = fontSize * 1.6;
  const palette = palettes[Math.floor(time / 15) % palettes.length];

  let currentIdx = 0;
  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].time) {
      currentIdx = i;
      break;
    }
  }

  const contextLines = [
    { offset: -1, alpha: 0.12 },
    { offset: 1, alpha: 0.2 },
    { offset: 2, alpha: 0.08 },
  ];

  const centerY = h / 2;

  for (const { offset, alpha } of contextLines) {
    const idx = currentIdx + offset;
    if (idx < 0 || idx >= lyrics.length) continue;
    const text = lyrics[idx].text;
    if (!text) continue;

    const prepared = getPrepared(text, font);
    const { lines } = layoutBalancedLines(prepared, w * 0.55, lineHeight);

    for (let i = 0; i < lines.length; i++) {
      const x = (w - lines[i].width) / 2;
      const yBase =
        centerY + offset * 55 + (offset < 0 ? -85 : 85) + i * lineHeight;

      // Subtle audio reactivity on context lines too
      const wobble =
        Math.sin(time * 1.5 + offset * 2) * metrics.mid * 3 * lyricMotion;

      ctx.save();
      ctx.globalAlpha = alpha + metrics.overall * 0.05;
      ctx.font = font;
      ctx.textBaseline = "top";
      ctx.fillStyle = getColor(palette, Math.abs(offset) + 2, alpha + 0.1);
      ctx.fillText(lines[i].text, x + wobble, yBase);
      ctx.restore();
    }
  }
}

// ── Main render loop ───────────────────────────────────────────────────
let startWallTime = null;
let fakeTime = 0;

function render(timestamp) {
  const dt = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : 1 / 60;
  lastTimestamp = timestamp;

  if (!startWallTime) startWallTime = timestamp;
  fakeTime = (timestamp - startWallTime) / 1000;

  const w = window.innerWidth;
  const h = window.innerHeight;

  // Clear. Linebed wants a crisp opaque frame (it repaints its own field);
  // the default viz uses a fading trail — more opaque on beats for sharper response.
  if (vizMode === "linebed") {
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, w, h);
  } else {
    const trailOpacity = 0.2 + beat.bassBeat * 0.15;
    ctx.fillStyle = `rgba(10, 10, 15, ${trailOpacity})`;
    ctx.fillRect(0, 0, w, h);
  }

  // Get audio metrics
  const metrics = audio.playing
    ? audio.getMetrics()
    : {
        bass: 0.15 + Math.sin(fakeTime * 0.8) * 0.1,
        mid: 0.1 + Math.sin(fakeTime * 1.2) * 0.08,
        treble: 0.08 + Math.sin(fakeTime * 1.7) * 0.06,
        overall: 0.12 + Math.sin(fakeTime) * 0.08,
        rms: 0.1,
        frequencyData: generateIdleFrequency(fakeTime),
        waveformData: generateIdleWaveform(fakeTime),
        sampleRate: audio.sampleRate,
      };

  // Update beat detector
  beat.update(metrics, dt);
  // Update vocal-onset detector (Vocal Sync mode). Skipped when off so the extra
  // analyser reads and flux math don't run needlessly.
  if (vocalSyncMode) {
    vocalDetector.update(
      audio.playing
        ? audio.getVocalMetrics()
        : { level: 0, flux: 0, body: 0, presence: 0, sibilance: 0 },
      dt,
    );
  }
  updateMotionMode(metrics, dt);

  // Beat flash overlay (skip under linebed to keep its lines crisp)
  if (vizMode !== "linebed" && beat.bassBeat > 0.3) {
    const palette = palettes[Math.floor(fakeTime / 15) % palettes.length];
    ctx.fillStyle = getColor(
      palette,
      beat.beatCount % palette.length,
      beat.bassBeat * 0.06,
    );
    ctx.fillRect(0, 0, w, h);
  }

  // Draw layers
  if (vizMode === "linebed") {
    drawLinebed(metrics, w, h, fakeTime, dt);
  } else {
    drawFrequencyBars(metrics, w, h, fakeTime);
    drawWaveform(metrics, w, h, fakeTime);
  }
  // Draw lyrics when we have a timeline: file playback, or the bridge feeding
  // a system track position. Pure capture (no bridge) has no timeline → skip.
  if (!audio.captureMode || bridge.active) {
    drawContextLyrics(metrics, w, h, fakeTime);
    drawLyrics(metrics, w, h, fakeTime);
  }
  updateParticles();
  drawParticles();
  syncProgressUI();

  animFrame = requestAnimationFrame(render);
}

function generateIdleFrequency(t) {
  const data = new Uint8Array(1024);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.max(
      0,
      Math.min(
        255,
        80 * Math.sin(i * 0.05 + t * 2) +
          40 * Math.sin(i * 0.02 + t * 0.7) +
          30 * Math.cos(i * 0.08 + t * 1.3) +
          60,
      ),
    );
  }
  return data;
}

function generateIdleWaveform(t) {
  const data = new Uint8Array(1024);
  for (let i = 0; i < data.length; i++) {
    data[i] =
      128 + 30 * Math.sin(i * 0.03 + t * 3) + 15 * Math.sin(i * 0.07 + t * 1.5);
  }
  return data;
}

function startLoop() {
  if (!animFrame) animFrame = requestAnimationFrame(render);
}

startLoop();
syncPlaybackControls();
updateLyricsStatus("Load an audio file to begin");

// ── Now-Playing bridge: system metadata + lrclib lyrics ─────────────────
function bridgeLabel(track) {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

function initBridge() {
  bridge.onTrack = (track) => {
    if (!track.title) return;
    const version = ++bridgeVersion;
    const label = bridgeLabel(track);
    nowPlaying.textContent = label;
    setLyricsState(EMPTY_LYRICS);

    // Embedded lyrics first: the player may expose xesam:asText (a loaded .lrc
    // or tag lyrics). Use them before hitting the network. Synced [mm:ss] text
    // parses as LRC; anything else is auto-timed plain text across the track.
    const embedded = (track.lyrics || "").trim();
    if (embedded) {
      const synced = /\[\d{1,3}:\d{2}/.test(embedded);
      const { lyrics: parsed } = parseLyricsFile(
        embedded,
        synced ? "embedded.lrc" : "embedded.txt",
        track.length || undefined,
      );
      if (parsed && parsed.filter((l) => l.text).length > 0) {
        setLyricsState(parsed, synced);
        const lines = parsed.filter((l) => l.text).length;
        updateLyricsStatus(
          `${label} · ${lines} lines (embedded${synced ? ", synced" : ""})`,
        );
        return;
      }
    }

    updateLyricsStatus(`${label} · fetching lyrics…`);
    fetchLyrics({
      title: track.title,
      artist: track.artist,
      album: track.album,
      audioDuration: track.length || undefined,
    })
      .then((fetched) => {
        if (version !== bridgeVersion) return; // track changed mid-fetch
        if (fetched && fetched.lyrics.length > 0) {
          setLyricsState(fetched.lyrics, !!fetched.source?.includes("synced"));
          const lines = fetched.lyrics.filter((l) => l.text).length;
          updateLyricsStatus(`${label} · ${lines} lines (lrclib)`);
        } else {
          updateLyricsStatus(`${label} · no lyrics found`);
        }
      })
      .catch(() => {
        if (version === bridgeVersion) {
          updateLyricsStatus(`${label} · lyrics fetch failed`);
        }
      });
  };
  // Every poll: refresh the transport buttons so they track the system
  // player's status even when it's play/paused outside the app.
  bridge.onUpdate = () => syncPlaybackControls();
  bridge.start().then((reachable) => {
    if (reachable && !bridge.track) {
      updateLyricsStatus("Bridge connected · waiting for a track…");
    }
  });
}

initBridge();
