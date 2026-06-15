#!/usr/bin/env node
// Now-Playing bridge — reads the OS "currently playing" media session and
// serves it (plus the built app) over http://localhost so the browser app can
// read system metadata it could never reach from inside the sandbox.
//
//   Linux   → MPRIS via `playerctl`            (install via your package manager)
//   macOS   → `nowplaying-cli`                 (brew install nowplaying-cli)
//   Windows → SMTC via PowerShell + WinRT      (built in)
//
// Run:  node bridge/now-playing-bridge.mjs   then open the printed URL.
// Serves dist/ at the root and exposes GET /api/now-playing as JSON.

import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
// Fixed, pinned port. Override only if you must: BRIDGE_PORT=xxxx npm run bridge
const PORT = Number(process.env.BRIDGE_PORT) || 8787;
const OS = platform();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

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

const TAB = String.fromCharCode(9);

async function readLinux() {
  // Tab-delimited single read. Tabs in track text are vanishingly rare.
  const FMT = [
    "{{playerName}}",
    "{{status}}",
    "{{xesam:title}}",
    "{{xesam:artist}}",
    "{{xesam:album}}",
    "{{mpris:length}}",
  ].join(TAB);
  const meta = await run("playerctl", ["metadata", "--format", FMT]);
  if (!meta) return null;
  const [player, status, title, artist, album, lengthUs] = meta
    .replace(/\n$/, "")
    .split(TAB);
  if (!title && !artist) return null;
  const posStr = await run("playerctl", ["position"]);
  const length = lengthUs ? Number(lengthUs) / 1e6 : 0; // µs → s
  const position = posStr ? Number(posStr.trim()) : 0;
  return { player, status, title, artist, album, length, position };
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

async function getNowPlaying() {
  if (!reader) return { ok: false, error: `unsupported platform: ${OS}` };
  const data = await reader();
  if (!data) return { ok: false, error: "no active media session" };
  return { ok: true, ts: Date.now(), ...data };
}

// ── System audio loopback stream ─────────────────────────────────────────
// Capture the default output's monitor (everything the system plays, native
// apps included) as raw mono s16le PCM and stream it to the browser. This
// sidesteps the browser refusing to enumerate PipeWire monitor sources.
// Linux only (parec). Other platforms fall back to in-browser capture.

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

const audioSupported = OS === "linux";

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

// ── Static file + API server ─────────────────────────────────────────────
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = normalize(join(DIST, rel));
  if (!full.startsWith(DIST)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const info = await stat(full);
    if (info.isDirectory())
      return serveStatic(req, res, join(rel, "index.html"));
    const body = await readFile(full);
    res.writeHead(200, {
      "content-type": MIME[extname(full)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/api/now-playing") {
    const payload = await getNowPlaying();
    payload.audioStream = audioSupported; // client shows the bridge-capture option
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === "/api/audio") {
    const rate = Math.min(48000, Math.max(8000, Number(url.searchParams.get("rate")) || 48000));
    await streamAudio(req, res, rate);
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use. Stop whatever holds it, or run:\n    BRIDGE_PORT=8788 npm run bridge\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", async () => {
  const probe = await getNowPlaying();
  const tool =
    OS === "linux"
      ? "playerctl"
      : OS === "darwin"
        ? "nowplaying-cli"
        : OS === "win32"
          ? "PowerShell SMTC"
          : "(unsupported)";
  console.log(`\n  Now-Playing bridge → http://localhost:${PORT}/`);
  console.log(`  Platform: ${OS}  ·  reader: ${tool}`);
  if (!probe.ok)
    console.log(`  ! ${probe.error} (start playback in any player, then refresh)`);
  else console.log(`  > ${probe.artist} — ${probe.title}`);
  console.log("");
});
