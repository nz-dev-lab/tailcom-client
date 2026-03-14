import { EventEmitter } from 'events'
import type { IceCandidateMessage } from './types'
import { startMicCapture, startSpeakerPlayback } from './audio'

// Load wrtc for Node/Electron main process.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wrtc = require('@roamhq/wrtc') as {
  RTCPeerConnection: typeof RTCPeerConnection
  RTCSessionDescription: typeof RTCSessionDescription
  RTCIceCandidate: typeof RTCIceCandidate
  nonstandard: {
    RTCAudioSource: new () => {
      createTrack(): MediaStreamTrack
      onData(data: unknown): void
    }
    RTCAudioSink: new (track: MediaStreamTrack) => {
      ondata: ((data: unknown) => void) | null
      stop(): void
    }
  }
}

export class WebRTCHandler extends EventEmitter {
  private pc: RTCPeerConnection | null = null
  private audioSink: { ondata: ((data: unknown) => void) | null; stop(): void } | null = null
  private stopMic: (() => void) | null = null
  private stopSpeaker: (() => void) | null = null

  createPeerConnection(): RTCPeerConnection {
    console.log('[tailcom:webrtc] new RTCPeerConnection...')
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    console.log('[tailcom:webrtc] RTCPeerConnection OK')

    // Add a mic track so the remote side receives audio from us
    console.log('[tailcom:webrtc] new RTCAudioSource...')
    const micSource = new wrtc.nonstandard.RTCAudioSource()
    console.log('[tailcom:webrtc] RTCAudioSource OK')
    console.log('[tailcom:webrtc] addTrack...')
    pc.addTrack(micSource.createTrack())
    console.log('[tailcom:webrtc] addTrack OK')

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        console.log(`[tailcom:webrtc] ICE candidate — ${event.candidate.type} ${event.candidate.protocol} ${event.candidate.address}`)
        this.emit('ice-candidate', {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        } satisfies IceCandidateMessage)
      } else {
        console.log('[tailcom:webrtc] ICE gathering complete (null candidate)')
      }
    }

    pc.onconnectionstatechange = () => {
      console.log(`[tailcom:webrtc] connectionState → ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        console.log('[tailcom:webrtc] peer connected — starting mic capture')
        // Start real mic capture — push samples into wrtc source
        this.stopMic = startMicCapture(
          { onData: (d) => micSource.onData(d) },
          undefined,
          (rms) => this.emit('local-level', rms),
        )
        this.emit('connected')
      } else if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        console.log(`[tailcom:webrtc] peer ${pc.connectionState} — tearing down`)
        this.emit('disconnected')
      }
    }

    pc.onicegatheringstatechange = () => {
      console.log(`[tailcom:webrtc] iceGatheringState → ${pc.iceGatheringState}`)
    }

    pc.oniceconnectionstatechange = () => {
      console.log(`[tailcom:webrtc] iceConnectionState → ${pc.iceConnectionState}`)
    }

    pc.ontrack = (event: RTCTrackEvent) => {
      const track = event.track
      console.log(`[tailcom:webrtc] ontrack — kind=${track.kind}`)
      if (track.kind !== 'audio') return

      // Attach sink to receive incoming audio from dashboard
      const sink = new wrtc.nonstandard.RTCAudioSink(track)
      this.audioSink = sink

      // Play incoming audio through system speakers
      this.stopSpeaker = startSpeakerPlayback(
        sink as { ondata: ((data: unknown) => void) | null },
        (rms) => this.emit('remote-level', rms),
      )
    }

    this.pc = pc
    return pc
  }

  async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error('No peer connection — call createPeerConnection() first')

    await this.pc.setRemoteDescription(new wrtc.RTCSessionDescription(offer))
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    if (!this.pc.localDescription) throw new Error('Failed to set local description')
    return this.pc.localDescription
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return
    try {
      await this.pc.addIceCandidate(new wrtc.RTCIceCandidate(candidate))
    } catch { /* stale candidate — non-fatal */ }
  }

  teardown(): void {
    this.stopMic?.()
    this.stopMic = null

    this.stopSpeaker?.()
    this.stopSpeaker = null

    if (this.audioSink) {
      try { this.audioSink.stop() } catch { /* ignore */ }
      this.audioSink = null
    }
    if (this.pc) {
      try { this.pc.close() } catch { /* ignore */ }
      this.pc = null
    }
  }
}
