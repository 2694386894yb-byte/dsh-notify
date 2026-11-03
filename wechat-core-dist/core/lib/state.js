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
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeQuota } from "./quota.js";
/** Values applied when a setting has never been stored. */
export const DEFAULT_SETTINGS = {
    mergeWindowMs: 10_000,
    maxReplyChars: 4_000,
    settleMs: 1_200,
    quoteHistory: 40,
    autoReplyAttachments: true,
    requireConfirmation: true,
    permissionPreset: 'danger-full-access',
    allowCrossSessionNotify: true,
    workspacePath: '',
    presenceNote: '[渠道：微信] 你在和微信上的用户对话，对方在手机上，看不到这台电脑的屏幕和文件系统。' +
        '不要让他去"打开某个路径"或"看某个文件"。需要给他看东西时，直接发送：' +
        '图片或视频会显示成照片/视频，其他文件会作为附件发过去。' +
        '回复尽量简短，适合手机阅读。',
};
/**
 * Resolve the stored settings against the defaults.
 *
 * @param state - State to read from.
 * @returns Every setting, with defaults filled in.
 */
export function resolveSettings(state) {
    const stored = state.settings ?? {};
    return {
        mergeWindowMs: stored.mergeWindowMs ?? DEFAULT_SETTINGS.mergeWindowMs,
        maxReplyChars: stored.maxReplyChars ?? DEFAULT_SETTINGS.maxReplyChars,
        settleMs: stored.settleMs ?? DEFAULT_SETTINGS.settleMs,
        quoteHistory: stored.quoteHistory ?? DEFAULT_SETTINGS.quoteHistory,
        autoReplyAttachments: stored.autoReplyAttachments ?? DEFAULT_SETTINGS.autoReplyAttachments,
        requireConfirmation: stored.requireConfirmation ?? DEFAULT_SETTINGS.requireConfirmation,
        permissionPreset: stored.permissionPreset ?? DEFAULT_SETTINGS.permissionPreset,
        allowCrossSessionNotify: stored.allowCrossSessionNotify ?? DEFAULT_SETTINGS.allowCrossSessionNotify,
        workspacePath: stored.workspacePath ?? DEFAULT_SETTINGS.workspacePath,
        presenceNote: stored.presenceNote ?? DEFAULT_SETTINGS.presenceNote,
    };
}
/** How many sent messages to retain per conversation. */
export const SENT_MESSAGE_HISTORY = 40;
/** How many numbered lists to retain per conversation. */
export const SESSION_LIST_HISTORY = 5;
/**
 * How much of a conversation title a stored listing keeps.
 *
 * A session is named from the user's first sentence, which is routinely a whole paragraph, and this
 * file is rewritten in full on every change — a binding, a quota count, every reply. Five listings of
 * ten paragraph-long titles would make that write megabytes. The title here only has to be recognisable
 * in a switch confirmation, so the head of it is enough.
 */
export const SESSION_LIST_TITLE_LIMIT = 120;
/**
 * Record one numbered listing, dropping the oldest when the record is full.
 *
 * @param state - State to mutate.
 * @param accountId - Account the listing went out on.
 * @param conversationId - Conversation it went to.
 * @param entry - The listing: the message id and the rows it numbered.
 * @param limit - How many listings to keep per conversation.
 */
export function rememberSessionList(state, accountId, conversationId, entry, limit = SESSION_LIST_HISTORY) {
    const perAccount = (state.sessionLists ??= {});
    const perConversation = (perAccount[accountId] ??= {});
    const history = (perConversation[conversationId] ??= []);
    history.push({
        messageId: entry.messageId,
        sessions: entry.sessions.map((row) => ({
            sessionId: row.sessionId,
            title: row.title.slice(0, SESSION_LIST_TITLE_LIMIT),
        })),
        first: entry.first,
        at: entry.at,
    });
    if (limit >= 0 && history.length > limit)
        history.splice(0, history.length - limit);
}
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
export function findSessionList(state, accountId, messageId) {
    for (const history of Object.values(state.sessionLists?.[accountId] ?? {})) {
        // Newest first: a message id appears once, but scanning backwards costs nothing and matches the
        // order the entries were written in.
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const entry = history[index];
            if (entry?.messageId === messageId)
                return entry;
        }
    }
    return undefined;
}
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
export function latestSessionList(state, accountId, conversationId) {
    const history = state.sessionLists?.[accountId]?.[conversationId];
    return history?.[history.length - 1];
}
/**
 * Record where a conversation is in the listing browser.
 *
 * @param state - State to mutate.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to record for.
 * @param position - The place it has reached.
 */
export function rememberBrowse(state, accountId, conversationId, position) {
    const perAccount = (state.browsing ??= {});
    const perConversation = (perAccount[accountId] ??= {});
    perConversation[conversationId] = {
        level: position.level,
        workspace: position.workspace,
        page: position.page,
        at: position.at,
    };
}
/**
 * Where a conversation is in the listing browser, if it is anywhere.
 *
 * @param state - State to read.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to look up.
 * @returns The stored position, or undefined when this conversation is not browsing.
 */
export function findBrowse(state, accountId, conversationId) {
    return state.browsing?.[accountId]?.[conversationId];
}
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
export function forgetBrowse(state, accountId, conversationId) {
    const perAccount = state.browsing?.[accountId];
    if (perAccount === undefined)
        return;
    delete perAccount[conversationId];
    if (Object.keys(perAccount).length === 0)
        delete state.browsing?.[accountId];
}
/** How many undelivered notifications to keep. */
export const PENDING_NOTIFICATION_LIMIT = 20;
/** How long an undelivered notification stays worth sending. */
export const PENDING_NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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
export function queuePendingNotification(state, entry, now = Date.now(), limit = PENDING_NOTIFICATION_LIMIT) {
    const queue = (state.pendingNotifications ??= []);
    queue.push({ ...entry, id: entry.id ?? randomUUID(), queuedAt: entry.queuedAt ?? now });
    let dropped = 0;
    // `limit >= 0` mirrors the sent-message helper: a limit of 0 means "keep nothing", not "no bound".
    while (limit >= 0 && queue.length > limit) {
        queue.shift();
        dropped += 1;
    }
    return dropped;
}
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
export function expirePendingNotifications(state, now = Date.now(), maxAgeMs = PENDING_NOTIFICATION_MAX_AGE_MS) {
    const queue = state.pendingNotifications;
    if (queue === undefined || queue.length === 0)
        return [];
    const expired = queue.filter((entry) => now - entry.queuedAt > maxAgeMs);
    if (expired.length > 0) {
        state.pendingNotifications = queue.filter((entry) => now - entry.queuedAt <= maxAgeMs);
    }
    return expired;
}
const EMPTY_STATE = {
    version: 1,
    accounts: {},
    syncBufs: {},
    contextTokens: {},
    bindings: {},
    sentMessages: {},
};
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
export function rememberSentMessage(state, accountId, conversationId, message, limit = SENT_MESSAGE_HISTORY) {
    const perAccount = (state.sentMessages[accountId] ??= {});
    const history = (perAccount[conversationId] ??= []);
    history.push(message);
    if (limit >= 0 && history.length > limit) {
        history.splice(0, history.length - limit);
    }
}
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
export function findSentMessage(state, accountId, messageId) {
    for (const history of Object.values(state.sentMessages[accountId] ?? {})) {
        for (const entry of history)
            if (entry.messageId === messageId)
                return entry;
    }
    return undefined;
}
/** Composed storage for one state file. */
export class StateStore {
    file;
    #cache;
    /** In-flight disk load, shared by concurrent {@link read} calls. */
    #loading;
    /** Serializes concurrent writes; the channel is event-driven and re-entrant. */
    #writeChain = Promise.resolve();
    /**
     * @param file - Absolute path of the state file. Parent directories are created on demand.
     */
    constructor(file) {
        this.file = file;
    }
    /** Resolve the default state path under a DSH home directory. */
    static under(dshHome) {
        return new StateStore(join(dshHome, 'wechat', 'state.json'));
    }
    /** Read the current state, tolerating a missing or corrupt file. */
    async read() {
        // Share one in-flight load between concurrent callers. Without this, a second
        // `read()` that starts before the first finishes would fall back to an empty
        // state and cache it, silently discarding everything already on disk — which is
        // how a concurrent update could wipe accounts that had been seeded or adopted.
        this.#loading ??= this.#load();
        return await this.#loading;
    }
    /** Load from disk once, caching the result. Only called through {@link read}. */
    async #load() {
        if (this.#cache !== undefined)
            return this.#cache;
        try {
            const parsed = JSON.parse(await readFile(this.file, 'utf-8'));
            this.#cache = normalize(parsed);
        }
        catch {
            // A missing file is the normal first run; a corrupt one must not be fatal,
            // because the user can always log in again.
            this.#cache = structuredClone(EMPTY_STATE);
        }
        return this.#cache;
    }
    /**
     * Apply a mutation and persist the result.
     *
     * @param mutate - Receives the live state object and may change it in place.
     */
    async update(mutate) {
        const state = await this.read();
        mutate(state);
        // Chain writes so two concurrent updates cannot interleave their renames.
        this.#writeChain = this.#writeChain.then(() => this.#persist(state));
        await this.#writeChain;
    }
    /** Drop every artifact for one account. Used when a token goes stale. */
    async forgetAccount(accountId) {
        await this.update((state) => {
            delete state.accounts[accountId];
            delete state.syncBufs[accountId];
            delete state.contextTokens[accountId];
            if (state.sessionLists !== undefined)
                delete state.sessionLists[accountId];
            // A position is only meaningful for a conversation that can still be reached, and the
            // conversations go with the account.
            if (state.browsing !== undefined)
                delete state.browsing[accountId];
            for (const [key, binding] of Object.entries(state.bindings)) {
                if (binding.accountId === accountId)
                    delete state.bindings[key];
            }
        });
    }
    async #persist(state) {
        await mkdir(dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        // mode 0600: the file holds a bearer token that grants full bot access.
        await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
        try {
            await rename(temp, this.file);
        }
        catch (error) {
            await rm(temp, { force: true });
            throw error;
        }
    }
}
/** Coerce a possibly-foreign object into a well-formed state. */
function normalize(parsed) {
    return {
        version: 1,
        accounts: isRecord(parsed.accounts) ? parsed.accounts : {},
        syncBufs: isRecord(parsed.syncBufs) ? parsed.syncBufs : {},
        contextTokens: isRecord(parsed.contextTokens)
            ? parsed.contextTokens
            : {},
        bindings: isRecord(parsed.bindings) ? parsed.bindings : {},
        sentMessages: isRecord(parsed.sentMessages)
            ? parsed.sentMessages
            : {},
        /*
         * Validated entry by entry, like the pending queue.
         *
         * This is the field the handbook warns about: `normalize` is an allowlist, so a field added to
         * `ChannelState` and forgotten here is silently dropped on the next write — settings that save
         * fine and are gone after a restart. It is also read back and *acted on*: a session list with a
         * missing conversation or a row without an id would resolve a number to nothing at all.
         */
        ...(isRecord(parsed.sessionLists) ? { sessionLists: normalizeSessionLists(parsed.sessionLists) } : {}),
        /*
         * Validated entry by entry, like the listings above, and for the same reason: this is read back
         * and acted on. A page number that arrived as a string would make 「查看其余」 arithmetic produce
         * NaN, and a level that is neither of the two known ones would send the router down a branch that
         * does not exist. The loss is one stale position, which the next `/list` replaces.
         */
        ...(isRecord(parsed.browsing) ? { browsing: normalizeBrowsing(parsed.browsing) } : {}),
        /*
         * Filtered rather than trusted. This array is read back and sent to the user, so an entry with a
         * missing conversation or a non-string text would reach the send path as `undefined`.
         */
        ...(Array.isArray(parsed.pendingNotifications)
            ? { pendingNotifications: parsed.pendingNotifications.filter(isPendingNotification) }
            : {}),
        /*
         * Always written, even when empty, and validated entry by entry.
         *
         * This field is the reason the omission it prevents was worth a handbook section: `normalize` is
         * an allowlist, so a field added to `ChannelState` but not here is silently discarded on the next
         * write. The count decides whether the user is asked for a new window in time, so losing it
         * quietly is the same failure the settings page had — data that saves fine and is gone after a
         * restart.
         */
        quota: normalizeQuota(parsed.quota),
        ...(isRecord(parsed.settings) ? { settings: normalizeSettings(parsed.settings) } : {}),
        ...(typeof parsed.autoStart === 'boolean' ? { autoStart: parsed.autoStart } : {}),
    };
}
/**
 * Whether a stored entry is a usable pending notification.
 *
 * @param raw - One entry from the state file.
 * @returns True when every required field is present and of the right type.
 */
function isPendingNotification(raw) {
    if (!isRecord(raw))
        return false;
    return (typeof raw.id === 'string' &&
        typeof raw.conversationId === 'string' &&
        typeof raw.text === 'string' &&
        typeof raw.queuedAt === 'number' &&
        (raw.path === undefined || typeof raw.path === 'string'));
}
/**
 * Keep only the numbered listings that are usable.
 *
 * A listing without a message id can never be found by a quote, and one with a malformed row would
 * resolve a number to a session id of `undefined` — which reaches the session controller as a
 * request to adopt nothing. Both are dropped rather than repaired: the cost is one stale number,
 * and the alternative is guessing at what the user was looking at.
 *
 * @param raw - The stored `sessionLists` object.
 * @returns The usable subset, in the stored order.
 */
function normalizeSessionLists(raw) {
    const result = {};
    for (const [accountId, conversations] of Object.entries(raw)) {
        if (!isRecord(conversations))
            continue;
        const kept = {};
        for (const [conversationId, history] of Object.entries(conversations)) {
            if (!Array.isArray(history))
                continue;
            const entries = [];
            for (const candidate of history) {
                const entry = asSessionListMessage(candidate);
                if (entry !== undefined)
                    entries.push(entry);
            }
            if (entries.length > 0)
                kept[conversationId] = entries;
        }
        if (Object.keys(kept).length > 0)
            result[accountId] = kept;
    }
    return result;
}
/**
 * Coerce one stored entry into a usable numbered listing, copying the fields it validates.
 *
 * A listing without a message id can never be found by a quote, and one with a malformed row would
 * resolve a number to a session id of `undefined` — which reaches the session controller as a request
 * to adopt nothing. Both are dropped rather than repaired: the cost is one stale number, and the
 * alternative is guessing at what the user was looking at. The copy is what keeps `first` from being
 * absent on an entry written before paging existed — see {@link SessionListMessage.first}.
 *
 * @param raw - One entry from the state file.
 * @returns The usable entry, or undefined when it cannot resolve a number to a real session.
 */
function asSessionListMessage(raw) {
    if (!isRecord(raw))
        return undefined;
    if (typeof raw.messageId !== 'string' || raw.messageId === '')
        return undefined;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at))
        return undefined;
    if (!Array.isArray(raw.sessions) || raw.sessions.length === 0)
        return undefined;
    const sessions = [];
    for (const row of raw.sessions) {
        if (!isRecord(row) || typeof row.sessionId !== 'string' || typeof row.title !== 'string') {
            return undefined;
        }
        sessions.push({ sessionId: row.sessionId, title: row.title });
    }
    const first = raw.first === undefined ? 1 : raw.first;
    if (typeof first !== 'number' || !Number.isInteger(first) || first < 1)
        return undefined;
    return { messageId: raw.messageId, sessions, first, at: raw.at };
}
/**
 * Keep only the browsing positions that are usable.
 *
 * A position that does not name a known level or carries a page that is not a positive integer cannot
 * be continued, and continuing it wrongly is worse than starting over: 「查看其余」 would page from a
 * number nobody chose. Dropping costs the user one `/list all`.
 *
 * @param raw - The stored `browsing` object.
 * @returns The usable subset, in the stored order.
 */
function normalizeBrowsing(raw) {
    const result = {};
    for (const [accountId, conversations] of Object.entries(raw)) {
        if (!isRecord(conversations))
            continue;
        const kept = {};
        for (const [conversationId, entry] of Object.entries(conversations)) {
            const position = asBrowsePosition(entry);
            if (position !== undefined)
                kept[conversationId] = position;
        }
        if (Object.keys(kept).length > 0)
            result[accountId] = kept;
    }
    return result;
}
/**
 * Whether a stored entry is a resumable browsing position.
 *
 * @param raw - One entry from the state file.
 * @returns The position, or undefined when it cannot be continued.
 */
function asBrowsePosition(raw) {
    if (!isRecord(raw))
        return undefined;
    const level = raw.level;
    if (level !== 'folders' && level !== 'sessions')
        return undefined;
    if (typeof raw.workspace !== 'string')
        return undefined;
    if (typeof raw.page !== 'number' || !Number.isInteger(raw.page) || raw.page < 1)
        return undefined;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at))
        return undefined;
    return { level, workspace: raw.workspace, page: raw.page, at: raw.at };
}
/**
 * One validator per setting, keyed the way the state file stores it.
 *
 * A mapped type over every setting rather than a hand-copied list, because the hand-copied list is
 * what broke: it kept four numbers and three booleans, so `permissionPreset`,
 * `allowCrossSessionNotify` and `workspacePath` were all discarded on load. A saved setting
 * survived until the next write, then vanished — every write reloads and re-normalizes — which is
 * why the page appeared to forget everything across a restart. Adding a setting without a validator
 * here is now a compile error, so the same omission cannot happen again.
 *
 * @param raw - The stored value for one setting.
 * @returns The usable value, or undefined when it is the wrong shape.
 */
const SETTING_VALIDATORS = {
    mergeWindowMs: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
    maxReplyChars: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
    settleMs: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
    quoteHistory: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
    autoReplyAttachments: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    requireConfirmation: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    presenceNote: (raw) => (typeof raw === 'string' ? raw : undefined),
    permissionPreset: (raw) => raw === 'danger-full-access' || raw === 'auto' || raw === 'default' ? raw : undefined,
    allowCrossSessionNotify: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    workspacePath: (raw) => (typeof raw === 'string' ? raw : undefined),
};
/**
 * Keep only settings of the expected type.
 *
 * The file is user-editable and survives upgrades, so a hand-written string where a number
 * belongs must not reach arithmetic that would turn it into NaN and disable a timer silently.
 *
 * @param raw - The stored settings object.
 * @returns The usable subset.
 */
function normalizeSettings(raw) {
    const settings = {};
    for (const key of Object.keys(SETTING_VALIDATORS)) {
        const validate = SETTING_VALIDATORS[key];
        const value = validate(raw[key]);
        if (value !== undefined)
            settings[key] = value;
    }
    return settings;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=state.js.map