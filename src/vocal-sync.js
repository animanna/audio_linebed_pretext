// Vocal-onset detector for Vocal Sync mode.
//
// Consumes the band-limited vocal-stem metrics from AudioEngine.getVocalMetrics
// and fires discrete "onsets" — the moments a singer starts a word/syllable —
// by peak-picking positive spectral flux against an adaptive threshold. Mirrors
// the shape of BeatDetector (src/beat-detect.js): time-decayed scalars plus a
// per-frame update.
//
// The reveal cursor in main.js watches `onsetId` (monotonic) to advance one word
// per onset; `onset` (0..1 strength) and `onsetBand` route the pop-in motion.

// Sub-band flux weights. Presence (~2–5 kHz) carries consonant attacks — the
// actual word/syllable starts — and in the centre-extracted stem the usual
// presence-band impostors (cymbals/hats) are largely panned-out, so it's the
// cleanest onset cue: weight it highest. Body anchors voicing; sibilance helps.
const W_BODY = 0.8
const W_PRESENCE = 1.5
const W_SIB = 1.0
// Voicing floor: reject frames where the vocal band is top-heavy (percussive
// spikes) rather than carrying low-formant vowel body.
const MIN_BODY_RATIO = 0.28
// Absolute quiet floor so near-silence never reads as vocal presence.
const MIN_LEVEL = 0.012

export class VocalOnsetDetector {
  constructor() {
    this.fluxHistory = []
    this.historySize = 43 // ~1s at 60fps, matches BeatDetector

    this.onsetId = 0 // bumped on each fire; the reveal cursor watches this
    this.onset = 0 // 0..1 strength, decays after a fire
    this.onsetBand = 'body' // 'body' | 'presence' | 'sibilance'
    this.level = 0 // smoothed vocal volume, drives motion intensity
    this.cooldown = 0 // refractory timer, blocks double-fires

    // Voicing gate: adaptive baseline of the quiet bed, and whether the current
    // frame reads as actual voice (loud enough over the bed). The reveal engine
    // watches `vocalPresent` to know a line's vocals have started.
    this.levelFloor = 0
    this.vocalPresent = false

    // Live-tunable from the Vocal Sync settings tab.
    this.thresholdMult = 1.6 // weighted flux must exceed avg × this to fire
    this.refractory = 0.12 // min seconds between onsets (max word rate)
    this.gate = 0.4 // voicing margin: level must exceed floor × (1+gate)
  }

  update(vocalMetrics, dt) {
    const { level, body, presence, sibilance, bodyRatio = 0 } = vocalMetrics

    // Decay transient state and refractory timer.
    this.onset = Math.max(0, this.onset - dt * 4)
    this.cooldown = Math.max(0, this.cooldown - dt)
    // Smooth the volume so motion intensity doesn't jitter frame-to-frame.
    this.level += (level - this.level) * Math.min(1, dt * 10)

    // Adaptive quiet-bed baseline: rises slowly, falls quicker, so it settles at
    // the recent quiet level rather than chasing vocal peaks.
    this.levelFloor +=
      (level - this.levelFloor) * (level > this.levelFloor ? 0.002 : 0.05)
    // Voice is "present" when it's clearly louder than the bed (and not silence).
    this.vocalPresent =
      level > Math.max(this.levelFloor * (1 + this.gate), MIN_LEVEL)

    // Presence-weighted flux is the onset signal (see weights above).
    const wf = body * W_BODY + presence * W_PRESENCE + sibilance * W_SIB

    this.fluxHistory.push(wf)
    if (this.fluxHistory.length > this.historySize) this.fluxHistory.shift()

    if (this.fluxHistory.length < 10) return

    const avg = average(this.fluxHistory)
    // Fire only when the weighted flux clearly exceeds its recent average, the
    // frame reads as voiced (present + bottom-heavy, not a percussive spike), and
    // the ~120ms refractory gap has elapsed.
    const voiced = this.vocalPresent && bodyRatio > MIN_BODY_RATIO
    if (
      voiced &&
      wf > avg * this.thresholdMult &&
      wf > 0.04 &&
      this.cooldown <= 0
    ) {
      this.onsetId++
      this.onset = Math.min(1, wf / (avg * 3 + 0.06))
      this.onsetBand =
        sibilance >= body && sibilance >= presence
          ? 'sibilance'
          : presence >= body
            ? 'presence'
            : 'body'
      this.cooldown = this.refractory
    }
  }
}

function average(arr) {
  let sum = 0
  for (let i = 0; i < arr.length; i++) sum += arr[i]
  return sum / arr.length
}
