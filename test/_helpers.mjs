/**
 * 测试夹具：合成会话日志（真的用 node:zstd 分帧压缩）、临时沙箱、假通道。
 *
 * 所有临时目录都建在 `dsh-notify/.tmp-*`（工作区内），不会污染 `~/.dsh`。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

/** dsh-notify/ 目录（本文件在 dsh-notify/test/ 下）。 */
export const NOTIFY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 每次测试一个独立沙箱：stateDir / sessionsRoot / workspace.json 都在里面。 */
export function makeSandbox(label = 'test') {
	const root = mkdtempSync(join(NOTIFY_ROOT, `.tmp-${label}-`))
	const sandbox = {
		root,
		stateDir: join(root, 'state'),
		sessionsRoot: join(root, 'sessions'),
		workspacesFile: join(root, 'workspace.json'),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
	mkdirSync(sandbox.stateDir, { recursive: true })
	mkdirSync(sandbox.sessionsRoot, { recursive: true })
	return sandbox
}

function deepMerge(base, patch) {
	if (patch === null || patch === undefined) return base
	if (Array.isArray(patch) || typeof patch !== 'object') return patch
	const out = { ...base }
	for (const [key, value] of Object.entries(patch)) {
		const current = out[key]
		out[key] =
			current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)
				? deepMerge(current, value)
				: value
	}
	return out
}

/** 一份等价于 loadConfig() 默认值的配置，路径指向沙箱；`overrides` 深合并。 */
export function makeConfig(sandbox, overrides = {}) {
	const base = {
		configPath: join(sandbox.root, 'config.json'),
		configExists: false,
		stateDir: sandbox.stateDir,
		sessions: {
			root: sandbox.sessionsRoot,
			startupLookbackMinutes: 120,
			workspacesFile: sandbox.workspacesFile,
		},
		server: { port: 0, host: '127.0.0.1' },
		notify: {
			approval: true,
			question: true,
			turnDone: true,
			turnError: true,
			minTurnSeconds: 20,
			escalateAfterSeconds: [180, 600, 1800],
			quietHours: null,
			includeSubagents: false,
		},
		channels: {
			desktop: { enabled: true, fallbackWhenWidgetStale: true, widgetStaleSeconds: 30 },
			wechat: { enabled: false, events: ['approval', 'turn-done', 'turn-error'] },
		},
		intervalMs: 1000,
	}
	return deepMerge(base, overrides)
}

export function silentLogger() {
	const entries = []
	const push = (level) => (...args) => entries.push({ level, args })
	return { entries, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}

/** 一条 zstd 帧（内容通常是若干条 JSONL）。 */
export function zstdFrame(text) {
	return zstdCompressSync(Buffer.from(text, 'utf8'))
}

let sequence = 0

/** 造一条日志事件；`time` 是 Unix 毫秒。 */
export function mk(type, data, time) {
	sequence += 1
	return { type, seq: sequence, time, data }
}

/** 造一条 `type:"session"` 的 header（字段在顶层，不在 data 里）。 */
export function sessionHeader(id, extra = {}) {
	return {
		type: 'session',
		version: 4,
		id,
		createdAt: Date.now(),
		cwd: '/Users/example/Desktop/demo',
		isSeeded: false,
		delegationDepth: 0,
		agentPreset: 'standard',
		...extra,
	}
}

/** 多条事件 → 一条 JSONL 文本。 */
export function ndjson(...entries) {
	return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')
}

/**
 * 在沙箱里开一个会话日志（默认路径符合 DSH 布局：
 * `sessionsRoot/<projectDir>/<sessionId>/session.v4.jsonl.zstd`）。
 */
export function openLog(
	sandbox,
	{
		projectDir = '--Users-example-Desktop-demo--',
		sessionId = 'session-demo-1',
		fileName = 'session.v4.jsonl.zstd',
	} = {},
) {
	const dir = join(sandbox.sessionsRoot, projectDir, sessionId)
	mkdirSync(dir, { recursive: true })
	const file = join(dir, fileName)
	writeFileSync(file, '')
	const api = {
		dir,
		file,
		projectDir,
		sessionId,
		/** 追加一条 zstd 帧。 */
		frame(text) {
			appendFileSync(file, zstdFrame(text))
		},
		/** 追加裸字节（造坏帧/半帧用）。 */
		raw(buffer) {
			appendFileSync(file, buffer)
		},
		/** 每条事件一帧。 */
		entries(...list) {
			for (const entry of list) api.frame(`${JSON.stringify(entry)}\n`)
		},
		/** 原样追加文本字节（明文 .jsonl 用）。 */
		text(text) {
			appendFileSync(file, text)
		},
		/** 改 mtime（测试「老会话启动不解析」）。 */
		touch(mtimeMs) {
			const date = new Date(mtimeMs)
			utimesSync(file, date, date)
		},
	}
	return api
}

/** 写挂件心跳。 */
export function writeHeartbeat(sandbox, at, pid = 4321) {
	writeFileSync(join(sandbox.stateDir, 'widget-heartbeat.json'), `${JSON.stringify({ pid, at })}\n`)
}

/** 读持久化的 state.json。 */
export function readStateFile(sandbox) {
	return JSON.parse(readFileSync(join(sandbox.stateDir, 'state.json'), 'utf8'))
}

/**
 * 假微信通道：形状严格按 Lead 的契约
 * `{start, stop, send(text,{kind,alertId}) → {ok,queued?,reason?,used?}, status(), flushQueue()}`。
 */
export function fakeWechat(options = {}) {
	const sends = []
	let running = false
	const mode = options.mode ?? 'ok'
	return {
		sends,
		get running() {
			return running
		},
		async start() {
			running = true
		},
		async stop() {
			running = false
		},
		async send(text, meta = {}) {
			sends.push({ text, ...meta })
			if (mode === 'ok') return { ok: true, used: 1 }
			if (mode === 'queued') return { ok: false, queued: true, reason: 'window-closed' }
			if (mode === 'not-bound') return { ok: false, reason: 'not-bound' }
			throw new Error('wechat send boom')
		},
		status() {
			return { mode: running ? 'running' : 'idle', bound: mode === 'ok', queued: 0 }
		},
		flushQueue() {
			return { flushed: 0 }
		},
	}
}

/** 假桌面通道。 */
export function fakeDesktop(options = {}) {
	const delivered = []
	return {
		delivered,
		async deliver(alert, opts = {}) {
			delivered.push({ alert, opts })
			if (options.ok === false) return { ok: false, mode: 'osascript', error: 'boom' }
			return { ok: true, mode: options.mode ?? 'osascript', error: null }
		},
		status() {
			return { mode: options.mode ?? 'osascript', enabled: true, widgetAlive: false }
		},
	}
}
