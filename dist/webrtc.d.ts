import { EventEmitter } from 'events';
export declare class WebRTCHandler extends EventEmitter {
    private pc;
    private audioSink;
    private stopMic;
    private stopSpeaker;
    createPeerConnection(): RTCPeerConnection;
    createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
    addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
    teardown(): void;
}
//# sourceMappingURL=webrtc.d.ts.map