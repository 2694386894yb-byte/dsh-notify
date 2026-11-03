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
export * from './constants.ts';
export * from './types.ts';
export * from './http.ts';
export * from './crypto.ts';
export * from './state.ts';
export * from './quota.ts';
export * from './login.ts';
export * from './channel.ts';
export * from './media.ts';
export * from './thumbnail.ts';
export * from './silk.ts';
export * from './session-index.ts';
export * from './render.ts';
export { SessionRouter, BROWSE_PAGE_SIZE, MISSING_BINDING_GRACE_MS, SHORT_ID_LENGTH, SHOW_REST, ambiguousFolderMessage, ambiguousTargetMessage, browsePage, heldNames, heldOnlyList, isShowRest, mintSessionId, relativeTime, renderFolderScreen, renderModelList, renderLevels, renderSessionRow, renderSessionScreen, resolveFolder, resolveLevel, resolveModelOption, resolveTarget, parseModelCommand, screenRows, sessionFolders, shortId, splitCommand, unprintedFolderMessage, unprintedTargetMessage, workspaceLabel, HELP_TEXT, type BindingStore, type BrowsePosition, type FolderResolution, type ListedSession, type ModelListing, type ModelOption, type ModelSelection, type ModelCommand, type ReasoningLevel, type NumberedRows, type NumberedSession, type RouteDecision, type RouteResult, type SessionBinding, type SessionFolder, type SessionGateway, type SessionRouterOptions, type SessionState, type TargetResolution, } from './router.ts';
//# sourceMappingURL=index.d.ts.map