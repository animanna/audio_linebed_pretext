// Sample lyrics with timestamps (in seconds)
// Replace these with your own song's lyrics and timings.
// Each entry: { time: seconds, text: "lyric line", emphasis: true/false }
//
// When no audio-specific lyrics are provided, these demo lyrics play
// to demonstrate the sync + visualization system.

export const demoLyrics = [
  { time: 0.0,  text: "", emphasis: false },
  { time: 0.5,  text: "Frequencies align", emphasis: false },
  { time: 3.0,  text: "Waveforms intertwine", emphasis: true },
  { time: 6.0,  text: "Pixels breathing light", emphasis: false },
  { time: 9.0,  text: "Sound becomes sight", emphasis: true },
  { time: 12.0, text: "Bass drops through the floor", emphasis: true },
  { time: 15.0, text: "Echoes wanting more", emphasis: false },
  { time: 18.0, text: "Colors shift and bend", emphasis: false },
  { time: 21.0, text: "Where does music end?", emphasis: true },
  { time: 24.0, text: "Rhythm paints the dark", emphasis: false },
  { time: 27.0, text: "Every beat a spark", emphasis: true },
  { time: 30.0, text: "Harmony in motion", emphasis: false },
  { time: 33.0, text: "An infinite ocean", emphasis: true },
  { time: 36.0, text: "Treble climbs the sky", emphasis: false },
  { time: 39.0, text: "Melodies float by", emphasis: true },
  { time: 42.0, text: "Silence holds its breath", emphasis: false },
  { time: 45.0, text: "Then the drop", emphasis: true },
  { time: 47.0, text: "Resonance", emphasis: true },
  { time: 50.0, text: "The sound of everything", emphasis: false },
  { time: 54.0, text: "And nothing at all", emphasis: true },
  { time: 58.0, text: "", emphasis: false },
]

// Utility: find the current lyric line for a given playback time
export function getCurrentLyric(lyrics, currentTime) {
  let current = lyrics[0]
  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].time) {
      current = lyrics[i]
      break
    }
  }
  return current
}

// Same scan as getCurrentLyric, but returns the array index (-1 if the
// timeline hasn't reached any line yet). The full-lyrics modal uses it to
// mark the active row.
export function getCurrentLyricIndex(lyrics, currentTime) {
  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].time) return i
  }
  return -1
}

// Utility: get progress within current lyric (0..1)
export function getLyricProgress(lyrics, currentTime) {
  let idx = 0
  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].time) {
      idx = i
      break
    }
  }
  const start = lyrics[idx].time
  const end = idx < lyrics.length - 1 ? lyrics[idx + 1].time : start + 4
  const duration = end - start
  return Math.min(1, (currentTime - start) / duration)
}
