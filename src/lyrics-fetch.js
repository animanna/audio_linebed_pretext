// Auto-fetch synced lyrics from lrclib.net (free, no API key needed)
// Returns LRC-formatted synced lyrics if available, or plain lyrics as fallback

import { parseLRC, parsePlainLyrics } from './lrc-parser.js'

/**
 * Search for lyrics by track name and artist
 * Returns { lyrics: [...], source: string } or null
 */
// Hard cap per request. lrclib's /api/search has been seen to hang for ~60s
// (504), so without this the lyrics status freezes on "fetching…" indefinitely.
const FETCH_TIMEOUT_MS = 8000

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null // timeout, abort, network, or non-JSON
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchLyrics(trackInfo, artistName, audioDuration) {
  const query = typeof trackInfo === 'string'
    ? { title: trackInfo, artist: artistName, audioDuration }
    : trackInfo
  const candidates = buildSearchCandidates(query)

  if (candidates.length === 0) return null

  try {
    // Fast path first: the exact-match /api/get endpoint is reliable and quick,
    // whereas /api/search is the slow/flaky one. Try get for every candidate
    // before falling back to a scored search.
    for (const candidate of candidates) {
      const direct = await getLrclib(candidate.trackName, candidate.artistName, query.audioDuration)
      if (direct) return direct
    }

    let bestMatch = null
    for (const candidate of candidates) {
      const results = await searchLrclib(candidate.trackName, candidate.artistName)
      if (!results || results.length === 0) continue

      for (const result of results) {
        const score = scoreResult(result, candidate, query.audioDuration)
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { result, score }
        }
      }
    }

    if (bestMatch && bestMatch.score >= 70) {
      const payload = buildLyricsPayload(bestMatch.result, query.audioDuration)
      if (payload) return payload
    }
  } catch (err) {
    console.warn('Lyrics fetch failed:', err)
  }

  return null
}

async function searchLrclib(trackName, artistName) {
  const params = new URLSearchParams({ track_name: trackName })
  if (artistName) params.set('artist_name', artistName)
  return fetchJson(`https://lrclib.net/api/search?${params}`)
}

async function getLrclib(trackName, artistName, audioDuration) {
  const base = new URLSearchParams({ track_name: trackName })
  if (artistName) base.set('artist_name', artistName)

  // Duration sharpens the match, but /api/get 404s when it doesn't line up, so
  // fall back to a duration-less lookup.
  if (audioDuration) {
    const withDur = new URLSearchParams(base)
    withDur.set('duration', Math.round(audioDuration).toString())
    const exact = await fetchJson(`https://lrclib.net/api/get?${withDur}`)
    if (exact) {
      const payload = buildLyricsPayload(exact, audioDuration)
      if (payload) return payload
    }
  }

  const data = await fetchJson(`https://lrclib.net/api/get?${base}`)
  if (!data) return null
  return buildLyricsPayload(data, audioDuration)
}

function buildLyricsPayload(record, audioDuration) {
  if (record.syncedLyrics) {
    const { lyrics } = parseLRC(record.syncedLyrics)
    if (lyrics.length > 0) {
      return {
        lyrics,
        source: 'lrclib.net (synced)',
        meta: { title: record.trackName, artist: record.artistName, album: record.albumName },
      }
    }
  }

  if (record.plainLyrics) {
    const lyrics = parsePlainLyrics(record.plainLyrics, audioDuration || 180)
    return {
      lyrics,
      source: 'lrclib.net (plain, auto-timed)',
      meta: { title: record.trackName, artist: record.artistName, album: record.albumName },
    }
  }

  return null
}

function buildSearchCandidates({ title = '', artist = '', fileName = '' }) {
  const candidates = []
  const seen = new Set()

  const addCandidate = (trackName, artistName = '') => {
    const cleanTrack = sanitizeSearchText(trackName)
    const cleanArtist = sanitizeSearchText(artistName)
    if (!cleanTrack) return

    const key = `${normalizeText(cleanArtist)}::${normalizeText(cleanTrack)}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ trackName: cleanTrack, artistName: cleanArtist })
  }

  addCandidate(title, artist)

  const splitTitle = splitArtistAndTitle(title)
  if (!artist && splitTitle) addCandidate(splitTitle.title, splitTitle.artist)

  const fileStem = stripExtension(fileName)
  addCandidate(fileStem, artist)

  const splitFileName = splitArtistAndTitle(fileStem)
  if (splitFileName) addCandidate(splitFileName.title, splitFileName.artist)

  return candidates
}

function splitArtistAndTitle(value) {
  if (!value) return null
  const parts = stripExtension(value).split(/\s+[—–-]\s+/)
  if (parts.length < 2) return null

  const artist = sanitizeSearchText(parts[0])
  const title = sanitizeSearchText(parts.slice(1).join(' - '))
  if (!artist || !title) return null
  return { artist, title }
}

function sanitizeSearchText(value) {
  if (!value) return ''

  return stripExtension(value)
    .replace(/[_]+/g, ' ')
    .replace(/^\d{1,2}\s*[-.)]\s*/g, '')
    .replace(/\b(?:official video|official audio|lyrics video|audio|video|mv|hd|hq)\b/gi, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeText(value) {
  return sanitizeSearchText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .trim()
}

function scoreResult(result, candidate, audioDuration) {
  let score = result.syncedLyrics ? 30 : 0
  score += scoreTextMatch(candidate.trackName, result.trackName)
  score += Math.round(scoreTextMatch(candidate.artistName, result.artistName) * 0.65)
  score += scoreDurationMatch(audioDuration, result.duration)
  return score
}

function scoreTextMatch(expected, actual) {
  const left = normalizeText(expected)
  const right = normalizeText(actual)
  if (!left || !right) return 0
  if (left === right) return 100
  if (left.includes(right) || right.includes(left)) return 82

  const leftTokens = new Set(left.split(' ').filter(Boolean))
  const rightTokens = new Set(right.split(' ').filter(Boolean))
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0

  let overlap = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++
  }

  return Math.round((overlap / Math.max(leftTokens.size, rightTokens.size)) * 70)
}

function scoreDurationMatch(audioDuration, matchDuration) {
  const actualDuration = Number(matchDuration)
  if (!audioDuration || !actualDuration) return 0

  const diff = Math.abs(audioDuration - actualDuration)
  if (diff <= 2) return 25
  if (diff <= 5) return 16
  if (diff <= 10) return 6
  if (diff >= 30) return -20
  return 0
}

function stripExtension(value) {
  return (value || '').replace(/\.[^.]+$/, '')
}
