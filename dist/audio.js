"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMicCapture = startMicCapture;
exports.startSpeakerPlayback = startSpeakerPlayback;
const child_process_1 = require("child_process");
// Inline types — no @types/node-record-lpcm16 on npm
// eslint-disable-next-line @typescript-eslint/no-require-imports
const record = require('node-record-lpcm16');
// PCM format used throughout — must match wrtc RTCAudioSource/Sink
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const FRAME_MS = 10;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 480 samples per frame
const BYTES_PER_FRAME = FRAME_SAMPLES * (BIT_DEPTH / 8); // 960 bytes per frame
// ── Mic capture ───────────────────────────────────────────────────────────────
// Uses arecord on Linux, sox on Windows.
// Returns a stop function.
function startMicCapture(source, isMuted = () => false) {
    const recorder = record.record({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        audioType: 'raw',
        recorder: process.platform === 'win32' ? 'sox' : 'arecord',
        verbose: false,
        silence: 0,
    });
    let overflow = Buffer.alloc(0);
    const stream = recorder.stream();
    stream.on('data', (chunk) => {
        overflow = Buffer.concat([overflow, chunk]);
        while (overflow.length >= BYTES_PER_FRAME) {
            const frame = overflow.slice(0, BYTES_PER_FRAME);
            overflow = overflow.slice(BYTES_PER_FRAME);
            if (!isMuted()) {
                // Create a copy so the Int16Array owns its memory
                const samples = new Int16Array(FRAME_SAMPLES);
                for (let i = 0; i < FRAME_SAMPLES; i++) {
                    samples[i] = frame.readInt16LE(i * 2);
                }
                source.onData({
                    samples,
                    sampleRate: SAMPLE_RATE,
                    bitsPerSample: BIT_DEPTH,
                    channelCount: CHANNELS,
                    numberOfFrames: FRAME_SAMPLES,
                });
            }
        }
    });
    stream.on('error', () => { });
    return () => {
        try {
            recorder.stop();
        }
        catch { /* ignore */ }
    };
}
// ── Speaker playback ──────────────────────────────────────────────────────────
// Pipes raw PCM to aplay (Linux) or sox (Windows) via stdin.
// Returns a stop function.
function startSpeakerPlayback(sink) {
    let player = null;
    if (process.platform === 'win32') {
        // sox on Windows: read raw PCM from stdin, output to default sound device
        player = (0, child_process_1.spawn)('sox', [
            '-t', 'raw',
            '-r', String(SAMPLE_RATE),
            '-e', 'signed-integer',
            '-b', String(BIT_DEPTH),
            '-c', String(CHANNELS),
            '-', // stdin
            '-d', // default audio device
        ], { stdio: ['pipe', 'ignore', 'ignore'] });
    }
    else {
        // aplay on Linux
        player = (0, child_process_1.spawn)('aplay', [
            '-r', String(SAMPLE_RATE),
            '-c', String(CHANNELS),
            '-f', 'S16_LE',
            '-t', 'raw',
            '-', // stdin
        ], { stdio: ['pipe', 'ignore', 'ignore'] });
    }
    player.on('error', () => { });
    sink.ondata = (data) => {
        if (!player?.stdin?.writable)
            return;
        const buf = Buffer.from(data.samples.buffer, data.samples.byteOffset, data.samples.byteLength);
        player.stdin.write(buf);
    };
    return () => {
        sink.ondata = null;
        try {
            player?.stdin?.end();
        }
        catch { /* ignore */ }
        try {
            player?.kill();
        }
        catch { /* ignore */ }
        player = null;
    };
}
//# sourceMappingURL=audio.js.map