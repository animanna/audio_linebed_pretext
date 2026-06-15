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
    // Live system/tab audio capture (getDisplayMedia) state.
    this.captureMode = false
    this.captureStream = null
    this.captureSource = null
    // Bridge PCM-stream capture state.
    this._streamNode = null
    this._streamReader = null
    this._streamAbort = false
  }

  async init() {
    this.ctx = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    // Large FFT so low octaves resolve to individual semitones (~1.3 Hz/bin
    // at 44.1 kHz) for the chromatic linebed visualization.
    this.analyser.fftSize = 16384
    this.analyser.smoothingTimeConstant = 0.65
    // analyser → monitorGain → speakers. monitorGain is muted during live
    // capture so the visualizer can analyse the tab/system audio without
    // re-playing it (which would double/echo what the source app already plays).
    this.monitorGain = this.ctx.createGain()
    this.analyser.connect(this.monitorGain)
    this.monitorGain.connect(this.ctx.destination)

    const bufLen = this.analyser.frequencyBinCount
    this.frequencyData = new Uint8Array(bufLen)
    this.timeDomainData = new Uint8Array(bufLen)
  }

  // Wire any captured MediaStream into the analyser. Shared by the tab-share
  // and input-device paths. Throws 'NO_AUDIO' if the stream has no audio track.
  _wireCaptureStream(stream) {
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('NO_AUDIO')
    }
    this.stop()
    this.teardownCapture(false)
    this.captureStream = stream // keep full stream (incl. any video) to stop later
    this.captureSource = this.ctx.createMediaStreamSource(
      new MediaStream(audioTracks),
    )
    this.captureSource.connect(this.analyser)
    this.monitorGain.gain.value = 0 // don't re-emit; source already plays it
    this.captureMode = true
    this.playing = true // so the render loop pulls live metrics
    // End on track stop or browser "Stop sharing".
    stream.getTracks().forEach((t) => {
      t.addEventListener('ended', () => this.stopCapture())
    })
    this.notifyStateChange()
    return true
  }

  async _ensureCtx() {
    if (!this.ctx) await this.init()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  // Capture a browser tab/window via getDisplayMedia. Only ever yields tab
  // audio on most platforms — use startDeviceCapture for native-app audio.
  async startCapture() {
    await this._ensureCtx()
    // video:true is required — most browsers won't offer an audio checkbox on
    // an audio-only request. The video track is discarded by _wireCaptureStream.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    })
    return this._wireCaptureStream(stream)
  }

  // Capture a system audio *input* device (e.g. a PipeWire/Pulse "Monitor of …"
  // sink on Linux, BlackHole on macOS, VB-Cable/Stereo Mix on Windows). This is
  // how we pick up audio from native apps, not just browser tabs. Music DSP
  // (echo cancel / noise suppress / AGC) is disabled so the spectrum is clean.
  async startDeviceCapture(deviceId) {
    await this._ensureCtx()
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
    if (deviceId) audioConstraints.deviceId = { exact: deviceId }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    })
    return this._wireCaptureStream(stream)
  }

  // List audio input devices. Labels are only populated after mic permission
  // has been granted at least once, so call ensureInputPermission() first.
  async listInputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audioinput')
  }

  // Prompt for mic permission once so device labels become readable, then drop
  // the throwaway stream immediately.
  async ensureInputPermission() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
  }

  // Capture the system output monitor via the local bridge's /api/audio PCM
  // stream and feed it through the analyser. Works even when the browser
  // refuses to enumerate PipeWire monitor sources. Same-origin only (the page
  // must be served by the bridge).
  async startBridgeStream() {
    await this._ensureCtx()
    const rate = Math.round(this.ctx.sampleRate)
    const resp = await fetch(`/api/audio?rate=${rate}`)
    if (!resp.ok || !resp.body) throw new Error("STREAM_FAIL")

    this.stop()
    this.teardownCapture(false)

    // Ring buffer (~2 s) the audio thread reads and the fetch pump writes.
    const RING = rate * 2
    const ring = new Float32Array(RING)
    let writePos = 0
    let readPos = 0
    let filled = 0

    const node = this.ctx.createScriptProcessor(2048, 1, 1)
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0)
      for (let i = 0; i < out.length; i++) {
        if (filled > 0) {
          out[i] = ring[readPos]
          readPos = (readPos + 1) % RING
          filled--
        } else {
          out[i] = 0
        }
      }
    }
    node.connect(this.analyser)
    this.monitorGain.gain.value = 0 // system already plays it; don't re-emit
    this.captureMode = true
    this.playing = true
    this._streamNode = node
    this._streamReader = resp.body.getReader()
    this._streamAbort = false

    // Decode s16le little-endian mono into the ring buffer as it streams in.
    let carry = null
    const pump = async () => {
      try {
        while (!this._streamAbort) {
          const { done, value } = await this._streamReader.read()
          if (done) break
          let buf = value
          if (carry) {
            const merged = new Uint8Array(carry.length + buf.length)
            merged.set(carry)
            merged.set(buf, carry.length)
            buf = merged
            carry = null
          }
          const samples = buf.length >> 1
          const usable = samples << 1
          if (usable < buf.length) carry = buf.slice(usable)
          const dv = new DataView(buf.buffer, buf.byteOffset, usable)
          for (let i = 0; i < samples; i++) {
            ring[writePos] = dv.getInt16(i * 2, true) / 32768
            writePos = (writePos + 1) % RING
            if (filled < RING) filled++
            else readPos = (readPos + 1) % RING // overwrite oldest on overrun
          }
        }
      } catch {
        // stream aborted or errored — fall through to stop
      }
      if (this.captureMode && this._streamNode === node) this.stopCapture()
    }
    pump()
    this.notifyStateChange()
    return true
  }

  teardownCapture(restoreMonitor = true) {
    if (this.captureSource) {
      this.captureSource.disconnect()
      this.captureSource = null
    }
    if (this._streamNode) {
      this._streamNode.onaudioprocess = null
      this._streamNode.disconnect()
      this._streamNode = null
    }
    if (this._streamReader) {
      this._streamAbort = true
      try {
        this._streamReader.cancel()
      } catch {}
      this._streamReader = null
    }
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((t) => t.stop())
      this.captureStream = null
    }
    if (this.captureMode) {
      this.captureMode = false
      this.playing = false
    }
    if (restoreMonitor && this.monitorGain) this.monitorGain.gain.value = 1
  }

  stopCapture() {
    this.teardownCapture(true)
    this.notifyStateChange()
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
    this.teardownCapture(true)
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

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 44100
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

    return { bass, mid, treble, overall, rms, frequencyData: freq, waveformData: wave, sampleRate: this.sampleRate }
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange()
    }
  }
}
