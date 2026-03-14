import { spawn, ChildProcess } from 'child_process'

// Inline types — no @types/node-record-lpcm16 on npm
// eslint-disable-next-line @typescript-eslint/no-require-imports
const record = require('node-record-lpcm16') as {
  record(options: {
    sampleRate: number; channels: number; audioType: string
    recorder: string; verbose: boolean; silence: number
  }): { stream(): import('stream').Readable; stop(): void }
}

// PCM format used throughout — must match wrtc RTCAudioSource/Sink
const SAMPLE_RATE = 48000
const CHANNELS = 1
const BIT_DEPTH = 16
const FRAME_MS = 10
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000   // 480 samples per frame
const BYTES_PER_FRAME = FRAME_SAMPLES * (BIT_DEPTH / 8) // 960 bytes per frame

export interface AudioSource {
  onData(data: {
    samples: Int16Array
    sampleRate: number
    bitsPerSample: number
    channelCount: number
    numberOfFrames: number
  }): void
}

export interface AudioSink {
  ondata: ((data: {
    samples: Int16Array
    sampleRate: number
    bitsPerSample: number
    channelCount: number
    numberOfFrames: number
  }) => void) | null
}

// ── RMS helper ────────────────────────────────────────────────────────────────
function computeRms(samples: Int16Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

// ── Mic capture ───────────────────────────────────────────────────────────────
// Uses arecord on Linux, sox on Windows.
// Returns a stop function.

export function startMicCapture(
  source: AudioSource,
  isMuted: () => boolean = () => false,
  onLevel?: (rms: number) => void,
): () => void {
  const recorderBin = process.platform === 'win32' ? 'sox' : 'arecord'
  console.log(`[tailcom:audio] startMicCapture — recorder=${recorderBin} rate=${SAMPLE_RATE} ch=${CHANNELS}`)

  const recorder = record.record({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    audioType: 'raw',
    recorder: recorderBin,
    verbose: false,
    silence: 0,
  })

  let overflow = Buffer.alloc(0)
  let frameCount = 0

  const stream = recorder.stream()
  stream.on('data', (chunk: Buffer) => {
    frameCount++
    if (frameCount === 1) console.log('[tailcom:audio] mic stream receiving data — first frame OK')
    if (frameCount === 100) console.log('[tailcom:audio] mic stream healthy — 100 frames captured')
    overflow = Buffer.concat([overflow, chunk])
    while (overflow.length >= BYTES_PER_FRAME) {
      const frame = overflow.slice(0, BYTES_PER_FRAME)
      overflow = overflow.slice(BYTES_PER_FRAME)

      const samples = new Int16Array(FRAME_SAMPLES)
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        samples[i] = frame.readInt16LE(i * 2)
      }

      if (!isMuted()) {
        source.onData({
          samples,
          sampleRate: SAMPLE_RATE,
          bitsPerSample: BIT_DEPTH,
          channelCount: CHANNELS,
          numberOfFrames: FRAME_SAMPLES,
        })
      }

      // Level metering — every 10 frames ≈ 100 ms (independent of mute)
      if (onLevel && frameCount % 10 === 0) {
        onLevel(computeRms(samples))
      }
    }
  })

  stream.on('error', (err: Error) => {
    console.error('[tailcom:audio] mic stream error:', err.message)
  })

  return () => {
    console.log('[tailcom:audio] stopMicCapture called')
    try { recorder.stop() } catch { /* ignore */ }
  }
}

// ── Speaker playback ──────────────────────────────────────────────────────────
// Pipes raw PCM to aplay (Linux) or sox (Windows) via stdin.
// Returns a stop function.

export function startSpeakerPlayback(sink: AudioSink, onLevel?: (rms: number) => void): () => void {
  let player: ChildProcess | null = null

  if (process.platform === 'win32') {
    // sox on Windows: read raw PCM from stdin, output to default sound device
    player = spawn('sox', [
      '-t', 'raw',
      '-r', String(SAMPLE_RATE),
      '-e', 'signed-integer',
      '-b', String(BIT_DEPTH),
      '-c', String(CHANNELS),
      '-',   // stdin
      '-d',  // default audio device
    ], { stdio: ['pipe', 'ignore', 'ignore'] })
  } else {
    // aplay on Linux
    player = spawn('aplay', [
      '-r', String(SAMPLE_RATE),
      '-c', String(CHANNELS),
      '-f', 'S16_LE',
      '-t', 'raw',
      '-',   // stdin
    ], { stdio: ['pipe', 'ignore', 'ignore'] })
  }

  const playerBin = process.platform === 'win32' ? 'sox' : 'aplay'
  console.log(`[tailcom:audio] startSpeakerPlayback — player=${playerBin}`)
  player.on('error', (err: Error) => {
    console.error('[tailcom:audio] speaker player error:', err.message)
  })
  player.on('exit', (code: number | null) => {
    if (code !== null && code !== 0) console.error(`[tailcom:audio] speaker player exited with code ${code}`)
  })

  let speakerFrameCount = 0
  sink.ondata = (data) => {
    if (!player?.stdin?.writable) return
    const buf = Buffer.from(
      data.samples.buffer,
      data.samples.byteOffset,
      data.samples.byteLength,
    )
    player.stdin.write(buf)

    // Level metering — every 10 frames ≈ 100 ms
    speakerFrameCount++
    if (onLevel && speakerFrameCount % 10 === 0) {
      onLevel(computeRms(data.samples))
    }
  }

  return () => {
    sink.ondata = null
    try { player?.stdin?.end() } catch { /* ignore */ }
    try { player?.kill() } catch { /* ignore */ }
    player = null
  }
}
