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
// ── RMS helper ────────────────────────────────────────────────────────────────
function computeRms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i] / 32768;
        sum += v * v;
    }
    return Math.sqrt(sum / samples.length);
}
// ── Mic capture ───────────────────────────────────────────────────────────────
// Uses arecord on Linux, sox on Windows.
// Returns a stop function.
function startMicCapture(source, isMuted = () => false, onLevel) {
    let overflow = Buffer.alloc(0);
    let frameCount = 0;
    function handleChunk(chunk) {
        frameCount++;
        if (frameCount === 1)
            console.log('[tailcom:audio] mic stream receiving data — first frame OK');
        if (frameCount === 100)
            console.log('[tailcom:audio] mic stream healthy — 100 frames captured');
        overflow = Buffer.concat([overflow, chunk]);
        while (overflow.length >= BYTES_PER_FRAME) {
            const frame = overflow.slice(0, BYTES_PER_FRAME);
            overflow = overflow.slice(BYTES_PER_FRAME);
            const samples = new Int16Array(FRAME_SAMPLES);
            for (let i = 0; i < FRAME_SAMPLES; i++) {
                samples[i] = frame.readInt16LE(i * 2);
            }
            if (!isMuted()) {
                source.onData({ samples, sampleRate: SAMPLE_RATE, bitsPerSample: BIT_DEPTH, channelCount: CHANNELS, numberOfFrames: FRAME_SAMPLES });
            }
            if (onLevel && frameCount % 10 === 0)
                onLevel(computeRms(samples));
        }
    }
    if (process.platform === 'win32') {
        // Bypass node-record-lpcm16 on Windows — spawn sox directly with waveaudio input
        console.log(`[tailcom:audio] startMicCapture — recorder=sox(waveaudio) rate=${SAMPLE_RATE} ch=${CHANNELS}`);
        const proc = (0, child_process_1.spawn)('sox', [
            '-t', 'waveaudio', 'default',
            '-r', String(SAMPLE_RATE),
            '-c', String(CHANNELS),
            '-e', 'signed-integer',
            '-b', String(BIT_DEPTH),
            '-t', 'raw', '-',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.on('error', (err) => console.error('[tailcom:audio] mic spawn error:', err.message));
        proc.on('exit', (code) => { if (code !== null && code !== 0)
            console.error(`[tailcom:audio] mic sox exited code ${code}`); });
        proc.stderr?.on('data', (d) => console.error('[tailcom:audio] mic stderr:', d.toString().trim()));
        proc.stdout?.on('data', handleChunk);
        proc.stdout?.on('error', (err) => console.error('[tailcom:audio] mic stdout error:', err.message));
        return () => {
            console.log('[tailcom:audio] stopMicCapture called');
            try {
                proc.kill();
            }
            catch { /* ignore */ }
        };
    }
    // Linux: use node-record-lpcm16 with arecord
    console.log(`[tailcom:audio] startMicCapture — recorder=arecord rate=${SAMPLE_RATE} ch=${CHANNELS}`);
    const recorder = record.record({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        audioType: 'raw',
        recorder: 'arecord',
        verbose: false,
        silence: 0,
    });
    const stream = recorder.stream();
    stream.on('data', handleChunk);
    stream.on('error', (err) => {
        console.error('[tailcom:audio] mic stream error:', err?.message ?? String(err));
    });
    return () => {
        console.log('[tailcom:audio] stopMicCapture called');
        try {
            recorder.stop();
        }
        catch { /* ignore */ }
    };
}
// ── Speaker playback ──────────────────────────────────────────────────────────
// Pipes raw PCM to aplay (Linux) or sox (Windows) via stdin.
// Returns a stop function.
function startSpeakerPlayback(sink, onLevel) {
    let player = null;
    if (process.platform === 'win32') {
        // sox on Windows: -t waveaudio is required for Windows audio output
        player = (0, child_process_1.spawn)('sox', [
            '-t', 'raw',
            '-r', String(SAMPLE_RATE),
            '-e', 'signed-integer',
            '-b', String(BIT_DEPTH),
            '-c', String(CHANNELS),
            '-', // stdin
            '-t', 'waveaudio',
            'default', // default audio device
        ], { stdio: ['pipe', 'ignore', 'pipe'] }); // capture stderr for diagnostics
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
    const playerBin = process.platform === 'win32' ? 'sox' : 'aplay';
    console.log(`[tailcom:audio] startSpeakerPlayback — player=${playerBin}`);
    player.stderr?.on('data', (d) => {
        console.error('[tailcom:audio] speaker stderr:', d.toString().trim());
    });
    player.on('error', (err) => {
        console.error('[tailcom:audio] speaker player error:', err.message);
    });
    player.on('exit', (code) => {
        if (code !== null && code !== 0)
            console.error(`[tailcom:audio] speaker player exited with code ${code}`);
    });
    player.stdin?.on('error', (err) => {
        console.error('[tailcom:audio] speaker stdin error (sox exited?):', err.message);
    });
    let speakerFrameCount = 0;
    sink.ondata = (data) => {
        if (speakerFrameCount === 0)
            console.log('[tailcom:audio] speaker receiving audio — first frame from dashboard');
        if (!player?.stdin?.writable)
            return;
        const buf = Buffer.from(data.samples.buffer, data.samples.byteOffset, data.samples.byteLength);
        player.stdin.write(buf);
        // Level metering — every 10 frames ≈ 100 ms
        speakerFrameCount++;
        if (onLevel && speakerFrameCount % 10 === 0) {
            onLevel(computeRms(data.samples));
        }
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