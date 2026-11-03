/**
 * Conversation routing: one WeChat conversation maps to one DSH session, and the
 * user switches between them with in-chat commands.
 *
 * Why commands rather than a picker: WeChat gives a channel exactly one chat
 * surface, so a session list has to live inside the message stream. Tencent's own
 * client uses the same technique (it handles `/echo` and `/toggle-debug` in chat),
 * and the protocol's tool-call item types could eventually render something
 * richer. Commands work today, on every client, with no extra payload.
 *
 * Session ids are minted by this router in DSH's own format (`session-<uuid>`) and
 * handed to the session controller, which adopts an existing session with that id
 * or creates one. The mapping is what survives a restart, so a chat keeps talking
 * to the same session across reboots.
 *
 * @module @dsh-wechat/core/router
 */
/** One conversation's binding to a DSH session. */
export interface SessionBinding {
    conversationId: string;
    accountId: string;
    peerId: string;
    /** DSH session id, in the platform's own `session-<uuid>` form. */
    sessionId: string;
    /** Human label shown in `/list`, captured when the session was bound. */
    title: string;
    createdAt: number;
    lastUsedAt: number;
}
/**
 * The part of a session a numbering needs.
 *
 * Deliberately just these two fields: a numbering is written to the state file so a quote can pin it,
 * and the row it names must stay switchable after a restart — which title and id are enough for.
 */
export interface NumberedSession {
    sessionId: string;
    title: string;
}
/** One conversation as a listing shows it. */
export interface ListedSession extends NumberedSession {
    updatedAt: number;
    /**
     * Working directory the session belongs to, when the channel knows it.
     *
     * Absent means "this workspace's own", which is the only thing a conversation can vouch for — see
     * {@link sessionFolders}.
     */
    workspace?: string;
}
/**
 * The rows a numbering printed, and the number printed beside the first of them.
 *
 * The pair travels together because a number is only meaningful with its offset: numbering runs on
 * across screens, so a second screen of ten starts at 11, and a reply of "13" read from row 1 would
 * name a conversation the user never saw.
 */
export interface NumberedRows {
    sessions: NumberedSession[];
    /** 1-based number printed beside `sessions[0]`. 1 on a first screen, 11 on the second of ten. */
    first: number;
}
/**
 * Where a conversation is in the two-level browser.
 *
 * Persisted because 「查看其余」 carries no target: it means "the next ten of what I am looking at",
 * and this is the only record of what that is. Keyed per conversation, because one plugin serves
 * several chats.
 */
export interface BrowsePosition {
    /** `folders` is the workspace list; `sessions` is one workspace's conversations. */
    level: 'folders' | 'sessions';
    /** Directory whose conversations are shown at the `sessions` level; `''` is the channel's own. */
    workspace: string;
    /** 1-based screen last shown. */
    page: number;
    /** When it was last advanced, so an abandoned position can be retired. */
    at: number;
}
/**
 * One workspace as the first level of the browser lists it.
 *
 * A folder rather than a row: the first level answers "which project", not "which conversation", and
 * a conversation is only reachable after one has been chosen.
 */
export interface SessionFolder {
    /** Absolute directory; `''` for the channel's own workspace. */
    path: string;
    /** Name printed in the list and accepted back when entering. */
    label: string;
    /** Conversations inside, so the user can tell a project they work in from one they do not. */
    count: number;
}
/** Why the router handed work to the agent, for logging. */
export interface RouteDecision {
    /** Session the prompt belongs to. */
    sessionId: string;
    /** Text to send to the agent. */
    prompt: string;
    /** True when this message started a brand new session. */
    created: boolean;
    /**
     * A sentence to send to the user before the prompt, when the conversation had to be moved.
     *
     * Carried back rather than sent here because core has no way to send anything: the caller owns
     * every outbound message. It is not optional decoration — a rebind without it looks to the user
     * like their conversation was replaced at random, and the one thing they can do about it is be
     * told.
     */
    notice?: string;
}
/** Result of routing one message. */
export type RouteResult = {
    kind: 'reply';
    text: string;
    /**
     * The rows this reply numbered, in the order it printed them.
     *
     * Travels back to the caller because only the caller knows the id the service assigns to the
     * message it is about to send — and that id is what a later quote of the list refers to. Handing
     * the numbering over here is what lets a quote pin the numbers the user is looking at, instead
     * of re-deriving them from sessions that have moved on since.
     */
    numbered?: NumberedRows;
    /**
     * Where this reply left the conversation in the browser, when it was a screen of a listing.
     *
     * Absent everywhere else, which is the signal to forget any position: a listing is a place the
     * user is standing, and every other outcome means they walked away from it.
     */
    browse?: BrowsePosition;
} | {
    kind: 'prompt';
    decision: RouteDecision;
};
/**
 * One model a conversation can be moved to.
 *
 * Flattened and provider-labelled by the host, because core must not know what a provider is. What
 * it needs is the two opaque strings `selectModel` takes back, plus enough labels to show a row and
 * to match what the user typed.
 */
export interface ModelOption {
    /** Provider id, handed straight back to the host when this model is chosen. */
    provider: string;
    /** Provider label, shown beside the model so two providers' identical ids are told apart. */
    providerName: string;
    /** Model id, handed straight back to the host. */
    model: string;
    /** Model label, which is what the user reads and usually types. */
    name: string;
    /**
     * Reasoning levels this model accepts, in the host's own order.
     *
     * Absent means the model has no such setting at all — not that the host forgot to say. The ids are
     * adapter-owned and opaque; the names are what the user reads and may type back. Which levels exist
     * is the provider adapter's decision (the bundled DeepSeek adapter publishes `off`/`low`/`high`/`max`,
     * and only `off` when the deployment disables thinking), so the plugin never assumes a set.
     */
    levels?: readonly ReasoningLevel[];
    /**
     * Level the host picks when a selection names none.
     *
     * Sent back on a plain model switch, so the level in effect is one the user was shown rather than
     * one a resolve step chose invisibly. The desktop picker does the same thing.
     */
    defaultLevel?: string;
}
/** One reasoning level a model accepts, as the host names it. */
export interface ReasoningLevel {
    /** Adapter-owned id, handed straight back to the host. */
    id: string;
    /** Label the user reads, usually the id in the host's own capitalisation. */
    name: string;
}
/** Which model a session runs on, and at which reasoning level. Opaque to core: ids from the host. */
export interface ModelSelection {
    provider: string;
    model: string;
    /** Level in effect, absent when the session's model has no reasoning levels. */
    reasoningEffort?: string;
}
/** Every model on offer, plus the one the host reported as current. */
export interface ModelListing {
    /**
     * The selection the host reports for the session that asked, when it reports one.
     *
     * The bound session is what `/model` is about, so the host is handed its id and answers with *that*
     * session's model and level. It may instead answer with the deployment default — a composition
     * without the per-session read, or a session with no request logged yet — which is what the mark
     * falls back to: choosing a model also saves it as that default, so only a model chosen in the
     * desktop for one session can differ.
     */
    current?: ModelSelection;
    models: readonly ModelOption[];
    /** Providers whose models could not be listed, with the host's own reason. */
    failures?: readonly {
        name: string;
        message: string;
    }[];
}
/**
 * Whether the session a conversation is bound to can still take a message.
 *
 * Three answers, because two different failures look identical from the phone. An **archived**
 * session is still on disk and still accepts a prompt — DSH records the archive in the workspace
 * registry and rejects the *step* the prompt proposes, so the turn ends blocked with no error and
 * nothing said. A **missing** session has no record at all, so the prompt lands nowhere. Either way
 * the user's message is swallowed in silence, which is the failure this vocabulary exists to name.
 */
export type SessionState = 'usable' | 'archived' | 'missing';
/**
 * The session surface this router needs from the host.
 *
 * Keeping it narrow means the routing rules are unit-testable without booting DSH,
 * and it documents exactly which host calls the channel depends on.
 */
export interface SessionGateway {
    /** Bind or resume a session with this id. Implementations should be idempotent. */
    ensureSession(sessionId: string, title: string): Promise<void>;
    /** Hand a prompt to a session. */
    prompt(sessionId: string, text: string): Promise<void>;
    /**
     * Recent sessions, newest first, for the whole-machine levels of the browser.
     *
     * Each row should carry its `workspace` so the listing can group by it. A row without one is
     * treated as belonging to the channel's own workspace.
     */
    listSessions(): Promise<ListedSession[]>;
    /**
     * Sessions belonging to the channel's own workspace.
     *
     * Optional because only the host knows where a session lives. `/list` uses it to show just this
     * workspace's conversations and merely mention the rest; without it, every session is treated as
     * the channel's own and the list shows the whole machine.
     */
    listOwnSessions?(): Promise<ListedSession[]>;
    /** Abort whatever the session is currently doing. */
    cancel(sessionId: string): Promise<void>;
    /**
     * Models a session may be moved to, and the one the host says is in use.
     *
     * Optional for the same reason as {@link SessionGateway.listOwnSessions}: only the host knows
     * which models exist. A composition without a catalog answers that it has none, rather than
     * throwing out of a command the user typed.
     *
     * The session id is passed rather than resolved, because a model selection is session-local while
     * the catalog is deployment-wide: the same list is shown everywhere, but "current" means the model
     * *this* conversation is on. It is absent when there is no conversation yet, in which case the host
     * answers with its deployment default.
     */
    listModels?(sessionId?: string): Promise<ModelListing>;
    /**
     * Point a session at one model, and optionally at one reasoning level.
     *
     * The reasoning effort travels with the model rather than being left to the host to default,
     * because leaving it out would hand a decision to a resolve step the user cannot see: the same
     * model at a different effort is a different answer. A level with the *same* provider and model is
     * how the level is changed on its own.
     */
    selectModel?(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<ModelSelection>;
    /**
     * Whether a session a conversation is already bound to can still take work.
     *
     * **Optional, and the router behaves exactly as it did before without it.** A gateway that cannot
     * answer must not cost the user a message, so an absent probe is not an error and not a reason to
     * rebind — the binding is reused as it always was.
     *
     * It exists because both of the ways a bound session goes dead are invisible downstream: the
     * prompt is accepted and nothing is ever answered, and no layer logs a thing. Asking *before*
     * reuse is the only point at which the channel can tell the difference between a session that
     * works and one that will swallow the message.
     *
     * A throw is not a verdict. The router treats a failed probe as `usable` and writes a diagnostic
     * line, because a broken probe losing the user's message would be worse than a stale binding.
     */
    sessionState?(sessionId: string): Promise<SessionState>;
}
/**
 * How long a binding must have existed before a `missing` verdict is believed.
 *
 * This is not a nicety; it is what a live run cost. The first version of this check replaced a
 * binding whenever the probe answered `missing`, and the machine immediately produced an endless
 * run of new sessions: a session has **no record on disk until its first turn writes one**, so every
 * message that arrived before that write judged the session it had just created to be missing, and
 * created another one. The user saw a new conversation per message.
 *
 * The age of the *binding* is what separates "its record is not written yet" from "it is actually
 * gone": the binding is created before the session's first prompt, so a young binding is expected to
 * be recordless, while an old one that still has no record is a session that has been deleted. Two
 * minutes is far longer than a first write takes and short enough that a deleted session is repaired
 * during the same exchange the user would otherwise have lost.
 *
 * `archived` is deliberately not subject to this. The archive set lives in the workspace registry,
 * which answers immediately and knows nothing about whether a record has been written yet — there is
 * no race here to be tolerant of, and an archived session never becomes usable by waiting.
 */
export declare const MISSING_BINDING_GRACE_MS: number;
/** Everything persisted for routing, injected so the store stays pluggable. */
export interface BindingStore {
    load(): Promise<Record<string, SessionBinding>>;
    save(bindings: Record<string, SessionBinding>): Promise<void>;
}
export interface SessionRouterOptions {
    gateway: SessionGateway;
    store: BindingStore;
    /** Display name used when auto-creating a session title. */
    titlePrefix?: string;
    /**
     * Directory the channel's own sessions live in.
     *
     * Only used to decide which rows belong under the channel's own heading. The store records absolute
     * directories, so without it the channel's workspace would be labelled with its folder name
     * (`dsh_wechat`) instead of the name the user knows it by.
     */
    ownWorkspace?: string;
    /** Heading for the channel's own workspace. */
    ownWorkspaceLabel?: string;
    /**
     * Sink for routing facts that have to end up in a log.
     *
     * The router cannot write to a log itself — core imports nothing from the host — and the facts that
     * matter most here are precisely the ones with no other trace: a binding replaced because its
     * session died, a rebind *skipped* because the binding is too young to judge, and a probe that
     * threw and was therefore treated as `usable`. Each of those is a decision a person diagnosing a
     * silence needs to see, and none of them is visible in the message that was routed.
     *
     * Lines are English, like the rest of the channel's log, and each names the conversation, the
     * session, the verdict and what was done with it.
     */
    onDiagnostic?: (line: string) => void;
}
/**
 * Routes WeChat messages to DSH sessions and implements the in-chat commands.
 */
export declare class SessionRouter {
    #private;
    constructor(options: SessionRouterOptions);
    /**
     * Route one inbound message.
     *
     * @param params.conversationId - Stable conversation key.
     * @param params.accountId - Bot account the message arrived on.
     * @param params.peerId - Counterparty user id.
     * @param params.text - Message text.
     * @param params.numbered - The rows a bare number refers to, when the caller knows of a listing the
     *   user is looking at — a quoted list, or the newest one sent into this conversation.
     * @param params.heldHint - Wording for the "there are more conversations elsewhere" sentence, which
     *   differs between a typed `/list` and a spoken request.
     * @param params.browse - Where this conversation was left in the listing browser, when it is
     *   somewhere. Without it a bare number is an ordinary message, as it always was.
     * @returns Either text to reply with directly, or a prompt for a session. A prompt decision may
     *   carry a `notice` when the conversation had to be moved to a new session first — see
     *   {@link SessionGateway.sessionState}.
     */
    route(params: {
        conversationId: string;
        accountId: string;
        peerId: string;
        text: string;
        numbered?: NumberedRows;
        heldHint?: string;
        browse?: BrowsePosition;
    }): Promise<RouteResult>;
    /** Currently bound session for a conversation, if any. */
    current(conversationId: string): Promise<SessionBinding | undefined>;
}
/**
 * Split `/cmd args` into its parts.
 *
 * The separator space is optional, and `:` is accepted in its place, because these
 * commands are typed on a phone keyboard where a dropped space is the common case.
 * `/switch1`, `/switch 1`, and `/switch:1` all mean the same thing. A leading token
 * that only *starts* with a command name is left alone, so `/news` is not `/new`.
 */
export declare function splitCommand(text: string): {
    command: string;
    args: string;
};
/**
 * What a `/switch` argument resolved to.
 *
 * Ambiguity is a distinct outcome rather than a missing one. The two need different answers: nothing
 * matched means "look at the list again", while several matched means "your id is too short" — and
 * the second is the one the user can fix, so it has to name the candidates instead of guessing.
 */
export type TargetResolution = {
    kind: 'found';
    session: NumberedSession;
} | {
    kind: 'ambiguous';
    candidates: NumberedSession[];
}
/**
 * A number that named no row of the listing the user was shown.
 *
 * Its own outcome because the answer has to say *which numbers do exist* — "no such conversation"
 * would send the user back to the list for a reading they already have. And because this is the
 * case that must never be rescued by a looser reading: see {@link resolveTarget}.
 */
 | {
    kind: 'unprinted';
    number: number;
    first: number;
    last: number;
} | {
    kind: 'none';
};
/**
 * Resolve a `/switch` argument against the session list.
 *
 * Accepts a 1-based list position, a full session id, the short id printed by `/list` (or any longer
 * prefix of it), or a title — a phone keyboard makes copying a full uuid painful.
 *
 * Matching is deliberately strict. Session ids share a common shape (`session-<short>-<uuid>`), so a
 * loose `includes` test can match several rows; an ambiguous argument must fail rather than switch to
 * a surprise session. Since the printed id is only the first few hex digits of it, two conversations
 * *can* share one, and the caller is told to ask for a longer one rather than being handed whichever
 * happened to be found first.
 *
 * Order matters: the exact readings are tried before the prefix reading, so a conversation whose
 * title looks like a hex fragment is still reachable by that title.
 *
 * **A number is a row of the listing, never a fragment of an identifier.** It used to fall through to
 * the id and title readings when no row carried it, and that fall-through is what produced three
 * flaky tests and blocked a release: `99` and `14` are legal hex prefixes, so a session whose
 * six-character id happened to begin with either made `/switch` *succeed* where the caller required
 * it to fail. The auto-generated title repeats those same six characters (`微信 14c71a`), so the
 * loose title reading could have rescued the number even if the prefix reading had been removed —
 * which is why patching one reading at a time never held. A number that names no row is answered with
 * `unprinted` (the row range it could have named) instead of being reinterpreted: ambiguity has to
 * fail out loud, because a guess moves the user's conversation somewhere they never asked to be.
 * Refusing costs nothing a number could still deliver, because every conversation is a row of some
 * listing.
 *
 * The one thing a number may still name is the **exact** short id the row prints, six characters and
 * no more — otherwise a row whose id happens to be all digits (`123456`, about one in seventeen)
 * could not be typed as the id the listing tells the user to type. That is an exact identifier, not a
 * prefix match, and it is tried only when no row carries the number.
 *
 * @param args - What the user typed after `/switch`.
 * @param sessions - Every session that may be named, usually the whole machine.
 * @param numbered - The rows a number refers to, and the number printed beside the first of them.
 *
 *   This matters because the two are not the same list. A number is answered from the listing the
 *   user was actually shown, while a title or id may name a session from any workspace — and a
 *   conversation the user picked out of a listing has to be switchable, or the listing is a lie.
 *   The offset is part of it because numbering runs on across screens: the second screen of ten
 *   prints 11..20, and a "13" read as row 3 would move the chat to a conversation that screen never
 *   showed.
 */
export declare function resolveTarget(args: string, sessions: readonly NumberedSession[], numbered?: NumberedRows): TargetResolution;
/**
 * The answer to a number that named no row of the screen the user was shown.
 *
 * The first line is the whole explanation, because the channel quotes only that line back when this
 * answer travels through the tool: a failure announced without the range would leave the user typing
 * numbers at a screen that cannot answer them. It opens with `找不到` for a second, unrelated reason:
 * the host decides whether a spoken switch succeeded by that word, so an answer that named no
 * conversation has to keep saying so. The tail offers the other form the row prints — which does work
 * for any six characters, including an all-digit one, because that is read as the exact id when no
 * row carries the number.
 *
 * @param value - The number the user typed.
 * @param first - Number printed beside the screen's first row.
 * @param last - Number printed beside its last row.
 * @returns The message body.
 */
export declare function unprintedTargetMessage(value: number, first: number, last: number): string;
/**
 * The message for a `/switch` whose id was too short to identify one conversation.
 *
 * The candidates are printed with the *longest* prefix of their hex group, which is exactly the
 * longer id the user should reply with — and with their titles, because a phone user recognises the
 * conversation, not the id.
 *
 * @param value - What the user typed.
 * @param candidates - Every session it matched.
 * @returns The message body.
 */
export declare function ambiguousTargetMessage(value: string, candidates: readonly NumberedSession[]): string;
/**
 * Mint a session id in DSH's own format.
 *
 * The id is `session-<uuid>` because the host treats that shape as its native
 * session identity. The trailing hex group is random; the leading group is
 * derived from it so that the compact form shown by `/list` is also the form
 * `/switch` accepts. Keeping the two identical is what makes switching possible
 * from a phone keyboard.
 */
export declare function mintSessionId(random?: () => string): string;
/**
 * How many characters of a session id the list prints.
 *
 * Six hex digits is still short enough to read and retype on a phone, while the space it draws from
 * is 16 777 216 values instead of the 65 536 four digits gave: a machine with a few hundred sessions
 * collided often enough to be noticed, and the extra two characters are free to type. The printed
 * form is a prefix of the id, so a collision is answered by asking for more characters rather than by
 * failing. The bound is the requirement, not a preference: an identifier the user has to copy is not
 * an identifier they will use.
 */
export declare const SHORT_ID_LENGTH = 6;
/** Compact identifier shown to the user, and accepted back by `/switch`. */
export declare function shortId(sessionId: string): string;
/**
 * The name a user knows a workspace by.
 *
 * The store records absolute directories, and a full path in a chat message is noise. The last
 * component is what the desktop sidebar shows, so it is what the user will recognise.
 *
 * @param path - Working directory recorded for a session.
 * @returns Its final path component, or the path itself when there is nothing to trim.
 */
export declare function workspaceLabel(path: string): string;
/**
 * Resolve a `/model` argument against the catalog.
 *
 * Accepts a 1-based list position, a model id, or a model name — the same three shapes `/switch`
 * accepts for a conversation, for the same reason: the number is what the listing prints, and the
 * name is what a person remembers. A number is only ever a position; see `resolveTarget` for the
 * incidents that rule comes from.
 *
 * Matching is deliberately strict, and every match must be unique. Two providers can expose the same
 * model id (`deepseek-chat` from two accounts), so a loose match would silently pick one of them, and
 * which one silently picked is not something the user could even see. Several matches return
 * undefined: a model the user did not ask for is worse than a question.
 *
 * @param args - What the user typed after `/model`.
 * @param models - Every model the host offers, in the order the listing numbered them.
 */
export declare function resolveModelOption(args: string, models: readonly ModelOption[]): ModelOption | undefined;
/** What a `/model` argument turned out to be about. */
export interface ModelCommand {
    /** Model the user named, or an empty string when they mean the one in use. */
    target: string;
    /** Level the user named, when the argument named one. */
    level?: string;
    /** Whether the argument is about a reasoning level at all. */
    levelForm: boolean;
}
/**
 * Words that mean "what follows is a reasoning level, not a model".
 *
 * `/model 等级 高`, `/model 2 等级 高` and `/model level high` all name the level explicitly instead of
 * leaving the plugin to guess which half of the argument it is. Nothing else is accepted: a level id
 * is a single word the adapter published, so a positional rule would have to guess where a
 * multi-word model name ends — and a guess here picks either the wrong model or the wrong level,
 * both of which the user would only discover from the next answer.
 *
 * `等级` is matched as a *suffix* so the full name of the setting (`推理等级`, `思考等级`) works
 * without a second spelling table. No model is called that.
 *
 * @param args - What the user typed after `/model`.
 * @returns The parts the command needs, with `levelForm` false for the plain model forms.
 */
export declare function parseModelCommand(args: string): ModelCommand;
/**
 * Resolve a level the user named against the ones a model publishes.
 *
 * Ids and names are both accepted, case-insensitively, because the two are near-identical for the
 * adapters that ship with DSH (`high` / `High`) and a phone keyboard makes the capitalisation the
 * user's problem otherwise. No partial matching: a level guessed wrong silently changes how much the
 * model thinks, which is not a mistake the user can see in the answer.
 *
 * @param value - What the user typed.
 * @param levels - Levels the model publishes.
 */
export declare function resolveLevel(value: string, levels: readonly ReasoningLevel[]): ReasoningLevel | undefined;
/**
 * Render one model's reasoning levels, with the one in effect marked.
 *
 * The level the conversation is *on* is what is marked; for any other model the host's own default
 * is, because that is the level a switch to it would land on. Only one of the two can apply to a
 * given model — the mark means "you would get this if you stopped typing here".
 *
 * @param option - Model whose levels are being shown.
 * @param current - Selection the host reported, which may be for another model.
 * @param levels - Levels the model publishes.
 * @returns The message body.
 */
export declare function renderLevels(option: ModelOption, current: ModelSelection | undefined, levels: readonly ReasoningLevel[]): string;
/**
 * How many rows one screen of the browser shows, at both levels.
 *
 * Ten, because that is what a phone screen holds and what the listing already showed. The point of
 * two levels is not to fit more on one screen but to make every conversation reachable without ever
 * printing more than a readable amount at once — which is what the old fixed cut could not do.
 */
export declare const BROWSE_PAGE_SIZE = 10;
/** The phrase that walks one screen further down whichever level the user is on. */
export declare const SHOW_REST = "\u67E5\u770B\u5176\u4F59";
/**
 * Whether a message is the phrase that walks to the next screen.
 *
 * Trailing sentence punctuation is stripped because a phone keyboard adds it and the user is writing
 * a sentence, not typing a token. Nothing else is accepted: this phrase has no target, so a near miss
 * that was guessed at would move the user somewhere they did not ask to go.
 *
 * @param text - The inbound message.
 */
export declare function isShowRest(text: string): boolean;
/**
 * Group rows into the folders the first level lists.
 *
 * The channel's own workspace leads, because those are the conversations this chat created; the rest
 * follow, most recently active first, with the directory as the tie-break so the same machine always
 * produces the same list. A row that does not say where it lives counts as the channel's own, which
 * is the only workspace a conversation can vouch for.
 *
 * Counts, not rows: the first level answers "which project", and its rows have to be small enough
 * that ten of them name ten projects. A folder holding nothing is left out — a row that opens onto
 * an empty list is a dead end dressed as a choice.
 *
 * @param rows - Every conversation the machine knows.
 * @param options.ownWorkspace - Directory the channel's own conversations live in.
 * @param options.ownLabel - Name printed for that directory.
 * @returns Non-empty folders, in display order.
 */
export declare function sessionFolders(rows: readonly ListedSession[], options: {
    ownWorkspace?: string;
    ownLabel: string;
}): SessionFolder[];
/**
 * Cut one screen of ten out of an ordered sequence.
 *
 * @param rows - The whole sequence, already ordered.
 * @param page - 1-based screen to cut; clamped into range, so a stored page that no longer exists
 *   still renders something rather than an empty message.
 * @returns The rows on that screen, where the screen sits, and how many there are.
 */
export declare function browsePage<T>(rows: readonly T[], page: number): {
    items: T[];
    page: number;
    pages: number;
    start: number;
};
/**
 * The numbering one screen of a folder prints, for a caller that has no frozen listing.
 *
 * Only a fallback: the numbering the user is looking at is the one frozen under the message that
 * printed it, and the caller passes that whenever it has one.
 *
 * @param rows - Every row of the folder, ordered.
 * @param page - Screen the reply is answering.
 * @returns That screen's rows and the number printed beside the first of them.
 */
export declare function screenRows(rows: readonly ListedSession[], page: number): NumberedRows;
/**
 * Render one screen of the workspace list.
 *
 * @param folders - Every folder, in display order.
 * @param page - 1-based screen to print.
 * @returns The message body.
 */
export declare function renderFolderScreen(folders: readonly SessionFolder[], page: number): string;
/**
 * Render one screen of a folder's conversations.
 *
 * The numbering runs on across screens, so the second screen of ten prints 11..20 — the number is
 * what the user replies with, and starting over at 1 would give one number two meanings within a
 * single browse.
 *
 * @param rows - Every conversation in the folder, ordered.
 * @param options.label - Folder name, printed in the heading.
 * @param options.page - 1-based screen to print.
 * @param options.currentId - Session this conversation is bound to, marked in the list.
 * @param options.held - Conversations in other folders, counted and named rather than left invisible.
 * @param options.heldHint - How to reach them, which differs between typed and spoken requests.
 * @param options.now - Current time, so every row of one message agrees on what "3 分钟前" means.
 * @returns The message body, and the numbering it printed.
 */
export declare function renderSessionScreen(rows: readonly ListedSession[], options: {
    label: string;
    page: number;
    currentId?: string;
    held?: {
        count: number;
        names?: readonly string[];
    };
    heldHint?: string;
    now?: number;
}): {
    text: string;
    numbered: NumberedRows;
};
/** What entering a folder resolved to. Ambiguous, unprinted and none are separate, as for `resolveTarget`. */
export type FolderResolution = {
    kind: 'found';
    folder: SessionFolder;
} | {
    kind: 'ambiguous';
    candidates: SessionFolder[];
}
/** A number at or above which the machine has no workspace. */
 | {
    kind: 'unprinted';
    number: number;
    count: number;
} | {
    kind: 'none';
};
/**
 * Resolve what the user typed against the workspace list.
 *
 * Accepts the printed number, the printed name, or a fragment of it — the same three shapes
 * `resolveTarget` accepts for a conversation, for the same reason: the number is what the listing
 * prints, and the name is what a person remembers.
 *
 * Two directories routinely share a last component (`…/workplace` under two parents), and the printed
 * name is that last component — so a name matching several folders returns the candidates instead of
 * picking one. Entering the wrong project's folder is worse than a question.
 *
 * A pure number is a position and nothing else, exactly as in {@link resolveTarget}: it used to fall
 * through to the names, which would enter a folder called `3` when the user meant the third row (or
 * the reverse). The two readings are the same ambiguity that cost three flaky tests on the session
 * side of this browser, and a number out of range says how many there are instead of guessing.
 *
 * @param args - What the user replied with.
 * @param folders - Every folder, in the order the listing numbered them.
 * @returns What it named.
 */
export declare function resolveFolder(args: string, folders: readonly SessionFolder[]): FolderResolution;
/**
 * The answer to a folder number this machine has no workspace at.
 *
 * Same shape as {@link unprintedTargetMessage}, for the same reason: the user is looking at a list
 * that printed numbers, so the useful reply is how many it printed. Folders are numbered across the
 * whole list rather than one screen at a time (they are a short list), so there is no screen to name.
 *
 * @param value - The number the user replied with.
 * @param count - Workspaces on this machine.
 * @returns The message body.
 */
export declare function unprintedFolderMessage(value: number, count: number): string;
/**
 * The message for a workspace name that named several folders.
 *
 * The candidates are printed with their numbers, because the number is the one form that is never
 * ambiguous, and it is what the user replies with next.
 *
 * @param value - What the user typed.
 * @param candidates - Every folder it matched.
 * @param folders - The whole list, so each candidate can be shown with its own number.
 * @returns The message body.
 */
export declare function ambiguousFolderMessage(value: string, candidates: readonly SessionFolder[], folders: readonly SessionFolder[]): string;
/**
 * Render one row of a session list.
 *
 * The title leads because it is what a person recognises, the time follows because the list is
 * ordered by it, and the **short id closes the row** because it is what `/switch` accepts when a
 * number is not enough — and a workspace heading is shared by every row under it, so two
 * conversations in one workspace are otherwise indistinguishable.
 *
 * One row per line rather than two: a listing of ten conversations has to fit in one WeChat message,
 * and a second line per row doubles the height of a phone screen full of them.
 *
 * @param session - Session to render.
 * @param index - 0-based position, rendered as the 1-based number to reply with.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @param now - Current time, so every row of one message agrees on what "3 分钟前" means.
 * @returns The row.
 */
export declare function renderSessionRow(session: {
    sessionId: string;
    title?: string;
    updatedAt?: number;
}, index: number, currentId: string | undefined, now?: number): string;
/**
 * The message for a `/list` whose own workspace has no conversations yet.
 *
 * @param held - Conversations in other workspaces.
 * @param ownLabel - Heading for the channel's own workspace.
 * @returns The message body.
 */
export declare function heldOnlyList(held: readonly ListedSession[], ownLabel: string): string;
/**
 * The workspace names behind a set of held rows, for the sentence that counts them.
 *
 * @param held - Rows left out of a listing.
 * @returns Distinct workspace labels, sorted, without duplicates.
 */
export declare function heldNames(held: readonly ListedSession[]): string[];
/**
 * Render the model list.
 *
 * Unlike sessions this is not capped. A session list grows without bound as a machine is used, so it
 * needs a cut-off; a model catalog is a closed set the host itself offers in full, and every model
 * has to be reachable by the number printed next to it.
 *
 * Each model also carries its reasoning levels when it has any, because "which model" and "how hard
 * it thinks" are the two halves of the same choice: a list that showed only the first would send the
 * user back for a second question, and the level is not discoverable anywhere else on a phone.
 *
 * @param listing - Models on offer, and the selection the host reports.
 * @returns The message body.
 */
export declare function renderModelList(listing: ModelListing): string;
/**
 * How long ago something happened, in the words a person would use.
 *
 * Relative rather than absolute because the question the list answers is "which one was I just
 * working on", and a 24-hour clock makes that harder, not easier. `昨天` appears because that is the
 * word people actually use for it, and it is the boundary a reader cares about most.
 *
 * @param at - Timestamp in milliseconds.
 * @param now - Current time, injectable so the wording is testable and one message stays consistent.
 * @returns A short phrase such as `3 分钟前`.
 */
export declare function relativeTime(at: number, now?: number): string;
export declare const HELP_TEXT: string;
//# sourceMappingURL=router.d.ts.map