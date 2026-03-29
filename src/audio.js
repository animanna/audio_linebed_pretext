// Audio engine: handles file loading, playback, and frequency analysis

export class AudioEngine {
  constructor() {
    this.ctx = null
    this.analyser = null
    this.source = null
    this.audioBuffer = null
    this.startTime = 0
    this.pauseOffset = 0
    this.playing = false
    this.frequencyData = new Uint8Array(0)
    this.timeDomainData = new Uint8Array(0)
    this.loadVersion = 0
    this.onStateChange = null
  }

  async init() {
    this.ctx = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.82
    this.analyser.connect(this.ctx.destination)

    const bufLen = this.analyser.frequencyBinCount
    this.frequencyData = new Uint8Array(bufLen)
    this.timeDomainData = new Uint8Array(bufLen)
  }

  async loadFile(file) {
    const arrayBuffer = await file.arrayBuffer()
    return this.loadArrayBuffer(arrayBuffer)
  }

  async loadUrl(url) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`audio request failed: ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    return this.loadArrayBuffer(arrayBuffer)
  }

  async loadArrayBuffer(arrayBuffer) {
    const loadVersion = ++this.loadVersion
    if (!this.ctx) await this.init()
    this.stop()
    this.audioBuffer = null
    const decoded = await this.ctx.decodeAudioData(arrayBuffer)
    if (loadVersion !== this.loadVersion) return false
    this.audioBuffer = decoded
    this.pauseOffset = 0
    this.notifyStateChange()
    return true
  }

  play() {
    if (!this.audioBuffer || this.playing) return
    if (this.ctx.state === 'suspended') this.ctx.resume()

    const source = this.ctx.createBufferSource()
    source.buffer = this.audioBuffer
    source.connect(this.analyser)
    source.start(0, this.pauseOffset)
    this.source = source
    this.startTime = this.ctx.currentTime - this.pauseOffset
    this.playing = true
    this.notifyStateChange()

    source.onended = () => {
      if (this.source !== source) return
      this.source = null
      if (this.playing) {
        this.playing = false
        this.pauseOffset = 0
      }
      this.notifyStateChange()
    }
  }

  pause() {
    if (!this.playing || !this.source) return
    this.pauseOffset = this.ctx.currentTime - this.startTime
    this.stop(false)
  }

  seekTo(time) {
    const clampedTime = Math.max(0, Math.min(time, this.duration || 0))
    const wasPlaying = this.playing
    if (wasPlaying) {
      this.stop(false)
    }
    this.pauseOffset = clampedTime
    if (wasPlaying) this.play()
  }

  stop(resetOffset = true) {
    if (this.source) {
      this.source.onended = null
      try {
        this.source.stop()
      } catch {
        // The current source may already have ended.
      }
      this.source.disconnect()
      this.source = null
    }
    this.playing = false
    if (resetOffset) this.pauseOffset = 0
    this.notifyStateChange()
  }

  get currentTime() {
    if (!this.ctx) return 0
    if (this.playing) return this.ctx.currentTime - this.startTime
    return this.pauseOffset
  }

  get duration() {
    return this.audioBuffer ? this.audioBuffer.duration : 0
  }

  // Get frequency spectrum data (0-255 per bin)
  getFrequencyData() {
    if (this.analyser) this.analyser.getByteFrequencyData(this.frequencyData)
    return this.frequencyData
  }

  // Get waveform data
  getTimeDomainData() {
    if (this.analyser) this.analyser.getByteTimeDomainData(this.timeDomainData)
    return this.timeDomainData
  }

  // Derived metrics for visualization
  getMetrics() {
    const freq = this.getFrequencyData()
    const wave = this.getTimeDomainData()

    const binCount = freq.length

    // Bass energy (20-250 Hz range, roughly first ~12 bins at 44100/2048)
    let bass = 0
    const bassEnd = Math.floor(binCount * 0.02)
    for (let i = 0; i < bassEnd; i++) bass += freq[i]
    bass = bassEnd > 0 ? bass / (bassEnd * 255) : 0

    // Mid energy (250-4000 Hz)
    const midStart = bassEnd
    const midEnd = Math.floor(binCount * 0.18)
    let mid = 0
    for (let i = midStart; i < midEnd; i++) mid += freq[i]
    mid = (midEnd - midStart) > 0 ? mid / ((midEnd - midStart) * 255) : 0

    // Treble energy (4000-20000 Hz)
    const trebStart = midEnd
    let treble = 0
    for (let i = trebStart; i < binCount; i++) treble += freq[i]
    treble = (binCount - trebStart) > 0 ? treble / ((binCount - trebStart) * 255) : 0

    // Overall energy
    let overall = 0
    for (let i = 0; i < binCount; i++) overall += freq[i]
    overall = overall / (binCount * 255)

    // RMS from waveform
    let rms = 0
    for (let i = 0; i < wave.length; i++) {
      const v = (wave[i] - 128) / 128
      rms += v * v
    }
    rms = Math.sqrt(rms / wave.length)

    return { bass, mid, treble, overall, rms, frequencyData: freq, waveformData: wave }
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange()
    }
  }
}
