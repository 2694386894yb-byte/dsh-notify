/**
 * 守护进程编排（SPEC §5/§6）。
 *
 * 每 1000ms tick 一次：watcher 只 stat，变了才解析 → detector 把事件翻成 alert →
 * state 去重落盘 → 需要时投递桌面/微信。
 *
 * 设计要点：
 *   - 启动第一次 tick 是「回放」：lookback 内的会话完整解析，重建 pending。
 *     回放出来的历史 turn 不重新通知；仍 pending 的 approval/question 会补发一条
 *     「仍在等待」（前提是持久化状态里这条还没通知过）。
 *   - **幂等**：反复 tick 不会重复通知——只有新插入的 alert 才进入投递队列，
 *     升级提醒按 escalatedAt 记账；已 notified 的通道不再重发。
 *   - 任何单个通道/单个会话出错都不能中断 tick。
 *   - 桌面通道由本模块内部 import；微信通道由 `bin/` 注入（可能为 null）。
 */
import { createDesktopChannel } from './channels/desktop.mjs'
import { createDetector } from './detect.mjs'
import { createHttpServer } from './server.mjs'
import { createStateStore, isQuietHours } from './state.mjs'
import { createWatcher } from './watcher.mjs'

const DEFAULT_INTERVAL_MS = 1000
const MAX_WECHAT_TEXT = 500
const MAX_WECHAT_TEXT_OTHER = 650

function truncate(text, limit) {
	const value = String(text ?? '')
	if (value.length <= limit) return value
	return `${value.slice(0, limit - 1)}…`
}

/** 每种 alert 受哪个开关控制。 */
function kindEnabled(config, kind) {
	const notify = config?.notify ?? {}
	if (kind === 'approval') return notify.approval !== false
	if (kind === 'question') return notify.question !== false
	if (kind === 'turn-done') return notify.turnDone !== false
	if (kind === 'turn-error') return notify.turnError !== false
	return true
}

/**
 * 创建 daemon。
 *
 * @param {object} options
 * @param {object} options.config - `loadConfig()` 产物
 * @param {{wechat?: object|null}} [options.channels]
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {object} [options.watcher] - 测试注入
 * @param {object} [options.detector]
 * @param {object} [options.stateStore]
 * @param {object} [options.desktop]
 */
export function createDaemon({
	config,
	channels = {},
	logger = console,
	now = Date.now,
	watcher: injectedWatcher,
	detector: injectedDetector,
	stateStore: injectedState,
	desktop: injectedDesktop,
} = {}) {
	if (!config) throw new TypeError('createDaemon 需要 config')

	const wechat = channels?.wechat ?? null
	const state = injectedState ?? createStateStore({ dir: config.stateDir, now, logger, pendingMaxAgeHours: config.notify?.pendingMaxAgeHours })
	const watcher =
		injectedWatcher ??
		createWatcher({
			sessionsRoot: config.sessions.root,
			workspacesFile: config.sessions.workspacesFile,
			lookbackMinutes: config.sessions.startupLookbackMinutes,
			logger,
			now,
		})
	const includeSubagents = config.notify?.includeSubagents === true
	const detector =
		injectedDetector ??
		createDetector({ minTurnSeconds: config.notify.minTurnSeconds, now, includeSubagents })
	const desktopChannel = injectedDesktop ?? createDesktopChannel({ config, logger, now })

	const lookbackMs = Math.max(0, Number(config.sessions?.startupLookbackMinutes) || 0) * 60_000
	const escalateThresholds = Array.isArray(config.notify?.escalateAfterSeconds)
		? config.notify.escalateAfterSeconds.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
		: []

	/**
	 * 微信只推「需要人处理」和「最终汇报」两类（默认 approval/turn-done/turn-error），
	 * 中间过程 question 不推（桌面/挂件仍然显示）。`"*"` 表示全推。
	 */
	const wechatEvents = (() => {
		const raw = config.channels?.wechat?.events
		const list = Array.isArray(raw) ? raw.map((value) => String(value)) : ['approval', 'turn-done', 'turn-error']
		if (list.includes('*')) return { all: true, set: new Set(['approval', 'question', 'turn-done', 'turn-error']) }
		return { all: false, set: new Set(list) }
	})()

	function wechatAllows(kind) {
		if (wechatEvents.all) return true
		return wechatEvents.set.has(String(kind))
	}

	let started = false
	let startedAt = null
	let timer = null
	let ticking = false
	let lastScanErrors = new Set()
	let lastSummary = { tickCount: 0, newAlerts: 0, notified: 0 }
	// `/test` 注入的 demo alert：60s 后自动移除，避免一条假 pending 赖在挂件红条里。
	const demoTimers = new Map()
	const demoAlertTtlMs =
		Number.isFinite(Number(config.test?.demoAlertTtlMs)) && Number(config.test.demoAlertTtlMs) > 0
			? Number(config.test.demoAlertTtlMs)
			: 60_000

	function clearDemoTimer(id) {
		const timer = demoTimers.get(id)
		if (timer) {
			clearTimeout(timer)
			demoTimers.delete(id)
		}
	}

	/** 进程重启后清掉上次遗留的 demo alert（它不应该持久存在）。 */
	function purgeStaleDemoAlerts() {
		let removed = 0
		for (const alert of state.list()) {
			if (!String(alert.id).startsWith('demo:')) continue
			state.remove(alert.id)
			clearDemoTimer(alert.id)
			removed += 1
		}
		return removed
	}

	// ---- 通道工具 -------------------------------------------------------

	function desktopStatus() {
		try {
			return desktopChannel.status()
		} catch (error) {
			return { mode: 'error', error: String(error?.message ?? error) }
		}
	}

	function wechatStatus() {
		if (!wechat) return { mode: 'off', enabled: Boolean(config.channels?.wechat?.enabled), reason: 'not-configured' }
		try {
			return wechat.status()
		} catch (error) {
			return { mode: 'error', error: String(error?.message ?? error) }
		}
	}

	function channelStatus() {
		return { desktop: desktopStatus(), wechat: wechatStatus() }
	}

	async function deliverDesktop(alert, options = {}) {
		try {
			return await desktopChannel.deliver(alert, options)
		} catch (error) {
			const message = String(error?.message ?? error)
			logger?.error?.(`[daemon] 桌面通道异常：${message}`)
			return { ok: false, mode: 'error', error: message }
		}
	}

	async function sendWechat(alert, { reason, occurrence = 0, max = 0, bypassFilter = false } = {}) {
		if (!wechat) return { ok: false, reason: 'not-configured' }
		if (!bypassFilter && !wechatAllows(alert.kind)) {
			return { ok: false, skipped: 'kind-not-in-wechat-events', kind: alert.kind }
		}
		const text = formatAlertText(alert, { reason, occurrence, max })
		try {
			const result = await wechat.send(text, { kind: alert.kind, alertId: alert.id })
			if (!result || (!result.ok && !result.queued)) {
				logger?.warn?.(`[daemon] 微信通知未发出（${result?.reason ?? 'unknown'}），alert=${alert.id}`)
			}
			return result ?? { ok: false, reason: 'empty-result' }
		} catch (error) {
			const message = String(error?.message ?? error)
			logger?.error?.(`[daemon] 微信通道异常：${message}`)
			return { ok: false, reason: 'exception', error: message }
		}
	}

	/** 拼给人看/发微信的一段文字；approval/question 控制在 ~500 字内（回复窗口有限）。 */
	function formatAlertText(alert, { reason = 'new', occurrence = 0, max = 0 } = {}) {
		const icon =
			alert.kind === 'approval'
				? '🔐'
				: alert.kind === 'question'
					? '❓'
					: alert.kind === 'turn-error'
						? '❌'
						: '✅'
		const lines = [`${icon} ${alert.title}`]
		if (alert.body) lines.push(alert.body)
		const context = []
		if (alert.sessionTitle) context.push(`会话：${alert.sessionTitle}`)
		if (alert.project && alert.project !== alert.sessionTitle) context.push(`项目：${alert.project}`)
		if (context.length > 0) lines.push(context.join(' · '))
		if (alert.detail?.stillWaiting) lines.push('（仍在等待）')
		if (reason === 'escalate') lines.push(`（再次提醒 ${occurrence}/${max}）`)
		const limit = alert.kind === 'approval' || alert.kind === 'question' ? MAX_WECHAT_TEXT : MAX_WECHAT_TEXT_OTHER
		return truncate(lines.join('\n'), limit)
	}

	/**
	 * 投递一条 alert 到桌面 + 微信，并回写 notified 记账。
	 * 任何通道失败都只记录、不抛。
	 */
	async function notifyAlert({ alert, reason = 'new', occurrence = 0, max = 0 }) {
		const quiet = isQuietHours(config.notify?.quietHours, new Date(now()))
		// approval/question 无视安静时段；turn-done/error 安静时段只写状态不推送。
		if (quiet && (alert.kind === 'turn-done' || alert.kind === 'turn-error') && reason !== 'escalate') {
			return { skipped: 'quiet' }
		}

		const delivered = { desktop: null, wechat: null }
		const desktopTarget =
			reason === 'escalate' ? { ...alert, title: `${alert.title}（再次提醒 ${occurrence}/${max}）` } : alert

		if (reason === 'escalate' || !alert.notified?.desktop) {
			delivered.desktop = await deliverDesktop(desktopTarget)
			// 主路径是挂件自己弹（mode=widget），那种情况不算 daemon 的桌面投递；
			// 只有 osascript 兜底成功才写 notified.desktop。
			if (delivered.desktop?.ok && delivered.desktop.mode === 'osascript') {
				state.markNotified(alert.id, 'desktop', now())
			}
		}

		// 微信事件过滤对升级提醒同样生效（question 的再次提醒也不推微信）。
		if ((reason === 'escalate' || !alert.notified?.wechat) && wechatAllows(alert.kind)) {
			delivered.wechat = await sendWechat(alert, { reason, occurrence, max })
			if (delivered.wechat?.ok || delivered.wechat?.queued) {
				state.markNotified(alert.id, 'wechat', now())
			}
		} else if (!wechatAllows(alert.kind)) {
			delivered.wechat = { ok: false, skipped: 'kind-not-in-wechat-events', kind: alert.kind }
		}

		return delivered
	}

	// ---- 扫描 / 通知 ----------------------------------------------------

	function logScanErrors(errors) {
		const seen = new Set()
		for (const item of errors ?? []) {
			const signature = `${item.scope ?? item.sessionId ?? ''}:${item.error}`
			if (lastScanErrors.has(signature) || seen.has(signature)) continue
			seen.add(signature)
			logger?.warn?.(`[daemon] 扫描告警：${signature}`)
		}
		lastScanErrors = new Set([...(errors ?? []).map((item) => `${item.scope ?? item.sessionId ?? ''}:${item.error}`)])
	}

	/** 回放出来的 alert 哪些需要补通知。 */
	function collectNotifications(created, scan) {
		const out = []
		for (const alert of created) {
			if (!kindEnabled(config, alert.kind)) continue
			if (alert.status === 'pending') {
				if (scan.initial) {
					// 启动回放：只有仍挂着的 approval/question 补一条「仍在等待」。
					if (alert.kind !== 'approval' && alert.kind !== 'question') continue
					if (scan.scannedAt - alert.createdAt > lookbackMs) continue
					alert.detail = { ...(alert.detail ?? {}), stillWaiting: true }
					out.push({ alert, reason: 'still-waiting' })
				} else {
					out.push({ alert, reason: 'new' })
				}
			} else if (!scan.initial) {
				// 只有 turn 类「最终汇报」才在创建即 resolved；同一批里被 resolve 掉的
				// approval/question（例如问题刚问就被 turn/end 取消）不该再通知。
				if (alert.kind !== 'turn-done' && alert.kind !== 'turn-error') continue
				out.push({ alert, reason: 'new' })
			}
		}
		return out
	}

	/**
	 * 跑一次扫描。可被重复调用（幂等：已通知过的不再通知）。
	 *
	 * @param {{notify?: boolean, persist?: boolean}} [options]
	 *   `notify:false` 用于 CLI `once`——只扫不发；此时默认不落盘，避免影响
	 *   正在/将要运行的 daemon 的通知记账。
	 */
	async function tick(options = {}) {
		const notify = options.notify !== false
		const persist = options.persist !== undefined ? Boolean(options.persist) : notify
		if (ticking) return { ...lastSummary, skipped: 'tick-in-progress' }
		ticking = true
		try {
			state.load()
			const scan = watcher.scan()
			logScanErrors(scan.errors)

			// 子 agent 会话默认整体忽略（不 pending/done/error、不推送）。
			// 顺带把历史遗留的子 agent alert 从 state 里清掉（之前的版本推过）。
			const subagentSessionIds = new Set()
			for (const session of scan.sessions) {
				if (session.origin === 'subagent') subagentSessionIds.add(session.sessionId)
			}
			if (!includeSubagents && subagentSessionIds.size > 0) {
				const removed = state.removeForSessions(subagentSessionIds)
				if (removed > 0) {
					logger?.info?.(`[daemon] 清理了 ${removed} 条子 agent 遗留 alert`)
				}
			}

			// 按会话聚合并交给 detector（保证事件顺序）。
			const groups = new Map()
			let skippedSubagentSessions = 0
			for (const event of scan.events) {
				if (!includeSubagents && event.origin === 'subagent') {
					skippedSubagentSessions += 1
					continue
				}
				let group = groups.get(event.sessionId)
				if (!group) {
					group = {
						meta: {
							sessionId: event.sessionId,
							project: event.project,
							projectPath: event.projectPath,
							origin: event.origin ?? null,
							parentSession: event.parentSession ?? null,
							delegationDepth: event.delegationDepth ?? null,
						},
						entries: [],
					}
					groups.set(event.sessionId, group)
				}
				group.entries.push(event.entry)
			}

			const drafts = []
			const resolutions = []
			const turnEnds = []
			const metaUpdates = []
			for (const group of groups.values()) {
				try {
					const result = detector.consume(group.meta, group.entries)
					drafts.push(...result.alerts)
					resolutions.push(...result.resolutions)
					turnEnds.push(...result.turnEnds)
					metaUpdates.push(...result.metaUpdates)
				} catch (error) {
					logger?.error?.(`[daemon] 解析会话 ${group.meta.sessionId} 失败：${String(error?.message ?? error)}`)
				}
			}

			// 启动回放只重建 pending：历史 turn 的 done/error 一律不落库、不通知，
			// 否则装好后第一次启动会把过去 2 小时「已完成」全弹一遍（刷屏）。
			const acceptedDrafts = scan.initial
				? drafts.filter((draft) => draft.kind !== 'turn-done' && draft.kind !== 'turn-error')
				: drafts
			const created = state.upsertMany(acceptedDrafts)
			for (const update of metaUpdates) state.refreshSessionTitles(update.sessionId, update.sessionTitle)
			const resolved = state.resolveMany(resolutions)
			for (const turnEnd of turnEnds) state.resolveTurnPendings(turnEnd.sessionId, turnEnd.turn, turnEnd.at)

			// 启动瞬间别把停机期间攒下的升级提醒一次性补发。
			if (scan.initial && escalateThresholds.length > 0) {
				state.consumeOverdueEscalations(escalateThresholds, now())
			}

			const notified = []
			if (notify) {
				for (const item of collectNotifications(created, scan)) {
					const delivered = await notifyAlert(item)
					notified.push({ id: item.alert.id, reason: item.reason, ...delivered })
				}
				// 启动时还挂着的 approval/question：即使状态文件里早就有它（例如上次
				// 微信投递失败/进程被杀），也把「尚未通知成功的通道」补一次。
				if (scan.initial) {
					const notifiedIds = new Set(notified.map((item) => item.id))
					for (const alert of state.pending()) {
						if (notifiedIds.has(alert.id)) continue
						if (alert.kind !== 'approval' && alert.kind !== 'question') continue
						if (scan.scannedAt - alert.createdAt > lookbackMs) continue
						if (!kindEnabled(config, alert.kind)) continue
						const desktopNeeded =
							config.channels?.desktop?.enabled !== false && !alert.notified?.desktop
						const wechatNeeded = Boolean(wechat) && wechatAllows(alert.kind) && !alert.notified?.wechat
						if (!desktopNeeded && !wechatNeeded) continue
						alert.detail = { ...(alert.detail ?? {}), stillWaiting: true }
						const delivered = await notifyAlert({ alert, reason: 'still-waiting' })
						notified.push({ id: alert.id, reason: 'still-waiting', ...delivered })
					}
				}
				for (const alert of state.dueEscalations(escalateThresholds, now())) {
					if (!kindEnabled(config, alert.kind)) continue
					if (String(alert.id).startsWith('demo:')) continue
					const occurrence = alert.escalatedAt.length + 1
					const delivered = await notifyAlert({
						alert,
						reason: 'escalate',
						occurrence,
						max: escalateThresholds.length,
					})
					state.markEscalated(alert.id, now())
					notified.push({ id: alert.id, reason: 'escalate', occurrence, ...delivered })
				}
			}

			state.prune()
			if (persist) state.save()

			const summary = {
				tickCount: (lastSummary.tickCount ?? 0) + 1,
				scannedAt: scan.scannedAt,
				initial: scan.initial,
				sessions: scan.sessions.length,
				events: scan.events.length,
				newAlerts: created.length,
				resolvedAlerts: resolved.length,
				skippedSubagentEvents: skippedSubagentSessions,
				notified,
				pending: state.pending().length,
			}
			lastSummary = summary
			return summary
		} finally {
			ticking = false
		}
	}

	// ---- 对外接口 -------------------------------------------------------

	function getState() {
		state.load()
		return {
			generatedAt: now(),
			pending: state.pending(),
			recentDone: state.recentDone(),
			counts: state.counts(),
			channels: channelStatus(),
		}
	}

	function health() {
		state.load()
		const sessions = watcher.getSessions?.() ?? []
		return {
			ok: true,
			uptimeMs: startedAt ? Math.max(0, now() - startedAt) : 0,
			watcher: {
				sessions: sessions.length,
				lastScanAt: watcher.lastScanAt ?? null,
				lastEventAt: watcher.lastEventAt ?? null,
			},
			channels: channelStatus(),
			server: {
				port: httpServer.port,
				listening: httpServer.listening,
				error: httpServer.error ?? null,
			},
		}
	}

	/**
	 * `dsh-notify test`：
	 *   1. 往 /state 注入一条合成 pending alert（`demo:<ts>`），让挂件 3s 轮询能拉到、
	 *      显示红条并弹原生通知——一次验证「daemon → /state → 挂件 → 系统通知」全链路；
	 *   2. 桌面强制走 osascript（心跳新鲜时也弹，测试就该看得见）；
	 *   3. 微信只发这一条测试文案（demo alert 本身不进微信，省回复窗口）；
	 *   4. demo alert 默认 60s 后自动移除（`config.test.demoAlertTtlMs` 可覆盖），
	 *      不进历史、不参与统计，也不写日志事件。
	 */
	async function test(payload = {}) {
		state.load()
		const at = now()
		const requestedKind = payload?.kind
		const demoKind = ['approval', 'question', 'turn-done', 'turn-error'].includes(requestedKind)
			? requestedKind
			: 'question'
		const title =
			typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : '测试：需要你处理'
		const body =
			typeof payload?.body === 'string' && payload.body.trim()
				? payload.body
				: '如果你在挂件红条、电脑通知和手机微信上都看到了这条，说明通知链路是通的。'

		const demoId = `demo:${at}`
		const demoAlert = {
			id: demoId,
			kind: demoKind,
			status: 'pending',
			sessionId: '',
			sessionTitle: '端到端测试',
			project: '通知自检',
			projectPath: '',
			title,
			body,
			detail: {},
			createdAt: at,
			resolvedAt: null,
			resolution: null,
		}
		state.upsertMany([demoAlert])
		state.save()

		clearDemoTimer(demoId)
		const timer = setTimeout(() => {
			state.remove(demoId)
			state.save()
			demoTimers.delete(demoId)
		}, demoAlertTtlMs)
		timer.unref?.()
		demoTimers.set(demoId, timer)

		const desktop = await deliverDesktop(demoAlert, { force: true })
		// /test 是用户显式触发的一次性自检，不受 channels.wechat.events 过滤。
		const wechatResult = await sendWechat(demoAlert, { reason: 'test', bypassFilter: true })
		return {
			ok: Boolean(desktop?.ok || wechatResult?.ok || wechatResult?.queued),
			demoAlertId: demoId,
			desktop,
			wechat: wechatResult,
		}
	}

	function ack(id) {
		state.load()
		if (typeof id !== 'string' || !id) return { ok: false, reason: 'missing-id' }
		if (id.startsWith('demo:')) {
			clearDemoTimer(id)
			const removed = state.remove(id)
			state.save()
			return removed ? { ok: true, id, removed: true } : { ok: false, reason: 'not-found', id }
		}
		const alert = state.ack(id, now())
		if (!alert) return { ok: false, reason: 'not-found', id }
		state.save()
		return { ok: true, id, alert }
	}

	async function start() {
		if (started) return api
		started = true
		startedAt = now()
		state.load()
		purgeStaleDemoAlerts()

		if (wechat?.start) {
			try {
				await wechat.start()
			} catch (error) {
				logger?.error?.(`[daemon] 微信通道启动失败：${String(error?.message ?? error)}`)
			}
		}

		try {
			await httpServer.start()
		} catch (error) {
			// 端口被占不致命：通知照发，/state 由另一个实例提供。
			logger?.error?.(`[daemon] HTTP 启动失败：${String(error?.message ?? error)}`)
		}

		try {
			await tick()
		} catch (error) {
			logger?.error?.(`[daemon] 首次扫描失败：${String(error?.message ?? error)}`)
		}

		const intervalMs = Number.isFinite(Number(config.intervalMs)) && Number(config.intervalMs) > 0
			? Number(config.intervalMs)
			: DEFAULT_INTERVAL_MS
		timer = setInterval(() => {
			tick().catch((error) => logger?.error?.(`[daemon] tick 失败：${String(error?.message ?? error)}`))
		}, Math.max(100, intervalMs))
		return api
	}

	async function stop() {
		if (timer) {
			clearInterval(timer)
			timer = null
		}
		let removedDemos = 0
		for (const id of [...demoTimers.keys()]) {
			clearDemoTimer(id)
			state.load()
			if (state.remove(id)) removedDemos += 1
		}
		if (removedDemos > 0) state.save()
		await httpServer.stop()
		if (wechat?.stop) {
			try {
				await wechat.stop()
			} catch (error) {
				logger?.error?.(`[daemon] 微信通道停止失败：${String(error?.message ?? error)}`)
			}
		}
		started = false
		return api
	}

	const api = {
		start,
		stop,
		tick,
		getState,
		test,
		health,
		ack,
		address: () => httpServer.address(),
		get started() {
			return started
		},
		get stateStore() {
			return state
		},
	}

	const httpServer = createHttpServer({ config, daemon: api, logger })

	return api
}
