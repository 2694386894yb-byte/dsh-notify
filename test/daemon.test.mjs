import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { loadConfig } from '../lib/config.mjs'
import { createDaemon } from '../lib/daemon.mjs'
import { createStateStore } from '../lib/state.mjs'
import {
	fakeDesktop,
	fakeWechat,
	makeConfig,
	makeSandbox,
	mk,
	openLog,
	readStateFile,
	sessionHeader,
	silentLogger,
} from './_helpers.mjs'

const sandboxes = []
function sandbox(label) {
	const item = makeSandbox(`daemon-${label}`)
	sandboxes.push(item)
	return item
}
const running = []
afterEach(async () => {
	while (running.length > 0) {
		try {
			await running.pop().stop()
		} catch {
			/* 忽略 */
		}
	}
	while (sandboxes.length > 0) sandboxes.pop().cleanup()
})

function setup(sb, { configOverrides = {}, wechat, desktop } = {}) {
	const clock = { value: Date.now() }
	const wechatChannel = wechat ?? fakeWechat()
	const desktopChannel = desktop ?? fakeDesktop()
	const config = makeConfig(sb, configOverrides)
	const daemon = createDaemon({
		config,
		channels: { wechat: wechatChannel },
		logger: silentLogger(),
		desktop: desktopChannel,
		now: () => clock.value,
	})
	running.push(daemon)
	return { daemon, config, wechat: wechatChannel, desktop: desktopChannel, clock }
}

function seedApproval(log, time) {
	log.entries(
		mk('session/title', { title: '导出课表' }, time - 100),
		mk('turn/start', { turn: 1 }, time),
		mk('approval/asked', { id: 'ap-1', toolName: 'bash', reason: '需要放宽沙箱到 danger-full-access' }, time + 10),
	)
}

describe('daemon: approval 生命周期', () => {
	it('tick 产出 pending alert 并通知桌面+微信；decided 后消失且不重复通知', async () => {
		const sb = sandbox('approval')
		const { daemon, wechat, desktop, clock } = setup(sb)
		const log = openLog(sb)
		seedApproval(log, clock.value - 1000)

		const first = await daemon.tick()
		assert.equal(first.initial, true)
		assert.equal(first.newAlerts, 1)

		const state = daemon.getState()
		assert.equal(state.pending.length, 1)
		const alert = state.pending[0]
		assert.equal(alert.id, 'approval:session-demo-1:ap-1')
		assert.equal(alert.kind, 'approval')
		assert.equal(alert.status, 'pending')
		assert.equal(alert.title, '需要你批准：bash')
		assert.equal(alert.sessionTitle, '导出课表')
		assert.equal(alert.project, 'demo')
		assert.equal(alert.notified.desktop, true)
		assert.equal(alert.notified.wechat, true)
		assert.equal(wechat.sends.length, 1)
		assert.match(wechat.sends[0].text, /需要你批准：bash/)
		assert.match(wechat.sends[0].text, /会话：导出课表/)
		assert.equal(wechat.sends[0].kind, 'approval')
		assert.equal(wechat.sends[0].alertId, alert.id)
		assert.equal(desktop.delivered.length, 1)

		// 幂等：没有新事件时再 tick 不重复通知。
		const second = await daemon.tick()
		assert.equal(second.newAlerts, 0)
		assert.equal(wechat.sends.length, 1)
		assert.equal(desktop.delivered.length, 1)

		log.entries(mk('approval/decided', { id: 'ap-1', outcome: 'allowed-once' }, clock.value + 20))
		const third = await daemon.tick()
		assert.equal(third.resolvedAlerts, 1)
		const after = daemon.getState()
		assert.equal(after.pending.length, 0)
		assert.equal(after.recentDone.length, 0, 'resolved 的 approval 不进 recentDone（避免挂件当新 alert 再弹）')
		const stored = daemon.stateStore.get(alert.id)
		assert.equal(stored.status, 'resolved')
		assert.equal(stored.resolution, 'allowed-once')
		assert.equal(wechat.sends.length, 1, 'resolved 不应该再发通知')
	})
})

describe('daemon: question（真实 tool/result 形状）', () => {
	it('无 result 时 pending；data.message.toolCallId 匹配后消失', async () => {
		const sb = sandbox('question')
		const { daemon, wechat, desktop, clock } = setup(sb)
		const log = openLog(sb)
		const args = JSON.stringify({
			questions: [{ header: '选课程', question: '导出哪门课？', options: [{ label: '高数' }], multiSelect: false }],
		})
		log.entries(
			mk('session/title', { title: '导课件' }, clock.value - 1010),
			mk('turn/start', { turn: 1 }, clock.value - 1000),
			mk('tool/call', { turn: 1, step: 1, callId: 'call_ask_1', name: 'ask_user_question', arguments: args }, clock.value - 990),
		)
		await daemon.tick()
		let state = daemon.getState()
		assert.equal(state.pending.length, 1)
		assert.equal(state.pending[0].id, 'question:session-demo-1:call_ask_1')
		assert.equal(state.pending[0].title, '需要你回答：选课程')
		// 默认 channels.wechat.events 不含 question：微信不推，桌面/挂件照常。
		assert.equal(wechat.sends.length, 0, 'question 默认不推微信')
		assert.equal(desktop.delivered.length, 1)
		assert.equal(desktop.delivered[0].alert.kind, 'question')

		log.entries(
			mk(
				'tool/result',
				{
					turn: 1,
					step: 1,
					message: {
						role: 'tool',
						source: { kind: 'tool', callId: 'call_ask_1' },
						toolCallId: 'call_ask_1',
						content: [{ type: 'text', text: '高数' }],
					},
				},
				clock.value - 900,
			),
		)
		await daemon.tick()
		state = daemon.getState()
		assert.equal(state.pending.length, 0)
		assert.equal(state.recentDone.length, 0, '答过的 question 不进 recentDone')
		const stored = daemon.stateStore.get('question:session-demo-1:call_ask_1')
		assert.equal(stored.status, 'resolved')
		assert.equal(stored.resolution, 'answered')
	})
})

describe('daemon: turn 结束语义', () => {
	it('completed（够长）→ turn-done；error → turn-error；aborted → 静默', async () => {
		const sb = sandbox('turns')
		const { daemon, wechat, clock } = setup(sb)

		// 先跑一次启动扫描（初始回放不通知历史 turn），再追加事件走「实时」路径。
		const done = openLog(sb, { sessionId: 'session-done' })
		const errorLog = openLog(sb, { sessionId: 'session-error' })
		const aborted = openLog(sb, { sessionId: 'session-aborted' })
		await daemon.tick()
		assert.equal(wechat.sends.length, 0)

		done.entries(
			mk('session/title', { title: '导出课表' }, clock.value - 31_000),
			mk('turn/start', { turn: 1 }, clock.value - 30_000),
			mk('assistant/message', { message: { content: [{ type: 'text', text: '导出完成。' }] } }, clock.value - 6000),
			mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, clock.value - 5000),
		)
		errorLog.entries(
			mk('turn/start', { turn: 1 }, clock.value - 3000),
			mk('turn/end', { turn: 1, reason: { kind: 'error', message: '模型调用失败' } }, clock.value - 2000),
		)
		aborted.entries(
			mk('turn/start', { turn: 1 }, clock.value - 3000),
			mk('turn/end', { turn: 1, reason: { kind: 'aborted' } }, clock.value - 1000),
		)

		await daemon.tick()
		const state = daemon.getState()
		assert.equal(state.pending.length, 0)
		const kinds = state.recentDone.map((alert) => alert.kind).sort()
		assert.deepEqual(kinds, ['turn-done', 'turn-error'])
		const doneAlert = state.recentDone.find((alert) => alert.kind === 'turn-done')
		assert.equal(doneAlert.body, '导出完成。')
		const errorAlert = state.recentDone.find((alert) => alert.kind === 'turn-error')
		assert.equal(errorAlert.body, '模型调用失败')
		assert.equal(wechat.sends.length, 2)
		assert.equal(wechat.sends.some((send) => send.text.includes('aborted')), false)
	})
})

describe('daemon: 启动回放只重建 pending', () => {
	it('启动时历史 turn/end（completed/error）不落 done、不通知；启动后新增的恰好多 1 条', async () => {
		const sb = sandbox('startup-replay')
		const { daemon, wechat, clock } = setup(sb)
		const log = openLog(sb)
		log.entries(
			mk('session/title', { title: '历史会话' }, clock.value - 61_000),
			mk('turn/start', { turn: 1 }, clock.value - 60_000),
			mk('assistant/message', { message: { content: [{ type: 'text', text: '历史完成' }] } }, clock.value - 40_000),
			mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, clock.value - 30_000),
			mk('turn/start', { turn: 2 }, clock.value - 20_000),
			mk('turn/end', { turn: 2, reason: { kind: 'error', message: '历史错误' } }, clock.value - 10_000),
		)

		await daemon.tick()
		let state = daemon.getState()
		assert.equal(state.pending.length, 0)
		assert.deepEqual(state.recentDone, [], '启动回放不该把历史 turn 变成 recentDone')
		assert.equal(wechat.sends.length, 0, '启动回放不该推送历史 turn')
		assert.equal(daemon.stateStore.size(), 0, '历史 turn 不应该落库')

		log.entries(
			mk('turn/start', { turn: 3 }, clock.value - 26_000),
			mk('assistant/message', { message: { content: [{ type: 'text', text: '刚刚做完' }] } }, clock.value - 2000),
			mk('turn/end', { turn: 3, reason: { kind: 'completed' } }, clock.value - 1000),
		)
		await daemon.tick()
		state = daemon.getState()
		assert.equal(state.recentDone.length, 1)
		assert.equal(state.recentDone[0].id, 'turn-done:session-demo-1:3')
		assert.equal(wechat.sends.length, 1)
		assert.match(wechat.sends[0].text, /刚刚做完|已完成/)
	})
})

describe('daemon: 子 agent 会话默认忽略', () => {
	const SUB_ID = '2dfb8e42-1c9e-4b4d-8a3e-0123456789ab'

	function seedSubagent(sb) {
		const sub = openLog(sb, { sessionId: SUB_ID })
		sub.entries(sessionHeader(SUB_ID, { origin: 'subagent', parentSession: 'session-main', delegationDepth: 1 }))
		return sub
	}

	function appendSubagentEvents(sub, clock, { turn = 2 } = {}) {
		sub.entries(
			mk('session/title', { title: '子 agent 会话' }, clock.value - 32_000),
			mk('turn/start', { turn }, clock.value - 31_000),
			mk('approval/asked', { id: `ap-sub-${turn}`, toolName: 'bash', reason: '子 agent 内部批准' }, clock.value - 30_000),
			mk('turn/end', { turn, reason: { kind: 'completed' } }, clock.value - 5000),
			mk('turn/start', { turn: turn + 1 }, clock.value - 3000),
			mk('turn/end', { turn: turn + 1, reason: { kind: 'error', message: '子 agent 出错' } }, clock.value - 1000),
		)
	}

	it('默认：子 agent 的 pending/done/error 全部不产生、不推送、不进 recentDone/统计', async () => {
		const sb = sandbox('subagent-default')
		const { daemon, wechat, desktop, clock } = setup(sb)
		const sub = seedSubagent(sb)
		appendSubagentEvents(sub, clock)

		await daemon.tick()
		const state = daemon.getState()
		assert.deepEqual(state.pending, [])
		assert.deepEqual(state.recentDone, [])
		assert.deepEqual(state.counts, { pending: 0, todayDone: 0 })
		assert.equal(wechat.sends.length, 0)
		assert.equal(desktop.delivered.length, 0)
		assert.equal(daemon.stateStore.size(), 0)

		// 启动后子 agent 又结束一轮，也不该推送。
		sub.entries(
			mk('turn/start', { turn: 4 }, clock.value - 26_000),
			mk('turn/end', { turn: 4, reason: { kind: 'completed' } }, clock.value - 1000),
		)
		await daemon.tick()
		assert.deepEqual(daemon.getState().recentDone, [])
		assert.equal(wechat.sends.length, 0)
	})

	it('notify.includeSubagents=true 时才纳入', async () => {
		const sb = sandbox('subagent-included')
		const { daemon, wechat, clock } = setup(sb, { configOverrides: { notify: { includeSubagents: true } } })
		const sub = seedSubagent(sb)
		// 先跑启动扫描（初始回放不落 done），再追加事件走实时路径。
		await daemon.tick()
		appendSubagentEvents(sub, clock)
		await daemon.tick()
		const state = daemon.getState()
		assert.deepEqual(state.recentDone.map((alert) => alert.kind).sort(), ['turn-done', 'turn-error'])
		assert.equal(state.recentDone.every((alert) => alert.sessionId === SUB_ID), true)
		assert.equal(wechat.sends.length, 2, 'turn-done + turn-error 都属于微信默认事件')
	})

	it('清理历史遗留的子 agent alert（只清子 agent，不动主会话）', async () => {
		const sb = sandbox('subagent-cleanup')
		seedSubagent(sb)
		const store = createStateStore({ dir: sb.stateDir, now: () => Date.now(), logger: silentLogger() })
		const at = Date.now() - 1000
		store.upsertMany([
			{
				id: `turn-done:${SUB_ID}:2`,
				kind: 'turn-done',
				status: 'resolved',
				sessionId: SUB_ID,
				title: '已完成 · 子 agent 会话',
				createdAt: at,
				resolvedAt: at,
			},
			{
				id: 'turn-done:session-main:1',
				kind: 'turn-done',
				status: 'resolved',
				sessionId: 'session-main',
				title: '已完成 · 主会话',
				createdAt: at,
				resolvedAt: at,
			},
		])
		store.save()

		const { daemon } = setup(sb)
		await daemon.tick()
		const ids = daemon.getState().recentDone.map((alert) => alert.id)
		assert.equal(ids.includes(`turn-done:${SUB_ID}:2`), false)
		assert.equal(ids.includes('turn-done:session-main:1'), true)
		assert.equal(daemon.stateStore.get(`turn-done:${SUB_ID}:2`), null)
	})
})

describe('daemon: 微信事件过滤', () => {
	function seedQuestion(sb, clock) {
		const args = JSON.stringify({ questions: [{ header: '选课程', question: '导出哪门课？', options: [{ label: '高数' }] }] })
		openLog(sb).entries(
			mk('turn/start', { turn: 1 }, clock.value - 100),
			mk('tool/call', { turn: 1, step: 1, callId: 'call_q1', name: 'ask_user_question', arguments: args }, clock.value - 50),
		)
	}

	it('question：微信不推、桌面照发；配置 ["*"] 时微信也推', async () => {
		const sb = sandbox('wechat-filter-question')
		const first = setup(sb)
		seedQuestion(sb, first.clock)
		await first.daemon.tick()
		assert.equal(first.wechat.sends.length, 0, '默认不含 question')
		assert.equal(first.desktop.delivered.length, 1)
		assert.equal(first.desktop.delivered[0].alert.kind, 'question')
		await first.daemon.stop()

		const sbAll = sandbox('wechat-filter-all')
		const all = setup(sbAll, { configOverrides: { channels: { wechat: { events: ['*'] } } } })
		seedQuestion(sbAll, all.clock)
		await all.daemon.tick()
		assert.equal(all.wechat.sends.length, 1)
		assert.match(all.wechat.sends[0].text, /需要你回答：选课程/)
	})

	it('approval 与 turn-done 仍然推微信', async () => {
		const sb = sandbox('wechat-filter-approval')
		const { daemon, wechat, clock } = setup(sb)
		seedApproval(openLog(sb, { sessionId: 'session-approval' }), clock.value - 1000)
		await daemon.tick()
		assert.equal(wechat.sends.length, 1)
		assert.equal(wechat.sends[0].kind, 'approval')

		const doneLog = openLog(sb, { sessionId: 'session-done' })
		doneLog.entries(
			mk('turn/start', { turn: 1 }, clock.value - 30_000),
			mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, clock.value - 5000),
		)
		await daemon.tick()
		assert.equal(wechat.sends.length, 2)
		assert.equal(wechat.sends[1].kind, 'turn-done')
	})

	it('question 的升级提醒也不走微信，但桌面仍收到', async () => {
		const sb = sandbox('wechat-filter-escalation')
		const { daemon, wechat, desktop, clock } = setup(sb, {
			configOverrides: { notify: { escalateAfterSeconds: [1] } },
		})
		seedQuestion(sb, clock)
		await daemon.tick()
		assert.equal(wechat.sends.length, 0)
		assert.equal(desktop.delivered.length, 1)

		clock.value += 1500
		await daemon.tick()
		assert.equal(wechat.sends.length, 0, 'question 的升级提醒也不能走微信')
		assert.equal(desktop.delivered.length, 2, '桌面/挂件仍然升级提醒')
		assert.equal(daemon.getState().pending[0].escalatedAt.length, 1)
	})
})

describe('daemon: 重启去重', () => {
	it('重启后回放历史不重复通知 pending，也不重复通知已完成的 turn', async () => {
		const sb = sandbox('restart')
		const first = setup(sb)
		const log = openLog(sb)
		seedApproval(log, first.clock.value - 1000)
		await first.daemon.tick()
		assert.equal(first.wechat.sends.length, 1)
		await first.daemon.stop()

		const second = setup(sb)
		await second.daemon.tick()
		assert.equal(second.wechat.sends.length, 0, '重启后不能重复通知')
		assert.equal(second.desktop.delivered.length, 0)
		assert.equal(second.daemon.getState().pending.length, 1)
	})

	it('持久化状态丢失时，仍 pending 的 approval 会补一条「仍在等待」', async () => {
		const sb = sandbox('restart-lost')
		const first = setup(sb)
		const log = openLog(sb)
		seedApproval(log, first.clock.value - 1000)
		await first.daemon.tick()
		await first.daemon.stop()

		// 模拟状态文件被删（首次部署 / 清状态）。
		const statePath = join(sb.stateDir, 'state.json')
		assert.equal(existsSync(statePath), true)
		writeFileSync(statePath, '{"version":1,"alerts":[]}\n')

		const second = setup(sb)
		await second.daemon.tick()
		assert.equal(second.wechat.sends.length, 1)
		assert.match(second.wechat.sends[0].text, /仍在等待/)
		const alert = second.daemon.getState().pending[0]
		assert.equal(alert.detail.stillWaiting, true)
	})
})

describe('daemon: 升级提醒', () => {
	it('pending 超过 escalateAfterSeconds 再提醒一次（最多 len 次）', async () => {
		const sb = sandbox('escalate')
		const { daemon, wechat, clock } = setup(sb, { configOverrides: { notify: { escalateAfterSeconds: [1] } } })
		const log = openLog(sb)
		seedApproval(log, clock.value - 200)

		await daemon.tick()
		assert.equal(wechat.sends.length, 1)

		clock.value += 1500
		await daemon.tick()
		assert.equal(wechat.sends.length, 2)
		assert.match(wechat.sends[1].text, /再次提醒 1\/1/)
		assert.equal(daemon.getState().pending[0].escalatedAt.length, 1)

		// 超过阈值次数后不再提醒。
		clock.value += 60_000
		await daemon.tick()
		assert.equal(wechat.sends.length, 2)
	})
})

describe('daemon: 安静时段', () => {
	it('turn-done 在安静时段只写状态不推送；approval 照常通知', async () => {
		const sb = sandbox('quiet')
		const { daemon, wechat, clock } = setup(sb, {
			configOverrides: { notify: { quietHours: { start: '00:00', end: '23:59' } } },
		})
		const approvalLog = openLog(sb, { sessionId: 'session-approval' })
		seedApproval(approvalLog, clock.value - 1000)
		await daemon.tick()
		assert.equal(wechat.sends.length, 1, 'approval 无视安静时段')

		const doneLog = openLog(sb, { sessionId: 'session-quiet-done' })
		doneLog.entries(
			mk('session/title', { title: '安静时段完成' }, clock.value - 31_000),
			mk('turn/start', { turn: 1 }, clock.value - 30_000),
			mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, clock.value - 5000),
		)
		await daemon.tick()
		assert.equal(wechat.sends.length, 1, '安静时段 turn-done 不推送')
		const doneAlert = daemon.getState().recentDone.find((alert) => alert.kind === 'turn-done')
		assert.ok(doneAlert, 'turn-done 仍应写进状态')
	})
})

describe('daemon: once / 容错 / 生命周期', () => {
	it('tick({notify:false}) 只扫不发、不落盘；getState 能看到结果', async () => {
		const sb = sandbox('once')
		const { daemon, wechat } = setup(sb)
		const log = openLog(sb)
		seedApproval(log, Date.now() - 1000)
		const summary = await daemon.tick({ notify: false })
		assert.equal(summary.newAlerts, 1)
		assert.equal(wechat.sends.length, 0)
		assert.equal(existsSync(join(sb.stateDir, 'state.json')), false)
		assert.equal(daemon.getState().pending.length, 1)
	})

	it('坏日志（无 zstd 帧）不会拖垮整次扫描', async () => {
		const sb = sandbox('badlog')
		const { daemon } = setup(sb)
		seedApproval(openLog(sb, { sessionId: 'session-good' }), Date.now() - 1000)
		const bad = openLog(sb, { sessionId: 'session-bad' })
		writeFileSync(bad.file, Buffer.from([1, 2, 3, 4, 5, 6]))
		const summary = await daemon.tick()
		assert.equal(summary.newAlerts, 1)
		assert.equal(daemon.getState().pending.length, 1)
	})

	it('lookback 之外的老会话不解析（不会把几天前的 approval 翻出来）', async () => {
		const sb = sandbox('old-session')
		const { daemon } = setup(sb)
		const log = openLog(sb, { sessionId: 'session-old' })
		seedApproval(log, Date.now() - 3 * 3600 * 1000)
		log.touch(Date.now() - 3 * 3600 * 1000)
		await daemon.tick()
		assert.equal(daemon.getState().pending.length, 0)
	})

	it('start()/stop() 起 HTTP、跑扫描；health 形状正确', async () => {
		const sb = sandbox('lifecycle')
		const { daemon } = setup(sb, { configOverrides: { server: { port: 0 } } })
		seedApproval(openLog(sb), Date.now() - 1000)
		await daemon.start()
		assert.equal(daemon.started, true)
		const health = daemon.health()
		assert.equal(health.ok, true)
		assert.equal(typeof health.uptimeMs, 'number')
		assert.equal(health.watcher.sessions, 1)
		assert.equal(typeof health.watcher.lastScanAt, 'number')
		assert.equal(health.server.listening, true)
		assert.equal(typeof health.server.port, 'number')
		assert.ok(daemon.address())
		assert.equal(daemon.getState().pending.length, 1)
		await daemon.stop()
		assert.equal(daemon.started, false)
	})

	it('配置路径全部来自 loadConfig（DSH_NOTIFY_STATE_DIR / DSH_NOTIFY_SESSIONS）', () => {
		const sb = sandbox('env')
		const previous = { ...process.env }
		try {
			process.env.DSH_NOTIFY_STATE_DIR = sb.stateDir
			process.env.DSH_NOTIFY_SESSIONS = sb.sessionsRoot
			process.env.DSH_NOTIFY_CONFIG = join(sb.root, 'missing-config.json')
			const config = loadConfig()
			assert.equal(config.stateDir, sb.stateDir)
			assert.equal(config.sessions.root, sb.sessionsRoot)
			assert.equal(config.server.port, 19400)
			assert.deepEqual(config.channels.wechat.events, ['approval', 'turn-done', 'turn-error'])
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in previous)) delete process.env[key]
			}
			Object.assign(process.env, previous)
		}
	})

	it('/test 注入 demo pending alert，并从 state 里自动移除', async () => {
		const sb = sandbox('demo')
		const { daemon, wechat, clock } = setup(sb, { configOverrides: { test: { demoAlertTtlMs: 60 } } })
		const before = await daemon.test({ title: '自检标题', body: '自检正文' })
		assert.equal(before.ok, true)
		assert.match(before.demoAlertId, /^demo:/)
		const pending = daemon.getState().pending
		const demo = pending.find((alert) => alert.id === before.demoAlertId)
		assert.ok(demo)
		assert.equal(demo.kind, 'question')
		assert.equal(demo.project, '通知自检')
		assert.equal(demo.sessionTitle, '端到端测试')
		assert.equal(demo.title, '自检标题')
		assert.equal(demo.body, '自检正文')
		assert.equal(before.desktop.mode, 'osascript')
		assert.equal(wechat.sends.length, 1)
		assert.equal(wechat.sends[0].kind, 'question')

		await new Promise((resolve) => setTimeout(resolve, 150))
		const after = daemon.getState()
		assert.equal(after.pending.some((alert) => alert.id === before.demoAlertId), false)
		assert.equal(after.recentDone.some((alert) => alert.id === before.demoAlertId), false)
		void clock
	})

	it('重启后补发「上次没通知成功」的通道（notified.wechat=false 的 pending）', async () => {
		const sb = sandbox('retry-missed')
		const first = setup(sb, { wechat: fakeWechat({ mode: 'not-bound' }) })
		const log = openLog(sb)
		seedApproval(log, first.clock.value - 1000)
		await first.daemon.tick()
		const alert = first.daemon.getState().pending[0]
		assert.equal(alert.notified.wechat, false)
		await first.daemon.stop()

		const second = setup(sb)
		await second.daemon.tick()
		assert.equal(second.wechat.sends.length, 1, '重启应把没发成功的微信补一次')
		assert.match(second.wechat.sends[0].text, /仍在等待/)
		assert.equal(second.daemon.getState().pending[0].notified.wechat, true)

		const third = setup(sb)
		await third.daemon.tick()
		assert.equal(third.wechat.sends.length, 0, '都通知过之后不再重复')
	})

	it('stop() 会清掉还没到 TTL 的 demo alert', async () => {
		const sb = sandbox('demo-stop')
		const { daemon } = setup(sb)
		const demo = await daemon.test({})
		assert.equal(daemon.getState().pending.some((alert) => alert.id === demo.demoAlertId), true)
		await daemon.stop()
		assert.equal(daemon.getState().pending.some((alert) => alert.id === demo.demoAlertId), false)
	})

	it('start() 清理上个进程遗留的 demo alert', async () => {
		const sb = sandbox('demo-stale')
		const store = createStateStore({ dir: sb.stateDir, now: () => Date.now(), logger: silentLogger() })
		store.upsertMany([
			{
				id: 'demo:1700000000000',
				kind: 'question',
				status: 'pending',
				title: '遗留测试',
				body: '',
				project: '通知自检',
				sessionTitle: '端到端测试',
				createdAt: Date.now(),
			},
		])
		store.save()
		const { daemon } = setup(sb)
		await daemon.start()
		assert.equal(daemon.getState().pending.some((alert) => alert.id.startsWith('demo:')), false)
	})

	it('ack(approvalId) 标记 resolved；ack(demo) 直接删除', async () => {
		const sb = sandbox('ack')
		const { daemon } = setup(sb)
		seedApproval(openLog(sb), Date.now() - 1000)
		await daemon.tick()
		const approvalId = daemon.getState().pending[0].id
		const acked = daemon.ack(approvalId)
		assert.equal(acked.ok, true)
		assert.equal(acked.alert.resolution, 'acknowledged')
		assert.equal(daemon.getState().pending.length, 0)

		const demo = await daemon.test({})
		const removed = daemon.ack(demo.demoAlertId)
		assert.equal(removed.ok, true)
		assert.equal(removed.removed, true)
		assert.equal(removed.id, demo.demoAlertId)
		assert.equal(daemon.ack('nope:1').ok, false)
	})
})
