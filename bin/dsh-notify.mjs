#!/usr/bin/env node
/**
 * dsh-notify —— DSH 通知守护进程的命令行入口。
 *
 * 子命令：
 *   run             常驻（LaunchAgent 用这个）
 *   once            扫一遍，打印检测结果，不发送
 *   state           从运行中的 daemon 拉 /state
 *   health          从运行中的 daemon 拉 /health
 *   doctor          自检（配置、会话日志、微信绑定、挂件心跳、端口）
 *   test            发一条测试通知（桌面 + 微信；daemon 没在跑也能用）
 *   wechat-status   微信通道凭据/窗口/队列状态
 *   wechat-adopt    用已有 bot token 写入凭据（不扫码）
 *   wechat-bind     扫码绑定新凭据（会打开二维码图片）
 *
 * 所有正常结果写 stdout（JSON 或人话），日志写 stderr。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { loadConfig, expandHome, readJsonFile } from '../lib/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const NODE = process.execPath
const DAEMON_HTTP = (config) => `http://127.0.0.1:${config.server.port}`

function log(...args) {
	process.stderr.write(`${args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')}\n`)
}

function out(value) {
	process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

function parseFlags(argv) {
	const flags = { _: [] }
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index]
		if (token.startsWith('--')) {
			const key = token.slice(2)
			const next = argv[index + 1]
			if (next !== undefined && !next.startsWith('--')) {
				flags[key] = next
				index += 1
			} else {
				flags[key] = true
			}
		} else {
			flags._.push(token)
		}
	}
	return flags
}

async function fetchJson(url, options = {}) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500)
	try {
		const response = await fetch(url, {
			method: options.method ?? 'GET',
			headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: controller.signal,
		})
		const text = await response.text()
		let parsed
		try {
			parsed = text === '' ? null : JSON.parse(text)
		} catch {
			parsed = { raw: text }
		}
		return { ok: response.ok, status: response.status, body: parsed }
	} finally {
		clearTimeout(timer)
	}
}

/** 用 osascript 发一条桌面通知（daemon 不在时的测试用；daemon 自己走 desktop 通道）。 */
function osascriptNotify(title, body) {
	return new Promise((resolve) => {
		const script = [
			'on run argv',
			'  display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
			'end run',
		].join('\n')
		const child = spawn('/usr/bin/osascript', ['-', title, body], { stdio: ['pipe', 'ignore', 'pipe'] })
		let stderr = ''
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		child.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }))
		child.on('close', (code) => resolve({ ok: code === 0, error: code === 0 ? null : stderr.trim() }))
		child.stdin.end(script)
	})
}

async function makeWechat(config) {
	const { createWechatChannel } = await import('../lib/channels/wechat.mjs')
	return createWechatChannel({ config, logger: { error: (...args) => log(...args), info: (...args) => log(...args) } })
}

async function commandRun(config, flags) {
	const { createDaemon } = await import('../lib/daemon.mjs')
	const wechat = config.channels.wechat.enabled ? await makeWechat(config) : null
	const daemon = createDaemon({
		config,
		channels: { wechat },
		logger: { info: (...args) => log(...args), error: (...args) => log(...args), warn: (...args) => log(...args) },
	})
	await daemon.start()
	const health = daemon.health()
	out({ ok: true, pid: process.pid, health })
	let closing = false
	const shutdown = async (signal) => {
		if (closing) return
		closing = true
		log(`[dsh-notify] ${signal} received, shutting down`)
		try {
			await daemon.stop()
			await wechat?.stop()
		} finally {
			process.exit(0)
		}
	}
	process.on('SIGINT', () => void shutdown('SIGINT'))
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
	// 常驻：保持事件循环；健康信息只在启动时打一次，避免日志刷屏。
	await new Promise(() => {})
}

async function commandOnce(config, flags) {
	const { createDaemon } = await import('../lib/daemon.mjs')
	const daemon = createDaemon({
		config,
		channels: { wechat: null },
		logger: { info: (...args) => log(...args), error: (...args) => log(...args), warn: (...args) => log(...args) },
	})
	await daemon.tick({ notify: false })
	out(flags.json ? daemon.getState() : daemon.getState())
	await daemon.stop()
}

async function commandState(config) {
	let result
	try {
		result = await fetchJson(`${DAEMON_HTTP(config)}/state`, { timeoutMs: 2000 })
	} catch (error) {
		out({ ok: false, error: `daemon 没在跑（${String(error?.cause?.code ?? error?.message ?? error)}）` })
		process.exitCode = 1
		return
	}
	if (!result.ok) {
		out({ ok: false, error: `daemon 没在跑？(HTTP ${result.status})`, body: result.body })
		process.exitCode = 1
		return
	}
	out(result.body)
}

async function commandHealth(config) {
	let result
	try {
		result = await fetchJson(`${DAEMON_HTTP(config)}/health`, { timeoutMs: 2000 })
	} catch (error) {
		out({ ok: false, error: `daemon 没在跑（${String(error?.cause?.code ?? error?.message ?? error)}）` })
		process.exitCode = 1
		return
	}
	if (!result.ok) {
		out({ ok: false, error: `daemon 没在跑？(HTTP ${result.status})`, body: result.body })
		process.exitCode = 1
		return
	}
	out(result.body)
}

async function commandTest(config, flags) {
	const title = typeof flags.title === 'string' ? flags.title : 'DSH 通知测试'
	const body =
		typeof flags.body === 'string'
			? flags.body
			: '如果你在手机微信和电脑上都看到了这条，说明通知通道已经打通。'
	const report = { ok: true, desktop: null, wechat: null }

	const health = await fetchJson(`${DAEMON_HTTP(config)}/health`, { timeoutMs: 1500 }).catch(() => null)
	if (health?.ok) {
		const result = await fetchJson(`${DAEMON_HTTP(config)}/test`, {
			method: 'POST',
			timeoutMs: 15000,
			body: { title, body },
		})
		out(result.body ?? { ok: false, error: '空响应' })
		return
	}

	// daemon 没跑：桌面走 osascript，微信直接调通道。
	if (config.channels.desktop.enabled !== false) {
		report.desktop = await osascriptNotify(title, body)
	}
	if (config.channels.wechat.enabled !== false) {
		const wechat = await makeWechat(config)
		await wechat.start()
		await new Promise((resolve) => setTimeout(resolve, 300))
		report.wechat = await wechat.send(`${title}\n\n${body}`, { kind: 'test' })
		await wechat.stop()
	}
	if (report.desktop === null && report.wechat === null) {
		report.ok = false
		report.error = '两个通道都被禁用（DSH_NOTIFY_DESKTOP=off 且微信通道关闭），没有发送任何东西'
		process.exitCode = 1
	}
	out(report)
}

async function commandDoctor(config) {
	const report = { ok: true, checks: [] }
	const add = (name, ok, detail) => {
		report.checks.push({ name, ok, detail })
		if (!ok) report.ok = false
	}

	add('node>=22', Number(process.versions.node.split('.')[0]) >= 22, process.version)
	add('config', true, { path: config.configPath, exists: config.configExists })

	// 会话日志
	try {
		const root = config.sessions.root
		const exists = existsSync(root)
		let dirs = 0
		let latest = 0
		if (exists) {
			for (const name of readdirSafe(root)) {
				if (!name.startsWith('--')) continue
				dirs += 1
				for (const session of readdirSafe(join(root, name))) {
					const file = join(root, name, session, 'session.v4.jsonl.zstd')
					try {
						latest = Math.max(latest, statSync(file).mtimeMs)
					} catch {
						/* 忽略 */
					}
				}
			}
		}
		add('sessions', exists && dirs > 0, { root, projects: dirs, latestAgeSeconds: latest ? Math.round((Date.now() - latest) / 1000) : null })
	} catch (error) {
		add('sessions', false, String(error?.message ?? error))
	}

	// 状态目录可写
	try {
		mkdirSync(config.stateDir, { recursive: true })
		const probe = join(config.stateDir, `.doctor-${process.pid}`)
		writeFileSync(probe, 'ok')
		unlinkQuiet(probe)
		add('stateDir', true, config.stateDir)
	} catch (error) {
		add('stateDir', false, String(error?.message ?? error))
	}

	// 微信凭据 + peer
	try {
		const statePath = config.channels.wechat.statePath
		const state = readJsonFile(statePath)
		const accounts = state ? Object.values(state.accounts ?? {}) : []
		const peer = readJsonFile(join(config.stateDir, 'wechat-peer.json'))
		const contextCount = Object.values(state?.contextTokens ?? {}).reduce(
			(sum, perAccount) => sum + Object.keys(perAccount ?? {}).length,
			0,
		)
		add('wechat', accounts.length > 0, {
			enabled: config.channels.wechat.enabled,
			statePath,
			stateExists: existsSync(statePath),
			accounts: accounts.map((account) => account.accountId),
			peerId: peer?.peerId ?? null,
			contextTokens: contextCount,
			queued: Array.isArray(peer?.queue) ? peer.queue.length : 0,
		})
	} catch (error) {
		add('wechat', false, String(error?.message ?? error))
	}

	// 挂件心跳
	try {
		const heartbeat = readJsonFile(join(config.stateDir, 'widget-heartbeat.json'))
		const age = heartbeat?.at ? Math.round((Date.now() - heartbeat.at) / 1000) : null
		add('widget', Boolean(heartbeat?.at) && age !== null && age < 120, { ageSeconds: age, pid: heartbeat?.pid ?? null })
	} catch (error) {
		add('widget', false, String(error?.message ?? error))
	}

	// 挂件 App
	add('widgetApp', existsSync(join(homedir(), 'Desktop', 'DSHWidget.app')), join(homedir(), 'Desktop', 'DSHWidget.app'))

	// daemon
	const health = await fetchJson(`${DAEMON_HTTP(config)}/health`, { timeoutMs: 1200 }).catch(() => null)
	add('daemon', Boolean(health?.ok), health?.body ?? { hint: '没有运行；用 launchctl kickstart 或 `dsh-notify run`' })

	add('osascript', existsSync('/usr/bin/osascript'), '/usr/bin/osascript')
	add('qrHelper', existsSync(join(ROOT, 'tools', 'qr')), join(ROOT, 'tools', 'qr'))

	out(report)
	if (!report.ok) process.exitCode = 1
}

async function commandWechatStatus(config) {
	// 优先问运行中的 daemon：它才是真正持有 monitor / 窗口计数的那一个。
	// 直接 new 一个通道对象不会 start 长轮询，status() 会误报 unbound（实测踩过）。
	const health = await fetchJson(`${DAEMON_HTTP(config)}/health`, { timeoutMs: 1500 }).catch(() => null)
	if (health?.ok && health.body?.channels?.wechat) {
		out({ ok: true, source: 'daemon', ...health.body.channels.wechat })
		return
	}
	// daemon 没在跑：只读状态文件，别起第二个长轮询（会跟 daemon 抢 syncBuf）。
	const { StateStore } = await import('../wechat-core-dist/core/lib/index.js')
	const stateFile = config.channels.wechat.statePath
	const store = new StateStore(stateFile)
	const state = await store.read().catch(() => ({ accounts: {}, contextTokens: {} }))
	const peer = readJsonFile(join(config.stateDir, 'wechat-peer.json')) ?? {}
	const accounts = Object.values(state.accounts ?? {})
	out({
		ok: true,
		source: 'files',
		enabled: config.channels.wechat.enabled,
		configured: accounts.length > 0,
		bound: Boolean(accounts.length > 0 && peer.peerId && peer.conversationId),
		accountId: accounts[0]?.accountId ?? peer.accountId ?? null,
		peerId: peer.peerId ?? null,
		monitorRunning: false,
		queueLength: Array.isArray(peer.queue) ? peer.queue.length : 0,
		lastInboundAt: peer.lastInboundAt ?? null,
		lastSendAt: peer.lastSendAt ?? null,
		lastError: peer.lastError ?? null,
		stateFile,
		peerFile: join(config.stateDir, 'wechat-peer.json'),
		hint: 'daemon 没在跑：以上只读文件状态。',
	})
}

async function writeAccount(config, account) {
	const { StateStore } = await import('../wechat-core-dist/core/lib/index.js')
	const store = new StateStore(config.channels.wechat.statePath)
	await store.update((state) => {
		state.accounts[account.accountId] = account
		state.autoStart = true
	})
	out({ ok: true, stateFile: config.channels.wechat.statePath, account: { ...account, token: `${account.accountId}:…` } })
}

async function commandWechatAdopt(config, flags) {
	const token = flags.token
	if (typeof token !== 'string' || !token.includes(':')) {
		out({ ok: false, error: '需要 --token "<accountId>:<secret>"（就是之前 state.json 里的 token 原文）' })
		process.exitCode = 2
		return
	}
	const accountId = token.slice(0, token.lastIndexOf(':'))
	const account = {
		accountId,
		token,
		baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : 'https://ilinkai.weixin.qq.com',
		...(typeof flags['user-id'] === 'string' ? { userId: flags['user-id'] } : {}),
		savedAt: new Date().toISOString(),
		boundAt: new Date().toISOString(),
	}
	await writeAccount(config, account)
	log('下一步：在微信里给这个机器人随便发一句话，让通道记下 peer 和回复窗口（或直接跑 wechat-status 看绑定状态）。')
}

/** 画二维码并打开预览，返回 png 路径。 */
async function renderQr(text) {
	const helper = join(ROOT, 'tools', 'qr')
	if (!existsSync(helper)) return null
	const target = join(config_state_dir(), 'wechat-qr.png')
	mkdirSync(dirname(target), { recursive: true })
	await new Promise((resolve, reject) => {
		const child = spawn(helper, [text, target], { stdio: ['ignore', 'ignore', 'pipe'] })
		let stderr = ''
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		child.on('error', reject)
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `qr helper exit ${code}`))))
	})
	spawn('/usr/bin/open', [target], { stdio: 'ignore' }).unref()
	return target
}

let _configForQr = null
function config_state_dir() {
	return _configForQr?.stateDir ?? join(homedir(), '.dsh', 'notify')
}

async function commandWechatBind(config, flags) {
	_configForQr = config
	const { login } = await import('../wechat-core-dist/core/lib/index.js')
	const { StateStore } = await import('../wechat-core-dist/core/lib/index.js')
	const store = new StateStore(config.channels.wechat.statePath)
	const state = await store.read()
	const existingTokens = Object.values(state.accounts ?? {})
		.map((account) => account.token)
		.filter(Boolean)

	const readline = createInterface({ input: stdin, output: stdout })
	let answer = undefined
	let result = null
	try {
		const generator = login({ existingTokens, botType: '3', reuseExisting: 'adopt' })
		let lastQr = null
		while (true) {
			const step = await generator.next(answer)
			answer = undefined
			if (step.done) {
				result = step.value
				break
			}
			const event = step.value
			if (event.kind === 'qr') {
				lastQr = event
				const png = await renderQr(event.qrUrl)
				out({
					phase: 'qr',
					png,
					qrUrl: event.qrUrl,
					hint: png ? '已打开二维码图片，用手机微信「+ → 扫一扫」扫描并在手机上确认' : '请把 qrUrl 发到微信文件传输助手后点开确认',
				})
			} else if (event.kind === 'scanned') {
				out({ phase: 'scanned', hint: '手机已扫码，请在手机上点「确认登录」' })
			} else if (event.kind === 'verifycode-required') {
				out({ phase: 'verifycode-required', hint: '微信要求输入配对验证码' })
				answer = await readline.question('请输入验证码（直接回车跳过）：')
			} else if (event.kind === 'expired') {
				out({ phase: 'expired', hint: '二维码过期，正在刷新…' })
			} else if (event.kind === 'redirected') {
				out({ phase: 'redirected', host: event.host })
			} else if (event.kind === 'already-bound') {
				out({ phase: 'already-bound', hint: '服务端认为这台机器已经绑定；若旧凭据还在，可直接用 wechat-adopt。' })
			} else if (event.kind === 'failed') {
				out({ phase: 'failed', reason: event.reason })
			} else {
				out({ phase: event.kind })
			}
		}
	} finally {
		readline.close()
	}
	if (result?.account) {
		await writeAccount(config, {
			accountId: result.account.accountId,
			token: result.account.token,
			baseUrl: result.account.baseUrl,
			...(result.account.userId ? { userId: result.account.userId } : {}),
			savedAt: new Date().toISOString(),
			boundAt: new Date().toISOString(),
		})
		out({ ok: true, phase: 'confirmed', next: '现在用微信给机器人发一句话，让通道记下 peer 和回复窗口' })
	} else {
		out({ ok: false, phase: 'not-confirmed', alreadyBound: Boolean(result?.alreadyBound), reason: result?.reason ?? null })
		process.exitCode = 1
	}
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

function unlinkQuiet(file) {
	try {
		unlinkSync(file)
	} catch {
		/* 忽略 */
	}
}

const HELP = `dsh-notify —— DSH 通知守护进程

用法：
  dsh-notify run [--verbose]         常驻（LaunchAgent 用）
  dsh-notify once [--json]           扫一遍并打印检测结果（不发送）
  dsh-notify state                   运行中 daemon 的 /state
  dsh-notify health                  运行中 daemon 的 /health
  dsh-notify doctor                  自检
  dsh-notify test [--title T] [--body B]
                                     发一条测试通知（桌面 + 微信）
  dsh-notify wechat-status           微信通道状态
  dsh-notify wechat-adopt --token "<accountId>:<secret>" [--base-url URL] [--user-id ID]
                                     复用已有 bot token（不扫码）
  dsh-notify wechat-bind             扫码绑定新凭据（会打开二维码图片）
  dsh-notify --help

环境变量：
  DSH_NOTIFY_CONFIG  DSH_NOTIFY_STATE_DIR  DSH_NOTIFY_SESSIONS
  DSH_NOTIFY_PORT    DSH_NOTIFY_WECHAT_STATE
  DSH_NOTIFY_WECHAT=off / DSH_NOTIFY_DESKTOP=off
`

async function main() {
	const argv = process.argv.slice(2)
	if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
		process.stdout.write(HELP)
		return
	}
	const command = argv[0]
	const flags = parseFlags(argv.slice(1))
	const config = loadConfig()

	switch (command) {
		case 'run':
			return commandRun(config, flags)
		case 'once':
			return commandOnce(config, flags)
		case 'state':
			return commandState(config)
		case 'health':
			return commandHealth(config)
		case 'doctor':
			return commandDoctor(config)
		case 'test':
			return commandTest(config, flags)
		case 'wechat-status':
			return commandWechatStatus(config)
		case 'wechat-adopt':
			return commandWechatAdopt(config, flags)
		case 'wechat-bind':
			return commandWechatBind(config, flags)
		default:
			out({ ok: false, error: `认不出的子命令：${command}`, help: 'dsh-notify --help' })
			process.exitCode = 2
	}
}

main().catch((error) => {
	out({ ok: false, error: String(error?.stack ?? error?.message ?? error) })
	process.exitCode = 1
})
