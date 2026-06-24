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
import { getCurrentLyric, getLyricProgress } from "./lyrics.js";
import { parseLyricsFile } from "./lrc-parser.js";
import { fetchLyrics } from "./lyrics-fetch.js";
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
const bridge = new NowPlayingBridge();
let bridgeVersion = 0; // guards async lyric fetches against track changes
let lyrics = EMPTY_LYRICS;
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
const capturePanel = document.getElementById("capture-panel");
const capList = document.getElementById("cap-list");
const capHint = document.getElementById("cap-hint");
const btnMinimize = document.getElementById("btn-minimize");
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

function setLyricsState(nextLyrics) {
  lyrics = nextLyrics.length > 0 ? nextLyrics : EMPTY_LYRICS;
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
  setLyricsState(parsed);

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
      setLyricsState(fetched.lyrics);
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
const settingsPages = settingsPanel.querySelectorAll(".settings-page");
const vizModeBtns = settingsPanel.querySelectorAll(".viz-mode");
const lbInactiveHint = document.getElementById("lb-inactive-hint");

function syncVizPage() {
  vizModeBtns.forEach((b) =>
    b.setAttribute("aria-checked", b.dataset.viz === vizMode ? "true" : "false"),
  );
}

// Linebed params only affect the linebed visualizer; dim that page + flag its
// tab when another viz is active, but keep it reachable.
function syncLinebedAvailability() {
  const on = vizMode === "linebed";
  const tab = settingsPanel.querySelector('.settings-tab[data-page="linebed"]');
  const page = settingsPanel.querySelector('.settings-page[data-page="linebed"]');
  tab.dataset.inactive = on ? "false" : "true";
  page.classList.toggle("page-dim", !on);
  lbInactiveHint.hidden = on;
}

function showSettingsPage(page) {
  settingsTabs.forEach((t) =>
    t.setAttribute("aria-selected", t.dataset.page === page ? "true" : "false"),
  );
  settingsPages.forEach((p) => {
    p.hidden = p.dataset.page !== page;
  });
}

function openSettings(page) {
  syncVizPage();
  syncMotionPanel();
  syncLinebedPanel();
  syncLinebedAvailability();
  if (page) showSettingsPage(page);
  settingsPanel.hidden = false;
  btnSettings.setAttribute("aria-expanded", "true");
}

function closeSettings() {
  settingsPanel.hidden = true;
  btnSettings.setAttribute("aria-expanded", "false");
}

btnSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  if (settingsPanel.hidden) openSettings();
  else closeSettings();
});

settingsPanel.addEventListener("click", (e) => e.stopPropagation());
settingsTabs.forEach((t) =>
  t.addEventListener("click", () => showSettingsPage(t.dataset.page)),
);
document.addEventListener("click", () => closeSettings());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsPanel.hidden) closeSettings();
});

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
try {
  const p = localStorage.getItem("linebedPreset");
  if (p && (p === "smooth" || p === "dynamic" || p === "custom")) linebedPreset = p;
  const c = JSON.parse(localStorage.getItem("linebedCustom") || "null");
  if (c && typeof c === "object") linebedCustom = { ...LINEBED_CUSTOM_DEFAULT, ...c };
  const o = parseFloat(localStorage.getItem("linebedOpacity"));
  if (Number.isFinite(o)) linebedOpacity = Math.max(0, Math.min(1, o));
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
}

lbPresets.querySelectorAll(".lb-preset").forEach((b) => {
  b.addEventListener("click", () => {
    linebedPreset = b.dataset.preset;
    try { localStorage.setItem("linebedPreset", linebedPreset); } catch {}
    linebedHistory.length = 0; // restart so new dynamics apply at once
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

lbFlip.addEventListener("click", () => {
  adoptCustom();
  linebedCustom.flip = !(linebedCustom.flip !== false);
  try { localStorage.setItem("linebedCustom", JSON.stringify(linebedCustom)); } catch {}
  syncLinebedPanel();
});

// ── Lyrics styling + motion controls ────────────────────────────────────
// Font, size, effect, timing offset, and a global motion multiplier (0 = still
// text — accessibility). All persisted; the render loop reads them live.
const LYRIC_FONTS = {
  sans: { label: "Sans", family: "Inter", weight: 600, emphasisWeight: 800 },
  serif: { label: "Serif", family: '"Playfair Display"', weight: 600, emphasisWeight: 800 },
  cursive: { label: "Cursive", family: '"Dancing Script"', weight: 600, emphasisWeight: 700 },
  mono: { label: "Mono", family: '"Space Mono"', weight: 400, emphasisWeight: 700 },
};
const LYRIC_EFFECTS = ["wordwave", "reveal", "fade"];

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
let lyricFontKey = "sans";
let lyricEffect = "wordwave";
try {
  const f = localStorage.getItem("lyricFontKey");
  if (f && LYRIC_FONTS[f]) lyricFontKey = f;
  const e = localStorage.getItem("lyricEffect");
  if (e && LYRIC_EFFECTS.includes(e)) lyricEffect = e;
} catch {}

// Playback time the lyrics follow, with the user's sync offset applied.
function getLyricTime() {
  return getPlaybackTime() + lyricOffset;
}

const lmMotion = document.getElementById("lm-motion");
const lmLabel = document.getElementById("lm-label");
const lmFont = document.getElementById("lm-font");
const lmSize = document.getElementById("lm-size");
const lmSizeLabel = document.getElementById("lm-size-label");
const lmEffect = document.getElementById("lm-effect");
const lmOffset = document.getElementById("lm-offset");
const lmOffsetLabel = document.getElementById("lm-offset-label");

function syncMotionPanel() {
  lmMotion.value = lyricMotion;
  lmLabel.textContent = `Motion ${Math.round(lyricMotion * 100)}%`;
  lmFont.value = lyricFontKey;
  lmSize.value = lyricFontScale;
  lmSizeLabel.textContent = `Size ${Math.round(lyricFontScale * 100)}%`;
  lmEffect.value = lyricEffect;
  lmOffset.value = lyricOffset;
  lmOffsetLabel.textContent = `Offset ${lyricOffset > 0 ? "+" : ""}${lyricOffset.toFixed(1)}s`;
}

lmMotion.addEventListener("input", () => {
  lyricMotion = parseFloat(lmMotion.value);
  try { localStorage.setItem("lyricMotion", String(lyricMotion)); } catch {}
  syncMotionPanel();
});

lmFont.addEventListener("change", () => {
  if (LYRIC_FONTS[lmFont.value]) lyricFontKey = lmFont.value;
  try { localStorage.setItem("lyricFontKey", lyricFontKey); } catch {}
  clearLocalTextCaches(); // re-layout under the new face
  syncMotionPanel();
});

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

lmOffset.addEventListener("input", () => {
  lyricOffset = parseFloat(lmOffset.value);
  try { localStorage.setItem("lyricOffset", String(lyricOffset)); } catch {}
  syncMotionPanel();
});

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

seekBar.addEventListener("input", (event) => {
  if (audio.duration <= 0) return;
  const target = event.currentTarget;
  const progress = Number.parseFloat(target.value) / 1000;
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
      setLyricsState(fetched.lyrics);
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
const LINEBED_ROWS = 80;
// One column per semitone, C1 (MIDI 24) up. 84 = 7 octaves to C8.
const LINEBED_START_MIDI = 24;
const LINEBED_COLS = 84;
const LINEBED_BG = "#0a0a0f";
let linebedHistory = []; // newest at index 0; each entry a Float32Array(LINEBED_COLS)
let linebedAccum = 0;
let linebedPrevRow = null; // last pre-velocity baseline, for transient boost

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function pushLinebedRow(metrics, params) {
  const freq = metrics.frequencyData;
  const sr = metrics.sampleRate || 44100;
  const binFreq = sr / 2 / freq.length; // Hz per bin
  const gate = params.gate;
  const gamma = params.contrast;
  const velocity = params.velocity;
  const base = new Float32Array(LINEBED_COLS); // post-gate/gamma, pre-velocity
  const row = new Float32Array(LINEBED_COLS); // what we store/draw

  for (let c = 0; c < LINEBED_COLS; c++) {
    const midi = LINEBED_START_MIDI + c;
    // Gather the bins spanning this semitone's half-step-wide band.
    const fLo = midiToFreq(midi - 0.5);
    const fHi = midiToFreq(midi + 0.5);
    let lo = Math.floor(fLo / binFreq);
    let hi = Math.ceil(fHi / binFreq);
    lo = Math.max(0, Math.min(lo, freq.length - 1));
    hi = Math.max(lo + 1, Math.min(hi, freq.length));

    let peak = 0;
    let sum = 0;
    for (let i = lo; i < hi; i++) {
      const v = freq[i];
      sum += v;
      if (v > peak) peak = v;
    }
    // Peak-weighted: emphasise the dominant pitch so intonation reads, with a
    // little averaging for body.
    let val = (peak * 0.72 + (sum / (hi - lo)) * 0.28) / 255;
    // Gate: lift the noise floor away so quiet passages read as flat silence
    // instead of constant sea-wave ripple.
    if (gate > 0) val = val > gate ? (val - gate) / (1 - gate) : 0;
    // Contrast: gamma separates loud from quiet (>1 spikes dynamics).
    base[c] = Math.min(1, Math.pow(val, gamma));
  }

  for (let c = 0; c < LINEBED_COLS; c++) {
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

  linebedHistory.unshift(row);
  if (linebedHistory.length > LINEBED_ROWS)
    linebedHistory.length = LINEBED_ROWS;
}

function drawLinebed(metrics, w, h, time, dt) {
  const params = getLinebedParams();
  // Advance the scroll at a fixed cadence so it's frame-rate independent.
  linebedAccum += dt;
  const stepInterval = 1 / 50;
  let pushed = 0;
  while (linebedAccum >= stepInterval && pushed < 4) {
    pushLinebedRow(metrics, params);
    linebedAccum -= stepInterval;
    pushed++;
  }
  if (linebedHistory.length === 0) pushLinebedRow(metrics, params);

  const rows = linebedHistory.length;
  const cx = w / 2;
  // Keep the front rows clear of the transport. Reserve its measured height
  // (plus its bottom offset and a gap) so minimizing reclaims the space.
  const shellH = transportShell ? transportShell.offsetHeight : 0;
  const reserved = shellH > 0 ? shellH + 28 + 20 : 0;
  const yFar = h * 0.12;
  const yNear = Math.min(h * 1.0, h - reserved);
  const wNear = w * 1.12; // bleed past the edges so the front fills the screen
  const wFar = w * 0.52;
  const ampNear = h * 0.17 * params.amplitude;
  const ampFar = h * 0.085 * params.amplitude;
  // Thinner ridges on narrow/mobile screens — full-weight lines crowd the
  // smaller field and read as heavy. Taper down toward phones.
  const lineScale = w >= 900 ? 1 : w <= 420 ? 0.6 : 0.6 + ((w - 420) / 480) * 0.4;

  // Always draw far→near so nearer fills occlude the rows behind them.
  // flip = newest row sits near/bottom (the present moment is the front line);
  // otherwise newest enters far/top and scrolls down.
  const flip = params.flip !== false;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * linebedOpacity;
  for (let k = 0; k < rows; k++) {
    const i = flip ? rows - 1 - k : k; // history index, oldest→newest draw order
    const row = linebedHistory[i];
    const age = i; // 0 = newest
    const d =
      rows <= 1
        ? 1
        : flip
          ? age / (rows - 1) // newest(age 0) → near/bottom
          : 1 - age / (rows - 1); // newest(age 0) → far/top
    const yBase = yNear + (yFar - yNear) * d;
    const rowW = wNear + (wFar - wNear) * d;
    const amp = ampNear + (ampFar - ampNear) * d;
    const left = cx - rowW / 2;
    const colStep = rowW / (LINEBED_COLS - 1);

    const trace = () => {
      for (let c = 0; c < LINEBED_COLS; c++) {
        const x = left + c * colStep;
        const y = yBase - row[c] * amp;
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    };

    // Fill beneath the curve down to the bottom edge to hide farther rows.
    ctx.beginPath();
    trace();
    ctx.lineTo(left + rowW, h);
    ctx.lineTo(left, h);
    ctx.closePath();
    ctx.fillStyle = LINEBED_BG;
    ctx.fill();

    // Stroke the ridge. Nearer rows are brighter and slightly thicker.
    const nearness = 1 - d;
    ctx.beginPath();
    trace();
    ctx.strokeStyle = `rgba(234, 238, 247, ${0.16 + nearness * 0.66})`;
    ctx.lineWidth = (1 + nearness * 0.7) * lineScale;
    ctx.stroke();
  }
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

  // Dynamic font sizing — user scale, then a beat pump (scaled by motion).
  const fontDef = LYRIC_FONTS[lyricFontKey] || LYRIC_FONTS.sans;
  const baseFontSize = Math.min(w, h) * 0.06 * lyricFontScale;
  const emphasisScale = lyric.emphasis ? 1.2 : 1;
  const beatPump = 1 + (beat.impact * 0.12 + beat.pressure * 0.08) * lyricMotion;
  const fontSize = Math.round(baseFontSize * emphasisScale * beatPump);
  const weight = lyric.emphasis ? fontDef.emphasisWeight : fontDef.weight;
  const font = `${weight} ${fontSize}px ${fontDef.family}`;
  const maxWidth = w * 0.72;
  const lineHeight = fontSize * 1.35;

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

  // ── Per-word drop rendering with audio-reactive transforms ──
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const tokens = getLineTokens(prepared, line, font);
    const tokenCount = tokens.filter((token) => !token.isSpace).length;
    if (tokenCount === 0) continue;

    const lineY = baseY + lineIdx * lineHeight;
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
        // Static width — no per-frame beat term, so the line never reflows.
        return { ...token, reserveWidth: token.baseWidth };
      }

      const wordIdx = seenWords++;
      const globalWordIdx = globalWordBase + wordIdx;
      const timingFront = progress * (totalTokens + 0.8);
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
      // reveal = calm left-to-right wipe; fade = whole line eases in together.
      let revealAlpha = clamp(phase * 1.35, 0, 1);
      const calmFactor = lyricEffect === "wordwave" ? 1 : 0.35;
      if (lyricEffect !== "wordwave") {
        dropHeight = 0;
        bounce = 0;
      }
      if (lyricEffect === "fade") revealAlpha = clamp(lineReveal * 1.1, 0, 1);
      const swingX =
        position *
        (motion.spread * (18 + edgeBias * 12) - motion.compression * 6);
      const rippleX =
        Math.sin(time * 3.0 + wordIdx * 0.8 + lineIdx * 0.35) *
        (motion.shimmer * 1.2 + wordEnergy * 0.8);
      const scaleX = clamp(
        1 +
          (motion.spread * 0.1 + beat.splitPulse * 0.08 + wordEnergy * 0.06) *
            lyricMotion,
        0.92,
        1.38,
      );
      const scaleY = clamp(
        1 +
          ((1 - clamp(phase, 0, 1)) * 0.18 -
            beat.splitPulse * 0.035 +
            motion.release * 0.05) *
            lyricMotion,
        0.9,
        1.34,
      );
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

      return {
        ...token,
        wordIdx,
        charFreq,
        energy: wordEnergy,
        phase,
        settle,
        reserveWidth,
        scaleX,
        scaleY,
        offsetX,
        offsetY,
        rotation,
        alpha: revealAlpha * (0.84 + beat.impact * 0.16 * lyricMotion),
        glow: motion.glow + wordEnergy * 10,
        position,
      };
    });

    const totalTokenWidth = tokenStates.reduce(
      (sum, state) => sum + state.reserveWidth,
      0,
    );
    // Shrink-to-fit: keep the whole line inside a visible side margin so the
    // first/last words never run off-screen. Gutter ≈8%, capped at 10%.
    const margin = Math.min(w * 0.1, Math.max(24, w * 0.08));
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
        const splitDirection =
          state.position === 0
            ? tokenIdx % 2 === 0
              ? -1
              : 1
            : Math.sign(state.position);
        const splitStrength =
          beat.splitPulse *
          (0.4 + state.energy * 0.9) *
          (0.55 + Math.abs(state.position) * 0.85) *
          lyricMotion;
        const splitNormal = splitStrength * (12 + state.energy * 18);
        const splitTangent =
          splitDirection * splitStrength * (10 + Math.abs(state.position) * 14);
        const drawX = clamp(
          tokenBaseX +
            (state.offsetX +
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
          contour.normalY * splitNormal +
          contour.tangentY * splitTangent;
        const drawRotation =
          contour.angle * 0.88 +
          state.rotation +
          splitDirection * beat.splitPulse * 0.06 * lyricMotion;

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
          state.scaleX + (beat.splitPulse * 0.12 + state.energy * 0.05) * lyricMotion,
          state.scaleY + (-beat.splitPulse * 0.04 + state.energy * 0.03) * lyricMotion,
        );
        ctx.globalAlpha = state.alpha;
        ctx.font = font;
        ctx.textBaseline = "top";
        ctx.shadowColor = lyric.emphasis ? colorBase : "rgba(255,255,255,0.52)";
        ctx.shadowBlur =
          state.glow + state.charFreq * 18 + beat.splitPulse * 10;
        ctx.fillStyle = charColor;
        ctx.fillText(state.text, -state.baseWidth / 2, -fontSize / 2);

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
          setLyricsState(fetched.lyrics);
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
