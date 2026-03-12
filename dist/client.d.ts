import { EventEmitter } from 'events';
import type { TailcomClientOptions } from './types';
export declare class TailcomClient extends EventEmitter {
    private readonly port;
    private readonly autoAccept;
    private readonly autoRejectTimeout;
    private server;
    private wss;
    private activeSocket;
    private webrtc;
    private inCall;
    private pendingOffer;
    private autoRejectTimer;
    constructor(options?: TailcomClientOptions);
    /**
     * Accept a pending incoming call (only relevant when autoAccept is false).
     * Does nothing if there is no pending offer.
     */
    acceptCall(): void;
    /**
     * Reject a pending incoming call (only relevant when autoAccept is false).
     * Sends a hangup back to the dashboard and resets state.
     */
    rejectCall(): void;
    start(): Promise<void>;
    stop(): void;
    private handleConnection;
    private handleMessage;
    private holdOffer;
    private clearPending;
    private handleOffer;
    private teardownCall;
    private send;
}
//# sourceMappingURL=client.d.ts.map