export interface AudioSource {
    onData(data: {
        samples: Int16Array;
        sampleRate: number;
        bitsPerSample: number;
        channelCount: number;
        numberOfFrames: number;
    }): void;
}
export interface AudioSink {
    ondata: ((data: {
        samples: Int16Array;
        sampleRate: number;
        bitsPerSample: number;
        channelCount: number;
        numberOfFrames: number;
    }) => void) | null;
}
export declare function startMicCapture(source: AudioSource, isMuted?: () => boolean, onLevel?: (rms: number) => void): () => void;
export declare function startSpeakerPlayback(sink: AudioSink, onLevel?: (rms: number) => void): () => void;
//# sourceMappingURL=audio.d.ts.map