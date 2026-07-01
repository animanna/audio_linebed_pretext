// Shared core for the now-playing + system-audio API. Used by BOTH the
// standalone bridge server (bridge/now-playing-bridge.mjs, serves dist/ on its
// own port) AND the Vite dev/preview server (via the plugin in vite.config.js),
// so `npm run dev` / `npm run preview` expose the same /api endpoints on a
// single port — no separate `npm run bridge` process needed for local use.
//
//   Linux   → MPRIS via `playerctl`            (install via your package manager)
//   macOS   → `nowplaying-cli`                 (brew install nowplaying-cli)
//   Windows → SMTC via PowerShell + WinRT      (built in)

import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";

const OS = platform();
const TAB = String.fromCharCode(9);

function run(cmd, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout));
    });
  });
}

// ── Per-platform readers ────────────────────────────────────────────────
// Each returns { player, status, title, artist, album, length, position } or
// null. length/position are in seconds.

async function readLinux() {
  // Tab-delimited single read. Tabs in track text are vanishingly rare.
  // xesam:asText (embedded lyrics) is LAST so any internal newlines stay in the
  // final field after the TAB split.
  const FMT = [
    "{{playerName}}",
    "{{status}}",
    "{{xesam:title}}",
    "{{xesam:artist}}",
    "{{xesam:album}}",
    "{{mpris:length}}",
    "{{xesam:asText}}",
  ].join(TAB);
  const meta = await run("playerctl", ["metadata", "--format", FMT]);
  if (!meta) return null;
  const [player, status, title, artist, album, lengthUs, ...rest] = meta
    .replace(/\n$/, "")
    .split(TAB);
  if (!title && !artist) return null;
  const lyrics = rest.join(TAB).trim(); // embedded lyrics, "" when absent
  const posStr = await run("playerctl", ["position"]);
  const length = lengthUs ? Number(lengthUs) / 1e6 : 0; // µs → s
  const position = posStr ? Number(posStr.trim()) : 0;
  return { player, status, title, artist, album, length, position, lyrics };
}

async function readMac() {
  const out = await run("nowplaying-cli", [
    "get",
    "title",
    "artist",
    "album",
    "duration",
    "elapsedTime",
    "playbackRate",
  ]);
  if (!out) return null;
  const [title, artist, album, duration, elapsed, rate] = out
    .trim()
    .split("\n");
  if (!title || title === "null") return null;
  const clean = (v) => (v && v !== "null" ? v : "");
  return {
    player: "macOS",
    status: Number(rate) > 0 ? "Playing" : "Paused",
    title: clean(title),
    artist: clean(artist),
    album: clean(album),
    length: Number(duration) || 0,
    position: Number(elapsed) || 0,
  };
}

const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] > $null",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(); $task.Result }",
  "$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
  "$s = $mgr.GetCurrentSession()",
  "if ($null -eq $s) { Write-Output '{}'; exit }",
  "$props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])",
  "$tl = $s.GetTimelineProperties()",
  "$pb = $s.GetPlaybackInfo()",
  "$status = switch ($pb.PlaybackStatus) { 4 {'Playing'} 5 {'Paused'} default {'Stopped'} }",
  "$o = [ordered]@{ player = $s.SourceAppUserModelId; status = $status; title = $props.Title; artist = $props.Artist; album = $props.AlbumTitle; length = $tl.EndTime.TotalSeconds; position = $tl.Position.TotalSeconds }",
  "$o | ConvertTo-Json -Compress",
].join("\n");

async function readWindows() {
  const out = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
    3000,
  );
  if (!out) return null;
  try {
    const o = JSON.parse(out.trim() || "{}");
    if (!o.title) return null;
    return {
      player: o.player || "Windows",
      status: o.status || "Playing",
      title: o.title || "",
      artist: o.artist || "",
      album: o.album || "",
      length: Number(o.length) || 0,
      position: Number(o.position) || 0,
    };
  } catch {
    return null;
  }
}

const reader =
  OS === "linux"
    ? readLinux
    : OS === "darwin"
      ? readMac
      : OS === "win32"
        ? readWindows
        : null;

export const READER_NAME =
  OS === "linux"
    ? "playerctl"
    : OS === "darwin"
      ? "nowplaying-cli"
      : OS === "win32"
        ? "PowerShell SMTC"
        : "(unsupported)";

// Browsers (esp. Firefox/Zen) report MPRIS metadata from the page's
// MediaSession, but when a site sets none they fall back to the TAB TITLE —
// which carries a streaming-service brand ("Song - Spotify", "Song | Deezer").
// Some players (e.g. kdeconnect phone bridges) also prefix the artist into the
// title ("Artist - Song"). Both poison the lrclib query and the on-screen
// label, so strip them here, in one place, for every platform reader.
const SERVICE_SUFFIX =
  /\s*[-–—|·•]\s*(spotify|deezer|tidal|qobuz|youtube music|youtube|apple music|soundcloud|amazon music|pandora|napster)\s*$/i;

// Identify the streaming service from the (raw) title suffix or, for native
// apps, the player name. Returns a slug like "spotify" / "youtube-music", or ""
// when unknown (e.g. a generic chromium/firefox tab with proper metadata).
function detectService(rawTitle, player) {
  const m = (rawTitle || "").match(SERVICE_SUFFIX);
  if (m) return m[1].toLowerCase().replace(/\s+/g, "-");
  const p = (player || "").toLowerCase();
  for (const s of ["spotify", "deezer", "tidal", "qobuz", "soundcloud"]) {
    if (p.includes(s)) return s;
  }
  return "";
}

function normalizeTrack(t) {
  const rawTitle = (t.title || "").trim();
  const artist = (t.artist || "").trim();
  let title = rawTitle;
  // Drop a trailing service brand (repeat: "Song - Deezer - Deezer").
  let prev;
  do {
    prev = title;
    title = title.replace(SERVICE_SUFFIX, "").trim();
  } while (title !== prev);
  // Drop a leading "<artist> - " the player duplicated into the title.
  if (artist) {
    const prefix = `${artist} - `;
    if (title.toLowerCase().startsWith(prefix.toLowerCase())) {
      title = title.slice(prefix.length).trim();
    }
  }
  return {
    ...t,
    title: title || t.title,
    artist,
    service: detectService(rawTitle, t.player),
  };
}

export async function getNowPlaying() {
  if (!reader) return { ok: false, error: `unsupported platform: ${OS}` };
  const data = await reader();
  if (!data) return { ok: false, error: "no active media session" };
  return { ok: true, ts: Date.now(), ...normalizeTrack(data) };
}

// ── System audio loopback stream ─────────────────────────────────────────
// Capture the default output's monitor (everything the system plays, native
// apps included) as raw mono s16le PCM and stream it to the browser. This
// sidesteps the browser refusing to enumerate PipeWire monitor sources.
// Linux only (parec). Other platforms fall back to in-browser capture.

export const audioSupported = OS === "linux";

async function defaultMonitor() {
  const sink = await run("pactl", ["get-default-sink"]);
  if (sink && sink.trim()) return `${sink.trim()}.monitor`;
  // Fallback: first RUNNING monitor source.
  const list = await run("pactl", ["list", "sources", "short"]);
  if (list) {
    const line = list
      .split("\n")
      .find((l) => /monitor/i.test(l) && /running/i.test(l));
    if (line) return line.split(TAB)[1];
  }
  return null;
}

async function streamAudio(req, res, rate) {
  if (!audioSupported) {
    res.writeHead(501).end("system audio stream is Linux-only (parec)");
    return;
  }
  const monitor = await defaultMonitor();
  if (!monitor) {
    res.writeHead(503).end("no monitor source found");
    return;
  }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    // Raw PCM params the client needs to interpret the bytes.
    "x-audio-rate": String(rate),
    "x-audio-channels": "1",
    "x-audio-format": "s16le",
  });
  const proc = spawn("parec", [
    "-d",
    monitor,
    "--format=s16le",
    `--rate=${rate}`,
    "--channels=1",
    "--latency-msec=40",
  ]);
  proc.stdout.pipe(res);
  proc.stderr.on("data", () => {}); // swallow chatter
  const cleanup = () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  proc.on("error", () => res.destroy());
  req.on("close", cleanup);
  res.on("close", cleanup);
}

// ── Playback control ──────────────────────────────────────────────────────
// Toggle/play/pause the OS media session the readers above report on. Action
// is whitelisted to fixed verbs, so nothing user-supplied reaches the shell.

const LINUX_CMD = {
  play: "play",
  pause: "pause",
  "play-pause": "play-pause",
  next: "next",
  previous: "previous",
};

async function controlLinux(action) {
  return (await run("playerctl", [LINUX_CMD[action] || "play-pause"])) !== null;
}

const MAC_CMD = {
  play: "play",
  pause: "pause",
  "play-pause": "togglePlayPause",
  next: "next",
  previous: "previous",
};

async function controlMac(action) {
  return (
    (await run("nowplaying-cli", [MAC_CMD[action] || "togglePlayPause"])) !==
    null
  );
}

function controlPsScript(method) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] > $null",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    "function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(); $task.Result }",
    "$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
    "$s = $mgr.GetCurrentSession()",
    "if ($null -eq $s) { exit 1 }",
    `Await ($s.${method}()) ([bool]) > $null`,
  ].join("\n");
}

const WIN_METHOD = {
  play: "TryPlayAsync",
  pause: "TryPauseAsync",
  "play-pause": "TryTogglePlayPauseAsync",
  next: "TrySkipNextAsync",
  previous: "TrySkipPreviousAsync",
};

async function controlWindows(action) {
  const method = WIN_METHOD[action] || "TryTogglePlayPauseAsync";
  const out = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", controlPsScript(method)],
    3000,
  );
  return out !== null;
}

export async function controlPlayback(action) {
  if (OS === "linux") return controlLinux(action);
  if (OS === "darwin") return controlMac(action);
  if (OS === "win32") return controlWindows(action);
  return false;
}

// ── Absolute seek ──────────────────────────────────────────────────────────
// Jump the OS media session to `seconds` (absolute position from the start).
// `seconds` is coerced to a finite, non-negative number before it reaches any
// command, and run() uses execFile (no shell), so nothing user-supplied can
// inject. Returns true on success.

async function seekLinux(seconds) {
  // playerctl position <s> sets the absolute position (player must implement
  // the MPRIS SetPosition method — most do).
  return (await run("playerctl", ["position", String(seconds)])) !== null;
}

async function seekMac(seconds) {
  // Best-effort: nowplaying-cli's seek support varies by version/app, so this
  // may be a no-op on some macOS setups.
  return (await run("nowplaying-cli", ["seek", String(seconds)])) !== null;
}

function seekPsScript(ticks) {
  // SMTC position is in 100-ns ticks. TryChangePlaybackPositionAsync(Int64)
  // returns IAsyncOperation<bool>.
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] > $null",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    "function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(); $task.Result }",
    "$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
    "$s = $mgr.GetCurrentSession()",
    "if ($null -eq $s) { exit 1 }",
    `Await ($s.TryChangePlaybackPositionAsync([int64]${ticks})) ([bool]) > $null`,
  ].join("\n");
}

async function seekWindows(seconds) {
  const ticks = Math.round(seconds * 1e7);
  const out = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", seekPsScript(ticks)],
    3000,
  );
  return out !== null;
}

export async function seekPlayback(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return false;
  if (OS === "linux") return seekLinux(s);
  if (OS === "darwin") return seekMac(s);
  if (OS === "win32") return seekWindows(s);
  return false;
}

// Handle the /api/* routes. Returns true if the request was handled (so the
// caller can stop), false to let static serving / next middleware take over.
export async function handleApi(req, res, url) {
  if (url.pathname === "/api/now-playing") {
    const payload = await getNowPlaying();
    payload.audioStream = audioSupported; // client shows the bridge-capture option
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(payload));
    return true;
  }
  if (url.pathname === "/api/audio") {
    const rate = Math.min(
      48000,
      Math.max(8000, Number(url.searchParams.get("rate")) || 48000),
    );
    await streamAudio(req, res, rate);
    return true;
  }
  if (url.pathname === "/api/control") {
    const action = url.searchParams.get("action") || "play-pause";
    const allowed = ["play", "pause", "play-pause", "next", "previous"];
    const ok = allowed.includes(action)
      ? await controlPlayback(action)
      : false;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify({ ok }));
    return true;
  }
  if (url.pathname === "/api/seek") {
    const ok = await seekPlayback(url.searchParams.get("position"));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify({ ok }));
    return true;
  }
  return false;
}
