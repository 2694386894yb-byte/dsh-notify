/**
 * Media transfer: send images and files to a chat, and fetch what arrived.
 *
 * The flow is the same in both directions and is split across two services:
 *
 *   upload   `getuploadurl` reserves a slot and returns a signed CDN target, then
 *            the client encrypts the plaintext and POSTs it to that target.
 *   download the item carries a CDN reference plus the AES key; the client fetches
 *            the ciphertext and decrypts it locally.
 *
 * Every byte is AES-128-ECB with PKCS#7 padding. The upload declares three numbers
 * that must agree with the actual bytes — plaintext size, plaintext MD5, and the
 * *padded ciphertext* size — because the service validates them.
 *
 * @module @dsh-wechat/core/media
 */
import type { CDNMedia, MessageItem, UploadMediaTypeValue, WeixinAccount } from './types.ts';
/**
 * A file larger than this is refused before any network work.
 *
 * 100 MB, matching the reference implementation's inbound ceiling. A lower local limit
 * rejects files the service is perfectly willing to carry.
 */
export declare const MAX_MEDIA_BYTES: number;
/** What an upload produced, in the terms the message item needs. */
export interface UploadedMedia {
    /** CDN reference to embed in the item. */
    media: CDNMedia;
    /** Plaintext size. */
    size: number;
    /** Padded ciphertext size, which is what some item fields expect. */
    ciphertextSize: number;
    /** Original file name, for `file_item`. */
    fileName: string;
    /** Original plaintext MD5, for `file_item`. */
    md5: string;
    /**
     * Raw AES-128 key, hex encoded.
     *
     * Carried separately because an image item declares the key in two places: the media
     * reference uses base64, while `image_item.aeskey` uses raw hex. The service sends both
     * on an inbound photo, and a reference carrying only the base64 form cannot be
     * decrypted by the recipient, which is what renders as an empty placeholder.
     */
    aesKeyHex: string;
    /**
     * Uploaded thumbnail, when one could be produced.
     *
     * A chat bubble paints the thumbnail, so an image sent without one shows as an empty
     * placeholder even though the full-size object is present and fetchable. Absent when no
     * image encoder is available in the deployment.
     */
    thumbnail?: {
        media: CDNMedia;
        size: number;
        width: number;
        height: number;
    };
}
/** Options for {@link uploadMedia}. */
export interface UploadOptions {
    account: WeixinAccount;
    /** Recipient user id. The service requires it on the upload request. */
    toUserId: string;
    /** Bytes to send. */
    data: Buffer;
    /** File name shown to the recipient. */
    fileName: string;
    /** Media kind, which selects the service-side handling. */
    mediaType: UploadMediaTypeValue;
    /** Override the CDN host. Tests only. */
    cdnBaseUrl?: string;
    signal?: AbortSignal;
    /**
     * Optional observer for the raw `getuploadurl` response and the derived upload target.
     *
     * The service returns more than this client consumes, and the gap between what it
     * offers and what a message actually references is exactly how a sent image can be
     * accepted by the service yet never render for the recipient.
     */
    onDiagnostic?: (detail: {
        uploadUrl: string;
        downloadParam: string;
        response: Record<string, unknown>;
    }) => void;
}
/**
 * Reserve an upload slot, encrypt, and push the bytes to the CDN.
 *
 * @param options - See {@link UploadOptions}.
 * @returns The reference and the numbers a message item needs.
 * @throws {Error} When the file is too large, or the service returns no upload URL.
 */
export declare function uploadMedia(options: UploadOptions): Promise<UploadedMedia>;
/** Convenience wrapper for sending an image file from disk. */
export declare function uploadImage(params: {
    account: WeixinAccount;
    toUserId: string;
    path: string;
    signal?: AbortSignal;
}): Promise<UploadedMedia>;
/** Convenience wrapper for sending a generic file attachment from disk. */
export declare function uploadFile(params: {
    account: WeixinAccount;
    toUserId: string;
    path: string;
    fileName?: string;
    signal?: AbortSignal;
}): Promise<UploadedMedia>;
/**
 * Send an already-uploaded image.
 *
 * @param params.account - Sending bot.
 * @param params.to - Recipient user id.
 * @param params.uploaded - Result of {@link uploadMedia} with `IMAGE`.
 * @param params.contextToken - Token from the inbound message being answered.
 */
export declare function sendImage(params: {
    account: WeixinAccount;
    to: string;
    uploaded: UploadedMedia;
    contextToken?: string;
    signal?: AbortSignal;
}): Promise<{
    clientId: string;
    serverMessageId?: string;
}>;
/** Convenience wrapper for sending a video file from disk. */
export declare function uploadVideo(params: {
    account: WeixinAccount;
    toUserId: string;
    path: string;
    signal?: AbortSignal;
}): Promise<UploadedMedia>;
/**
 * Send an already-uploaded video.
 *
 * Video is its own item kind with its own handler, not a file attachment: the reference
 * implementation uploads it as `UploadMediaType.VIDEO` and sends a `video_item`, and a raw
 * video routed through the file path arrives as an opaque download instead of a playable
 * clip.
 *
 * @param params.account - Sending bot.
 * @param params.to - Recipient user id.
 * @param params.uploaded - Result of {@link uploadMedia} with `VIDEO`.
 * @param params.contextToken - Token from the inbound message being answered.
 */
export declare function sendVideo(params: {
    account: WeixinAccount;
    to: string;
    uploaded: UploadedMedia;
    contextToken?: string;
    signal?: AbortSignal;
}): Promise<{
    clientId: string;
    serverMessageId?: string;
}>;
/**
 * Send an already-uploaded file attachment.
 *
 * `len` is a uint64 on the wire, so it goes out as a string.
 */
export declare function sendFile(params: {
    account: WeixinAccount;
    to: string;
    uploaded: UploadedMedia;
    contextToken?: string;
    signal?: AbortSignal;
}): Promise<{
    clientId: string;
    serverMessageId?: string;
}>;
/** Send one structured item as a finished bot message. */
export declare function sendItem(params: {
    account: WeixinAccount;
    to: string;
    item: MessageItem;
    contextToken?: string;
    /**
     * Identifier of the agent run this item belongs to.
     *
     * The reference client stamps every item of one run with the same `run_id`, and the progress
     * cards in particular are grouped by it. Omitting it makes a card an orphan message the
     * client has no run to attach to — which is consistent with a card that is accepted by the
     * service and never rendered.
     */
    runId?: string;
    signal?: AbortSignal;
}): Promise<{
    clientId: string;
    serverMessageId?: string;
}>;
/** One attachment recovered from an inbound message. */
export interface DownloadedMedia {
    /** Which item kind it came from. */
    kind: 'image' | 'file' | 'voice' | 'video';
    /** Plaintext bytes. */
    data: Buffer;
    /** File name for files; a synthesised one otherwise. */
    fileName: string;
    /** Content type when it can be inferred. */
    contentType?: string;
    /** Original plaintext size as declared by the sender, for files. */
    declaredSize?: number;
    /** Server-side transcript, for voice. */
    transcript?: string;
    /** Wire encoding for voice: 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex. */
    codec?: number;
    /** Decoded length in milliseconds, for voice that was transcoded and for video. */
    durationMs?: number;
    /** Content MD5 as declared by the sender, for video. */
    md5?: string;
}
/** Options for {@link downloadItemMedia}. */
export interface DownloadOptions {
    /** The item to fetch. */
    item: MessageItem;
    /** Override the CDN host. Tests only. */
    cdnBaseUrl?: string;
    signal?: AbortSignal;
}
/**
 * Fetch and decrypt whatever media one inbound item carries.
 *
 * @param options - See {@link DownloadOptions}.
 * @returns The plaintext, or `undefined` when the item holds no usable media.
 */
export declare function downloadItemMedia(options: DownloadOptions): Promise<DownloadedMedia | undefined>;
/**
 * Whether an item carries downloadable media.
 *
 * The payload check matters as much as the type tag: a malformed or stripped item can
 * keep its type while losing its `media` reference, and treating that as an attachment
 * produces an inbound message with neither text nor anything to fetch.
 */
export declare function isMediaItem(item: MessageItem): boolean;
/** Build the CDN download URL from a reference. */
export declare function buildDownloadUrl(reference: CDNMedia, cdnBaseUrl?: string): string;
//# sourceMappingURL=media.d.ts.map