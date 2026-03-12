import { EventEmitter } from 'events'
import * as http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { WebRTCHandler } from './webrtc'
import type {
  TailcomClientOptions,
  IncomingMessage,
  OutgoingMessage,
} from './types'

const DEFAULT_PORT = 7654

export class TailcomClient extends EventEmitter {
  private readonly port: number
  private readonly autoAccept: boolean
  private readonly autoRejectTimeout: number

  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private activeSocket: WebSocket | null = null
  private webrtc: WebRTCHandler | null = null
  private inCall = false

  // Pending state when autoAccept is false
  private pendingOffer: RTCSessionDescriptionInit | null = null
  private autoRejectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: TailcomClientOptions = {}) {
    super()
    this.port = options.port ?? DEFAULT_PORT
    this.autoAccept = options.autoAccept ?? true
    this.autoRejectTimeout = options.autoRejectTimeout ?? 30
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Accept a pending incoming call (only relevant when autoAccept is false).
   * Does nothing if there is no pending offer.
   */
  acceptCall(): void {
    if (!this.pendingOffer || !this.activeSocket) return
    const offer = this.pendingOffer
    const ws = this.activeSocket
    this.clearPending()
    void this.handleOffer(ws, offer)
  }

  /**
   * Reject a pending incoming call (only relevant when autoAccept is false).
   * Sends a hangup back to the dashboard and resets state.
   */
  rejectCall(): void {
    this.clearPending()
    if (this.activeSocket) {
      const ws = this.activeSocket
      this.activeSocket = null
      if (ws.readyState === WebSocket.OPEN) {
        try {
          this.send(ws, { type: 'hangup' })
          ws.close()
        } catch { /* ignore */ }
      }
    }
  }

  async start(): Promise<void> {
    if (this.wss) return // already running

    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer()
      this.wss = new WebSocketServer({ server: this.server })

      this.wss.on('connection', (ws) => this.handleConnection(ws))
      this.wss.on('error', (err) => this.emit('error', err))

      this.server.listen(this.port, () => resolve())
      this.server.on('error', reject)
    })
  }

  stop(): void {
    this.teardownCall()

    this.wss?.close()
    this.server?.close()
    this.wss = null
    this.server = null
  }

  // ── Connection handling ────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    // Only one connection at a time — reject extras
    if (this.activeSocket) {
      ws.close(1008, 'busy')
      return
    }

    this.activeSocket = ws

    ws.on('message', (data) => {
      let msg: IncomingMessage
      try {
        msg = JSON.parse(data.toString()) as IncomingMessage
      } catch {
        return
      }
      this.handleMessage(ws, msg)
    })

    ws.on('close', () => {
      if (ws === this.activeSocket) {
        this.teardownCall()
      }
    })

    ws.on('error', (err) => {
      this.emit('error', err)
      if (ws === this.activeSocket) {
        this.teardownCall()
      }
    })
  }

  // ── Message routing ────────────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, msg: IncomingMessage): void {
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong' })
        break

      case 'offer':
        if (this.autoAccept) {
          void this.handleOffer(ws, msg.sdp)
        } else {
          this.holdOffer(ws, msg.sdp)
        }
        break

      case 'ice-candidate':
        void this.webrtc?.addIceCandidate(msg.candidate)
        break

      case 'hangup':
        this.teardownCall()
        break
    }
  }

  // ── Pending-call helpers (autoAccept: false) ───────────────────────────────

  private holdOffer(_ws: WebSocket, offer: RTCSessionDescriptionInit): void {
    // Already in a call or holding another offer — ignore
    if (this.inCall || this.pendingOffer) return

    this.pendingOffer = offer
    this.emit('incoming-call')

    // Auto-reject after timeout
    this.autoRejectTimer = setTimeout(() => {
      this.rejectCall()
    }, this.autoRejectTimeout * 1000)
  }

  private clearPending(): void {
    if (this.autoRejectTimer) {
      clearTimeout(this.autoRejectTimer)
      this.autoRejectTimer = null
    }
    this.pendingOffer = null
  }

  // ── Call logic ─────────────────────────────────────────────────────────────

  private async handleOffer(
    ws: WebSocket,
    offer: RTCSessionDescriptionInit,
  ): Promise<void> {
    if (this.inCall) return

    try {
      const handler = new WebRTCHandler()
      this.webrtc = handler

      // Forward ICE candidates to dashboard
      handler.on('ice-candidate', (msg) => {
        if (ws.readyState === WebSocket.OPEN) {
          this.send(ws, msg as OutgoingMessage)
        }
      })

      handler.on('connected', () => {
        this.inCall = true
        this.emit('call-started')
      })

      handler.on('disconnected', () => {
        this.teardownCall()
      })

      handler.on('error', (err) => {
        this.emit('error', err)
        this.teardownCall()
      })

      handler.createPeerConnection()
      const answer = await handler.createAnswer(offer)
      this.send(ws, { type: 'answer', sdp: answer })
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      this.teardownCall()
    }
  }

  private teardownCall(): void {
    this.clearPending()
    const wasInCall = this.inCall
    this.inCall = false

    this.webrtc?.teardown()
    this.webrtc = null

    if (this.activeSocket) {
      const ws = this.activeSocket
      this.activeSocket = null
      // Send hangup if socket still open, then close
      if (ws.readyState === WebSocket.OPEN) {
        try {
          this.send(ws, { type: 'hangup' })
          ws.close()
        } catch { /* ignore */ }
      }
    }

    if (wasInCall) {
      this.emit('call-ended')
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private send(ws: WebSocket, msg: OutgoingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }
}
