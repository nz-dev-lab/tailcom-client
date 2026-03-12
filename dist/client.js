"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TailcomClient = void 0;
const events_1 = require("events");
const http = __importStar(require("http"));
const ws_1 = require("ws");
const webrtc_1 = require("./webrtc");
const DEFAULT_PORT = 7654;
class TailcomClient extends events_1.EventEmitter {
    constructor(options = {}) {
        super();
        this.server = null;
        this.wss = null;
        this.activeSocket = null;
        this.webrtc = null;
        this.inCall = false;
        // Pending state when autoAccept is false
        this.pendingOffer = null;
        this.autoRejectTimer = null;
        this.port = options.port ?? DEFAULT_PORT;
        this.autoAccept = options.autoAccept ?? true;
        this.autoRejectTimeout = options.autoRejectTimeout ?? 30;
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * Accept a pending incoming call (only relevant when autoAccept is false).
     * Does nothing if there is no pending offer.
     */
    acceptCall() {
        if (!this.pendingOffer || !this.activeSocket)
            return;
        const offer = this.pendingOffer;
        const ws = this.activeSocket;
        this.clearPending();
        void this.handleOffer(ws, offer);
    }
    /**
     * Reject a pending incoming call (only relevant when autoAccept is false).
     * Sends a hangup back to the dashboard and resets state.
     */
    rejectCall() {
        this.clearPending();
        if (this.activeSocket) {
            const ws = this.activeSocket;
            this.activeSocket = null;
            if (ws.readyState === ws_1.WebSocket.OPEN) {
                try {
                    this.send(ws, { type: 'hangup' });
                    ws.close();
                }
                catch { /* ignore */ }
            }
        }
    }
    async start() {
        if (this.wss)
            return; // already running
        await new Promise((resolve, reject) => {
            this.server = http.createServer();
            this.wss = new ws_1.WebSocketServer({ server: this.server });
            this.wss.on('connection', (ws) => this.handleConnection(ws));
            this.wss.on('error', (err) => this.emit('error', err));
            this.server.listen(this.port, () => resolve());
            this.server.on('error', reject);
        });
    }
    stop() {
        this.teardownCall();
        this.wss?.close();
        this.server?.close();
        this.wss = null;
        this.server = null;
    }
    // ── Connection handling ────────────────────────────────────────────────────
    handleConnection(ws) {
        // Only one connection at a time — reject extras
        if (this.activeSocket) {
            ws.close(1008, 'busy');
            return;
        }
        this.activeSocket = ws;
        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            this.handleMessage(ws, msg);
        });
        ws.on('close', () => {
            if (ws === this.activeSocket) {
                this.teardownCall();
            }
        });
        ws.on('error', (err) => {
            this.emit('error', err);
            if (ws === this.activeSocket) {
                this.teardownCall();
            }
        });
    }
    // ── Message routing ────────────────────────────────────────────────────────
    handleMessage(ws, msg) {
        switch (msg.type) {
            case 'ping':
                this.send(ws, { type: 'pong' });
                break;
            case 'offer':
                if (this.autoAccept) {
                    void this.handleOffer(ws, msg.sdp);
                }
                else {
                    this.holdOffer(ws, msg.sdp);
                }
                break;
            case 'ice-candidate':
                void this.webrtc?.addIceCandidate(msg.candidate);
                break;
            case 'hangup':
                this.teardownCall();
                break;
        }
    }
    // ── Pending-call helpers (autoAccept: false) ───────────────────────────────
    holdOffer(_ws, offer) {
        // Already in a call or holding another offer — ignore
        if (this.inCall || this.pendingOffer)
            return;
        this.pendingOffer = offer;
        this.emit('incoming-call');
        // Auto-reject after timeout
        this.autoRejectTimer = setTimeout(() => {
            this.rejectCall();
        }, this.autoRejectTimeout * 1000);
    }
    clearPending() {
        if (this.autoRejectTimer) {
            clearTimeout(this.autoRejectTimer);
            this.autoRejectTimer = null;
        }
        this.pendingOffer = null;
    }
    // ── Call logic ─────────────────────────────────────────────────────────────
    async handleOffer(ws, offer) {
        if (this.inCall)
            return;
        try {
            const handler = new webrtc_1.WebRTCHandler();
            this.webrtc = handler;
            // Forward ICE candidates to dashboard
            handler.on('ice-candidate', (msg) => {
                if (ws.readyState === ws_1.WebSocket.OPEN) {
                    this.send(ws, msg);
                }
            });
            handler.on('connected', () => {
                this.inCall = true;
                this.emit('call-started');
            });
            handler.on('disconnected', () => {
                this.teardownCall();
            });
            handler.on('error', (err) => {
                this.emit('error', err);
                this.teardownCall();
            });
            handler.createPeerConnection();
            const answer = await handler.createAnswer(offer);
            this.send(ws, { type: 'answer', sdp: answer });
        }
        catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
            this.teardownCall();
        }
    }
    teardownCall() {
        this.clearPending();
        const wasInCall = this.inCall;
        this.inCall = false;
        this.webrtc?.teardown();
        this.webrtc = null;
        if (this.activeSocket) {
            const ws = this.activeSocket;
            this.activeSocket = null;
            // Send hangup if socket still open, then close
            if (ws.readyState === ws_1.WebSocket.OPEN) {
                try {
                    this.send(ws, { type: 'hangup' });
                    ws.close();
                }
                catch { /* ignore */ }
            }
        }
        if (wasInCall) {
            this.emit('call-ended');
        }
    }
    // ── Helpers ────────────────────────────────────────────────────────────────
    send(ws, msg) {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
}
exports.TailcomClient = TailcomClient;
//# sourceMappingURL=client.js.map