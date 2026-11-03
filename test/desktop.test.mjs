import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { buildNotificationScript, createDesktopChannel, escapeAppleScript } from '../lib/channels/desktop.mjs'
import { makeConfig, makeSandbox, writeHeartbeat } from './_helpers.mjs'

const sandboxes = []
function sandbox(label) {
	const item = makeSandbox(`desktop-${label}`)
	sandboxes.push(item)
	return item
}
afterEach(() => {
	while (sandboxes.length > 0) sandboxes.pop().cleanup()
})

const CLOCK = 1_800_000_000_000

function makeChannel(sb, { configOverrides = {}, clock = { value: CLOCK } } = {}) {
	const calls = []
	const channel = createDesktopChannel({
		config: makeConfig(sb, configOverrides),
		now: () => clock.value,
		execFile: async (file, args) => {
			calls.push({ file, args })
			return { stdout: '', stderr: '' }
		},
	})
	return { channel, calls, clock }
}

const ALERT = {
	id: 'approval:session-1:ap-1',
	kind: 'approval',
	title: '需要你批准：bash',
	body: '需要放宽沙箱到 danger-full-access',
}

describe('desktop: 心跳与路径选择', () => {
	it('心跳新鲜 → 走挂件，不调 osascript', async () => {
		const sb = sandbox('fresh')
		writeHeartbeat(sb, CLOCK - 1000)
		const { channel, calls } = makeChannel(sb)
		const result = await channel.deliver(ALERT)
		assert.deepEqual(result, { ok: true, mode: 'widget', error: null })
		assert.equal(calls.length, 0)
		assert.equal(channel.status().widgetAlive, true)
		assert.equal(channel.status().mode, 'widget')
	})

	it('心跳过期 → osascript 兜底，并记录 lastDeliveryAt', async () => {
		const sb = sandbox('stale')
		writeHeartbeat(sb, CLOCK - 60_000)
		const { channel, calls } = makeChannel(sb)
		const result = await channel.deliver(ALERT)
		assert.equal(result.ok, true)
		assert.equal(result.mode, 'osascript')
		assert.equal(calls.length, 1)
		assert.equal(calls[0].file, '/usr/bin/osascript')
		assert.equal(calls[0].args.length, 2)
		assert.equal(calls[0].args[0], '-e')
		assert.match(calls[0].args[1], /^display notification "/)
		assert.match(calls[0].args[1], /with title "需要你批准：bash" sound name "Glass"$/)
		assert.equal(channel.status().lastDeliveryAt, CLOCK)
		assert.equal(channel.status().error, null)
	})

	it('没有心跳文件 / 心跳坏 JSON → 当挂件没开，走兜底', async () => {
		const sb = sandbox('missing')
		const { channel, calls } = makeChannel(sb)
		assert.equal((await channel.deliver(ALERT)).mode, 'osascript')

		writeFileSync(join(sb.stateDir, 'widget-heartbeat.json'), 'not json')
		assert.equal((await channel.deliver(ALERT)).mode, 'osascript')
		assert.equal(calls.length, 2)
	})

	it('fallbackWhenWidgetStale=false 且心跳过期 → 不发、返回错误', async () => {
		const sb = sandbox('nofallback')
		writeHeartbeat(sb, CLOCK - 60_000)
		const { channel, calls } = makeChannel(sb, {
			configOverrides: { channels: { desktop: { fallbackWhenWidgetStale: false } } },
		})
		const result = await channel.deliver(ALERT)
		assert.equal(result.ok, false)
		assert.equal(result.mode, 'widget-stale')
		assert.equal(calls.length, 0)
	})

	it('enabled=false 时直接禁用（force 测试通知除外）', async () => {
		const sb = sandbox('disabled')
		const { channel, calls } = makeChannel(sb, { configOverrides: { channels: { desktop: { enabled: false } } } })
		const result = await channel.deliver(ALERT)
		assert.equal(result.ok, false)
		assert.equal(result.mode, 'disabled')
		assert.equal(calls.length, 0)

		const forced = await channel.deliver(ALERT, { force: true })
		assert.equal(forced.ok, true)
		assert.equal(calls.length, 1, '测试通知即使关闭桌面通道也应发一次（force）')
	})
})

describe('desktop: osascript 转义 / 注入防护', () => {
	it('引号、反斜杠、换行都被正确转义，argv 传参不经 shell', async () => {
		const sb = sandbox('escape')
		const { channel, calls } = makeChannel(sb)
		const alert = {
			id: 'test:1',
			kind: 'question',
			title: '标题 "带引号" \\ 反斜杠',
			body: '第一行\n第二行 "x" \\ $(touch /tmp/pwned)',
		}
		const result = await channel.deliver(alert, { force: true })
		assert.equal(result.ok, true)

		const script = calls[0].args[1]
		assert.equal(calls[0].args.length, 2)
		assert.equal(script.includes('\n'), false, '脚本必须是单行，不能有裸换行')
		assert.equal(script.includes('\\"带引号\\"'), true)
		assert.equal(script.includes('\\\\ 反斜杠'), true)
		assert.equal(script.includes('$(touch'), true, '内容原样保留但不经 shell，不会执行')
		// 结尾仍是合法的 AppleScript。
		assert.match(script, /sound name "Glass"$/)
	})

	it('buildNotificationScript / escapeAppleScript 单元行为', () => {
		assert.equal(escapeAppleScript('a"b\\c\nd'), 'a\\"b\\\\c d')
		const script = buildNotificationScript({ title: 'T', body: 'B' })
		assert.equal(script, 'display notification "B" with title "T" sound name "Glass"')
		assert.equal(buildNotificationScript({ title: '', body: '' }).includes('with title "DSH 通知"'), true)
	})

	it('osascript 失败 → ok:false + error，不抛；成功后 error 清空', async () => {
		const sb = sandbox('exec-fail')
		let shouldFail = true
		const channel = createDesktopChannel({
			config: makeConfig(sb),
			now: () => CLOCK,
			execFile: async () => {
				if (shouldFail) throw new Error('osascript exploded')
				return { stdout: '' }
			},
		})
		const failed = await channel.deliver(ALERT)
		assert.equal(failed.ok, false)
		assert.equal(failed.mode, 'osascript')
		assert.match(failed.error, /exploded/)
		assert.equal(channel.status().lastDeliveryAt, null)
		assert.match(channel.status().error, /exploded/)

		shouldFail = false
		const ok = await channel.deliver(ALERT)
		assert.equal(ok.ok, true)
		assert.equal(channel.status().error, null)
		assert.equal(channel.status().lastDeliveryAt, CLOCK)
	})
})
