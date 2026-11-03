/**
 * The reply-window quota: how many sends one `context_token` allows, and who counts them.
 *
 * The limit is measured, not documented: the platform refuses the eleventh send of a window with
 * `ret=-2 errcode=-2 errmsg=prepare failed`, and only an inbound message opens a new window. The
 * count therefore has one job — know when to ask the user to write again, *before* the last slot is
 * spent, because the ask is itself a message.
 *
 * It lives in `core` rather than in the host because the counting has to be shared. An agent that
 * writes its own script to send a timed series cannot be counted by the plugin at all, which is why
 * `dsh-wechat-send` exists; the command and the plugin both charge against this ledger, so the ten
 * are counted the same way whichever process spends them, and the count survives a restart on both
 * sides.
 *
 * @module @dsh-wechat/core/quota
 */
/**
 * Outbound messages one reply token allows.
 *
 * Measured against the live service: the tenth send of a window succeeds and the eleventh is
 * refused, at any interval — so this is a count, not a rate.
 */
export const QUOTA_PER_TOKEN = 10;
/**
 * The send count at which the user is asked for a new window.
 *
 * Two short of the limit rather than at it, because the warning is a message too: asking at ten
 * would be asking into a window with no slot left to carry the ask.
 */
export const QUOTA_WARN_AT = QUOTA_PER_TOKEN - 2;
/**
 * What the user is told as the window runs low.
 *
 * Plain, short, and it asks for the one action that works — any message back. It deliberately does
 * not promise that everything queued will follow; it will, but only after they write, and saying so
 * up front is what keeps the next silence from looking like a failure.
 */
export const QUOTA_WARNING = `📮 微信这边一个回复窗口最多连发 ${String(QUOTA_PER_TOKEN)} 条，我快到上限了。\n` +
    `你随便回我一句，我就能把剩下的接着发过来。`;
/**
 * Whether a value read from the state file is a usable quota entry.
 *
 * The file is user-editable and survives upgrades, so `used` reaches arithmetic that decides whether
 * to ask for a new window — a string there would compare as false forever and the warning would
 * silently never fire.
 *
 * @param raw - One entry from `state.quota`.
 * @returns True when every field has the expected shape.
 */
export function isQuotaEntry(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return false;
    const entry = raw;
    return (typeof entry.used === 'number' &&
        Number.isFinite(entry.used) &&
        entry.used >= 0 &&
        typeof entry.warned === 'boolean' &&
        (entry.token === undefined || typeof entry.token === 'string'));
}
/**
 * Charge one send against the token it used.
 *
 * Pure: it reads a stored entry and returns the next one, so the caller decides how to persist it.
 * That keeps the arithmetic — the part that decides whether the user gets asked for a new window —
 * testable without a store, a clock, or a network.
 *
 * **The warning is charged too.** It is a real message and spends a real slot, so recording it is
 * what keeps the count equal to what the service actually saw. It is *not* sent from here: the
 * caller sends it on its own low-level path, which is the only way charging a send cannot charge
 * another one and recurse.
 *
 * @param params.stored - The entry on disk for this conversation, if any.
 * @param params.token - Token this send used; a change means the window, and the count, are new.
 * @param params.warned - Overrides the stored flag, for a caller that already sent the warning.
 * @returns The next entry and whether to warn.
 */
export function chargeQuota(params) {
    const { stored, token } = params;
    /*
     * A token that differs from the stamp starts a new window.
     *
     * This is the whole of the reset rule, and it is why the token is stored rather than just the
     * count: the platform issues a fresh ten with every inbound message, and nothing on this side is
     * told when that happens except by seeing the token itself change.
     */
    const fresh = stored === undefined || stored.token !== token;
    const sent = (fresh ? 0 : stored.used) + 1;
    const alreadyWarned = params.warned ?? (fresh ? false : stored.warned);
    // Once per window: the warning asks the user to do something, and repeating it on every send
    // after the eighth would spend the remaining slots on asking.
    const warn = !alreadyWarned && sent >= QUOTA_WARN_AT;
    // The warning is charged as part of the same write, so the stored count is what the service saw
    // whether or not the send of the warning itself succeeds.
    const used = warn ? sent + 1 : sent;
    // `token` is omitted rather than written as `undefined`: a key that is present but empty is the kind
    // of value a later reader has to interpret, and the state file is read by people too.
    return {
        entry: { ...(token === undefined ? {} : { token }), used, warned: warn || alreadyWarned },
        warn,
        used,
    };
}
/**
 * Keep only quota entries of the expected shape.
 *
 * Filtered rather than trusted, exactly like the pending queue: `used` is the number that decides
 * whether the user is asked for a new window, and a malformed entry would either silence that ask or
 * make it fire on the wrong arithmetic. Dropping the entry is safe — a conversation whose count is
 * lost is treated as a fresh window, and the cost is at most one refused send, which is handled the
 * same way as reaching the limit.
 *
 * @param raw - The stored `quota` object.
 * @returns The usable entries, keyed as stored.
 */
export function normalizeQuota(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const quota = {};
    for (const [conversationId, entry] of Object.entries(raw)) {
        if (isQuotaEntry(entry))
            quota[conversationId] = entry;
    }
    return quota;
}
/**
 * A conversation's quota as it exists on disk, ready to be charged.
 *
 * The store is touched once per charged send. That is deliberately the only persistence point: the
 * count is small and the sends are seconds apart, so a transaction per send costs nothing, while a
 * cached ledger would need a flush on shutdown and would lose the last few sends of every restart —
 * which is exactly the count that decides whether the user gets asked in time.
 */
export class QuotaLedger {
    #state;
    #save;
    /**
     * @param state - Reads the current state, used for the stored entry.
     * @param save - Persists one conversation's entry.
     */
    constructor(state, save) {
        this.#state = state;
        this.#save = save;
    }
    /**
     * Charge one send and decide whether the user should now be asked for a new window.
     *
     * @param conversationId - Conversation the send went to.
     * @param token - Token the send used.
     * @param options.warned - Forces the ask, or suppresses it, for a message that is not the one the
     *   user should reply to. The count is never forced: it stays the number of sends the service saw.
     * @returns The charge, already persisted.
     */
    async charge(conversationId, token, options = {}) {
        const stored = (await this.#state()).quota?.[conversationId];
        const charge = chargeQuota({
            stored,
            token,
            ...(options.warned === undefined ? {} : { warned: options.warned }),
        });
        await this.#save(conversationId, charge.entry);
        return charge;
    }
}
/**
 * Build the ledger a running channel or command charges against.
 *
 * @param store - Durable state, shared by the plugin and the command line so both count the same ten.
 * @returns A ledger whose every charge is written before it is returned.
 */
export function quotaLedgerFor(store) {
    return new QuotaLedger(async () => await store.read(), async (conversationId, entry) => {
        await store.update((state) => {
            // Written one conversation at a time, so a charge for one chat cannot rewrite the entry of
            // another from a snapshot taken before a concurrent send — the command line and the plugin
            // are separate processes writing the same file, which is the case this guards.
            ;
            (state.quota ??= {})[conversationId] = entry;
        });
    });
}
//# sourceMappingURL=quota.js.map