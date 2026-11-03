/**
 * 事件 → alert 状态机（detect）。
 *
 * 输入是 watcher 吐出来的原始日志事件（按日志顺序），输出是 SPEC §4 的 alert
 * 草稿 + 「应该被 resolve 的 alert id」+ 「turn 结束」信号。持久化/去重/升级是
 * state.mjs 的职责，本模块只管把日志语义翻译成 SPEC §3 的判定规则：
 *
 *   - approval 待处理 = 有 `approval/asked` 且没有同 id 的 `approval/decided`，且 turn 仍开着；
 *   - question 待处理 = 有 ask 类 `tool/call` 且没有同 `callId` 的 `tool/result`，且 turn 仍开着；
 *   - turn 结束 → 该轮所有 pending 视为 resolved（cancelled）；
 *   - `turn/end` 的 `reason.kind`：
 *       completed → 时长 ≥ minTurnSeconds 或工具调用 ≥ 3 才发 turn-done；
 *       error     → 总是 turn-error；
 *       aborted   → 静默（但 pending 仍要清掉）。
 *
 * 真实日志字段（2026-10 实测，勿凭直觉改）：
 *   - `turn/start`  `{turn}`
 *   - `turn/end`    `{turn, reason:{kind, message?}}`
 *   - `tool/call`   `{turn, step, callId, name, arguments}`（arguments 是 JSON **字符串**）
 *   - `tool/result` `{turn, step, message:{toolCallId, source:{callId}, content:[...]}}`
 *                    —— callId 在 `data.message.toolCallId`，**不是** `data.toolCallId`；
 *                    为兼容不同版本，这里按 toolCallId ?? message.toolCallId ??
 *                    message.source.callId ?? source.callId 依次找。
 *   - `approval/asked`   `{id, toolName, reason, callId}`
 *   - `approval/decided` `{id, outcome}`
 *   - `assistant/message` `{message:{content:[{type:'text',text}]}}`（只取 text，排除 reasoning）
 *   - `session/title`   `{title}`
 */

/** 视为「要用户回答」的工具名。 */
export const ASK_TOOL_NAMES = new Set(['ask_user_question', 'request_user_input'])

/** SPEC §4：body 截断 400 字。 */
export const BODY_LIMIT = 400

const TURN_DONE_TOOL_THRESHOLD = 3

function truncate(text, limit = BODY_LIMIT) {
	const normalized = String(text ?? '')
		.replace(/\r\n/g, '\n')
		.trim()
	if (normalized.length <= limit) return normalized
	return `${normalized.slice(0, limit - 1)}…`
}

function normalizeTime(value, fallback) {
	const time = Number(value)
	if (!Number.isFinite(time) || time <= 0) return fallback
	if (time > 1e15) return Math.floor(time / 1e6)
	return Math.floor(time)
}

/** 从 content 数组只取正文（type==="text"），reasoning/tool 一律丢掉。 */
function textParts(content) {
	if (typeof content === 'string') return content.trim()
	if (!Array.isArray(content)) return ''
	return content
		.filter((part) => part && part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n')
		.trim()
}

/** tool/call 的 arguments 是 JSON 字符串；解析失败返回 null，不抛。 */
function parseArguments(raw) {
	if (raw && typeof raw === 'object') return raw
	if (typeof raw !== 'string') return null
	const text = raw.trim()
	if (!text) return null
	try {
		const parsed = JSON.parse(text)
		return parsed && typeof parsed === 'object' ? parsed : null
	} catch {
		return null
	}
}

function normalizeOptions(raw) {
	if (!Array.isArray(raw)) return []
	return raw.map((option) => {
		if (typeof option === 'string') return { label: option }
		if (option && typeof option === 'object') {
			return {
				label: String(option.label ?? option.value ?? option.text ?? option.title ?? ''),
				...(typeof option.description === 'string' ? { description: option.description } : {}),
			}
		}
		return { label: String(option) }
	})
}

/** 把 ask 类工具的 arguments 归一成 `{questions:[{question,header,options,multiSelect}]}`。 */
function extractQuestions(args) {
	if (!args) return []
	if (Array.isArray(args.questions)) {
		return args.questions
			.filter((item) => item && typeof item === 'object')
			.map((item) => ({
				question: String(item.question ?? item.prompt ?? item.text ?? ''),
				header: typeof item.header === 'string' ? item.header : '',
				options: normalizeOptions(item.options),
				multiSelect: Boolean(item.multiSelect),
			}))
	}
	// 兼容旧写法：单个 question / prompt / message + 顶层 options。
	const question = String(args.question ?? args.prompt ?? args.message ?? '')
	if (!question && !Array.isArray(args.options)) return []
	return [
		{
			question,
			header: typeof args.header === 'string' ? args.header : '',
			options: normalizeOptions(args.options),
			multiSelect: Boolean(args.multiSelect),
		},
	]
}

function buildQuestionAlert(model, data, time) {
	const callId = data.callId ?? data.id
	if (!callId) return null
	const args = parseArguments(data.arguments)
	const questions = extractQuestions(args)
	const first = questions[0] ?? { question: '', header: '', options: [], multiSelect: false }
	const body =
		questions
			.map((item) => item.question)
			.filter(Boolean)
			.join('\n\n') || (typeof data.arguments === 'string' ? data.arguments : '')
	const titleText = first.header || truncate(first.question, 40)
	const id = `question:${model.sessionId}:${callId}`
	return {
		id,
		kind: 'question',
		status: 'pending',
		sessionId: model.sessionId,
		sessionTitle: model.sessionTitle,
		project: model.project,
		projectPath: model.projectPath,
		title: `需要你回答：${titleText || data.name || '问题'}`,
		body: truncate(body),
		detail: {
			tool: data.name ?? 'ask_user_question',
			options: first.options,
			multiSelect: first.multiSelect,
			callId: String(callId),
			turn: data.turn ?? model.openTurn?.turn ?? null,
		},
		createdAt: time,
		resolvedAt: null,
		resolution: null,
	}
}

function buildApprovalAlert(model, data, time) {
	if (!data.id) return null
	const toolName = String(data.toolName ?? data.tool ?? '工具')
	const id = `approval:${model.sessionId}:${data.id}`
	return {
		id,
		kind: 'approval',
		status: 'pending',
		sessionId: model.sessionId,
		sessionTitle: model.sessionTitle,
		project: model.project,
		projectPath: model.projectPath,
		title: `需要你批准：${toolName}`,
		body: truncate(data.reason ?? data.description ?? ''),
		detail: {
			tool: toolName,
			options: normalizeOptions(data.options),
			...(data.callId ? { callId: String(data.callId) } : {}),
			turn: model.openTurn?.turn ?? null,
		},
		createdAt: time,
		resolvedAt: null,
		resolution: null,
	}
}

function buildTurnAlert(model, turn, kind, time, extra) {
	const id = `${kind}:${model.sessionId}:${turn}`
	return {
		id,
		kind,
		status: 'resolved',
		sessionId: model.sessionId,
		sessionTitle: model.sessionTitle,
		project: model.project,
		projectPath: model.projectPath,
		title: extra.title,
		body: truncate(extra.body),
		detail: extra.detail,
		createdAt: time,
		resolvedAt: time,
		resolution: kind === 'turn-done' ? 'completed' : 'error',
	}
}

function ensureTurn(model, turn, startTime) {
	let record = model.turns.get(turn)
	if (!record) {
		record = { turn, startedAt: startTime, endedAt: null, toolCount: 0 }
		model.turns.set(turn, record)
	}
	return record
}

function sessionLabel(model) {
	return model.sessionTitle || model.project || 'DSH 会话'
}

/**
 * 创建 detector。
 *
 * @param {object} options
 * @param {number} [options.minTurnSeconds] - 多短的 turn 不发 turn-done
 * @param {() => number} [options.now]
 * @param {number} [options.bodyLimit]
 * @param {boolean} [options.includeSubagents] - 默认 false：子 agent 会话整体忽略
 */
export function createDetector({
	minTurnSeconds = 20,
	now = Date.now,
	bodyLimit = BODY_LIMIT,
	includeSubagents = false,
} = {}) {
	const sessions = new Map()

	function modelFor(meta) {
		const sessionId = String(meta.sessionId)
		let model = sessions.get(sessionId)
		if (!model) {
			model = {
				sessionId,
				project: meta.project ?? '',
				projectPath: meta.projectPath ?? '',
				sessionTitle: meta.sessionTitle ?? '',
				openTurn: null,
				turns: new Map(),
				pendings: new Map(),
				currentTurnText: '',
				lastAssistantText: '',
				lastUserText: '',
				lastEventAt: 0,
			}
			sessions.set(sessionId, model)
		}
		if (meta.project) model.project = meta.project
		if (meta.projectPath) model.projectPath = meta.projectPath
		return model
	}

	/**
	 * 消费一个会话的一批新事件。
	 *
	 * @returns {{alerts:object[], resolutions:object[], turnEnds:object[], metaUpdates:object[]}}
	 */
	function consume(meta, entries) {
		// 子 agent 会话默认整体跳过：它们的 approval policy 是 never、turn 结束也不该
		// 打扰用户（否则会出现莫名其妙的「做完了」）。
		if (!includeSubagents && meta?.origin === 'subagent') {
			return { alerts: [], resolutions: [], turnEnds: [], metaUpdates: [] }
		}
		const model = modelFor(meta ?? {})
		const alerts = []
		const resolutions = []
		const turnEnds = []
		const metaUpdates = []
		let titleChanged = false

		for (const entry of entries ?? []) {
			if (!entry || typeof entry.type !== 'string') continue
			const data = entry.data ?? {}
			const time = normalizeTime(entry.time, now())
			if (time > model.lastEventAt) model.lastEventAt = time

			switch (entry.type) {
				case 'turn/start': {
					const turn = Number(data.turn)
					if (!Number.isFinite(turn)) break
					model.openTurn = { turn, startedAt: time }
					model.turns.set(turn, { turn, startedAt: time, endedAt: null, toolCount: 0 })
					model.currentTurnText = ''
					break
				}

				case 'session/title': {
					const title = typeof data.title === 'string' ? data.title.trim() : ''
					if (title && title !== model.sessionTitle) {
						model.sessionTitle = title
						titleChanged = true
					}
					break
				}

				case 'assistant/message': {
					const text = textParts(data.message?.content ?? data.content)
					if (text) {
						model.currentTurnText = text
						model.lastAssistantText = text
					}
					break
				}

				case 'user/message': {
					const text = textParts(data.content)
					if (text) model.lastUserText = text
					break
				}

				case 'tool/call': {
					const turn = Number.isFinite(Number(data.turn)) ? Number(data.turn) : (model.openTurn?.turn ?? null)
					if (turn !== null && Number.isFinite(turn)) ensureTurn(model, turn, time).toolCount += 1
					if (!ASK_TOOL_NAMES.has(data.name)) break
					const alert = buildQuestionAlert(model, data, time)
					if (!alert) break
					if (model.pendings.has(alert.id)) break
					alerts.push(alert)
					model.pendings.set(alert.id, { id: alert.id, kind: 'question', turn: alert.detail.turn })
					break
				}

				case 'tool/result': {
					// 真实形状：data.message.toolCallId / data.message.source.callId；
					// 旧/变体形状：data.toolCallId / data.source.callId。
					const callId =
						data.toolCallId ??
						data.message?.toolCallId ??
						data.message?.source?.callId ??
						data.source?.callId ??
						data.callId
					if (!callId) break
					const id = `question:${model.sessionId}:${callId}`
					if (!model.pendings.has(id)) break
					model.pendings.delete(id)
					resolutions.push({ id, resolution: 'answered', resolvedAt: time })
					break
				}

				case 'approval/asked': {
					const alert = buildApprovalAlert(model, data, time)
					if (!alert) break
					if (model.pendings.has(alert.id)) break
					alerts.push(alert)
					model.pendings.set(alert.id, { id: alert.id, kind: 'approval', turn: alert.detail.turn })
					break
				}

				case 'approval/decided': {
					const id = `approval:${model.sessionId}:${data.id}`
					if (!model.pendings.has(id)) break
					model.pendings.delete(id)
					resolutions.push({ id, resolution: String(data.outcome ?? 'decided'), resolvedAt: time })
					break
				}

				case 'turn/end': {
					const turn = Number.isFinite(Number(data.turn)) ? Number(data.turn) : (model.openTurn?.turn ?? null)
					if (turn === null || !Number.isFinite(turn)) break
					const record = ensureTurn(model, turn, time)
					record.endedAt = time
					const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
					const reasonKind = String(reason.kind ?? 'completed')

					// 该轮的所有 pending 一律视为 resolved（cancelled）。
					for (const [id, pending] of model.pendings) {
						if (pending.turn === turn || pending.turn === null || pending.turn === undefined) {
							model.pendings.delete(id)
							resolutions.push({ id, resolution: 'cancelled', resolvedAt: time })
						}
					}

					turnEnds.push({ sessionId: model.sessionId, turn, reasonKind, at: time })

					const durationSeconds = record.startedAt ? Math.max(0, (time - record.startedAt) / 1000) : 0
					const durationMs = durationSeconds * 1000
					if (reasonKind === 'completed') {
						const qualifies =
							durationMs >= Math.max(0, Number(minTurnSeconds) || 0) * 1000 ||
							record.toolCount >= TURN_DONE_TOOL_THRESHOLD
						if (qualifies) {
							const summary = model.currentTurnText || model.lastUserText
							alerts.push(
								buildTurnAlert(model, turn, 'turn-done', time, {
									title: `已完成 · ${sessionLabel(model)}`,
									body: summary || `第 ${turn} 轮已完成（用时 ${Math.round(durationSeconds)} 秒）`,
									detail: {
										turn,
										durationSeconds: Math.round(durationSeconds),
										toolCount: record.toolCount,
										reasonKind,
									},
								}),
							)
						}
					} else if (reasonKind === 'error') {
						// 真实日志是 reason.error = { message }，直接 String(object) 会得到
						// "[object Object]"（独立验收实测），错误原因就丢了。
						const errorMessage =
							(typeof reason.message === 'string' && reason.message.trim()) ||
							(typeof reason.error === 'string' ? reason.error : '') ||
							(typeof reason.error?.message === 'string' ? reason.error.message : '') ||
							(typeof data.message === 'string' ? data.message : '')
						const message = String(errorMessage ?? '').trim()
						alerts.push(
							buildTurnAlert(model, turn, 'turn-error', time, {
								title: `出错了 · ${sessionLabel(model)}`,
								body: message || `第 ${turn} 轮发生错误`,
								detail: { turn, reasonKind },
							}),
						)
					}
					// aborted：静默，只清理 pending。

					if (model.openTurn?.turn === turn) model.openTurn = null
					break
				}

				default:
					break
			}
		}

		if (titleChanged) {
			metaUpdates.push({ sessionId: model.sessionId, sessionTitle: model.sessionTitle })
		}

		return { alerts, resolutions, turnEnds, metaUpdates }
	}

	return {
		consume,
		/** 某个会话当前（内存里）挂着的 pending 数，测试/诊断用。 */
		getPending: (sessionId) => {
			const model = sessions.get(String(sessionId))
			return model ? [...model.pendings.values()].map((pending) => ({ ...pending })) : []
		},
		getSessionMeta: (sessionId) => {
			const model = sessions.get(String(sessionId))
			if (!model) return null
			return {
				sessionId: model.sessionId,
				sessionTitle: model.sessionTitle,
				project: model.project,
				projectPath: model.projectPath,
				openTurn: model.openTurn,
				lastEventAt: model.lastEventAt,
			}
		},
		reset: () => sessions.clear(),
	}
}
