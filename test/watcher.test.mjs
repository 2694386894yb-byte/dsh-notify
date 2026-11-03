import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { ZSTD_MAGIC, createWatcher, decodeSessionDirName } from '../lib/watcher.mjs'
import { makeSandbox, mk, ndjson, openLog, sessionHeader, silentLogger, zstdFrame } from './_helpers.mjs'

const sandboxes = []
function sandbox(label) {
	const item = makeSandbox(`watcher-${label}`)
	sandboxes.push(item)
	return item
}
afterEach(() => {
	while (sandboxes.length > 0) sandboxes.pop().cleanup()
})

function newWatcher(sandbox, overrides = {}) {
	return createWatcher({
		sessionsRoot: sandbox.sessionsRoot,
		workspacesFile: sandbox.workspacesFile,
		logger: silentLogger(),
		...overrides,
	})
}

describe('watcher: 路径解码与工作区标题', () => {
	it('把 DSH 的转义目录名解成中文路径，并命中 workspace.json 标题', () => {
		const sb = sandbox('path')
		const encoded = '--Users-example-Desktop-studynotes--'
		writeFileSync(
			sb.workspacesFile,
			JSON.stringify({
				tables: { workspaces: { a: { path: '/Users/example/Desktop/studynotes', title: 'studynotes' } } },
			}),
		)
		const log = openLog(sb, { projectDir: encoded, sessionId: 'session-a' })
		const time = Date.now()
		log.frame(ndjson(mk('session/title', { title: '查看对话列表' }, time), mk('turn/start', { turn: 1 }, time)))

		const watcher = newWatcher(sb)
		const scan = watcher.scan()

		assert.equal(scan.initial, true)
		assert.equal(scan.sessions.length, 1)
		assert.equal(scan.sessions[0].projectPath, '/Users/example/Desktop/studynotes')
		assert.equal(scan.sessions[0].project, 'studynotes')
		assert.equal(scan.events.length, 2)
		assert.equal(scan.events[0].entry.type, 'session/title')
		assert.equal(scan.events[0].project, 'studynotes')
		assert.equal(watcher.lastEventAt, time)
		assert.equal(decodeSessionDirName(encoded), '/Users/example/Desktop/studynotes')
	})

	it('解析 session header：主会话无 origin；子会话目录名没有 session- 前缀也能识别', () => {
		const sb = sandbox('header')
		const time = Date.now()
		const main = openLog(sb, { sessionId: 'session-main' })
		main.entries(sessionHeader('session-main'), mk('turn/start', { turn: 1 }, time))
		// 子 agent 的真实形态：目录名就是 uuid，没有 `session-` 前缀。
		const sub = openLog(sb, { sessionId: '2dfb8e42-1c9e-4b4d-8a3e-0123456789ab' })
		sub.entries(
			sessionHeader('2dfb8e42-1c9e-4b4d-8a3e-0123456789ab', {
				parentSession: 'session-main',
				origin: 'subagent',
				delegationDepth: 1,
			}),
			mk('turn/start', { turn: 1 }, time),
		)

		const scan = newWatcher(sb).scan()
		assert.equal(scan.sessions.length, 2)
		const mainSession = scan.sessions.find((session) => session.sessionId === 'session-main')
		const subSession = scan.sessions.find((session) => session.sessionId.includes('2dfb8e42'))
		assert.equal(mainSession.origin, null)
		assert.equal(mainSession.isSubagent, false)
		assert.equal(subSession.origin, 'subagent')
		assert.equal(subSession.parentSession, 'session-main')
		assert.equal(subSession.delegationDepth, 1)
		assert.equal(subSession.isSubagent, true)
		assert.equal(subSession.header.origin, 'subagent')

		const subEvents = scan.events.filter((event) => event.sessionId === subSession.sessionId)
		assert.equal(subEvents.length, 2, 'header 本身也是一条事件，外加 turn/start')
		const turnEvent = subEvents.find((event) => event.entry.type === 'turn/start')
		assert.equal(turnEvent.origin, 'subagent')
		assert.equal(turnEvent.parentSession, 'session-main')
	})

	it('lookback 之外的老会话也读 header（不解析历史事件也能识别子 agent）', () => {
		const sb = sandbox('header-old')
		const time = Date.now()
		const sub = openLog(sb, { sessionId: 'old-subagent-uuid' })
		sub.entries(
			sessionHeader('old-subagent-uuid', { origin: 'subagent', parentSession: 'session-main', delegationDepth: 1 }),
			mk('turn/start', { turn: 1 }, time - 3 * 3600 * 1000),
		)
		sub.touch(Date.now() - 3 * 3600 * 1000)

		const scan = newWatcher(sb, { lookbackMinutes: 120 }).scan()
		assert.equal(scan.events.length, 0, '老会话不该解析历史事件')
		assert.equal(scan.sessions[0].origin, 'subagent')
		assert.equal(scan.sessions[0].isSubagent, true)
	})

	it('没有 workspace.json 时用目录名末段兜底，且不崩', () => {
		const sb = sandbox('fallback')
		const log = openLog(sb, { projectDir: '--Users-example-Desktop-some-dir--', sessionId: 'session-b' })
		log.frame(ndjson(mk('turn/start', { turn: 1 }, Date.now())))
		const scan = newWatcher(sb).scan()
		assert.equal(scan.sessions[0].project, 'dir')
		assert.equal(scan.sessions[0].projectPath, '/Users/example/Desktop/some/dir')
	})
})

describe('watcher: 多 zstd 帧 / 跨帧半行 / 半帧重试', () => {
	it('跨帧的半行 JSON 会留到下一次扫描拼上', () => {
		const sb = sandbox('half-line')
		const log = openLog(sb)
		const time = Date.now()
		const lineA = `${JSON.stringify(mk('turn/start', { turn: 1 }, time))}\n`
		const lineB = JSON.stringify(
			mk('tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }, time + 5),
		)
		log.frame(lineA + lineB.slice(0, 20))

		const watcher = newWatcher(sb)
		const first = watcher.scan()
		assert.deepEqual(
			first.events.map((event) => event.entry.type),
			['turn/start'],
		)

		log.frame(`${lineB.slice(20)}\n`)
		const second = watcher.scan()
		assert.deepEqual(
			second.events.map((event) => event.entry.type),
			['tool/call'],
		)
		assert.equal(second.events[0].entry.data.callId, 'call_1')
		// 第一条事件不会被重复吐出来。
		assert.equal(second.events.some((event) => event.entry.type === 'turn/start'), false)
	})

	it('文件尾部半帧先不消费，补齐后重读成功', () => {
		const sb = sandbox('truncated-frame')
		const log = openLog(sb)
		const time = Date.now()
		log.frame(ndjson(mk('turn/start', { turn: 1 }, time)))
		const tail = zstdFrame(ndjson(mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, time + 1000)))
		log.raw(tail.subarray(0, tail.length - 5))

		const watcher = newWatcher(sb)
		const first = watcher.scan()
		assert.deepEqual(
			first.events.map((event) => event.entry.type),
			['turn/start'],
		)
		assert.ok(first.sessions[0].offset < statSync(log.file).size, '半帧不能推进 offset')

		log.raw(tail.subarray(tail.length - 5))
		const second = watcher.scan()
		assert.deepEqual(
			second.events.map((event) => event.entry.type),
			['turn/end'],
		)
		assert.equal(second.sessions[0].offset, statSync(log.file).size)
	})

	it('尾部坏帧连续重试后跳过，不会永远卡住', () => {
		const sb = sandbox('bad-tail')
		const log = openLog(sb)
		log.frame(ndjson(mk('turn/start', { turn: 1 }, Date.now())))
		log.raw(Buffer.concat([ZSTD_MAGIC, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]))

		const watcher = newWatcher(sb, { maxTailAttempts: 3 })
		const first = watcher.scan()
		assert.equal(first.events.length, 1)
		assert.ok(first.sessions[0].offset < statSync(log.file).size)

		watcher.scan()
		const third = watcher.scan()
		assert.equal(third.sessions[0].offset, statSync(log.file).size, '重试 3 次后应跳过坏帧')
		assert.equal(third.sessions[0].unreadable, null)
	})

	it('中间的坏帧被跳过，前后好帧仍能解析', () => {
		const sb = sandbox('bad-middle')
		const log = openLog(sb)
		const time = Date.now()
		log.frame(ndjson(mk('turn/start', { turn: 1 }, time)))
		log.raw(Buffer.concat([ZSTD_MAGIC, Buffer.from([9, 9, 9, 9, 9, 9])]))
		log.frame(ndjson(mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, time + 1000)))

		const watcher = newWatcher(sb)
		const scan = watcher.scan()
		assert.deepEqual(
			scan.events.map((event) => event.entry.type),
			['turn/start', 'turn/end'],
		)
		assert.equal(scan.sessions[0].unreadable, null)
		assert.equal(scan.sessions[0].offset, statSync(log.file).size)
	})
})

describe('watcher: 启动 lookback 与容错', () => {
	it('lookback 内的会话完整解析；更老的只记 offset 不解析', () => {
		const sb = sandbox('lookback')
		const fresh = openLog(sb, { sessionId: 'session-fresh' })
		fresh.frame(ndjson(mk('turn/start', { turn: 1 }, Date.now()), mk('approval/asked', { id: 'a1' }, Date.now() + 5)))
		const stale = openLog(sb, { sessionId: 'session-stale' })
		stale.frame(ndjson(mk('turn/start', { turn: 1 }, Date.now() - 3 * 3600 * 1000)))
		stale.touch(Date.now() - 3 * 3600 * 1000)

		const watcher = newWatcher(sb, { lookbackMinutes: 120 })
		const first = watcher.scan()
		assert.equal(first.events.length, 2, '老会话的历史事件不该被解析')
		assert.equal(first.events.every((event) => event.sessionId === 'session-fresh'), true)
		const staleSummary = first.sessions.find((session) => session.sessionId === 'session-stale')
		assert.ok(staleSummary)
		assert.equal(staleSummary.offset, statSync(stale.file).size)

		// 老会话之后追加的新事件照常读。
		stale.frame(ndjson(mk('turn/end', { turn: 1, reason: { kind: 'completed' } }, Date.now())))
		const second = watcher.scan()
		assert.deepEqual(
			second.events.map((event) => event.entry.type),
			['turn/end'],
		)
		assert.equal(second.events[0].sessionId, 'session-stale')
	})

	it('.zstd 文件里没有 zstd 帧时标记 unreadable，不抛错、不解析二进制', () => {
		const sb = sandbox('no-magic')
		const log = openLog(sb)
		writeFileSync(log.file, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))
		const scan = newWatcher(sb).scan()
		assert.equal(scan.sessions.length, 1)
		assert.match(String(scan.sessions[0].unreadable), /zstd/)
		assert.equal(scan.events.length, 0)
		assert.equal(scan.errors.length, 1)
		assert.equal(scan.errors[0].sessionId, 'session-demo-1')
	})

	it('明文 .jsonl 也能读；坏行跳过并计入 malformedLines', () => {
		const sb = sandbox('plaintext')
		const log = openLog(sb, { fileName: 'session.v4.jsonl' })
		const time = Date.now()
		log.text(`not json\n${JSON.stringify(mk('turn/start', { turn: 1 }, time))}\n{"no_entry_type":1}\n`)
		const scan = newWatcher(sb).scan()
		assert.deepEqual(
			scan.events.map((event) => event.entry.type),
			['turn/start'],
		)
		assert.equal(scan.sessions[0].malformedLines, 2)
	})

	it('不可读文件之后追加了有效帧 → 重新尝试并恢复', () => {
		const sb = sandbox('unreadable-recover')
		const log = openLog(sb)
		writeFileSync(log.file, Buffer.from([1, 2, 3, 4, 5]))
		const watcher = newWatcher(sb)
		assert.match(String(watcher.scan().sessions[0].unreadable), /zstd/)

		log.frame(ndjson(mk('turn/start', { turn: 1 }, Date.now())))
		const scan = watcher.scan()
		assert.equal(scan.sessions[0].unreadable, null)
		assert.deepEqual(
			scan.events.map((event) => event.entry.type),
			['turn/start'],
		)
	})

	it('会话目录不存在时返回错误而不是抛异常', () => {
		const sb = sandbox('missing-root')
		const watcher = createWatcher({ sessionsRoot: join(sb.root, 'nope'), logger: silentLogger() })
		const scan = watcher.scan()
		assert.equal(scan.sessions.length, 0)
		assert.equal(scan.errors.length, 1)
		assert.match(scan.errors[0].error, /不存在/)
	})

	it('文件被截断（轮转）时从头重读', () => {
		const sb = sandbox('rotate')
		const log = openLog(sb)
		const time = Date.now()
		log.frame(ndjson(mk('turn/start', { turn: 1 }, time), mk('turn/end', { turn: 1, reason: { kind: 'aborted' } }, time + 1)))
		const watcher = newWatcher(sb)
		assert.equal(watcher.scan().events.length, 2)

		// 模拟替换成更小的新日志。
		writeFileSync(log.file, Buffer.alloc(0))
		log.frame(ndjson(mk('turn/start', { turn: 2 }, time + 100)))
		const scan = watcher.scan()
		assert.deepEqual(
			scan.events.map((event) => event.entry.type),
			['turn/start'],
		)
		assert.equal(scan.events[0].entry.data.turn, 2)
	})

	it('进度事件时间戳是纳秒时归一化成毫秒', () => {
		const sb = sandbox('ns-time')
		const log = openLog(sb)
		// 1.79e15 在 Number 的安全整数范围内（再乘 1e6 会丢精度，别踩）。
		const nanoseconds = 1_792_940_000_123_456
		log.frame(`${JSON.stringify({ type: 'turn/start', seq: 1, time: nanoseconds, data: { turn: 1 } })}\n`)
		const watcher = newWatcher(sb)
		const scan = watcher.scan()
		assert.equal(scan.events.length, 1)
		assert.equal(watcher.lastEventAt, Math.floor(nanoseconds / 1e6))
	})
})

