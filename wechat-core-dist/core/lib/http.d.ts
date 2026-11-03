/**
 * HTTP transport for the iLink Bot API.
 *
 * Two details matter and are easy to get wrong:
 *
 * 1. Request headers. Every call carries `iLink-App-Id`, `iLink-App-ClientVersion`
 *    and a random `X-WECHAT-UIN`; authenticated calls add `AuthorizationType:
 *    ilink_bot_token` plus the bearer token.
 * 2. Identifier precision. The protocol defines several identifiers as `uint64`.
 *    They arrive as bare JSON numbers, so a plain `JSON.parse` would silently
 *    round 19-digit message ids. {@link parseWireJson} quotes those fields before
 *    parsing, copying Tencent's own scanner.
 *
 * @module @dsh-wechat/core/http
 */
import { DEFAULT_API_TIMEOUT_MS } from './constants.ts';
import type { BaseInfo, SendMessageResp } from './types.ts';
/**
 * A send the service refused.
 *
 * Distinct from every other failure on this path because it is the one kind that can succeed later
 * without anything changing on our side: the refusal means the reply window is closed, and the next
 * inbound message opens it. Retrying immediately cannot help, but keeping the message until then can
 * — which is what the channel does with it, and why the caller needs to tell this apart from "the
 * file does not exist" or "the network is down".
 */
export declare class SendRefusedError extends Error {
    /** The code the service gave, kept for the log and for tests. */
    readonly errcode: number;
    /**
     * @param message - What to tell the user.
     * @param errcode - The refusal code from the service.
     */
    constructor(message: string, errcode: number);
}
/**
 * Throw when the service refused a send.
 *
 * Every send endpoint answers HTTP 200 whether it accepted the message or not, and reports a refusal
 * as a non-zero `errcode` with no `message_id`. Reading only `message_id` therefore made every
 * failure indistinguishable from success: `notify_wechat` reported "已通过微信发送" while the phone
 * received nothing, which is the worst shape a bug can take — the user is told the opposite of what
 * happened, and there is nothing to investigate.
 *
 * `errcode ?? ret` because the send endpoints use `errcode` while the polling endpoint has been seen
 * with either; both are checked so a response shape change cannot reopen this hole.
 *
 * @param response - Parsed response from `ilink/bot/sendmessage`.
 * @throws {SendRefusedError} When the service refused, with the reason it gave.
 */
export declare function assertSendAccepted(response: SendMessageResp): void;
/**
 * Parse a wire response without losing `uint64` precision.
 *
 * Only object property values are rewritten, and only when they are long enough
 * to be at risk, so identifiers inside ordinary strings are left alone.
 *
 * @param raw - Response body.
 * @returns The parsed value.
 */
export declare function parseWireJson<T>(raw: string): T;
/** Copy the inbound message ids out of a raw body as strings. Diagnostic helper. */
export declare function extractRawIds(raw: string): string[];
export interface ApiRequest {
    /** API host. Trailing slash optional. */
    baseUrl: string;
    /** Endpoint path relative to the host, query string already encoded. */
    endpoint: string;
    method?: 'GET' | 'POST';
    /** JSON body, serialized verbatim. GET requests normally omit it. */
    body?: unknown;
    /** Bot token. Omit only for QR-code requests. */
    token?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Identity hint reported in `base_info`. */
    botAgent?: string;
}
/** Thrown when the service answers with a non-2xx status. */
export declare class ApiHttpError extends Error {
    readonly status: number;
    readonly body: string;
    readonly endpoint: string;
    constructor(endpoint: string, status: number, body: string);
}
/** `base_info` attached to request bodies that accept it. */
export declare function baseInfo(botAgent?: string): BaseInfo;
/**
 * Perform one API call and return the decoded JSON.
 *
 * @param request - Call description.
 * @returns The parsed response body.
 * @throws {ApiHttpError} On a non-2xx status.
 */
export declare function apiCall<T>(request: ApiRequest): Promise<T>;
/**
 * Perform one API call and return the raw body.
 *
 * Kept separate because the caller sometimes needs the untouched text — for
 * diagnostics, and because error replies are not always valid JSON.
 */
export declare function apiCallRaw(request: ApiRequest): Promise<string>;
/**
 * Headers shared by every call, authenticated or not.
 *
 * @param params.token - Bot token, when the call is authenticated.
 */
export declare function buildHeaders(params: {
    token?: string;
}): Record<string, string>;
/** Unique id for one outbound message, echoed back by the server for correlation. */
export declare function newClientId(prefix?: string): string;
export { DEFAULT_API_TIMEOUT_MS };
//# sourceMappingURL=http.d.ts.map