// Client for the local Now-Playing bridge (bridge/now-playing-bridge.mjs).
// Polls GET /api/now-playing — only reachable when the app is served BY the
// bridge (http://localhost:8787). On any other host the probe 404s/errors and
// the bridge stays inactive, so the normal file/capture flow is untouched.

const POLL_MS = 2000;

export class NowPlayingBridge {
  constructor() {
    this.active = false;
    this.audioStream = false; // bridge can stream system audio (Linux/parec)
    this.track = null; // { player, status, title, artist, album, length, position }
    this.polledAt = 0; // performance.now() at last successful poll
    this.trackKey = ""; // title|artist|album — change triggers onTrack
    this.onTrack = null; // (track) => void  — fired on track change
    this.onUpdate = null; // (track|null) => void — fired every poll
    this._timer = null;
  }

  // Probe once; if the endpoint answers JSON, start polling. Returns boolean.
  async start() {
    const ok = await this._poll();
    const reachable = ok !== null; // null = endpoint unreachable
    if (reachable) {
      this.active = true;
      this._timer = setInterval(() => this._poll(), POLL_MS);
    }
    return reachable;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.active = false;
  }

  // Returns playback position in seconds, extrapolated since the last poll
  // while playing — or null when no track is known.
  getTime() {
    if (!this.track) return null;
    let t = this.track.position || 0;
    if (this.track.status === "Playing") {
      t += (performance.now() - this.polledAt) / 1000;
    }
    if (this.track.length > 0) t = Math.min(t, this.track.length);
    return t;
  }

  // null  → endpoint unreachable (not served by bridge)
  // false → reachable but no active session
  // true  → got a track
  async _poll() {
    let res;
    try {
      res = await fetch("/api/now-playing", { cache: "no-store" });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let data;
    try {
      data = await res.json();
    } catch {
      return null;
    }
    // The bridge always returns { ok, ... }; a foreign 200 without it isn't ours.
    if (typeof data.ok !== "boolean") return null;

    this.audioStream = !!data.audioStream;

    if (!data.ok) {
      this.track = null;
      if (this.onUpdate) this.onUpdate(null);
      return false;
    }

    this.track = data;
    this.polledAt = performance.now();
    const key = `${data.title}|${data.artist}|${data.album}`;
    if (key !== this.trackKey) {
      this.trackKey = key;
      if (this.onTrack) this.onTrack(data);
    }
    if (this.onUpdate) this.onUpdate(data);
    return true;
  }
}
