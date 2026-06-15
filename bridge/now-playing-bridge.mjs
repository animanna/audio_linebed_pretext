#!/usr/bin/env node
// Standalone Now-Playing bridge — serves the built app (dist/) AND the /api
// endpoints over http://localhost on its own pinned port, so a production-ish
// local run needs neither Vite nor node_modules.
//
// The actual now-playing readers + system-audio stream live in
// now-playing-core.mjs, shared with the Vite dev/preview server (see the plugin
// in vite.config.js). That means system audio also works under `npm run dev` /
// `npm run preview` on a single port — this standalone server is only needed to
// serve the *built* dist/ with system access.
//
// Run:  node bridge/now-playing-bridge.mjs   then open the printed URL.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { handleApi, getNowPlaying, READER_NAME } from "./now-playing-core.mjs";

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

// ── Static file server (serves the built dist/) ──────────────────────────
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
  if (await handleApi(req, res, url)) return;
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
  console.log(`\n  Now-Playing bridge → http://localhost:${PORT}/`);
  console.log(`  Platform: ${OS}  ·  reader: ${READER_NAME}`);
  if (!probe.ok)
    console.log(`  ! ${probe.error} (start playback in any player, then refresh)`);
  else console.log(`  > ${probe.artist} — ${probe.title}`);
  console.log("");
});
