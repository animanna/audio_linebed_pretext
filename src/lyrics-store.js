// Permanent local store for fetched lyrics. Lyrics are tiny text, so we keep
// them in localStorage forever (no eviction, no TTL) keyed by track — a fetched
// line set survives refreshes, reloads, and bridge/server restarts. Only
// positive results are stored; a "no lyrics" outcome is never cached, so a
// track that gains lyrics on lrclib later still gets picked up next play.

import { fetchLyrics } from './lyrics-fetch.js'

const PREFIX = 'lyr:'
const VERSION = 1

// title|artist, lowercased and whitespace-collapsed so trivial metadata
// differences still hit the same entry. Returns '' when there's no usable
// title (can't key reliably → skip the store).
function storeKey(query) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  const title = norm(query && query.title)
  if (!title) return ''
  const artist = norm(query && query.artist)
  return PREFIX + title + '|' + artist
}

// A payload is worth storing only if it actually carries lyric text.
function hasLyrics(payload) {
  return !!(
    payload &&
    Array.isArray(payload.lyrics) &&
    payload.lyrics.some((l) => l && l.text)
  )
}

export function readStoredLyrics(query) {
  const key = storeKey(query)
  if (!key) return null
  let raw
  try {
    raw = localStorage.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const rec = JSON.parse(raw)
    if (!rec || rec.v !== VERSION || !hasLyrics(rec)) return null
    // meta drives the status line at the call sites; fall back to the query so
    // it's never undefined even if an older record lacked it.
    const meta = rec.meta || {
      title: query && query.title,
      artist: query && query.artist,
      album: query && query.album,
    }
    return { lyrics: rec.lyrics, source: rec.source || 'stored', meta }
  } catch {
    return null
  }
}

export function writeStoredLyrics(query, payload) {
  const key = storeKey(query)
  if (!key || !hasLyrics(payload)) return
  const rec = {
    v: VERSION,
    lyrics: payload.lyrics,
    source: payload.source || '',
    meta: payload.meta || null,
    ts: Date.now(),
  }
  try {
    localStorage.setItem(key, JSON.stringify(rec))
  } catch {
    // Quota or disabled storage — non-fatal, just skip persistence.
  }
}

// Drop-in for fetchLyrics: serve a stored hit without touching the network,
// otherwise fetch and persist a positive result before returning it.
export async function fetchLyricsCached(query) {
  const stored = readStoredLyrics(query)
  if (stored) return stored
  const fetched = await fetchLyrics(query)
  if (hasLyrics(fetched)) writeStoredLyrics(query, fetched)
  return fetched
}
