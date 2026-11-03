/**
 * The channel itself: long-poll inbound, send outbound, and the session guard.
 *
 * The loop mirrors Tencent's own monitor:
 *
 * - one long poll at a time, with the client timeout slightly longer than the
 *   server's suggestion so the server always wins the race and nothing is lost;
 * - the cursor is persisted before the messages in that batch are handled, so a
 *   crash mid-handling replays rather than drops;
 * - `errcode -14` pauses every call for this account for an hour instead of
 *   hammering an endpoint that cannot succeed;
 * - other failures retry, then back off.
 *
 * @module @dsh-wechat/core/channel
 */
import type { MessageItem, WeixinAccount, WeixinMessage } from './types.ts';
/** A message ready to be delivered to the agent. */
export interface InboundMessage {
    accountId: string;
    /** Counterparty: the WeChat user id. */
    peerId: string;
    /** Group id when the message came from a group conversation. */
    groupId?: string;
    /** Stable conversation key: account plus peer (plus group when present). */
    conversationId: string;
    messageId?: string;
    /** Required verbatim on the reply. */
    contextToken?: string;
    text: string;
    /**
     * Attachments the message carried, in wire order.
     *
     * Absent for text-only messages. A media-only message has empty `text` and this
     * populated, which is why `toInbound` cannot filter on text alone.
     */
    media?: MessageItem[];
    /** The untouched wire message, for features that need more than text. */
    raw: WeixinMessage;
    receivedAt: number;
}
/** Why the loop stopped, when it did. */
export type MonitorStopReason = 'stale-token' | 'aborted' | 'fatal';
export interface MonitorOptions {
    account: WeixinAccount;
    /** Invoked once per inbound text message, sequentially. */
    onMessage: (message: InboundMessage) => Promise<void>;
    /** Cursor restored from disk. */
    initialSyncBuf?: string;
    /** Called whenever the server hands back a new cursor, so the caller can persist it. */
    onSyncBuf?: (buf: string) => Promise<void> | void;
    /** Called on every loop error, for logging. */
    onError?: (error: unknown) => void;
    /** Called when the loop decides to stop. */
    onStop?: (reason: MonitorStopReason, detail?: string) => void;
    /** Identity hint reported in `base_info.bot_agent`. */
    botAgent?: string;
    /** Injectable sleep, for tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
/**
 * One account's inbound pump.
 *
 * Construct, then `run(signal)`; the promise settles when the loop stops.
 */
export declare class ChannelMonitor {
    #private;
    constructor(options: MonitorOptions);
    /** Current cursor, for persistence by the caller. */
    get syncBuf(): string;
    /**
     * Restore a persisted cursor before the first poll.
     *
     * Must be called before {@link run}: the server treats the cursor as incremental,
     * so starting from empty would replay or drop whatever the account received while
     * the process was down.
     */
    restoreSyncBuf(buf: string): void;
    /** True while the stale-token cooldown is active. */
    get paused(): boolean;
    /** Milliseconds left in the cooldown, or zero. */
    get remainingPauseMs(): number;
    /**
     * Run until aborted, the token goes stale, or a fatal error occurs.
     *
     * @param signal - Abort to stop promptly, including an in-flight long poll.
     */
    run(signal: AbortSignal): Promise<MonitorStopReason>;
    /** Show or clear the "typing…" indicator for a peer. Best effort. */
    setTyping(peerId: string, typing: boolean): Promise<void>;
    /** Notify the server that this client is stopping. Best effort. */
    notifyStop(): Promise<void>;
}
/**
 * Send one text message.
 *
 * @param params.account - Credentials for the sending bot.
 * @param params.to - Recipient user id.
 * @param params.text - Message body.
 * @param params.contextToken - Token from the inbound message being answered.
 * @returns The server message id, when the service returns one.
 */
export declare function sendText(params: {
    account: WeixinAccount;
    to: string;
    text: string;
    contextToken?: string;
    runId?: string;
    signal?: AbortSignal;
}): Promise<{
    clientId: string;
    serverMessageId?: string;
}>;
/** Build a conversation key that stays stable across restarts. */
export declare function conversationKey(accountId: string, peerId: string, groupId?: string): string;
/**
 * Convert a wire message into an inbound envelope.
 *
 * Returns `undefined` for anything this plugin does not handle: messages the bot
 * itself sent, and content that is neither text nor media. A media-only message is
 * kept — with empty text — because the media itself is the payload; dropping it here
 * is what made an incoming photo look like nothing had been sent at all.
 *
 * @param account - Account the message arrived on.
 * @param raw - Wire message.
 */
export declare function toInbound(account: WeixinAccount, raw: WeixinMessage): InboundMessage | undefined;
/**
 * Every item in the message that carries a downloadable attachment.
 *
 * Kept separate from {@link extractText} so a message can be text, media, or both
 * without either path deciding the other's fate.
 *
 * @param raw - Wire message.
 */
export declare function mediaItems(raw: WeixinMessage): MessageItem[];
/** Concatenate every text element, and any voice transcript the server supplied. */
export declare function extractText(raw: WeixinMessage): string;
//# sourceMappingURL=channel.d.ts.map