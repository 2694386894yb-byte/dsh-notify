/**
 * Thumbnail generation for outbound images.
 *
 * A WeChat chat bubble is rendered from a thumbnail, not from the full-size object. An
 * image item that references only the original shows as an empty placeholder: the
 * message arrives, and there is nothing for the client to paint.
 *
 * The encoder is `sharp`, which ships with the application and resolves from the
 * profile. It is loaded lazily and treated as optional: without it the caller falls back
 * to sending the original object alone, which is worse but still a delivered file.
 *
 * @module @dsh-wechat/core/thumbnail
 */
/**
 * Whether the optional codecs are switched off by configuration.
 *
 * `sharp` and `silk-wasm` are resolved at runtime, and neither is a dependency of this package — a
 * fresh install has `sharp` only because the application ships it, and `silk-wasm` at all only if
 * someone installed it. The paths that handle their absence are therefore the common path, and this
 * switch makes them reachable on a machine where the codec *is* present: without it those paths can
 * only be reasoned about, never executed, and a regression that made a missing codec throw would
 * pass every test and break for every new user.
 *
 * Set `DSH_WECHAT_NO_CODECS=1` to force both codecs unavailable. It is also the quick way to confirm
 * which behaviour a stripped deployment will get.
 *
 * @returns True when the codecs must report themselves unavailable.
 */
export declare function codecsDisabled(): boolean;
/** Drop the memoised encoder, so a test can re-resolve under a changed environment. */
export declare function forgetCodecCache(): void;
/** Whether a thumbnail can be produced in this deployment. */
export declare function thumbnailAvailable(): Promise<boolean>;
/**
 * Render a compact JPEG thumbnail for one image.
 *
 * @param data - Original image bytes, in any format `sharp` reads.
 * @returns Thumbnail bytes with their pixel size, or `undefined` when no encoder is
 *   available or the input cannot be decoded.
 */
export declare function makeThumbnail(data: Buffer): Promise<{
    data: Buffer;
    width: number;
    height: number;
} | undefined>;
//# sourceMappingURL=thumbnail.d.ts.map