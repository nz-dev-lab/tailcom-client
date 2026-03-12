// All shared TypeScript interfaces and message types for tailcom

// --- Signalling messages (Dashboard → Client) ---

export interface PingMessage {
  type: 'ping'
}

export interface OfferMessage {
  type: 'offer'
  sdp: RTCSessionDescriptionInit
}

export interface IceCandidateMessage {
  type: 'ice-candidate'
  candidate: RTCIceCandidateInit
}

export interface HangupMessage {
  type: 'hangup'
}

export type IncomingMessage =
  | PingMessage
  | OfferMessage
  | IceCandidateMessage
  | HangupMessage

// --- Signalling messages (Client → Dashboard) ---

export interface PongMessage {
  type: 'pong'
}

export interface AnswerMessage {
  type: 'answer'
  sdp: RTCSessionDescriptionInit
}

export type OutgoingMessage =
  | PongMessage
  | AnswerMessage
  | IceCandidateMessage
  | HangupMessage

// --- Config / Options ---

export interface TailcomClientOptions {
  port?: number
  autoAccept?: boolean
  /** Seconds before an unanswered incoming call is auto-rejected. Default 30. */
  autoRejectTimeout?: number
}

// --- Events ---

export interface TailcomClientEvents {
  'call-started': () => void
  'call-ended': () => void
  /** Emitted when autoAccept is false and an offer arrives. */
  'incoming-call': () => void
  'error': (err: Error) => void
}

// --- wrtc type declarations (no @types/wrtc on npm) ---

export interface WRTCModule {
  RTCPeerConnection: typeof RTCPeerConnection
  RTCSessionDescription: typeof RTCSessionDescription
  RTCIceCandidate: typeof RTCIceCandidate
  MediaStream: typeof MediaStream
  nonstandard: {
    RTCAudioSource: new () => RTCAudioSource
    RTCAudioSink: new (track: MediaStreamTrack) => RTCAudioSink
  }
}

export interface RTCAudioSource {
  createTrack(): MediaStreamTrack
  onData(data: AudioData): void
}

export interface RTCAudioSink {
  ondata: ((data: AudioData) => void) | null
  stop(): void
}

export interface AudioData {
  samples: Int16Array
  sampleRate: number
  bitsPerSample: number
  channelCount: number
  numberOfFrames: number
}
