/**
 * Durable state for the channel: credentials, the long-poll cursor, and the
 * per-conversation reply token cache.
 *
 * Three things must survive a process restart:
 *
 * - **Credentials.** A bot token is long-lived; re-scanning on every boot would be
 *   unacceptable and, worse, would re-bind the account.
 * - **The poll cursor** (`get_updates_buf`). The server treats it as an incremental
 *   cursor, so dropping it loses whatever arrived while the process was down.
 * - **`context_token`s.** Issued per inbound message and required verbatim on the
 *   reply. The official client persists them per account and per peer for exactly
 *   this reason.
 *
 * Writes are atomic (temp file plus rename) so a crash cannot leave a half-written
 * credential file that locks the user out of their own bot.
 *
 * @module @dsh-wechat/core/state
 */
import type { WeixinAccount } from './types.ts';
import { type QuotaEntry } from './quota.ts';
import type { BrowsePosition, SessionBinding } from './router.ts';
/** Everything persisted for one channel deployment. */
export interface ChannelState {
    version: 1;
    /** Bot accounts, keyed by `ilink_bot_id`. */
    accounts: Record<string, WeixinAccount>;
    /** Incremental long-poll cursor, per account id. */
    syncBufs: Record<string, string>;
    /**
     * Reply tokens, per account and then per **conversation**.
     *
     * Keyed by conversation rather than by peer on purpose: with several sessions in
     * play, a token captured in one conversation must never be echoed into another,
     * and the conversation key already distinguishes group from direct messages.
     */
    contextTokens: Record<string, Record<string, string>>;
    /** Conversation-to-session mapping, so a chat keeps its session across restarts. */
    bindings: Record<string, SessionBinding>;
    /**
     * Messages this channel sent, newest last, per account and then per conversation.
     *
     * A quoted message arrives as an id and nothing else — its `message_item` carries `type: 0`
     * and no text — so the quoted content exists nowhere unless we kept it. This is that record.
     * Bounded per conversation, since only a recent message is ever quoted.
     */
    sentMessages: Record<string, Record<string, SentMessage[]>>;
    /**
     * Numbered session lists this channel has sent, so a quote of one still means what it meant.
     *
     * A number identifies a row of a listing, and a listing is a photograph of a machine that keeps
     * moving: sessions run, others go quiet, and the same number means a different conversation a
     * minute later. A quote names one exact message, so the numbering printed in it can be frozen here
     * when it is sent and read back when the user replies — which is the difference between "switch to
     * 3" meaning the row they are looking at and meaning whichever row happens to be third now.
     *
     * Keyed per account and then per conversation, like {@link ChannelState.sentMessages}, and bounded
     * per conversation: only a recent list is ever quoted.
     */
    sessionLists?: Record<string, Record<string, SessionListMessage[]>>;
    /**
     * Where each conversation is in the two-level listing browser, per account.
     *
     * Persisted because 「查看其余」 has no target: it means "the next ten of what I am looking at", and
     * nothing else in the system knows what that is. Kept per **conversation**, not per plugin, because
     * one channel serves several chats and each is standing somewhere different.
     *
     * The entry is small on purpose — a level, a directory and a page number, never a snapshot of the
     * list. A snapshot would make 「查看其余」 immune to the machine moving underneath it, but it would
     * also make every listing write a copy of the session list into a file that is rewritten whole on
     * every message, which is the opposite of what this file is for.
     */
    browsing?: Record<string, Record<string, BrowsePosition>>;
    /**
     * Proactive messages the service refused, waiting for the reply window to reopen.
     *
     * The window that allows a send is opened by an inbound message, so a push that arrives too late is
     * refused — and until this queue existed it was simply lost, silently: several permission prompts
     * and result summaries never reached the phone while the log said they had been sent.
     *
     * Kept in the state file rather than in memory so a restart does not discard them, and bounded by
     * both count and age so a long silence cannot grow the file without limit.
     */
    pendingNotifications?: PendingNotification[];
    /**
     * Sends charged against the reply token in use, per conversation.
     *
     * Persisted rather than counted in memory, and that is the point of the field: the count decides
     * when the user is asked for a new window, and the ask has to arrive *before* the last slot is
     * spent. A restart used to lose the count, so a process that came back mid-window believed the ten
     * were untouched and spent the remainder on messages that were refused instead of on warning the
     * user first. `dsh-wechat-send` reads and writes the same entries, so a script and the plugin add
     * up to one count rather than two.
     */
    quota?: Record<string, QuotaEntry>;
    /** Whether the channel should reconnect on boot. */
    autoStart?: boolean;
    /**
     * Behaviour the user tunes from the settings page.
     *
     * Kept in the state file rather than in plugin config so a change takes effect on the next
     * message instead of requiring a restart — these are all per-message decisions, and a restart
     * to adjust a wait window is a poor trade.
     */
    settings?: ChannelSettings;
}
/**
 * Tuned behaviour, with every field optional so a stored file stays readable across versions.
 *
 * Defaults live in {@link DEFAULT_SETTINGS}; anything absent falls back to them.
 */
export interface ChannelSettings {
    /** Quiet time after a non-text message before it is answered on its own, in milliseconds. */
    mergeWindowMs?: number;
    /** Reply text longer than this is sent as a file instead of a message. */
    maxReplyChars?: number;
    /** Quiet time that ends a burst of assistant output into one message, in milliseconds. */
    settleMs?: number;
    /** How many sent messages to retain per conversation, for resolving quotes. */
    quoteHistory?: number;
    /** Whether a non-text message is answered on its own once the window elapses. */
    autoReplyAttachments?: boolean;
    /**
     * Whether the agent must confirm a session action with the user before taking it.
     *
     * On by default. The agent decides when to call the session tool, so a misreading would change
     * where the user's work goes with nothing to catch it — the confirmation is what stands between
     * an inferred intent and an effect.
     */
    requireConfirmation?: boolean;
    /**
     * Standing note prepended to every prompt, telling the agent it is on WeChat.
     *
     * Editable because the wording is a judgement call, but present by default: without it the
     * agent answers as if its user sits at the desktop console.
     */
    presenceNote?: string;
    /**
     * Permission preset applied to every session this channel creates.
     *
     * Defaults to `danger-full-access`, because the other option is unusable from a phone: a session
     * that asks before each tool call sends a prompt to WeChat and stops until the user answers, which
     * on a phone means every command stalls on a conversation. The user chose the phone precisely to
     * stop sitting at the desktop, so a prompt they must come back to is a prompt they will not answer.
     *
     * `default` leaves whatever the DSH profile is configured with, for people who want the same
     * guardrails on WeChat as at the console.
     *
     * The preset can only be applied before a session's first turn — DSH locks it after that — so this
     * is set when the channel creates or adopts a session and cannot retroactively change one that has
     * already run.
     */
    permissionPreset?: PermissionPreset;
    /**
     * Whether a session that is not the bound one may push to the WeChat conversation.
     *
     * **On by default**, and that default is the point of the feature: the reason to run DSH from a
     * phone is to leave the desk, and a task that finishes while the user is away is worthless if its
     * result cannot reach them. Whoever is doing the work can then say so.
     *
     * What it costs: any session on this machine can reach the user's phone. That is a deliberate
     * widening, and it is not the bug that removed `sessionOwners` — that was a session *impersonating*
     * a conversation it no longer had, while this only ever delivers *to* the conversation the user is
     * currently in. Turn it off to restore the stricter rule, where only the bound session may send.
     */
    allowCrossSessionNotify?: boolean;
    /**
     * Directory the channel's sessions run in, or empty for the default under the DSH home.
     *
     * Read once, during `apply`: a session's `cwd` is pinned when it is created. Changing it
     * therefore moves the sessions created afterwards and leaves the existing ones on the old
     * directory, which is why the settings page says a restart is needed.
     */
    workspacePath?: string;
}
/** Permission presets this channel will apply to its own sessions. */
export type PermissionPreset = 'danger-full-access' | 'auto' | 'default';
/** Values applied when a setting has never been stored. */
export declare const DEFAULT_SETTINGS: {
    readonly mergeWindowMs: 10000;
    readonly maxReplyChars: 4000;
    readonly settleMs: 1200;
    readonly quoteHistory: 40;
    readonly autoReplyAttachments: true;
    readonly requireConfirmation: true;
    readonly permissionPreset: "danger-full-access";
    readonly allowCrossSessionNotify: true;
    readonly workspacePath: "";
    readonly presenceNote: string;
};
/**
 * Resolve the stored settings against the defaults.
 *
 * @param state - State to read from.
 * @returns Every setting, with defaults filled in.
 */
export declare function resolveSettings(state: ChannelState): Required<ChannelSettings>;
/** One message this channel sent, retained so a quote of it can be resolved. */
export interface SentMessage {
    /** Server-assigned identity, which is what a quote refers to. */
    messageId: string;
    /** Item kind it went out as, so a quote of an attachment can be answered sensibly. */
    kind: 'text' | 'image' | 'video' | 'file';
    /** Body preview for text, or the file name for an attachment. */
    preview: string;
    /** When it was sent, for pruning. */
    at: number;
}
/** How many sent messages to retain per conversation. */
export declare const SENT_MESSAGE_HISTORY = 40;
/**
 * One numbered session list the channel sent, kept so a quote of it resolves the same way twice.
 *
 * Only what a numbering needs is stored: the position of each row is its index in `sessions`, and the
 * id and title are enough to switch to it. Times and workspace names are deliberately left out —
 * they are what a *new* listing is for, and keeping them would make a frozen listing grow stale in
 * ways the user could see.
 */
export interface SessionListMessage {
    /** Server-assigned id of the message that printed this numbering. */
    messageId: string;
    /** The rows in the order that message numbered them. */
    sessions: {
        sessionId: string;
        title: string;
    }[];
    /**
     * The number printed beside `sessions[0]`.
     *
     * Stored because numbering runs on across screens: a message showing rows 11..20 is quoted with
     * "14", and an array read from index 1 would answer with row 4 — a conversation that message never
     * printed. Written as 1 for a first screen, which is also what an entry stored before paging
     * existed is read back as.
     */
    first: number;
    /** When it was sent, for pruning. */
    at: number;
}
/** How many numbered lists to retain per conversation. */
export declare const SESSION_LIST_HISTORY = 5;
/**
 * How much of a conversation title a stored listing keeps.
 *
 * A session is named from the user's first sentence, which is routinely a whole paragraph, and this
 * file is rewritten in full on every change — a binding, a quota count, every reply. Five listings of
 * ten paragraph-long titles would make that write megabytes. The title here only has to be recognisable
 * in a switch confirmation, so the head of it is enough.
 */
export declare const SESSION_LIST_TITLE_LIMIT = 120;
/**
 * Record one numbered listing, dropping the oldest when the record is full.
 *
 * @param state - State to mutate.
 * @param accountId - Account the listing went out on.
 * @param conversationId - Conversation it went to.
 * @param entry - The listing: the message id and the rows it numbered.
 * @param limit - How many listings to keep per conversation.
 */
export declare function rememberSessionList(state: ChannelState, accountId: string, conversationId: string, entry: SessionListMessage, limit?: number): void;
/**
 * Find the listing a quoted message printed.
 *
 * Searched across every conversation of the account, for the same reason as
 * {@link findSentMessage}: the quote carries an id and no conversation, and an id is unique.
 *
 * @param state - State to search.
 * @param accountId - Account the quote arrived on.
 * @param messageId - Id taken from the quote.
 * @returns The recorded numbering, or undefined when that message was not a listing or has aged out.
 */
export declare function findSessionList(state: ChannelState, accountId: string, messageId: string): SessionListMessage | undefined;
/**
 * The newest listing sent into one conversation.
 *
 * Used when the user replies with a bare number and quotes nothing: the listing they most likely
 * still have on screen is the one this conversation last received. Reading it rather than re-deriving
 * the numbering from live sessions is what keeps a number from drifting onto a different conversation
 * while the user is reading.
 *
 * @param state - State to search.
 * @param accountId - Account the listing went out on.
 * @param conversationId - Conversation it went to.
 * @returns The recorded numbering, or undefined when none was sent.
 */
export declare function latestSessionList(state: ChannelState, accountId: string, conversationId: string): SessionListMessage | undefined;
/**
 * Record where a conversation is in the listing browser.
 *
 * @param state - State to mutate.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to record for.
 * @param position - The place it has reached.
 */
export declare function rememberBrowse(state: ChannelState, accountId: string, conversationId: string, position: BrowsePosition): void;
/**
 * Where a conversation is in the listing browser, if it is anywhere.
 *
 * @param state - State to read.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to look up.
 * @returns The stored position, or undefined when this conversation is not browsing.
 */
export declare function findBrowse(state: ChannelState, accountId: string, conversationId: string): BrowsePosition | undefined;
/**
 * Forget a conversation's place in the listing browser.
 *
 * Called both when the user moves on and when a position is found to be stale, so the state file
 * does not accumulate a row per conversation that ever asked for a listing.
 *
 * @param state - State to mutate.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to forget.
 */
export declare function forgetBrowse(state: ChannelState, accountId: string, conversationId: string): void;
/**
 * A proactive message that could not be delivered, kept for the next open window.
 *
 * Deliberately holds the file's *path*, not its bytes: the queue is written to the state file on
 * every change, and embedding attachments would turn a small JSON document into something that grows
 * with every missed screenshot. The cost is that a file deleted between queueing and delivery cannot
 * be sent, which is reported rather than retried forever.
 */
export interface PendingNotification {
    /**
     * Identity, so a delivered entry can be removed exactly.
     *
     * Matching on its fields instead would remove both copies of two identical messages queued in the
     * same millisecond, which is the one case where a duplicate is worth keeping.
     */
    id: string;
    /** Conversation it was meant for. Only a message from this one reopens the window. */
    conversationId: string;
    /** Text to send. May be empty when only a file was owed. */
    text: string;
    /** Absolute path of the file to send after the text, when there was one. */
    path?: string;
    /** When it was queued, for the age bound and for saying how late it is. */
    queuedAt: number;
}
/** How many undelivered notifications to keep. */
export declare const PENDING_NOTIFICATION_LIMIT = 20;
/** How long an undelivered notification stays worth sending. */
export declare const PENDING_NOTIFICATION_MAX_AGE_MS: number;
/**
 * Add one undelivered notification, dropping the oldest when the queue is full.
 *
 * Oldest-first because the queue is a backlog the user will read in order: when it overflows, the
 * least relevant entry is the one at the front, not the one just added.
 *
 * @param state - State to mutate.
 * @param entry - The notification to keep; `id` and `queuedAt` are filled in.
 * @param now - Current time, injected so tests need no clock.
 * @param limit - How many entries to keep.
 * @returns How many entries were dropped to make room.
 */
export declare function queuePendingNotification(state: ChannelState, entry: Omit<PendingNotification, 'id' | 'queuedAt'> & {
    id?: string;
    queuedAt?: number;
}, now?: number, limit?: number): number;
/**
 * Drop notifications too old to be worth sending.
 *
 * Without this a channel left running for a month would deliver month-old messages the first time
 * the user said hello, which reads as a malfunction rather than a backlog.
 *
 * @param state - State to mutate.
 * @param now - Current time, injected so tests need no clock.
 * @param maxAgeMs - How long an entry stays valid.
 * @returns The entries that were dropped, oldest first.
 */
export declare function expirePendingNotifications(state: ChannelState, now?: number, maxAgeMs?: number): PendingNotification[];
/**
 * Retain one sent message so a later quote of it can be resolved.
 *
 * Old entries are dropped from the front, so the record stays bounded no matter how long the
 * channel runs. Only recent messages are ever quoted, so nothing useful is lost.
 *
 * @param state - State to mutate.
 * @param accountId - Account the message went out on.
 * @param conversationId - Conversation it went to.
 * @param message - What was sent.
 */
export declare function rememberSentMessage(state: ChannelState, accountId: string, conversationId: string, message: SentMessage, limit?: number): void;
/**
 * Find a message this channel sent, by the id a quote refers to.
 *
 * Searched across every conversation of the account rather than one: the quote carries an id
 * and no conversation, and an id is unique, so looking wider can only help.
 *
 * @param state - State to search.
 * @param accountId - Account the quote arrived on.
 * @param messageId - Id taken from the quote.
 * @returns The recorded message, or undefined when it was not ours or has aged out.
 */
export declare function findSentMessage(state: ChannelState, accountId: string, messageId: string): SentMessage | undefined;
/** Composed storage for one state file. */
export declare class StateStore {
    #private;
    readonly file: string;
    /**
     * @param file - Absolute path of the state file. Parent directories are created on demand.
     */
    constructor(file: string);
    /** Resolve the default state path under a DSH home directory. */
    static under(dshHome: string): StateStore;
    /** Read the current state, tolerating a missing or corrupt file. */
    read(): Promise<ChannelState>;
    /**
     * Apply a mutation and persist the result.
     *
     * @param mutate - Receives the live state object and may change it in place.
     */
    update(mutate: (state: ChannelState) => void): Promise<void>;
    /** Drop every artifact for one account. Used when a token goes stale. */
    forgetAccount(accountId: string): Promise<void>;
}
//# sourceMappingURL=state.d.ts.map