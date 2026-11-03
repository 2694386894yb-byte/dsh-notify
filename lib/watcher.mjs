/**
 * 会话日志增量读取（watcher）。
 *
 * DSH 的会话日志 `session.v4.jsonl.zstd` **不是**单个连续 zstd 流，而是**多个 zstd
 * 帧首尾相接**（一帧 = 一次 append 的若干条 JSONL）。所以：
 *
 *   1. 不能 `zstdDecompressSync(整个文件)`（只能拿到第一帧）；
 *   2. 不能 `createZstdDecompress` 流式解（遇到下一个帧会报 "Unknown frame descriptor"）；
 *   3. 正确做法是按 zstd 魔数切帧、逐帧解压、再拼接。
 *
 * 增量策略：
 *   - 每 1s 只 stat（mtime + size），变了才从上次 offset 读增量；
 *   - 解出来的文本按行切，最后一行可能是「半个 JSON」——留在 carry 里，等下一帧拼上；
 *   - 文件尾部可能是**还没写完的半帧**：解压失败且它是最后一帧时，不推进 offset，
 *     下次重试；连续重试 maxTailAttempts 次仍失败才认定坏帧跳过（否则会永远卡住）；
 *   - 文件中间的坏帧跳过并插一个换行，避免前后半行粘成一条假事件。
 *
 * 这个模块只负责「把日志变成事件流」，不理解事件语义（那是 detect.mjs 的事）。
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端 0xFD2FB528）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志文件名：`session.v4.jsonl.zstd` / `*.jsonl` / `*.jsonl.zst`。 */
const LOG_FILE_RE = /\.jsonl(\.zstd|\.zst)?$/i

/** 默认工作区标题表（DSH 写的真实路径 → 标题）。 */
export const DEFAULT_WORKSPACES_FILE = join(homedir(), '.dsh', 'storages', 'workspace.json')

/**
 * 把 DSH 的会话目录名还原成真实工作区路径。
 *
 * DSH 把路径里的非 ASCII 字符转义成 UTF-16 码元，格式是「`~` 在前、整段转义最后补
 * 一个 `~` 收尾」：`大(5927) 二(4E8C)` → `~5927~4E8C~`。
 *
 * 三个坑（沿用 read-dsh-sessions.mjs 的实测结论）：
 *   1. 不能按 `~([0-9A-Fa-f]{4})~` 逐个匹配（会吃掉下一段开头定界符）；
 *   2. 必须先把转义段替换成占位符，再按 `-` 拆路径（否则十六进制字母和分隔符混淆）；
 *   3. 反解码有损（`deepseek-harness` 会变成 `deepseek/harness`），只当兜底，
 *      命中 workspace.json 的真实路径时以真实路径为准。
 */
export function decodeSessionDirName(name) {
	let body = String(name ?? '')
	if (body.startsWith('--')) body = body.slice(2)
	if (body.endsWith('--')) body = body.slice(0, -2)

	const decodedRuns = []
	const protectedBody = body.replace(/~(?:[0-9A-Fa-f]{4}~?)+/g, (match) => {
		const units = match
			.split('~')
			.filter((hex) => hex.length === 4 && /^[0-9A-Fa-f]{4}$/.test(hex))
			.map((hex) => String.fromCharCode(parseInt(hex, 16)))
		decodedRuns.push(units.join(''))
		return `@@${decodedRuns.length - 1}@@`
	})

	return (
		'/' +
		protectedBody
			.split('-')
			.filter(Boolean)
			.map((segment) => segment.replace(/@@(\d+)@@/g, (_, index) => decodedRuns[Number(index)] ?? ''))
			.join('/')
	)
}

/** 解码后路径的最后一段，用作反解码失败时的兜底项目名。 */
export function rawTailOfDirName(name) {
	const segments = decodeSessionDirName(name).split('/').filter(Boolean)
	return segments.length > 0 ? segments[segments.length - 1] : String(name ?? '')
}

/** 找出 buffer 里所有 zstd 帧的起始偏移。 */
function findMagicOffsets(buf) {
	const offsets = []
	let cursor = 0
	while (cursor < buf.length) {
		const found = buf.indexOf(ZSTD_MAGIC, cursor)
		if (found === -1) break
		offsets.push(found)
		cursor = found + ZSTD_MAGIC.length
	}
	return offsets
}

function readWorkspacesFile(file) {
	const map = new Map()
	try {
		if (!existsSync(file)) return map
		const raw = JSON.parse(readFileSync(file, 'utf8'))
		const table = raw?.tables?.workspaces
		const entries = Array.isArray(table) ? table : Object.values(table ?? {})
		for (const workspace of entries) {
			if (workspace?.path) map.set(String(workspace.path), String(workspace.title || workspace.path))
		}
	} catch {
		// 标题拿不到不是致命错误，上层用目录名兜底。
	}
	return map
}

/**
 * 解一段「从帧边界开始」的字节。
 *
 * @returns {{text: string, consumed: number, frameFail: null | {length:number,count:number}, skippedFrames: number}}
 *   `consumed` 是从这段字节开头算起、可以安全丢弃的字节数；尾部半帧时它会停在帧首，
 *   这样下次从同一位置重读。
 */
export function decodeChunk(chunk, options = {}) {
	const { isZstd = false, maxTailAttempts = 3, priorFail = null, logger = null, label = '' } = options
	const offsets = findMagicOffsets(chunk)

	if (offsets.length === 0) {
		if (isZstd) {
			throw new Error(`${label || '日志文件'}里找不到任何 zstd 帧（文件可能已损坏）`)
		}
		// 明文 .jsonl：整段都是文本。
		return { text: chunk.toString('utf8'), consumed: chunk.length, frameFail: null, skippedFrames: 0 }
	}

	const parts = []
	let consumed = 0
	let skippedFrames = 0
	let frameFail = null

	for (let index = 0; index < offsets.length; index += 1) {
		const start = offsets[index]
		const end = index + 1 < offsets.length ? offsets[index + 1] : chunk.length
		try {
			parts.push(zstdDecompressSync(chunk.subarray(start, end)).toString('utf8'))
			consumed = end
		} catch {
			const isLast = index === offsets.length - 1
			if (isLast) {
				// 最后一帧可能是「文件正在追加、还没写完」，先别丢，下次重试。
				// 重试只比较「这帧多长」：同一段字节每次都在同一个 offset 重读，
				// 帧长没变说明还是同一个没写完/坏掉的尾巴。
				const previousCount = priorFail && priorFail.length === end - start ? priorFail.count : 0
				const count = previousCount + 1
				if (count >= maxTailAttempts) {
					logger?.error?.(
						`[watcher] ${label} 尾部 zstd 帧连续 ${count} 次解压失败，跳过（${end - start} 字节）`,
					)
					parts.push('\n')
					skippedFrames += 1
					consumed = end
				} else {
					frameFail = { length: end - start, count }
				}
			} else {
				logger?.warn?.(`[watcher] ${label} 第 ${index + 1} 个 zstd 帧解压失败，跳过`)
				// 坏帧内容已经丢了：补一个换行，避免前一帧的半行和下一帧粘成假事件。
				parts.push('\n')
				skippedFrames += 1
				consumed = end
			}
		}
	}

	return { text: parts.join(''), consumed, frameFail, skippedFrames }
}

/** 从 fd 的 offset 处读 length 字节（循环处理短读）。 */
function readChunk(file, offset, size) {
	const length = size - offset
	if (length <= 0) return Buffer.alloc(0)
	const fd = openSync(file, 'r')
	try {
		const buffer = Buffer.alloc(length)
		let read = 0
		while (read < length) {
			const n = readSync(fd, buffer, read, length - read, offset + read)
			if (n <= 0) break
			read += n
		}
		return read === length ? buffer : buffer.subarray(0, read)
	} finally {
		closeSync(fd)
	}
}

/** 读会话 header 时最多读这么多字节（header 就在第一帧/第一行，64KB 绰绰有余）。 */
const HEADER_MAX_BYTES = 64 * 1024

/** 把 `type:"session"` 的 header 归一成上层需要的几个字段。 */
export function normalizeSessionHeader(entry) {
	if (!entry || entry.type !== 'session') return null
	return {
		id: typeof entry.id === 'string' ? entry.id : null,
		origin: typeof entry.origin === 'string' ? entry.origin : null,
		parentSession: typeof entry.parentSession === 'string' ? entry.parentSession : null,
		delegationDepth: Number.isFinite(Number(entry.delegationDepth)) ? Number(entry.delegationDepth) : null,
		cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
	}
}

/**
 * 只读日志开头，解析 `type:"session"` 的 header。
 *
 * 为什么单独读：启动时 lookback 之外的会话只记 offset、不解析事件；但子 agent
 * 判定必须知道 header（origin/parentSession），否则那些目录名没有 `session-`
 * 前缀的子会话会被当成用户会话通知出去。
 */
export function readSessionHeader(filePath, options = {}) {
	const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : HEADER_MAX_BYTES
	let chunk
	try {
		const stat = statSync(filePath)
		if (!stat.isFile() || stat.size === 0) return null
		chunk = readChunk(filePath, 0, Math.min(stat.size, maxBytes))
	} catch {
		return null
	}
	if (chunk.length === 0) return null

	const isZstd = /\.(zstd|zst)$/i.test(filePath)
	let text = ''
	if (isZstd) {
		const offsets = findMagicOffsets(chunk)
		if (offsets.length === 0) return null
		const parts = []
		for (let index = 0; index < offsets.length; index += 1) {
			const start = offsets[index]
			const end = index + 1 < offsets.length ? offsets[index + 1] : chunk.length
			let decoded = null
			try {
				decoded = zstdDecompressSync(chunk.subarray(start, end)).toString('utf8')
			} catch {
				continue
			}
			parts.push(decoded)
			// header 就在最前面；第一帧能解出完整行就不必继续翻后面的帧。
			const joined = parts.join('')
			const firstLine = joined.split('\n')[0]?.trim()
			if (firstLine) {
				try {
					const first = JSON.parse(firstLine)
					if (first?.type === 'session') return normalizeSessionHeader(first)
				} catch {
					// 半行：继续解下一帧
				}
			}
		}
		text = parts.join('')
	} else {
		text = chunk.toString('utf8')
	}

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim()
		if (!line) continue
		let entry
		try {
			entry = JSON.parse(line)
		} catch {
			continue
		}
		if (entry?.type === 'session') return normalizeSessionHeader(entry)
	}
	return null
}

/** 取会话目录里最新的日志文件。 */
function findLogFile(sessionDir) {
	let names
	try {
		names = readdirSync(sessionDir)
	} catch {
		return null
	}
	let best = null
	for (const name of names) {
		if (!LOG_FILE_RE.test(name)) continue
		const full = join(sessionDir, name)
		let stat
		try {
			stat = statSync(full)
		} catch {
			continue
		}
		if (!stat.isFile()) continue
		if (!best || stat.mtimeMs > best.mtimeMs) {
			best = { path: full, mtimeMs: stat.mtimeMs, size: stat.size }
		}
	}
	return best
}

/** 事件时间可能是毫秒，也见过纳秒；统一成毫秒，异常值返回 null。 */
export function normalizeEntryTime(value) {
	const time = Number(value)
	if (!Number.isFinite(time) || time <= 0) return null
	if (time > 1e15) return Math.floor(time / 1e6)
	return Math.floor(time)
}

/**
 * 创建 watcher。
 *
 * @param {object} options
 * @param {string} options.sessionsRoot - `~/.dsh/sessions`
 * @param {string} [options.workspacesFile] - `~/.dsh/storages/workspace.json`
 * @param {number} [options.lookbackMinutes] - 启动时「完整解析」的窗口（分钟）
 * @param {number} [options.maxTailAttempts] - 尾部半帧最多重试次数
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 */
export function createWatcher({
	sessionsRoot,
	workspacesFile = DEFAULT_WORKSPACES_FILE,
	lookbackMinutes = 120,
	maxTailAttempts = 3,
	logger = console,
	now = Date.now,
} = {}) {
	if (!sessionsRoot) throw new TypeError('createWatcher 需要 sessionsRoot')

	const sessions = new Map()
	let titles = null
	let firstScanDone = false
	let lastScanAt = null
	let lastEventAt = null
	let scanCount = 0

	function loadTitles() {
		if (titles === null) titles = readWorkspacesFile(workspacesFile)
		return titles
	}

	/** 把解出来的文本按行切成事件；半行留在 session.carry。 */
	function consumeText(session, text) {
		const events = []
		const combined = session.carry + text
		const lines = combined.split('\n')
		session.carry = lines.pop() ?? ''
		for (const rawLine of lines) {
			const line = rawLine.trim()
			if (!line) continue
			let entry
			try {
				entry = JSON.parse(line)
			} catch {
				session.malformedLines += 1
				continue
			}
			if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
				session.malformedLines += 1
				continue
			}
			session.parsedEntries += 1
			if (entry.type === 'session') {
				const header = normalizeSessionHeader(entry)
				// 只在 header 缺字段时补/覆盖，避免被后续（理论上不存在的）重复 header 覆盖
				if (header) session.header = { ...(session.header ?? {}), ...header }
			}
			const time = normalizeEntryTime(entry.time)
			if (time !== null && (lastEventAt === null || time > lastEventAt)) lastEventAt = time
			events.push({
				sessionId: session.sessionId,
				project: session.projectTitle,
				projectPath: session.projectPath,
				sessionDir: session.sessionDir,
				origin: session.header?.origin ?? null,
				parentSession: session.header?.parentSession ?? null,
				delegationDepth: session.header?.delegationDepth ?? null,
				entry,
			})
		}
		return events
	}

	function sessionSummary(session) {
		return {
			sessionId: session.sessionId,
			sessionDir: session.sessionDir,
			logFile: session.logFile,
			project: session.projectTitle,
			projectPath: session.projectPath,
			size: session.size,
			mtimeMs: session.mtimeMs,
			offset: session.offset,
			unreadable: session.unreadable,
			changed: session.changed,
			parsedEntries: session.parsedEntries,
			malformedLines: session.malformedLines,
			header: session.header,
			origin: session.header?.origin ?? null,
			parentSession: session.header?.parentSession ?? null,
			delegationDepth: session.header?.delegationDepth ?? null,
			isSubagent: session.header?.origin === 'subagent',
		}
	}

	/**
	 * 扫一遍 sessionsRoot，返回本次新增的事件。
	 *
	 * @returns {{scannedAt:number, initial:boolean, scanCount:number, sessions:object[], events:object[], errors:object[]}}
	 *   `initial` 为 true 表示这是进程启动后的第一次扫描（调用方据此决定要不要发
	 *   「仍在等待」通知 / 是否回放历史 turn）。
	 */
	function scan() {
		const scannedAt = now()
		const initial = !firstScanDone
		firstScanDone = true
		scanCount += 1
		lastScanAt = scannedAt

		const result = { scannedAt, initial, scanCount, sessions: [], events: [], errors: [] }

		if (!existsSync(sessionsRoot)) {
			result.errors.push({ scope: 'sessionsRoot', error: `会话目录不存在：${sessionsRoot}` })
			return result
		}

		let projectNames
		try {
			projectNames = readdirSync(sessionsRoot)
		} catch (error) {
			result.errors.push({ scope: 'sessionsRoot', error: String(error?.message ?? error) })
			return result
		}

		const lookbackMs = Math.max(0, Number(lookbackMinutes) || 0) * 60_000

		for (const projectName of projectNames) {
			if (projectName.startsWith('.')) continue
			const projectDir = join(sessionsRoot, projectName)
			let projectStat
			try {
				projectStat = statSync(projectDir)
			} catch {
				continue
			}
			if (!projectStat.isDirectory()) continue

			const projectPath = decodeSessionDirName(projectName)
			const projectTitle = loadTitles().get(projectPath) ?? rawTailOfDirName(projectName)

			let sessionNames
			try {
				sessionNames = readdirSync(projectDir)
			} catch {
				continue
			}

			for (const sessionName of sessionNames) {
				if (sessionName.startsWith('.')) continue
				const sessionDir = join(projectDir, sessionName)
				let sessionStat
				try {
					sessionStat = statSync(sessionDir)
				} catch {
					continue
				}
				if (!sessionStat.isDirectory()) continue

				const log = findLogFile(sessionDir)
				if (!log) continue

				const key = `${projectName}/${sessionName}`
				let session = sessions.get(key)
				const isNew = !session
				if (isNew) {
					session = {
						key,
						sessionId: sessionName,
						projectDirName: projectName,
						projectDir,
						sessionDir,
						logFile: log.path,
						projectPath,
						projectTitle,
						offset: 0,
						carry: '',
						size: 0,
						mtimeMs: 0,
						frameFail: null,
						unreadable: null,
						changed: false,
						parsedEntries: 0,
						malformedLines: 0,
						header: null,
					}
					// header 单独读：即使是 lookback 之外、不解析历史事件的会话，
					// 也要知道它是不是子 agent（origin / parentSession）。
					session.header = readSessionHeader(log.path)
					sessions.set(key, session)

					// 启动策略：lookback 内改过的会话从头完整解析（重建 pending）；
					// 更老的会话只记 offset = size，不解析历史事件。
					const ageMs = Math.max(0, scannedAt - log.mtimeMs)
					if (ageMs > lookbackMs) {
						session.offset = log.size
						session.size = log.size
						session.mtimeMs = log.mtimeMs
					}
				}

				session.projectPath = projectPath
				session.projectTitle = projectTitle
				session.logFile = log.path
				session.changed = false

				if (log.size < session.offset) {
					// 文件被截断/轮转：从头重读。
					logger?.warn?.(`[watcher] ${session.sessionId} 日志变短（offset=${session.offset} → size=${log.size}），从头重读`)
					session.offset = 0
					session.carry = ''
					session.frameFail = null
					session.unreadable = null
				} else if (session.unreadable && log.size > session.size) {
					// 之前判定不可读的文件又长新内容了：再给一次机会，从上次位置往后读。
					session.unreadable = null
				}

				const dirty = log.size !== session.size || log.mtimeMs !== session.mtimeMs || session.offset < log.size

				if (dirty && !session.unreadable) {
					session.changed = true
					try {
						if (log.size > session.offset) {
							const chunk = readChunk(log.path, session.offset, log.size)
							const isZstd = /\.(zstd|zst)$/i.test(log.path)
							const decoded = decodeChunk(chunk, {
								isZstd,
								maxTailAttempts,
								priorFail: session.frameFail,
								logger,
								label: session.sessionId,
							})
							session.frameFail = decoded.frameFail
							session.offset += decoded.consumed
							result.events.push(...consumeText(session, decoded.text))
						}
					} catch (error) {
						session.unreadable = String(error?.message ?? error)
						session.offset = log.size
						session.frameFail = null
						result.errors.push({ sessionId: session.sessionId, error: session.unreadable })
						logger?.error?.(`[watcher] 读不了会话 ${session.sessionId}：${session.unreadable}`)
					}
					session.size = log.size
					session.mtimeMs = log.mtimeMs
				}

				result.sessions.push(sessionSummary(session))
			}
		}

		return result
	}

	return {
		scan,
		getSessions: () => [...sessions.values()].map(sessionSummary),
		getSession: (sessionId) => {
			for (const session of sessions.values()) if (session.sessionId === sessionId) return sessionSummary(session)
			return null
		},
		get lastScanAt() {
			return lastScanAt
		},
		get lastEventAt() {
			return lastEventAt
		},
		get scanCount() {
			return scanCount
		},
		get sessionsRoot() {
			return sessionsRoot
		},
	}
}
