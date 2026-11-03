/**
 * alert 持久化 / 去重 / 裁剪 / 升级提醒。
 *
 * 状态文件：`stateDir/state.json`（原子写：tmp + rename，0600）。
 *
 * 关键约定（SPEC §4/§5）：
 *   - alert 以 `id` 去重：已存在同 id 不再通知，也不覆盖已有状态；
 *   - 保留最近 7 天 / 最多 500 条；pending 永不裁剪（它还要被升级提醒）；
 *   - 升级提醒：pending 超过 `escalateAfterSeconds[i]` 再通知一次，最多 len 次；
 *   - 安静时段：approval/question 无视；turn-done/turn-error 只写状态不推送；
 *   - `notified` 记账：只有真的投递成功/入队才置 true，重启后据此不重复通知。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000

/** 把 "HH:MM" / "HH:MM:SS" 解析成「当天第几分钟」。 */
export function parseClock(text) {
	if (typeof text !== 'string') return null
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
	if (!match) return null
	const hours = Number(match[1])
	const minutes = Number(match[2])
	if (hours > 23 || minutes > 59) return null
	return hours * 60 + minutes
}

/**
 * 判断某个时刻是否在安静时段内。
 *
 * @param {{start:string,end:string}|null|undefined} quietHours
 * @param {Date} [date]
 */
export function isQuietHours(quietHours, date = new Date()) {
	if (!quietHours || typeof quietHours !== 'object') return false
	const start = parseClock(quietHours.start)
	const end = parseClock(quietHours.end)
	if (start === null || end === null || start === end) return false
	const minutes = date.getHours() * 60 + date.getMinutes()
	if (start < end) return minutes >= start && minutes < end
	// 跨午夜，例如 23:30 → 07:30
	return minutes >= start || minutes < end
}

function emptyAlert(draft, at) {
	return {
		id: String(draft.id),
		kind: String(draft.kind ?? 'turn-done'),
		status: draft.status === 'resolved' ? 'resolved' : 'pending',
		sessionId: draft.sessionId ?? '',
		sessionTitle: draft.sessionTitle ?? '',
		project: draft.project ?? '',
		projectPath: draft.projectPath ?? '',
		title: draft.title ?? '',
		body: draft.body ?? '',
		detail: draft.detail && typeof draft.detail === 'object' ? { ...draft.detail } : {},
		createdAt: Number.isFinite(Number(draft.createdAt)) ? Number(draft.createdAt) : at,
		detectedAt: at,
		updatedAt: at,
		notified: { desktop: false, wechat: false },
		escalatedAt: [],
		resolvedAt: draft.status === 'resolved' && Number.isFinite(Number(draft.resolvedAt)) ? Number(draft.resolvedAt) : null,
		resolution: draft.resolution ?? null,
	}
}

function normalizeLoadedAlert(raw) {
	if (!raw || typeof raw !== 'object' || !raw.id) return null
	return {
		id: String(raw.id),
		kind: String(raw.kind ?? 'turn-done'),
		status: raw.status === 'resolved' ? 'resolved' : 'pending',
		sessionId: raw.sessionId ?? '',
		sessionTitle: raw.sessionTitle ?? '',
		project: raw.project ?? '',
		projectPath: raw.projectPath ?? '',
		title: raw.title ?? '',
		body: raw.body ?? '',
		detail: raw.detail && typeof raw.detail === 'object' ? raw.detail : {},
		createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
		detectedAt: Number.isFinite(Number(raw.detectedAt)) ? Number(raw.detectedAt) : null,
		updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : null,
		notified: {
			desktop: Boolean(raw.notified?.desktop),
			wechat: Boolean(raw.notified?.wechat),
		},
		escalatedAt: Array.isArray(raw.escalatedAt) ? raw.escalatedAt.filter((value) => Number.isFinite(Number(value))).map(Number) : [],
		resolvedAt: Number.isFinite(Number(raw.resolvedAt)) ? Number(raw.resolvedAt) : null,
		resolution: raw.resolution ?? null,
	}
}

/**
 * 创建 alert 状态仓库。
 *
 * @param {object} options
 * @param {string} options.dir - stateDir（`DSH_NOTIFY_STATE_DIR`）
 * @param {() => number} [options.now]
 * @param {number} [options.retentionDays]
 * @param {number} [options.maxAlerts]
 * @param {object} [options.logger]
 */
export function createStateStore({
	dir,
	now = Date.now,
	retentionDays = 7,
	maxAlerts = 500,
	pendingMaxAgeHours = 12,
	logger = console,
} = {}) {
	if (!dir) throw new TypeError('createStateStore 需要 dir')
	const statePath = join(dir, 'state.json')
	const alerts = new Map()
	let loaded = false
	let dirty = false
	let tmpCounter = 0

	function load() {
		if (loaded) return
		loaded = true
		if (!existsSync(statePath)) return
		try {
			const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
			const list = Array.isArray(parsed?.alerts) ? parsed.alerts : Object.values(parsed?.alerts ?? {})
			for (const raw of list) {
				const alert = normalizeLoadedAlert(raw)
				if (alert) alerts.set(alert.id, alert)
			}
		} catch (error) {
			logger?.warn?.(`[state] 读不了 ${statePath}，按空状态继续：${String(error?.message ?? error)}`)
		}
	}

	function save() {
		if (!dirty) return false
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		const payload = {
			version: STATE_VERSION,
			updatedAt: now(),
			alerts: [...alerts.values()].sort((a, b) => a.createdAt - b.createdAt),
		}
		const tmp = `${statePath}.tmp-${process.pid}-${(tmpCounter += 1)}`
		writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
		renameSync(tmp, statePath)
		dirty = false
		return true
	}

	/**
	 * 批量写入 detector 产出的 alert 草稿。
	 * @returns {object[]} 真正新建（此前不存在）的 alert
	 */
	function upsertMany(drafts = []) {
		load()
		const created = []
		for (const draft of drafts) {
			if (!draft || !draft.id) continue
			const id = String(draft.id)
			const existing = alerts.get(id)
			if (existing) {
				// 只刷新描述性字段（标题/正文/会话标题可能在事件之后才到），
				// 状态、通知记账、升级记录一律以第一次为准。
				let changed = false
				for (const key of ['sessionTitle', 'project', 'projectPath', 'title', 'body']) {
					if (draft[key] && existing[key] !== draft[key]) {
						existing[key] = draft[key]
						changed = true
					}
				}
				if (changed) {
					existing.updatedAt = now()
					dirty = true
				}
				continue
			}
			const alert = emptyAlert(draft, now())
			alerts.set(id, alert)
			created.push(alert)
			dirty = true
		}
		return created
	}

	function resolve(id, options = {}) {
		load()
		const alert = alerts.get(String(id))
		if (!alert || alert.status !== 'pending') return null
		alert.status = 'resolved'
		alert.resolution = options.resolution ?? alert.resolution ?? null
		alert.resolvedAt = Number.isFinite(Number(options.resolvedAt)) ? Number(options.resolvedAt) : now()
		alert.updatedAt = now()
		dirty = true
		return alert
	}

	function resolveMany(list = []) {
		const out = []
		for (const item of list) {
			if (!item || !item.id) continue
			const alert = resolve(item.id, item)
			if (alert) out.push(alert)
		}
		return out
	}

	/**
	 * turn 结束时清理「上一轮就该结束」的 pending（覆盖 detector 重启后不记得的旧 alert）。
	 * 只 resolve 该 turn 的、或没有 turn 信息的 pending。
	 */
	function resolveTurnPendings(sessionId, turn, at = now()) {
		load()
		const out = []
		for (const alert of alerts.values()) {
			if (alert.status !== 'pending') continue
			if (alert.sessionId !== sessionId) continue
			const alertTurn = alert.detail?.turn
			if (alertTurn !== turn && alertTurn !== null && alertTurn !== undefined) continue
			alert.status = 'resolved'
			alert.resolution = 'cancelled'
			alert.resolvedAt = at
			alert.updatedAt = now()
			dirty = true
			out.push(alert)
		}
		return out
	}

	function markNotified(id, channel, at = now()) {
		load()
		const alert = alerts.get(String(id))
		if (!alert) return null
		if (channel !== 'desktop' && channel !== 'wechat') return null
		if (alert.notified[channel]) return alert
		alert.notified[channel] = true
		alert.updatedAt = at
		dirty = true
		return alert
	}

	function markEscalated(id, at = now()) {
		load()
		const alert = alerts.get(String(id))
		if (!alert) return null
		alert.escalatedAt.push(at)
		alert.updatedAt = at
		dirty = true
		return alert
	}

	/**
	 * 升级提醒到期的 pending。
	 *
	 * 语义：`escalateAfterSeconds[i]` 是「距离 alert 创建（第 0 次）或上一次升级」
	 * 的秒数；每个 pending 最多升级 len(thresholds) 次。这样不会有「停机很久后
	 * 一秒钟补发三条」的刷屏。
	 */
	function dueEscalations(thresholds, at = now()) {
		load()
		const list = Array.isArray(thresholds) ? thresholds.map(Number).filter((value) => Number.isFinite(value) && value >= 0) : []
		if (list.length === 0) return []
		const due = []
		for (const alert of alerts.values()) {
			if (alert.status !== 'pending') continue
			const index = alert.escalatedAt.length
			if (index >= list.length) continue
			const base = index === 0 ? alert.createdAt : alert.escalatedAt[index - 1]
			if (at - base >= list[index] * 1000) due.push(alert)
		}
		due.sort((a, b) => a.createdAt - b.createdAt)
		return due
	}

	/**
	 * 启动时把「停机期间已经过期的升级阈值」标记为已消费，避免启动瞬间连发多条。
	 * 只有仍然 pending 的 alert 会处理；返回被消费的 alert id。
	 */
	function consumeOverdueEscalations(thresholds, at = now()) {
		load()
		const list = Array.isArray(thresholds) ? thresholds.map(Number).filter((value) => Number.isFinite(value) && value >= 0) : []
		if (list.length === 0) return []
		const touched = []
		for (const alert of alerts.values()) {
			if (alert.status !== 'pending') continue
			let index = alert.escalatedAt.length
			// 模拟「如果进程一直在跑，这些阈值本该在什么时候触发」。
			let deadline = index === 0 ? alert.createdAt : alert.escalatedAt[index - 1]
			const consumedAt = []
			while (index < list.length) {
				const nextDeadline = deadline + list[index] * 1000
				if (nextDeadline > at) break
				consumedAt.push(nextDeadline)
				deadline = nextDeadline
				index += 1
			}
			if (consumedAt.length === 0) continue
			alert.escalatedAt.push(...consumedAt)
			alert.updatedAt = now()
			dirty = true
			touched.push(alert.id)
		}
		return touched
	}

	function refreshSessionTitles(sessionId, title) {
		if (!sessionId || !title) return
		load()
		let changed = false
		for (const alert of alerts.values()) {
			if (alert.sessionId !== sessionId) continue
			if (alert.sessionTitle === title) continue
			alert.sessionTitle = title
			alert.updatedAt = now()
			changed = true
		}
		if (changed) dirty = true
	}

	function prune() {
		load()
		const cutoff = now() - Math.max(0, Number(retentionDays) || 0) * DAY_MS
		let removed = 0
		// 僵尸 pending 自愈：停机很久 + 事件落在 lookback 之外时，resolved 事件读不到，
		// 红条会永久挂着（只能手动 /ack）。超过 pendingMaxAgeHours 的 pending 视为失效。
		const pendingCutoff = now() - Math.max(0, Number(pendingMaxAgeHours) || 0) * 60 * 60 * 1000
		if (Number(pendingMaxAgeHours) > 0) {
			for (const alert of alerts.values()) {
				if (alert.status !== 'pending') continue
				if (alert.createdAt >= pendingCutoff) continue
				alert.status = 'resolved'
				alert.resolution = 'stale-timeout'
				alert.resolvedAt = now()
				alert.updatedAt = now()
				dirty = true
			}
		}
		for (const [id, alert] of alerts) {
			if (alert.status !== 'resolved') continue
			const at = alert.resolvedAt ?? alert.updatedAt ?? alert.createdAt
			if (at < cutoff) {
				alerts.delete(id)
				removed += 1
			}
		}
		const max = Math.max(0, Number(maxAlerts) || 0)
		if (max > 0 && alerts.size > max) {
			const resolved = [...alerts.values()]
				.filter((alert) => alert.status === 'resolved')
				.sort((a, b) => (a.resolvedAt ?? a.updatedAt ?? 0) - (b.resolvedAt ?? b.updatedAt ?? 0))
			let excess = alerts.size - max
			for (const alert of resolved) {
				if (excess <= 0) break
				alerts.delete(alert.id)
				excess -= 1
				removed += 1
			}
		}
		if (removed > 0) dirty = true
		return removed
	}

	function list() {
		load()
		return [...alerts.values()].sort((a, b) => a.createdAt - b.createdAt)
	}

	function pending() {
		load()
		return [...alerts.values()]
			.filter((alert) => alert.status === 'pending')
			.sort((a, b) => a.createdAt - b.createdAt)
	}

	/**
	 * 最近完成的 alert（挂件用；默认最近 6 小时、最多 20 条，按完成时间倒序）。
	 *
	 * **只包含 turn-done / turn-error**：resolved 的 approval/question 是「已经处理
	 * 掉了」，不是「完成了什么」。它们从 pending 消失就够了；放进 recentDone 会
	 * 被挂件当成「新 alert」再弹一次（用户已经答过的问题又弹出来）。
	 */
	function recentDone({ withinMs = 6 * 60 * 60 * 1000, limit = 20 } = {}) {
		load()
		const cutoff = now() - Math.max(0, Number(withinMs) || 0)
		return [...alerts.values()]
			.filter(
				(alert) =>
					alert.status === 'resolved' &&
					(alert.kind === 'turn-done' || alert.kind === 'turn-error') &&
					(alert.resolvedAt ?? alert.updatedAt ?? 0) >= cutoff,
			)
			.sort((a, b) => (b.resolvedAt ?? b.updatedAt ?? 0) - (a.resolvedAt ?? a.updatedAt ?? 0))
			.slice(0, Math.max(0, Number(limit) || 0))
	}

	function counts() {
		load()
		const today = new Date(now()).toDateString()
		let pendingCount = 0
		let todayDone = 0
		for (const alert of alerts.values()) {
			if (alert.status === 'pending') {
				pendingCount += 1
			} else if (
				(alert.kind === 'turn-done' || alert.kind === 'turn-error') &&
				alert.resolvedAt &&
				new Date(alert.resolvedAt).toDateString() === today
			) {
				todayDone += 1
			}
		}
		return { pending: pendingCount, todayDone }
	}

	function ack(id, at = now()) {
		return resolve(id, { resolution: 'acknowledged', resolvedAt: at })
	}

	/**
	 * 删掉某个集合里所有会话的 alert（子 agent 会话用：历史遗留的子 agent
	 * alert 也要从 recentDone/统计里清掉）。
	 */
	function removeForSessions(sessionIds) {
		load()
		const targets = sessionIds instanceof Set ? sessionIds : new Set(sessionIds ?? [])
		if (targets.size === 0) return 0
		let removed = 0
		for (const [id, alert] of alerts) {
			if (!targets.has(alert.sessionId)) continue
			alerts.delete(id)
			removed += 1
		}
		if (removed > 0) dirty = true
		return removed
	}

	/** 直接从状态里删掉（`/test` 的 demo alert 用：不进历史、不参与统计）。 */
	function remove(id) {
		load()
		const deleted = alerts.delete(String(id))
		if (deleted) dirty = true
		return deleted
	}

	return {
		statePath,
		load,
		save,
		get dirty() {
			return dirty
		},
		upsertMany,
		resolve,
		resolveMany,
		resolveTurnPendings,
		markNotified,
		markEscalated,
		dueEscalations,
		consumeOverdueEscalations,
		refreshSessionTitles,
		prune,
		list,
		pending,
		recentDone,
		counts,
		ack,
		remove,
		removeForSessions,
		get: (id) => {
			load()
			return alerts.get(String(id)) ?? null
		},
		size: () => {
			load()
			return alerts.size
		},
		clear: () => {
			load()
			alerts.clear()
			dirty = true
		},
	}
}
