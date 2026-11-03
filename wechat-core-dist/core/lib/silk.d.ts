/**
 * Voice transcoding: Tencent SILK in, WAV out.
 *
 * WeChat voice notes arrive as SILK, which nothing on this side can play or transcribe. The
 * codec lives in `silk-wasm`, resolved at runtime rather than declared as a hard dependency:
 * the plugin has to keep working without it, falling back to handing over the raw SILK and
 * whatever transcript the service supplied.
 *
 * @see `@tencent-weixin/openclaw-weixin` `src/media/silk-transcode.ts`, which this mirrors.
 *
 * @module @dsh-wechat/core/silk
 */
/** Sample rate WeChat records voice at, and the rate the decoder must be told to emit. */
export declare const SILK_SAMPLE_RATE = 24000;
/** Whether voice can be transcoded in this deployment. */
export declare function silkAvailable(): boolean;
/** Drop the memoised codec, so a test can re-resolve under a changed environment. */
export declare function forgetSilkCache(): void;
/**
 * Wrap raw `pcm_s16le` bytes in a WAV container.
 *
 * Mono, 16-bit signed little-endian — the only shape the decoder emits. Written by hand
 * because a 44-byte header is cheaper than a RIFF-writing dependency.
 *
 * @param pcm - Raw PCM samples.
 * @param sampleRate - Samples per second.
 * @returns A complete WAV file.
 */
export declare function pcmToWav(pcm: Uint8Array, sampleRate?: number): Buffer;
/**
 * Transcode one SILK voice note to WAV.
 *
 * @param silk - Raw SILK bytes as downloaded.
 * @returns The WAV bytes and the decoded duration, or `undefined` when the codec is missing
 *   or the input cannot be decoded. A failure here degrades the attachment; it must not lose
 *   the voice note.
 */
export declare function silkToWav(silk: Buffer): Promise<{
    data: Buffer;
    durationMs: number;
} | undefined>;
//# sourceMappingURL=silk.d.ts.map