import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'

import { createStateStore, isQuietHours, parseClock } from '../lib/state.mjs'
import { makeSandbox, silentLogger } from './_helpers.mjs'

const sandboxes = []
function sandbox(label) {
	const item = makeSandbox(`state-${label}`)
	sandboxes.push(item)
	return item
}
afterEach(() => {
	while (sandboxes.length > 0) sandboxes.pop().cleanup()
})

function makeStore(sandbox, { clock = { value: 1_800_000_000_000 }, ...options } = {}) {
	const store = createStateStore({
		dir: sandbox.stateDir,
		now: () => clock.value,
		logger: silentLogger(),
		...options,
	})
	return { store, clock }
}

function draft(id, overrides = {}) {
	return {
		id,
		kind: 'approval',
		status: 'pending',
		sessionId: 'session-1',
		sessionTitle: '导出课表',
		project: 'demo',
		projectPath: '/Users/example/Desktop/demo',
		title: '需要你批准：bash',
		body: '原因',
		detail: { tool: 'bash', turn: 1 },
		createdAt: 1_800_000_000_000,
		...overrides,
	}
}

describe('state: 去重 / 持久化 / resolve', () => {
	it('同 id 只新建一次，已存在不覆盖状态', () => {
		const sb = sandbox('dedupe')
		const { store } = makeStore(sb)
		const first = store.upsertMany([draft('approval:session-1:ap-1')])
		assert.equal(first.length, 1)
		assert.deepEqual(first[0].notified, { desktop: false, wechat: false })
		assert.deepEqual(first[0].escalatedAt, [])

		store.markNotified('approval:session-1:ap-1', 'wechat', 1_800_000_000_500)
		const second = store.upsertMany([draft('approval:session-1:ap-1')])
		assert.equal(second.length, 0)
		assert.equal(store.get('approval:session-1:ap-1').notified.wechat, true)
		assert.equal(store.pending().length, 1)
	})

	it('保存后新 store 能读回（含 notified/escalatedAt）', () => {
		const sb = sandbox('persist')
		const { store } = makeStore(sb)
		store.upsertMany([draft('approval:session-1:ap-1')])
		store.markNotified('approval:session-1:ap-1', 'desktop', 1_800_000_000_100)
		store.markEscalated('approval:session-1:ap-1', 1_800_000_000_200)
		store.save()
		assert.equal(existsSync(store.statePath), true)

		const { store: reloaded } = makeStore(sb)
		const alert = reloaded.get('approval:session-1:ap-1')
		assert.ok(alert)
		assert.equal(alert.status, 'pending')
		assert.equal(alert.notified.desktop, true)
		assert.deepEqual(alert.escalatedAt, [1_800_000_000_200])
		assert.equal(reloaded.pending().length, 1)
	})

	it('resolve 只对 pending 生效；重复 resolve 返回 null', () => {
		const sb = sandbox('resolve')
		const { store } = makeStore(sb)
		store.upsertMany([draft('approval:session-1:ap-1')])
		const alert = store.resolve('approval:session-1:ap-1', { resolution: 'allowed-once', resolvedAt: 1_800_000_000_900 })
		assert.equal(alert.status, 'resolved')
		assert.equal(alert.resolution, 'allowed-once')
		assert.equal(alert.resolvedAt, 1_800_000_000_900)
		assert.equal(store.resolve('approval:session-1:ap-1', { resolution: 'rejected' }), null)
		assert.equal(store.pending().length, 0)
	})

	it('损坏的 state.json 不崩，按空状态继续', () => {
		const sb = sandbox('corrupt')
		writeFileSync(`${sb.stateDir}/state.json`, '{not json')
		const { store } = makeStore(sb)
		assert.equal(store.size(), 0)
		store.upsertMany([draft('x:1')])
		assert.equal(store.size(), 1)
	})
})

describe('state: 升级提醒', () => {
	it('按 escalateAfterSeconds 逐级到期，每级只提醒一次', () => {
		const sb = sandbox('escalate')
		const clock = { value: 1_800_000_000_000 }
		const { store } = makeStore(sb, { clock })
		store.upsertMany([draft('approval:session-1:ap-1')])

		assert.equal(store.dueEscalations([1, 3], clock.value).length, 0)
		clock.value += 1000
		let due = store.dueEscalations([1, 3], clock.value)
		assert.equal(due.length, 1)
		store.markEscalated(due[0].id, clock.value)

		clock.value += 1000
		assert.equal(store.dueEscalations([1, 3], clock.value).length, 0, '第二级还没到')
		clock.value += 2000
		due = store.dueEscalations([1, 3], clock.value)
		assert.equal(due.length, 1)
		store.markEscalated(due[0].id, clock.value)

		clock.value += 60_000
		assert.equal(store.dueEscalations([1, 3], clock.value).length, 0, '最多 len(thresholds) 次')
	})

	it('resolved 的 alert 不会再升级', () => {
		const sb = sandbox('escalate-resolved')
		const clock = { value: 1_800_000_000_000 }
		const { store } = makeStore(sb, { clock })
		store.upsertMany([draft('approval:session-1:ap-1')])
		store.resolve('approval:session-1:ap-1', { resolution: 'cancelled' })
		clock.value += 60_000
		assert.equal(store.dueEscalations([1], clock.value).length, 0)
	})

	it('启动时消费停机期间已过期的阈值，避免连发', () => {
		const sb = sandbox('escalate-catchup')
		const clock = { value: 1_800_000_000_000 }
		const { store } = makeStore(sb, { clock })
		store.upsertMany([draft('approval:session-1:ap-1')])
		clock.value += 10_000
		const touched = store.consumeOverdueEscalations([1, 2, 3], clock.value)
		assert.deepEqual(touched, ['approval:session-1:ap-1'])
		assert.equal(store.get('approval:session-1:ap-1').escalatedAt.length, 3)
		assert.equal(store.dueEscalations([1, 2, 3], clock.value).length, 0)
	})
})

describe('state: 裁剪 / recentDone / counts', () => {
	it('7 天前的 resolved 被裁掉，pending 永远保留', () => {
		const sb = sandbox('prune-age')
		const clock = { value: 1_800_000_000_000 }
		const { store } = makeStore(sb, { clock })
		store.upsertMany([
			draft('approval:session-1:old', { status: 'resolved', resolvedAt: clock.value }),
			draft('approval:session-1:still'),
		])
		clock.value += 8 * 24 * 3600 * 1000
		assert.equal(store.prune(), 1)
		assert.equal(store.get('approval:session-1:old'), null)
		assert.ok(store.get('approval:session-1:still'))
	})

	it('超过 maxAlerts 时按完成时间裁最老的 resolved，pending 不动', () => {
		const sb = sandbox('prune-max')
		const clock = { value: 1_800_000_000_000 }
		const { store } = makeStore(sb, { clock, maxAlerts: 3 })
		for (let index = 0; index < 5; index += 1) {
			clock.value += 10
			store.upsertMany([
				draft(`approval:session-1:done-${index}`, {
					status: 'resolved',
					createdAt: clock.value,
					resolvedAt: clock.value,
				}),
			])
		}
		store.upsertMany([draft('approval:session-1:pending')])
		store.prune()
		assert.equal(store.size(), 3)
		assert.ok(store.get('approval:session-1:pending'))
		assert.ok(store.get('approval:session-1:done-4'))
	})

	it('recentDone 只看最近 6 小时、最多 limit 条，按完成时间倒序', () => {
		const sb = sandbox('recent')
		const clock = { value: 1_800_000_000_000 }
		const { store } = makeStore(sb, { clock })
		store.upsertMany([
			draft('done:recent', { kind: 'turn-done', status: 'resolved', resolvedAt: clock.value - 1000 }),
			draft('done:old', { kind: 'turn-done', status: 'resolved', resolvedAt: clock.value - 7 * 3600 * 1000 }),
			// resolved 的 approval/question 不属于「完成」，不能进 recentDone。
			draft('approval:resolved', { status: 'resolved', resolvedAt: clock.value - 500 }),
			draft('question:resolved', { kind: 'question', status: 'resolved', resolvedAt: clock.value - 400 }),
		])
		const recent = store.recentDone()
		assert.deepEqual(
			recent.map((alert) => alert.id),
			['done:recent'],
		)
		assert.equal(store.recentDone({ withinMs: 8 * 3600 * 1000, limit: 1 }).length, 1)
	})

	it('counts: pending 数 + 今天完成的数', () => {
		const sb = sandbox('counts')
		const clock = { value: new Date(2026, 9, 25, 12, 0, 0).getTime() }
		const { store } = makeStore(sb, { clock })
		store.upsertMany([
			draft('a:1'),
			draft('a:2', { kind: 'turn-done', status: 'resolved', resolvedAt: clock.value }),
			draft('a:3', { kind: 'turn-done', status: 'resolved', resolvedAt: clock.value - 48 * 3600 * 1000 }),
			draft('a:4', { kind: 'turn-error', status: 'resolved', resolvedAt: clock.value }),
		])
		assert.deepEqual(store.counts(), { pending: 1, todayDone: 2 })
	})

	it('resolveTurnPendings 只清理指定 turn 的 pending', () => {
		const sb = sandbox('turn-pending')
		const { store } = makeStore(sb)
		store.upsertMany([
			draft('approval:s:1', { sessionId: 's', detail: { turn: 1 } }),
			draft('approval:s:2', { sessionId: 's', detail: { turn: 2 } }),
			draft('approval:s:unknown', { sessionId: 's', detail: {} }),
		])
		const cleared = store.resolveTurnPendings('s', 1, 1_800_000_000_500)
		assert.deepEqual(
			cleared.map((alert) => alert.id).sort(),
			['approval:s:1', 'approval:s:unknown'],
		)
		assert.equal(store.get('approval:s:2').status, 'pending')
	})
})

describe('state: 安静时段', () => {
	it('parseClock / isQuietHours 覆盖跨午夜与非法值', () => {
		assert.equal(parseClock('23:30'), 23 * 60 + 30)
		assert.equal(parseClock('07:30:00'), 7 * 60 + 30)
		assert.equal(parseClock('25:00'), null)
		assert.equal(parseClock(null), null)

		const at = (hours, minutes) => new Date(2026, 9, 25, hours, minutes, 0)
		assert.equal(isQuietHours(null, at(23, 45)), false)
		assert.equal(isQuietHours({ start: '23:30', end: '07:30' }, at(23, 45)), true)
		assert.equal(isQuietHours({ start: '23:30', end: '07:30' }, at(3, 0)), true)
		assert.equal(isQuietHours({ start: '23:30', end: '07:30' }, at(12, 0)), false)
		assert.equal(isQuietHours({ start: '09:00', end: '18:00' }, at(12, 0)), true)
		assert.equal(isQuietHours({ start: 'bad', end: '07:30' }, at(12, 0)), false)
	})
})
