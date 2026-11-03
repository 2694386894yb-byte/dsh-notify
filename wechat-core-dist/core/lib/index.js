/**
 * `@dsh-wechat/core` — a client for the Tencent iLink Bot API, which is the
 * backend behind the official WeChat ClawBot plugin.
 *
 * The API is plain HTTP/JSON with an outbound long poll, so a machine running DSH
 * can receive WeChat messages from anywhere without a tunnel, a public address, or
 * any inbound port. This package contains only that client: no DSH imports, so it
 * can be unit-tested and reused on its own.
 *
 * Phase 1 covers text. Media transfer (AES-128-ECB plus Tencent CDN) is phase 2.
 *
 * @module @dsh-wechat/core
 */
export * from "./constants.js";
export * from "./types.js";
export * from "./http.js";
export * from "./crypto.js";
export * from "./state.js";
export * from "./quota.js";
export * from "./login.js";
export * from "./channel.js";
export * from "./media.js";
export * from "./thumbnail.js";
export * from "./silk.js";
export * from "./session-index.js";
export * from "./render.js";
export { SessionRouter, BROWSE_PAGE_SIZE, MISSING_BINDING_GRACE_MS, SHORT_ID_LENGTH, SHOW_REST, ambiguousFolderMessage, ambiguousTargetMessage, browsePage, heldNames, heldOnlyList, isShowRest, mintSessionId, relativeTime, renderFolderScreen, renderModelList, renderLevels, renderSessionRow, renderSessionScreen, resolveFolder, resolveLevel, resolveModelOption, resolveTarget, parseModelCommand, screenRows, sessionFolders, shortId, splitCommand, unprintedFolderMessage, unprintedTargetMessage, workspaceLabel, HELP_TEXT, } from "./router.js";
//# sourceMappingURL=index.js.map