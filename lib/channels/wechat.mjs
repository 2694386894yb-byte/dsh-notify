/**
 * 微信「单向」通道。
 *
 * 只做两件事：
 *   1. 用 iLink 长轮询保活 bot、记录 peerId / syncBuf / 回复窗口 token；
 *   2. 把通知文本发到用户微信（每个 contextToken 最多 10 条，超出排队等下一次 inbound）。
 *
 * 不做的事（刻意的）：
 *   - **不把收到的微信消息交给任何 agent**，也不执行其中任何内容；
 *   - 只回一条固定文案，用来（a）证明通道开着（b）重开回复窗口。
 *
 * 依赖 vendored `@dsh-wechat/core`（MIT，来自 dsh-wechat-plugin@0.46.0）。
 * 该 core 的协议端点只有腾讯 `ilinkai.weixin.qq.com` / 微信 CDN。
 */
import { readFileSync, existsSync, renameSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
	ChannelMonitor,
	StateStore,
	QUOTA_PER_TOKEN,
	QUOTA_WARNING,
	SendRefusedError,
	chargeQuota,
	conversationKey,
	sendText,
} from '../../wechat-core-dist/core/lib/index.js'

const SELF_REPLY_TEXT = [
	'已收到。',
	'这条通道只负责推送通知，不会执行你发给它的任何指令；需要操作请回到电脑。',
].join('\n')

/** 单条微信消息的保守长度上限（微信文本消息会截断/转文件，这里主动截）。 */
const MAX_TEXT = 1200

function truncate(text, limit = MAX_TEXT) {
	const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim()
	if (normalized.length <= limit) return normalized
	return `${normalized.slice(0, limit - 1)}…`
}

/** 原子写 JSON（tmp + rename），新文件收紧到 0600。 */
function writeJsonAtomic(file, value, mode = 0o600) {
	mkdirSync(dirname(file), { recursive: true })
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
	renameSync(tmp, file)
}

function readJson(file, fallback) {
	try {
		if (!existsSync(file)) return fallback
		return JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		return fallback
	}
}

/**
 * 创建微信通道。
 *
 * @param {object} options
 * @param {object} options.config - `loadConfig()` 的产物
 * @param {object} [options.core] - 注入用（测试传假实现），默认用 vendored core
 * @param {object} [options.logger] - 默认 console
 * @param {() => number} [options.now] - 可注入时钟
 */
export function createWechatChannel({ config, core, logger = console, now = Date.now }) {
	const impl = core ?? {
		ChannelMonitor,
		StateStore,
		sendText,
		conversationKey,
		chargeQuota,
		QUOTA_PER_TOKEN,
		QUOTA_WARNING,
		SendRefusedError,
	}

	const wechatConfig = config.channels?.wechat ?? {}
	const enabled = wechatConfig.enabled !== false
	const stateFile = wechatConfig.statePath ?? join(config.stateDir ?? '.', 'state.json')
	const peerFile = join(config.stateDir ?? '.', 'wechat-peer.json')
	const throttleMs = Math.max(0, Number(wechatConfig.selfReplyThrottleMinutes ?? 10)) * 60_000
	const maxQueue = Math.max(1, Number(wechatConfig.maxQueue ?? 5))

	const store = impl.StateStore ? new impl.StateStore(stateFile) : null

	/** 串行化 state 文件写入，避免轮询/发送/入站三条路径互相覆盖。 */
	let writeChain = Promise.resolve()
	function serialize(task) {
		const run = writeChain.then(task, task)
		writeChain = run.catch(() => {})
		return run
	}

	let peer = readJson(peerFile, {
		version: 1,
		accountId: null,
		peerId: null,
		conversationId: null,
		lastInboundAt: 0,
		lastSelfReplyAt: 0,
		lastSendAt: 0,
		sentCount: 0,
		lastError: null,
		queue: [],
	})
	if (!Array.isArray(peer.queue)) peer.queue = []

	let account = null
	let monitor = null
	let abortController = null
	let running = false
	let stopping = false
	let restartTimer = null
	let lastError = null
	let needsRebind = false
	let monitorStoppedReason = null
	let lastInboundAt = peer.lastInboundAt ?? 0
	let lastSendAt = peer.lastSendAt ?? 0

	const savePeer = () => writeJsonAtomic(peerFile, peer)
	const savePeerSerialized = () => serialize(savePeer)

	/** 当前窗口的用量：从插件兼容的 ChannelState.quota 里读。 */
	async function readQuota() {
		if (!store) return { used: 0, token: undefined }
		const state = await store.read()
		const token = state.contextTokens?.[account?.accountId ?? peer.accountId]?.[peer.conversationId]
		const entry = state.quota?.[peer.conversationId]
		if (!entry || entry.token !== token) return { used: 0, token }
		return { used: Number(entry.used) || 0, token }
	}

	/** 已处理 / 排队状态，供 /health 和 CLI 用。 */
	function status() {
		const queued = peer.queue.length
		return {
			enabled,
			configured: Boolean(account),
			bound: Boolean(account && peer.peerId && peer.conversationId),
			accountId: account?.accountId ?? peer.accountId ?? null,
			peerId: peer.peerId ?? null,
			monitorRunning: running && monitor !== null,
			monitorStoppedReason,
			needsRebind,
			windowLimit: impl.QUOTA_PER_TOKEN ?? QUOTA_PER_TOKEN,
			windowUsed: peer.windowUsed ?? null,
			queueLength: queued,
			lastInboundAt: lastInboundAt || null,
			lastSendAt: lastSendAt || null,
			lastError: lastError ?? peer.lastError ?? null,
			stateFile,
			peerFile,
		}
	}

	async function persistInbound(message) {
		const accountId = message.accountId ?? account?.accountId
		const conversationId = message.conversationId || impl.conversationKey(accountId, message.peerId, message.groupId)
		await serialize(async () => {
			if (store) {
				await store.update((state) => {
					if (message.contextToken) {
						;(state.contextTokens[accountId] ??= {})[conversationId] = message.contextToken
					}
					// 入站即视为「用户还想收」：把插件自动启动标记留着，方便将来真装插件时直接接管。
					state.autoStart = true
				})
			}
			peer.accountId = accountId
			peer.peerId = message.peerId
			peer.conversationId = conversationId
			peer.lastInboundAt = now()
			peer.lastError = null
			lastInboundAt = peer.lastInboundAt
			savePeer()
		})
	}

	/** 一次发送 + 记账；返回 charge（用于决定是否要提醒续窗）。 */
	async function sendOne(text, contextToken) {
		const sent = await impl.sendText({
			account,
			to: peer.peerId,
			text: truncate(text),
			...(contextToken ? { contextToken } : {}),
		})
		// 记到 ChannelState.quota，和官方插件共用一份计数（同一个 contextToken = 同一个窗口）。
		if (store) {
			await store.update((state) => {
				const stored = state.quota?.[peer.conversationId]
				const charge = impl.chargeQuota({ stored, token: contextToken })
				;(state.quota ??= {})[peer.conversationId] = charge.entry
				lastCharge = charge
			})
		}
		lastSendAt = now()
		peer.lastSendAt = lastSendAt
		peer.sentCount = (peer.sentCount ?? 0) + 1
		peer.lastError = null
		savePeer()
		return sent
	}

	let lastCharge = { warn: false, used: 0 }

	/** 如果窗口快用完了，补一条「回我一句」——它本身也占一个窗口。 */
	async function warnIfNeeded(contextToken) {
		const { warn, used } = lastCharge ?? {}
		if (!warn) return
		try {
			await impl.sendText({
				account,
				to: peer.peerId,
				text: impl.QUOTA_WARNING ?? QUOTA_WARNING,
				...(contextToken ? { contextToken } : {}),
			})
			logger.error?.(`[wechat] quota window ${used}/${impl.QUOTA_PER_TOKEN ?? QUOTA_PER_TOKEN}, warned user`)
		} catch (error) {
			logger.error?.(`[wechat] quota warning failed: ${String(error?.message ?? error)}`)
		}
	}

	function enqueue(text, meta = {}) {
		const entry = {
			text: truncate(text),
			kind: meta.kind ?? 'notice',
			alertId: meta.alertId ?? null,
			queuedAt: now(),
		}
		// 同一条 alert 只排一次队。
		if (entry.alertId && peer.queue.some((item) => item.alertId === entry.alertId)) return false
		peer.queue.push(entry)
		while (peer.queue.length > maxQueue) peer.queue.shift()
		savePeer()
		return true
	}

	async function currentContextToken() {
		if (!store) return undefined
		const state = await store.read()
		return state.contextTokens?.[account?.accountId ?? peer.accountId]?.[peer.conversationId]
	}

	/** 把队列里的消息补发出去（最多 5 条 / 次，遇到窗口关闭就停）。 */
	async function flushQueue() {
		if (!account || !peer.peerId) return 0
		let sent = 0
		while (peer.queue.length > 0 && sent < 5) {
			const token = await currentContextToken()
			if (!token) break
			const next = peer.queue[0]
			try {
				await sendOne(next.text, token)
				peer.queue.shift()
				await savePeerSerialized()
				await warnIfNeeded(token)
				sent += 1
			} catch (error) {
				if (error instanceof (impl.SendRefusedError ?? SendRefusedError)) {
					peer.lastError = String(error?.message ?? error)
					await savePeerSerialized()
				} else {
					peer.lastError = String(error?.message ?? error)
					await savePeerSerialized()
				}
				break
			}
		}
		return sent
	}

	async function handleInbound(message) {
		try {
			await persistInbound(message)
			logger.error?.(
				`[wechat] inbound peer=${message.peerId} conv=${peer.conversationId} hasToken=${Boolean(message.contextToken)}`,
			)
			// 1) 先补发积压的通知（它们比自我说明更重要）。
			await flushQueue()
			// 2) 固定文案回一句：证明通道活着 + 重开窗口。节流，避免刷屏。
			const token = await currentContextToken()
			if (token && now() - (peer.lastSelfReplyAt ?? 0) >= throttleMs) {
				try {
					await sendOne(SELF_REPLY_TEXT, token)
					peer.lastSelfReplyAt = now()
					await savePeerSerialized()
				} catch (error) {
					logger.error?.(`[wechat] self-reply failed: ${String(error?.message ?? error)}`)
				}
			}
		} catch (error) {
			lastError = String(error?.message ?? error)
			logger.error?.(`[wechat] inbound handling failed: ${lastError}`)
		}
	}

	function scheduleRestart(reason) {
		if (stopping || restartTimer) return
		restartTimer = setTimeout(() => {
			restartTimer = null
			void startMonitor()
		}, 60_000)
		restartTimer.unref?.()
		logger.error?.(`[wechat] monitor stopped (${reason}); retry in 60s`)
	}

	async function startMonitor() {
		if (!enabled) return
		if (running || !account || stopping) return
		const state = await store.read().catch(() => ({ syncBufs: {} }))
		const initialSyncBuf = state.syncBufs?.[account.accountId]
		abortController = new AbortController()
		monitor = new impl.ChannelMonitor({
			account,
			initialSyncBuf,
			botAgent: 'dsh-notify',
			onMessage: handleInbound,
			onSyncBuf: async (buf) => {
				await serialize(() =>
					store.update((current) => {
						current.syncBufs[account.accountId] = buf
					}),
				)
			},
			onError: (error) => {
				lastError = String(error?.message ?? error)
				logger.error?.(`[wechat] monitor error: ${lastError}`)
			},
			onStop: (reason, detail) => {
				running = false
				monitorStoppedReason = detail ? `${reason}: ${detail}` : reason
				if (reason === 'stale-token') needsRebind = true
				if (!stopping) scheduleRestart(monitorStoppedReason)
			},
		})
		running = true
		monitorStoppedReason = null
		logger.error?.(`[wechat] monitor started account=${account.accountId}`)
		monitor
			.run(abortController.signal)
			.then((reason) => {
				running = false
				if (!stopping && reason !== 'aborted') scheduleRestart(`run-ended:${reason}`)
			})
			.catch((error) => {
				running = false
				lastError = String(error?.message ?? error)
				if (!stopping) scheduleRestart(`run-threw:${lastError}`)
			})
	}

	/** 启动：读凭据、选账号、开始长轮询。没有凭据就安静地待着（doctor 能看到原因）。 */
	async function start() {
		stopping = false
		if (!enabled) {
			lastError = '微信通道已在配置里关闭'
			return status()
		}
		if (!store) {
			lastError = '找不到 vendored core 的 StateStore'
			return status()
		}
		try {
			const state = await store.read()
			const accounts = Object.values(state.accounts ?? {})
			if (accounts.length === 0) {
				lastError = '这台机器上没有微信 bot 凭据（先运行 wechat-bind 或 wechat-adopt）'
				return status()
			}
			account = accounts.find((item) => item.accountId === peer.accountId) ?? accounts[0]
			peer.accountId = account.accountId
			lastError = null
			await startMonitor()
		} catch (error) {
			lastError = String(error?.message ?? error)
			logger.error?.(`[wechat] start failed: ${lastError}`)
		}
		return status()
	}

	async function stop() {
		stopping = true
		if (restartTimer) {
			clearTimeout(restartTimer)
			restartTimer = null
		}
		if (monitor) {
			try {
				await monitor.notifyStop()
			} catch {
				/* 尽力而为 */
			}
		}
		abortController?.abort()
		running = false
		monitor = null
		return status()
	}

	/**
	 * 发一条通知。
	 * @returns {Promise<{ok:boolean, queued?:boolean, reason?:string, used?:number}>}
	 */
	async function send(text, meta = {}) {
		if (!enabled) return { ok: false, reason: 'disabled' }
		if (!account) {
			enqueue(text, meta)
			return { ok: false, queued: true, reason: 'not-bound' }
		}
		if (!peer.peerId || !peer.conversationId) {
			enqueue(text, meta)
			return { ok: false, queued: true, reason: 'no-peer' }
		}
		const token = await currentContextToken()
		if (!token) {
			enqueue(text, meta)
			return { ok: false, queued: true, reason: 'no-window' }
		}
		try {
			await sendOne(text, token)
			const { used } = lastCharge
			peer.windowUsed = used
			await warnIfNeeded(token)
			await savePeerSerialized()
			return { ok: true, used }
		} catch (error) {
			lastError = String(error?.message ?? error)
			if (error instanceof (impl.SendRefusedError ?? SendRefusedError)) {
				enqueue(text, meta)
				peer.lastError = lastError
				await savePeerSerialized()
				return { ok: false, queued: true, reason: 'refused' }
			}
			enqueue(text, meta)
			peer.lastError = lastError
			await savePeerSerialized()
			return { ok: false, queued: true, reason: 'error' }
		}
	}

	return {
		start,
		stop,
		send,
		status,
		flushQueue,
		// 测试钩子：直接喂一条入站消息，不经过网络。
		__handleInbound: handleInbound,
		__readQuota: readQuota,
	}
}
