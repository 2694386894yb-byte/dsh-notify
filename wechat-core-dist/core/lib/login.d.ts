/**
 * QR-code login for the WeChat ClawBot channel.
 *
 * The flow is a long-poll handshake, and two behaviours in it are load-bearing:
 *
 * - **`bot_type`** is sent on the QR request. Tencent's own client uses `3` and we
 *   keep it identical, because the server may branch on the declared client type.
 * - **`local_token_list`** tells the server which bot identities this deployment
 *   already holds. The server then answers `binded_redirect` instead of issuing a
 *   *new* identity, and it also reconciles the account's binding. Sending the list
 *   is therefore what lets us **adopt** an existing binding rather than silently
 *   take it over — see `reuseExisting` in {@link LoginOptions}.
 *
 * The generator shape keeps every interactive decision with the caller: rendering a
 * QR code, reading a verification code, and deciding what to do on a redirect.
 *
 * @module @dsh-wechat/core/login
 */
import type { QRCodeResponse, QRStatusResponse, WeixinAccount } from './types.ts';
/** How the caller wants an already-bound account handled. */
export type ReusePolicy = 
/** Keep the existing credentials and adopt them. The default, and the safe choice. */
'adopt'
/** Report the collision instead of pretending it succeeded. */
 | 'reject';
export interface LoginOptions {
    /**
     * Bot tokens this deployment already holds, newest first.
     *
     * Sent as `local_token_list`. Omitting it makes the server treat this as a brand
     * new client, which is what re-binds the account and unbinds whatever was bound
     * before — the exact behaviour a second client causes by scanning naively.
     */
    existingTokens?: readonly string[];
    /** `bot_type` query parameter. Defaults to the WeChat channel build. */
    botType?: string;
    /** Overall login deadline. Defaults to five minutes. */
    timeoutMs?: number;
    /** Base URL for QR requests. Only overridden by tests. */
    baseUrl?: string;
    /** Behaviour when the server reports the bot as already bound. */
    reuseExisting?: ReusePolicy;
    /** Called once per status poll with the raw status. Diagnostics only. */
    onStatus?: (status: QRStatusResponse) => void;
}
/** One step of the login handshake, surfaced to the caller. */
export type LoginEvent = 
/** A QR code is ready for the user to scan. */
{
    kind: 'qr';
    qrUrl: string;
    qrcode: string;
    refreshed: boolean;
}
/** The user scanned and is being asked to confirm on the phone. */
 | {
    kind: 'scanned';
}
/** The server wants a pairing verification code. Answer with the generator's input. */
 | {
    kind: 'verifycode-required';
    attempt: number;
}
/** The polling host changed. Informational. */
 | {
    kind: 'redirected';
    host: string;
}
/** The QR code expired and a fresh one was requested. */
 | {
    kind: 'expired';
    refreshCount: number;
    willRetry: boolean;
}
/** Terminal success. */
 | {
    kind: 'confirmed';
    account: WeixinAccount;
}
/** The server considers this deployment already bound. */
 | {
    kind: 'already-bound';
}
/** Terminal failure. */
 | {
    kind: 'failed';
    reason: string;
};
/** Outcome of a completed login attempt. */
export interface LoginResult {
    account?: WeixinAccount;
    alreadyBound: boolean;
    reason?: string;
}
/**
 * Request a QR code.
 *
 * @param params.localTokenList - Tokens this deployment already holds, newest first.
 * @param params.botType - Declared client type.
 * @param params.baseUrl - API host.
 * @returns The QR session handle and its renderable payload.
 */
export declare function fetchQRCode(params: {
    localTokenList?: readonly string[];
    botType?: string;
    baseUrl?: string;
}): Promise<QRCodeResponse>;
/**
 * Poll one QR status. The server holds the request, so a client-side timeout is a
 * normal `wait` rather than an error.
 *
 * @param params.qrcode - Session handle from {@link fetchQRCode}.
 * @param params.verifyCode - Pairing code, when the server demanded one.
 */
export declare function pollQRStatus(params: {
    qrcode: string;
    verifyCode?: string;
    baseUrl?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<QRStatusResponse>;
/**
 * Drive a complete login handshake.
 *
 * The caller consumes events and answers the interactive one by passing a string
 * back into the generator after `verifycode-required`. Aborting the signal cancels.
 *
 * @param options - Login policy, notably the existing-token list.
 * @param signal - Abort signal that cancels the handshake.
 * @returns Terminal outcome; a `confirmed` event also carries the account.
 */
export declare function login(options?: LoginOptions, signal?: AbortSignal): AsyncGenerator<LoginEvent, LoginResult, string | undefined>;
//# sourceMappingURL=login.d.ts.map