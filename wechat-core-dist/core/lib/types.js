/**
 * Wire types for the Tencent iLink Bot API.
 *
 * The API speaks JSON over HTTP. Fields the protocol defines as `uint64` (message
 * identifiers) are parsed as strings on purpose — see {@link parseWireJson}.
 *
 * @module @dsh-wechat/core/types
 */
/** `media_type` for `getuploadurl`. Phase 2 uses these. */
export const UploadMediaType = {
    IMAGE: 1,
    VIDEO: 2,
    FILE: 3,
    VOICE: 4,
};
/** Author of a message. */
export const MessageType = {
    NONE: 0,
    USER: 1,
    BOT: 2,
};
/**
 * Content element kinds.
 */
export const MessageItemType = {
    NONE: 0,
    TEXT: 1,
    IMAGE: 2,
    VOICE: 3,
    FILE: 4,
    VIDEO: 5,
};
/**
 * Message lifecycle.
 *
 * `NEW -> GENERATING -> FINISH` is what enables progressive updates: an outbound
 * message can be revised while it is still generating.
 */
export const MessageState = {
    NEW: 0,
    GENERATING: 1,
    FINISH: 2,
};
/** `status` for `sendtyping`. */
export const TypingStatus = {
    TYPING: 1,
    CANCEL: 2,
};
//# sourceMappingURL=types.js.map