"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebRTCHandler = void 0;
const events_1 = require("events");
const audio_1 = require("./audio");
// Load wrtc for Node/Electron main process.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wrtc = require('@roamhq/wrtc');
class WebRTCHandler extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.pc = null;
        this.audioSink = null;
        this.stopMic = null;
        this.stopSpeaker = null;
    }
    createPeerConnection() {
        const pc = new wrtc.RTCPeerConnection({ iceServers: [] });
        // Add a mic track so the remote side receives audio from us
        const micSource = new wrtc.nonstandard.RTCAudioSource();
        pc.addTrack(micSource.createTrack());
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.emit('ice-candidate', {
                    type: 'ice-candidate',
                    candidate: event.candidate.toJSON(),
                });
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                // Start real mic capture — push samples into wrtc source
                this.stopMic = (0, audio_1.startMicCapture)({ onData: (d) => micSource.onData(d) });
                this.emit('connected');
            }
            else if (pc.connectionState === 'disconnected' ||
                pc.connectionState === 'failed' ||
                pc.connectionState === 'closed') {
                this.emit('disconnected');
            }
        };
        pc.ontrack = (event) => {
            const track = event.track;
            if (track.kind !== 'audio')
                return;
            // Attach sink to receive incoming audio from dashboard
            const sink = new wrtc.nonstandard.RTCAudioSink(track);
            this.audioSink = sink;
            // Play incoming audio through system speakers
            this.stopSpeaker = (0, audio_1.startSpeakerPlayback)(sink);
        };
        this.pc = pc;
        return pc;
    }
    async createAnswer(offer) {
        if (!this.pc)
            throw new Error('No peer connection — call createPeerConnection() first');
        await this.pc.setRemoteDescription(new wrtc.RTCSessionDescription(offer));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        if (!this.pc.localDescription)
            throw new Error('Failed to set local description');
        return this.pc.localDescription;
    }
    async addIceCandidate(candidate) {
        if (!this.pc)
            return;
        try {
            await this.pc.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
        }
        catch { /* stale candidate — non-fatal */ }
    }
    teardown() {
        this.stopMic?.();
        this.stopMic = null;
        this.stopSpeaker?.();
        this.stopSpeaker = null;
        if (this.audioSink) {
            try {
                this.audioSink.stop();
            }
            catch { /* ignore */ }
            this.audioSink = null;
        }
        if (this.pc) {
            try {
                this.pc.close();
            }
            catch { /* ignore */ }
            this.pc = null;
        }
    }
}
exports.WebRTCHandler = WebRTCHandler;
//# sourceMappingURL=webrtc.js.map