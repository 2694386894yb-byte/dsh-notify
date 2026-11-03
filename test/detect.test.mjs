import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDetector } from '../lib/detect.mjs'
import { mk } from './_helpers.mjs'

const T = 1_800_000_000_000
const META = { sessionId: 'session-1', project: 'demo', projectPath: '/Users/example/Desktop/demo' }

function makeDetector(overrides = {}) {
	return createDetector({ minTurnSeconds: 20, now: () => T, ...overrides })
}

function feed(detector, ...events) {
	return detector.consume(META, events)
}

const REAL_RESULT = (callId, time) =>
	mk(
		'tool/result',
		{
			turn: 1,
			step: 2,
			message: {
				role: 'tool',
				source: { kind: 'tool', callId },
				toolCallId: callId,
				content: [{ type: 'text', text: '好的' }],
			},
			sourceEventSeqs: [1],
			surfaceOp: 'append',
		},
		time,
	)

describe('detect: approval 待处理 → decided 消失', () => {
	it('approval/asked 产出 pending alert，decided 后 resolve', () => {
		const detector = makeDetector()
		const first = feed(
			detector,
			mk('session/title', { title: '导出课表' }, T - 10),
			mk('turn/start', { turn: 1 }, T),
			mk('approval/asked', { id: 'ap-1', toolName: 'bash', reason: '需要放宽沙箱到 danger-full-access', callId: 'call_1' }, T + 10),
		)

		assert.equal(first.alerts.length, 1)
		const alert = first.alerts[0]
		assert.equal(alert.id, 'approval:session-1:ap-1')
		assert.equal(alert.kind, 'approval')
		assert.equal(alert.status, 'pending')
		assert.equal(alert.title, '需要你批准：bash')
		assert.equal(alert.body, '需要放宽沙箱到 danger-full-access')
		assert.equal(alert.sessionTitle, '导出课表')
		assert.equal(alert.project, 'demo')
		assert.equal(alert.detail.tool, 'bash')
		assert.equal(alert.createdAt, T + 10)
		assert.equal(alert.resolvedAt, null)
		assert.equal(detector.getPending('session-1').length, 1)

		const second = feed(detector, mk('approval/decided', { id: 'ap-1', outcome: 'allowed-once' }, T + 20))
		assert.deepEqual(second.alerts, [])
		assert.deepEqual(second.resolutions, [
			{ id: 'approval:session-1:ap-1', resolution: 'allowed-once', resolvedAt: T + 20 },
		])
		assert.equal(detector.getPending('session-1').length, 0)
	})

	it('重复的 approval/asked 不会产出两条 alert', () => {
		const detector = makeDetector()
		feed(detector, mk('turn/start', { turn: 1 }, T))
		const asked = mk('approval/asked', { id: 'ap-1', toolName: 'bash', reason: 'r' }, T + 10)
		assert.equal(feed(detector, asked).alerts.length, 1)
		assert.equal(feed(detector, asked).alerts.length, 0)
	})
})

describe('detect: question 待处理 → tool/result 消失', () => {
	const ARGS = JSON.stringify({
		questions: [
			{
				id: 'q1',
				header: '选择课程',
				question: '要导出哪门课？',
				options: [
					{ label: '高数', description: '周一早八' },
					{ label: '英语' },
				],
				multiSelect: false,
			},
		],
	})

	it('ask 类 tool/call 无 result 时 pending，真实形状的 tool/result 能匹配（data.message.toolCallId）', () => {
		const detector = makeDetector()
		const call = feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('tool/call', { turn: 1, step: 1, callId: 'call_ask_1', name: 'ask_user_question', arguments: ARGS }, T + 10),
		)

		assert.equal(call.alerts.length, 1)
		const alert = call.alerts[0]
		assert.equal(alert.id, 'question:session-1:call_ask_1')
		assert.equal(alert.kind, 'question')
		assert.equal(alert.status, 'pending')
		assert.equal(alert.title, '需要你回答：选择课程')
		assert.equal(alert.body, '要导出哪门课？')
		assert.equal(alert.detail.tool, 'ask_user_question')
		assert.deepEqual(alert.detail.options, [
			{ label: '高数', description: '周一早八' },
			{ label: '英语' },
		])
		assert.equal(alert.detail.multiSelect, false)

		const resolved = feed(detector, REAL_RESULT('call_ask_1', T + 20))
		assert.deepEqual(resolved.resolutions, [
			{ id: 'question:session-1:call_ask_1', resolution: 'answered', resolvedAt: T + 20 },
		])
		assert.equal(detector.getPending('session-1').length, 0)
	})

	it('兼容 data.toolCallId 旧写法与 data.message.source.callId', () => {
		const detector = makeDetector()
		feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('tool/call', { turn: 1, callId: 'call_a', name: 'ask_user_question', arguments: ARGS }, T + 1),
			mk('tool/call', { turn: 1, callId: 'call_b', name: 'request_user_input', arguments: ARGS }, T + 2),
			mk('tool/call', { turn: 1, callId: 'call_c', name: 'ask_user_question', arguments: ARGS }, T + 3),
		)
		assert.equal(detector.getPending('session-1').length, 3)

		const out = feed(
			detector,
			mk('tool/result', { turn: 1, toolCallId: 'call_a' }, T + 10),
			mk('tool/result', { turn: 1, message: { source: { kind: 'tool', callId: 'call_b' } } }, T + 11),
			mk('tool/result', { turn: 1, message: { toolCallId: 'call_c' } }, T + 12),
		)
		assert.deepEqual(
			out.resolutions.map((item) => item.id).sort(),
			['question:session-1:call_a', 'question:session-1:call_b', 'question:session-1:call_c'],
		)
		assert.equal(detector.getPending('session-1').length, 0)
	})

	it('参数解析失败也不崩，body 退回原始 arguments', () => {
		const detector = makeDetector()
		const out = feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('tool/call', { turn: 1, callId: 'call_x', name: 'ask_user_question', arguments: '{bad json' }, T + 1),
		)
		assert.equal(out.alerts.length, 1)
		assert.equal(out.alerts[0].body, '{bad json')
	})
})

describe('detect: turn/end 语义', () => {
	it('completed 且时长 ≥ minTurnSeconds → turn-done（正文只取 text，排除 reasoning）', () => {
		const detector = makeDetector()
		const out = feed(
			detector,
			mk('session/title', { title: '导出课表' }, T - 10),
			mk('turn/start', { turn: 1 }, T),
			mk(
				'assistant/message',
				{
					message: {
						content: [
							{ type: 'reasoning', text: '这里是不能给用户看的思考过程' },
							{ type: 'text', text: '已经导出到桌面了。' },
						],
					},
				},
				T + 20_000,
			),
			mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, T + 25_000),
		)

		assert.equal(out.alerts.length, 1)
		const alert = out.alerts[0]
		assert.equal(alert.id, 'turn-done:session-1:1')
		assert.equal(alert.kind, 'turn-done')
		assert.equal(alert.status, 'resolved')
		assert.equal(alert.body, '已经导出到桌面了。')
		assert.equal(alert.body.includes('思考过程'), false)
		assert.equal(alert.detail.durationSeconds, 25)
		assert.equal(alert.resolvedAt, T + 25_000)
	})

	it('completed 但太短且工具 < 3 → 不通知', () => {
		const detector = makeDetector()
		const out = feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }, T + 100),
			mk('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' }, T + 200),
			mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, T + 1000),
		)
		assert.equal(out.alerts.length, 0)
	})

	it('completed 很短但工具 ≥ 3 → 仍然 turn-done', () => {
		const detector = makeDetector()
		const out = feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }, T + 100),
			mk('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' }, T + 200),
			mk('tool/call', { turn: 1, callId: 'c3', name: 'read', arguments: '{}' }, T + 300),
			mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, T + 400),
		)
		assert.equal(out.alerts.length, 1)
		assert.equal(out.alerts[0].kind, 'turn-done')
		assert.equal(out.alerts[0].detail.toolCount, 3)
	})

	it('error 总是 turn-error；aborted 静默', () => {
		const detector = makeDetector()
		const errorOut = feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('turn/end', { turn: 1, reason: { kind: 'error', message: '模型调用失败' } }, T + 500),
		)
		assert.equal(errorOut.alerts.length, 1)
		assert.equal(errorOut.alerts[0].kind, 'turn-error')
		assert.equal(errorOut.alerts[0].body, '模型调用失败')

		const abortOut = feed(
			detector,
			mk('turn/start', { turn: 2 }, T + 1000),
			mk('turn/end', { turn: 2, reason: { kind: 'aborted' } }, T + 1500),
		)
		assert.equal(abortOut.alerts.length, 0)
	})

	it('turn 结束时该轮 pending 视为 resolved(cancelled)', () => {
		const detector = makeDetector()
		feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('approval/asked', { id: 'ap-1', toolName: 'bash', reason: 'r' }, T + 10),
			mk('tool/call', { turn: 1, callId: 'call_q', name: 'ask_user_question', arguments: '{}' }, T + 20),
		)
		assert.equal(detector.getPending('session-1').length, 2)

		const out = feed(detector, mk('turn/end', { turn: 1, reason: { kind: 'aborted' } }, T + 1000))
		assert.equal(out.resolutions.length, 2)
		assert.deepEqual(
			out.resolutions.map((item) => item.resolution),
			['cancelled', 'cancelled'],
		)
		assert.equal(detector.getPending('session-1').length, 0)
	})
})

describe('detect: 子 agent 会话', () => {
	const subMeta = { sessionId: 'sub-1', project: 'demo', projectPath: '/Users/example/Desktop/demo', origin: 'subagent' }
	const subEvents = () => [
		mk('turn/start', { turn: 1 }, T),
		mk('approval/asked', { id: 'ap-sub', toolName: 'bash', reason: '子 agent 内部批准' }, T + 10),
		mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, T + 31_000),
		mk('turn/start', { turn: 2 }, T + 40_000),
		mk('turn/end', { turn: 2, reason: { kind: 'error', message: '子 agent 出错' } }, T + 41_000),
	]

	it('默认整体跳过：不 pending、不 done、不 error', () => {
		const detector = makeDetector()
		const out = detector.consume(subMeta, subEvents())
		assert.deepEqual(out, { alerts: [], resolutions: [], turnEnds: [], metaUpdates: [] })
		assert.equal(detector.getPending('sub-1').length, 0)
	})

	it('includeSubagents:true 时才纳入', () => {
		const detector = makeDetector({ includeSubagents: true })
		const out = detector.consume(subMeta, subEvents())
		assert.deepEqual(out.alerts.map((alert) => alert.kind).sort(), ['approval', 'turn-done', 'turn-error'])
		// approval 会在该轮结束时被 cancelled（daemon 层随后 resolve 掉）。
		assert.equal(out.resolutions.some((item) => item.id.includes('ap-sub') && item.resolution === 'cancelled'), true)
	})
})

describe('detect: 会话标题与 meta', () => {
	it('标题变化产出 metaUpdates，供 daemon 回刷已建 alert', () => {
		const detector = makeDetector()
		const first = feed(
			detector,
			mk('turn/start', { turn: 1 }, T),
			mk('approval/asked', { id: 'ap-1', toolName: 'bash', reason: 'r' }, T + 10),
			mk('session/title', { title: '导出课表' }, T + 20),
		)
		assert.equal(first.alerts[0].sessionTitle, '')
		assert.deepEqual(first.metaUpdates, [{ sessionId: 'session-1', sessionTitle: '导出课表' }])
		assert.equal(detector.getSessionMeta('session-1').sessionTitle, '导出课表')
	})
})
