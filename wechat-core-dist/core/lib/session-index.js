/**
 * Reading the session list from DSH's own on-disk store.
 *
 * ## Why this exists
 *
 * The host exposes `sessionController.list()`, and on the machine this was built for it returns an
 * empty array — so `/list` answered with nothing, and the agent had to read the store itself to
 * tell the user anything at all. The store is always there: DSH writes every session to
 * `<home>/sessions/<encoded-cwd>/<session-id>/`, and every title to
 * `<home>/storages/session_projcache/sessions/<uuid>.json`.
 *
 * ## Why the filter is not optional
 *
 * The store holds every workspace on the machine — 73 sessions for the author's project directory
 * against 9 for the channel's own. A session belonging to another workspace **cannot be adopted**:
 * the host pins `cwd` for the life of a session and rejects an adopt whose working directory
 * differs. Offering one would produce a list of conversations that all fail on selection, so only
 * the channel's own workspace is read.
 *
 * @module @dsh-wechat/core/session-index
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * Order sessions newest first, totally.
 *
 * The second key is not decoration. Without it the order of two sessions that share a timestamp is
 * whatever order the filesystem handed their directories over in, so the same store printed two
 * different lists on two consecutive runs — the instability this comparator exists to end. The tie
 * is broken on the session id instead, which is a property of the data, so the same input always
 * produces byte-identical output.
 *
 * @param a - One session.
 * @param b - Another.
 * @returns Negative when `a` should sort first.
 */
export function compareSessionsNewestFirst(a, b) {
    if (a.updatedAt !== b.updatedAt)
        return b.updatedAt - a.updatedAt;
    // Plain `<`/`>` rather than `localeCompare`: collation depends on the runtime's locale data, and a
    // locale-sensitive tie-break would be deterministic on one machine and not on the next.
    if (a.sessionId === b.sessionId)
        return 0;
    return a.sessionId < b.sessionId ? -1 : 1;
}
/**
 * Encode a working directory the way the store names its folder.
 *
 * Runs of separators collapse into a single dash, so `C:\Users\me\.dsh\dsh_wechat` becomes
 * `--C-Users-me-.dsh-dsh_wechat--`. Dots and underscores survive; `C:` and the following `\` share
 * one dash. A leading or trailing separator is dropped first, so a Unix path does not gain an extra
 * dash: `--` plus `-home-me` would be three. Derived by matching the store on disk after two wrong
 * guesses, which is why the exact strings are asserted in the tests.
 *
 * The encoding is still lossy in principle (`a\b` and `a-b` collide), so it is only ever used to
 * *narrow* the search and the authoritative check is the `cwd` recorded inside each session.
 *
 * @param cwd - Absolute working directory.
 * @returns The folder name the store would use.
 */
export function encodeWorkspaceDir(cwd) {
    const trimmed = cwd.replace(/[\\/]+$/, '').replace(/^[\\/]+/, '');
    return `--${trimmed.replace(/[\\/:]+/g, '-')}--`;
}
/**
 * Whether this platform's filesystems ignore case in paths.
 *
 * Windows always does, and macOS ships case-insensitive APFS/HFS+ by default — a case-sensitive
 * volume is possible but unusual.
 *
 * Linux does not, and that is the one that matters: lowercasing there would report `/home/me/Projects`
 * and `/home/me/projects` as the same directory when they are two different ones. The plugin would
 * then count a stranger's sessions as its own, and try to adopt under a workspace they do not belong
 * to. Comparing case-sensitively is the correct answer wherever the filesystem is.
 */
export const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';
/**
 * Whether a recorded `cwd` belongs to the given workspace.
 *
 * Separators are always normalised, because the same directory is written as `C:\Users\me\x` and
 * `C:/Users/me/x` depending on who recorded it. Case is normalised only where the filesystem does —
 * see {@link CASE_INSENSITIVE_PATHS}.
 *
 * @param recorded - `cwd` from the session index.
 * @param workspace - The channel's workspace directory.
 * @param caseInsensitive - Override for the platform default, so both behaviours can be tested.
 * @returns Whether the two name the same place.
 */
export function isSameWorkspace(recorded, workspace, caseInsensitive = CASE_INSENSITIVE_PATHS) {
    const normalise = (value) => {
        const withSlashes = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
        return caseInsensitive ? withSlashes.toLowerCase() : withSlashes;
    };
    return normalise(recorded) === normalise(workspace);
}
/**
 * Strip the `session-` prefix to get the key the index is filed under.
 *
 * @param sessionId - Session id as the channel uses it.
 * @returns The bare uuid the store names its index file with.
 */
export function indexKeyFor(sessionId) {
    return sessionId.replace(/^session-/, '');
}
/**
 * The index file names to try for a session.
 *
 * Two forms exist in the store: sessions created through the workspace registry are filed under the
 * bare uuid, while the channel's own are filed under the full `session-<uuid>`. Both are tried
 * rather than one being assumed, because guessing wrong here silently produces a list with no
 * titles — which is exactly how this was found.
 *
 * @param sessionId - Session id as the channel uses it.
 * @returns Candidate file names, most likely first.
 */
export function indexNamesFor(sessionId) {
    const bare = indexKeyFor(sessionId);
    return bare === sessionId ? [`${sessionId}.json`] : [`${sessionId}.json`, `${bare}.json`];
}
/**
 * Read one session's index entry.
 *
 * The index is versioned per row (`{ver, seq, val}`), and the value is what matters. A missing or
 * unreadable file yields empty fields rather than failing the listing: one damaged entry must not
 * hide every other conversation.
 *
 * @param storeDir - Root of the index store.
 * @param sessionId - Session to read.
 * @returns The recorded title, working directory and last-prompt time.
 */
async function readIndex(storeDir, sessionId) {
    for (const name of indexNamesFor(sessionId)) {
        try {
            const raw = await readFile(join(storeDir, name), 'utf-8');
            const parsed = JSON.parse(raw);
            const title = parsed.record?.rows?.title?.val;
            const cwd = parsed.record?.identity?.cwd;
            return {
                title: typeof title === 'string' ? title : '',
                cwd: typeof cwd === 'string' ? cwd : '',
                updatedAt: recordedSessionTime(parsed),
            };
        }
        catch {
            // Try the next spelling.
        }
    }
    return { title: '', cwd: '', updatedAt: 0 };
}
/**
 * When a session record says the conversation last ran.
 *
 * Two fields are read, in the order the store itself prefers them: `sessionListMetadata.lastPromptAt`
 * is the timestamp DSH's own session list shows, and `identity.createdAt` is the fallback for a
 * record written before that row existed.
 *
 * **Why not the file's mtime**, which is what this used to read: mtime answers "when was this
 * directory last written", and *anything* touching the session changes it — a background write, an
 * unrelated tool call, the store compacting itself. The user saw a different "上次时间" every time
 * they asked, and a different row order to go with it. A field inside the record changes only when
 * the conversation itself moves, which is the question the list is answering.
 *
 * @param parsed - The parsed index entry.
 * @returns Milliseconds since epoch, or 0 when the record carries no usable timestamp.
 */
export function recordedSessionTime(parsed) {
    const lastPromptAt = parsed.record?.rows?.sessionListMetadata?.val?.lastPromptAt;
    if (typeof lastPromptAt === 'number' && Number.isFinite(lastPromptAt))
        return lastPromptAt;
    const createdAt = parsed.record?.identity?.createdAt;
    if (typeof createdAt === 'number' && Number.isFinite(createdAt))
        return createdAt;
    return 0;
}
/**
 * List the sessions belonging to one workspace, newest first.
 *
 * @param home - DSH home directory.
 * @param workspace - The channel's workspace directory.
 * @returns Sessions it can actually switch to.
 */
export async function listStoredSessions(home, workspace) {
    const sessionsRoot = join(home, 'sessions');
    const indexDir = join(home, 'storages', 'session_projcache', 'sessions');
    // The folder name is a lossy encoding, so the candidates are narrowed by it and confirmed by the
    // recorded `cwd` below.
    let candidates;
    try {
        const dirs = await readdir(sessionsRoot, { withFileTypes: true });
        candidates = dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch {
        return [];
    }
    const exact = encodeWorkspaceDir(workspace);
    const wanted = candidates.filter((name) => name === exact);
    const sessions = [];
    for (const folder of wanted) {
        let ids;
        try {
            const entries = await readdir(join(sessionsRoot, folder), { withFileTypes: true });
            ids = entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
                .map((entry) => entry.name);
        }
        catch {
            continue;
        }
        for (const sessionId of ids) {
            const index = await readIndex(indexDir, sessionId);
            // The folder name is a lossy encoding, so a session is only offered when its own record says
            // it belongs here. Without this check a differently-spelled path could contribute sessions
            // that would fail the moment the user picked one.
            if (index.cwd !== '' && !isSameWorkspace(index.cwd, workspace))
                continue;
            sessions.push({
                sessionId,
                title: index.title,
                updatedAt: index.updatedAt,
                cwd: index.cwd,
            });
        }
    }
    return sessions.sort(compareSessionsNewestFirst);
}
/**
 * List every session on the machine, grouped by the workspace it belongs to.
 *
 * Used when the user asks to see conversations beyond the channel's own: the store holds all of
 * them, and each record names its working directory, so the grouping is read rather than inferred.
 *
 * **The map's order is part of the answer.** A `Map` keeps insertion order, and this map is what the
 * caller renders, so leaving the order to the directory walk would put the same workspaces in a
 * different order on every run. Groups are therefore inserted most-recently-active first, with the
 * workspace path as the tie-break.
 *
 * @param home - DSH home directory.
 * @returns Sessions per workspace path, each list newest first.
 */
export async function listAllStoredSessions(home) {
    const sessionsRoot = join(home, 'sessions');
    const indexDir = join(home, 'storages', 'session_projcache', 'sessions');
    let folders;
    try {
        const entries = await readdir(sessionsRoot, { withFileTypes: true });
        folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch {
        return new Map();
    }
    const collected = new Map();
    for (const folder of folders) {
        let ids;
        try {
            const entries = await readdir(join(sessionsRoot, folder), { withFileTypes: true });
            ids = entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
                .map((entry) => entry.name);
        }
        catch {
            continue;
        }
        for (const sessionId of ids) {
            const index = await readIndex(indexDir, sessionId);
            // Grouped by the record, not the folder: the folder name is a lossy encoding and would merge
            // unrelated directories under one heading.
            const key = index.cwd;
            const list = collected.get(key);
            const entry = {
                sessionId,
                title: index.title,
                updatedAt: index.updatedAt,
                cwd: index.cwd,
            };
            if (list === undefined)
                collected.set(key, [entry]);
            else
                list.push(entry);
        }
    }
    const ordered = [...collected.entries()]
        .map(([path, list]) => {
        list.sort(compareSessionsNewestFirst);
        // A group's position is decided by its most recent conversation, which is the same fact the
        // rows inside it are ordered by.
        return { path, list, newest: list[0]?.updatedAt ?? 0 };
    })
        .sort((a, b) => {
        if (a.newest !== b.newest)
            return b.newest - a.newest;
        if (a.path === b.path)
            return 0;
        return a.path < b.path ? -1 : 1;
    });
    return new Map(ordered.map((group) => [group.path, group.list]));
}
/**
 * The working directory one session belongs to.
 *
 * Needed to adopt a session from another workspace: the host pins a session's `cwd`, so resuming one
 * means naming *its* workspace rather than the channel's own.
 *
 * @param home - DSH home directory.
 * @param sessionId - Session to look up.
 * @returns The recorded directory, or undefined when the store does not know the session.
 */
export async function storedSessionWorkspace(home, sessionId) {
    const index = await readIndex(join(home, 'storages', 'session_projcache', 'sessions'), sessionId);
    return index.cwd === '' ? undefined : index.cwd;
}
/**
 * Whether the store holds a record for this session at all, readable or not.
 *
 * The pair with {@link storedSessionWorkspace} matters more than it looks. That function answers
 * `undefined` both for "there is no such session" and for "there is a record I could not read", and
 * those two call for opposite responses: the first is a session the user deleted, while the second is
 * a damaged store. Reading the second as the first would move the conversation to a new session, and
 * — since the damage does not heal — move it again every time the binding aged past the grace
 * window, losing the history each time and saying nothing about why.
 *
 * Existence is the file's, not the parse's: a record that is present and unparseable still counts.
 * The session's own directory counts too, because the index beside it is a *projection cache* and a
 * row can be evicted while the conversation itself survives — the directory is what the listing
 * actually walks.
 *
 * @param home - DSH home directory.
 * @param sessionId - Session to look for.
 * @returns True when any index row or session directory for this id exists on disk.
 */
export async function hasStoredSession(home, sessionId) {
    const indexDir = join(home, 'storages', 'session_projcache', 'sessions');
    for (const name of indexNamesFor(sessionId)) {
        try {
            await stat(join(indexDir, name));
            return true;
        }
        catch {
            // Try the next spelling.
        }
    }
    let folders;
    try {
        const entries = await readdir(join(home, 'sessions'), { withFileTypes: true });
        folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch {
        return false;
    }
    for (const folder of folders) {
        try {
            const entries = await readdir(join(home, 'sessions', folder), { withFileTypes: true });
            if (entries.some((entry) => entry.isDirectory() && entry.name === sessionId))
                return true;
        }
        catch {
            // An unreadable folder has nothing to say about this session.
        }
    }
    return false;
}
//# sourceMappingURL=session-index.js.map