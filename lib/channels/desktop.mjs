/**
 * 桌面通道。
 *
 * 两条路：
 *   - **主路径**：挂件每 3s 拉 `/state`、自己发 `UNUserNotification`。挂件启动后每
 *     几秒写一次心跳 `stateDir/widget-heartbeat.json`（`{pid, at}`）。心跳新鲜时
 *     daemon 什么都不用做（`deliver()` 返回 `{ok:true, mode:"widget"}`）。
 *   - **兜底**：心跳过期/缺失（挂件没开）时，用 `/usr/bin/osascript` 发一条系统
 *     通知。这里**禁止命令注入**：`execFile` 用 argv 传参（不经过 shell），
 *     AppleScript 字符串里的 `\` 和 `"` 都转义、换行压成空格。
 *
 * 通道状态：`{mode:"widget"|"osascript", lastDeliveryAt, error, heartbeat, widgetAlive}`。
 */
import { execFile as execFileCallback } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCallback)
const OSASCRIPT = '/usr/bin/osascript'
const DEFAULT_STALE_SECONDS = 30
const BODY_LIMIT = 300
const TITLE_LIMIT = 120

/** AppleScript 字符串字面量转义：先转 `\` 再转 `"`，顺手把控制字符/换行压平。 */
export function escapeAppleScript(value) {
	return String(value ?? '')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
		.replace(/\r\n?|\n/g, ' ')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
}

function clamp(value, limit) {
	const text = String(value ?? '').trim()
	if (text.length <= limit) return text
	return `${text.slice(0, limit - 1)}…`
}

/** 生成 `display notification ... with title ... sound name "Glass"` 脚本。 */
export function buildNotificationScript({ title, body }) {
	const safeTitle = escapeAppleScript(clamp(title || 'DSH 通知', TITLE_LIMIT))
	const safeBody = escapeAppleScript(clamp(body || '', BODY_LIMIT))
	return `display notification "${safeBody}" with title "${safeTitle}" sound name "Glass"`
}

/** 读挂件心跳；文件不存在/坏 JSON 都当「没有心跳」。 */
export function readHeartbeatFile(file, now = Date.now) {
	try {
		const raw = JSON.parse(readFileSync(file, 'utf8'))
		const at = Number(raw?.at ?? raw?.time ?? 0)
		return {
			present: true,
			at: Number.isFinite(at) ? at : 0,
			pid: Number.isFinite(Number(raw?.pid)) ? Number(raw.pid) : null,
			ageMs: Number.isFinite(at) && at > 0 ? Math.max(0, now() - at) : null,
		}
	} catch {
		return { present: false, at: null, pid: null, ageMs: null }
	}
}

/**
 * 创建桌面通道。
 *
 * @param {object} options
 * @param {object} options.config - `loadConfig()` 产物（用 channels.desktop + stateDir）
 * @param {string} [options.heartbeatPath] - 默认 `stateDir/widget-heartbeat.json`
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {(file: string, args: string[]) => Promise<unknown>} [options.execFile] - 测试注入
 */
export function createDesktopChannel({
	config,
	heartbeatPath,
	logger = console,
	now = Date.now,
	execFile = execFileAsync,
} = {}) {
	if (!config) throw new TypeError('createDesktopChannel 需要 config')
	const desktopConfig = config.channels?.desktop ?? {}
	const staleSeconds = Number.isFinite(Number(desktopConfig.widgetStaleSeconds))
		? Number(desktopConfig.widgetStaleSeconds)
		: DEFAULT_STALE_SECONDS
	const heartbeatFile = heartbeatPath ?? join(config.stateDir ?? join(homedir(), '.dsh', 'notify'), 'widget-heartbeat.json')

	let lastDeliveryAt = null
	let lastError = null
	let lastMode = 'osascript'

	function heartbeat() {
		return readHeartbeatFile(heartbeatFile, now)
	}

	function isWidgetAlive(state = heartbeat()) {
		return Boolean(state.present && state.ageMs !== null && state.ageMs <= staleSeconds * 1000)
	}

	function status() {
		const state = heartbeat()
		const widgetAlive = isWidgetAlive(state)
		return {
			mode: widgetAlive ? 'widget' : 'osascript',
			enabled: Boolean(desktopConfig.enabled !== false),
			widgetAlive,
			heartbeat: state,
			staleSeconds,
			lastDeliveryAt,
			error: lastError,
		}
	}

	/**
	 * 投递一条桌面通知。
	 *
	 * @param {object} alert - SPEC §4 alert
	 * @param {{force?: boolean}} [options] - `force` 用于 `dsh-notify test`：无视心跳、
	 *   直接 osascript（测试通知不写 state，也不进去重）。
	 * @returns {Promise<{ok:boolean, mode:string, error?:string|null}>}
	 */
	async function deliver(alert, options = {}) {
		const force = Boolean(options.force)
		if (desktopConfig.enabled === false && !force) {
			return { ok: false, mode: 'disabled', error: 'desktop 通道已禁用' }
		}

		const state = heartbeat()
		const widgetAlive = isWidgetAlive(state)
		if (widgetAlive && !force) {
			lastMode = 'widget'
			return { ok: true, mode: 'widget', error: null }
		}

		if (!force && desktopConfig.fallbackWhenWidgetStale === false) {
			return { ok: false, mode: 'widget-stale', error: '挂件心跳过期，且 fallbackWhenWidgetStale=false' }
		}

		const script = buildNotificationScript({ title: alert?.title, body: alert?.body })
		try {
			await execFile(OSASCRIPT, ['-e', script])
			lastDeliveryAt = now()
			lastError = null
			lastMode = 'osascript'
			return { ok: true, mode: 'osascript', error: null }
		} catch (error) {
			lastError = String(error?.message ?? error)
			lastMode = 'osascript'
			logger?.error?.(`[desktop] osascript 通知失败：${lastError}`)
			return { ok: false, mode: 'osascript', error: lastError }
		}
	}

	return {
		deliver,
		status,
		heartbeat,
		isWidgetAlive,
		heartbeatPath: heartbeatFile,
		get lastDeliveryAt() {
			return lastDeliveryAt
		},
	}
}
