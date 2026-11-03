/**
 * AES-128-ECB crypto for Tencent CDN media.
 *
 * Every media blob the service moves — images, voice, files, video — is encrypted
 * with AES-128-ECB and PKCS#7 padding before it reaches the CDN. Two details are
 * easy to get wrong and are handled here:
 *
 * 1. **Key encoding varies.** Images carry a raw hex key on the item
 *    (`image_item.aeskey`), while other kinds carry a base64 key on the media
 *    reference. Worse, that base64 sometimes encodes the 16 raw bytes and sometimes
 *    encodes a 32-character hex *string*. {@link parseAesKey} accepts all of them.
 * 2. **The advertised ciphertext size is the padded size**, not the plaintext size.
 *    The upload request has to declare both.
 *
 * @module @dsh-wechat/core/crypto
 */
/** Encrypt with AES-128-ECB. PKCS#7 padding is the default. */
export declare function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer;
/** Decrypt with AES-128-ECB (PKCS#7 padding). */
export declare function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer;
/**
 * Ciphertext size for a given plaintext size.
 *
 * PKCS#7 always appends padding, so a 16-byte input becomes 32 bytes.
 */
export declare function aesEcbPaddedSize(plaintextSize: number): number;
/** Generate a fresh 16-byte AES key, as the upload flow requires per file. */
export declare function newAesKey(): Buffer;
/**
 * Normalise whatever key encoding the wire used into 16 raw bytes.
 *
 * Accepts, in order:
 *   - a 32-character hex string (`image_item.aeskey`)
 *   - base64 of 16 raw bytes (the common case)
 *   - base64 of a 32-character hex string (seen on file/voice/video)
 *
 * @param value - Key exactly as it appeared on the wire.
 * @param label - Context for the error message.
 * @throws {Error} When the value decodes to neither shape.
 */
export declare function parseAesKey(value: string, label?: string): Buffer;
/**
 * Resolve the key for one inbound item.
 *
 * Images are the special case: the item-level `aeskey` is raw hex and takes
 * precedence over the media-level base64 key.
 *
 * @param itemAesKeyHex - `image_item.aeskey`, when present.
 * @param mediaAesKeyBase64 - `media.aes_key`, when present.
 */
export declare function resolveInboundKey(params: {
    itemAesKeyHex?: string;
    mediaAesKeyBase64?: string;
    label?: string;
}): Buffer;
/** Hex render used by the upload request's `aeskey` field. */
export declare function aesKeyToHex(key: Buffer): string;
/**
 * Base64 render used by `CDNMedia.aes_key`.
 *
 * Encodes the *hex text* of the key, not its 16 raw bytes. The two differ in length
 * (44 vs 24 characters) and only this one decrypts: the raw form yields a message the
 * recipient accepts and cannot decode, which surfaces as a grey placeholder in the chat
 * rather than as any kind of error.
 *
 * Mirrors the reference implementation's `Buffer.from(aeskey).toString("base64")`, where
 * `aeskey` is already the hex string.
 */
export declare function aesKeyToBase64(key: Buffer): string;
/**
 * The raw-16-byte base64 form.
 *
 * Kept because inbound items have been seen to carry it; {@link parseAesKey} accepts every
 * encoding, so a reader never has to know which one arrived.
 */
export declare function aesKeyToBase64Raw(key: Buffer): string;
//# sourceMappingURL=crypto.d.ts.map