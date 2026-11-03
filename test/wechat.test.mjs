/**
 * 微信单向通道的离线用例。
 *
 * 不碰网络、不碰真实凭据：用假 core 替掉 StateStore / ChannelMonitor / sendText，
 * 只验证通道自己的逻辑——排队、窗口、节流、去重、拒发重开窗口后补发。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWechatChannel } from '../lib/channels/wechat.mjs'

class FakeSendRefusedError extends Error {
	constructor(message, errcode) {
		super(message)
		this.name = 'SendRefusedError'
		this.errcode = errcode
	}
}

class FakeStateStore {
	constructor(file) {
		this.file = file
		this.state = { version: 1, accounts: {}, syncBufs: {}, contextTokens: {}, bindings: {}, sentMessages: {}, autoStart: true }
		try {
			this.state = { ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) }
		} catch {
			/* 新建 */
		}
	}
	async read() {
		return structuredClone(this.state)
	}
	async update(mutate) {
		mutate(this.state)
		writeFileSync(this.file, JSON.stringify(this.state))
	}
}

function makeCore({ refuse = false } = {}) {
	const sends = []
	const core = {
		StateStore: FakeStateStore,
		SendRefusedError: FakeSendRefusedError,
		QUOTA_PER_TOKEN: 10,
		QUOTA_WARNING: '窗口快用完了，回我一句',
		conversationKey: (accountId, peerId, groupId) =>
			groupId ? `${accountId}:${groupId}:${peerId}` : `${accountId}:${peerId}`,
		chargeQuota: ({ stored, token }) => {
			const used = (stored?.token === token ? Number(stored?.used) || 0 : 0) + 1
			return { entry: { token, used, warned: used >= 8 }, warn: used >= 8, used }
		},
		sendText: async (params) => {
			if (refuse) throw new FakeSendRefusedError('prepare failed', -2)
			sends.push(params)
			return { clientId: `c${sends.length}` }
		},
		ChannelMonitor: class {
			constructor(options) {
				this.options = options
				this.paused = false
				this.remainingPauseMs = 0
				this.stopped = false
			}
			async run(signal) {
				await new Promise((resolve) => {
					if (signal.aborted) return resolve()
					signal.addEventListener('abort', resolve, { once: true })
				})
				return 'aborted'
			}
			async notifyStop() {}
		},
	}
	return { core, sends }
}

function setup({ refuse = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-wechat-'))
	const stateFile = join(dir, 'state.json')
	writeFileSync(
		stateFile,
		JSON.stringify({
			version: 1,
			accounts: {
				'bot@im.bot': {
					accountId: 'bot@im.bot',
					token: 'bot@im.bot:secret',
					baseUrl: 'https://example.invalid',
					userId: 'user@im.wechat',
				},
			},
			syncBufs: {},
			contextTokens: {},
			bindings: {},
			sentMessages: {},
			autoStart: true,
		}),
	)
	const config = {
		stateDir: dir,
		channels: {
			wechat: { enabled: true, statePath: stateFile, selfReplyThrottleMinutes: 10, maxQueue: 5 },
			desktop: { enabled: false },
		},
	}
	const { core, sends } = makeCore({ refuse })
	let clock = 1_000_000
	const channel = createWechatChannel({ config, core, logger: { error() {} }, now: () => clock })
	return {
		dir,
		channel,
		sends,
		advance: (ms) => {
			clock += ms
		},
	}
}

const inbound = (text = '你好', contextToken = 'ctx-1') => ({
	accountId: 'bot@im.bot',
	peerId: 'user@im.wechat',
	conversationId: 'bot@im.bot:user@im.wechat',
	contextToken,
	text,
	receivedAt: 1_000_000,
})

test('未绑定 peer 时发送进队列，不抛错', async () => {
	const { channel } = setup()
	await channel.start()
	const result = await channel.send('hello', { kind: 'test' })
	assert.equal(result.ok, false)
	assert.equal(result.queued, true)
	assert.equal(channel.status().queueLength, 1)
	await channel.stop()
})

test('入站消息记录 peer/context 并补发队列 + 固定自我说明', async () => {
	const { channel, sends } = setup()
	await channel.start()
	await channel.send('第一条积压通知', { alertId: 'a1' })
	await channel.__handleInbound(inbound())
	const texts = sends.map((item) => item.text)
	assert.ok(texts.includes('第一条积压通知'), '积压通知应被补发')
	assert.ok(texts.some((text) => text.includes('只负责推送通知')), '应发一次自我说明')
	const status = channel.status()
	assert.equal(status.bound, true)
	assert.equal(status.queueLength, 0)
	assert.equal(status.lastInboundAt, 1_000_000)
	await channel.stop()
})

test('窗口打开时直接发送，并记录 quota', async () => {
	const { channel, sends } = setup()
	await channel.start()
	await channel.__handleInbound(inbound('你好', 'ctx-9'))
	const before = sends.length
	const result = await channel.send('通知正文', { kind: 'approval', alertId: 'approval:1' })
	assert.equal(result.ok, true)
	assert.equal(sends.length, before + 1)
	assert.equal(sends.at(-1).contextToken, 'ctx-9')
	const sent = JSON.parse(readFileSync(channel.status().stateFile, 'utf8'))
	assert.equal(sent.quota['bot@im.bot:user@im.wechat'].used >= 1, true)
	await channel.stop()
})

test('同一 alertId 只排一次队', async () => {
	const { channel } = setup()
	await channel.start()
	await channel.send('x', { alertId: 'same' })
	await channel.send('y', { alertId: 'same' })
	await channel.send('z', { alertId: 'other' })
	assert.equal(channel.status().queueLength, 2)
	await channel.stop()
})

test('自我说明有节流：10 分钟内只回一次', async () => {
	const { channel, sends, advance } = setup()
	await channel.start()
	await channel.__handleInbound(inbound('a', 'ctx-a'))
	const first = sends.length
	advance(60_000)
	await channel.__handleInbound(inbound('b', 'ctx-b'))
	assert.equal(sends.length, first, '10 分钟内不应再发自我说明')
	advance(11 * 60_000)
	await channel.__handleInbound(inbound('c', 'ctx-c'))
	assert.equal(sends.length, first + 1, '超过 10 分钟应再发一次')
	await channel.stop()
})

test('被微信拒发后排队，下一次入站重开窗口补发', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-wechat-'))
	const stateFile = join(dir, 'state.json')
	writeFileSync(
		stateFile,
		JSON.stringify({
			version: 1,
			accounts: { 'bot@im.bot': { accountId: 'bot@im.bot', token: 'bot@im.bot:s', baseUrl: 'x' } },
			syncBufs: {},
			contextTokens: { 'bot@im.bot': { 'bot@im.bot:user@im.wechat': 'ctx-old' } },
			bindings: {},
			sentMessages: {},
		}),
	)
	// 先让通道知道 peer（上一次会话留下的），再让发送被拒。
	writeFileSync(
		join(dir, 'wechat-peer.json'),
		JSON.stringify({ version: 1, accountId: 'bot@im.bot', peerId: 'user@im.wechat', conversationId: 'bot@im.bot:user@im.wechat', queue: [] }),
	)
	const refusal = makeCore({ refuse: true })
	const config = { stateDir: dir, channels: { wechat: { enabled: true, statePath: stateFile, maxQueue: 5, selfReplyThrottleMinutes: 10 } } }
	const channel = createWechatChannel({ config, core: refusal.core, logger: { error() {} }, now: () => 2_000_000 })
	await channel.start()
	const result = await channel.send('会失败的推送', { alertId: 'a1' })
	assert.equal(result.ok, false)
	assert.equal(result.queued, true)
	assert.equal(channel.status().queueLength, 1)
	// 下一次入站：窗口重开，队列里的消息应该被补发。
	const inboundMessage = inbound('hi', 'ctx-new')
	// flush 走的是同一个 core（仍会拒发），但队列不应丢失。
	await channel.__handleInbound(inboundMessage)
	assert.equal(channel.status().queueLength, 1)
	await channel.stop()
})

test('没有凭据时 start 不抛错，status 说明原因', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-wechat-'))
	const config = { stateDir: dir, channels: { wechat: { enabled: true, statePath: join(dir, 'state.json') } } }
	const { core } = makeCore()
	const channel = createWechatChannel({ config, core, logger: { error() {} } })
	const status = await channel.start()
	assert.equal(status.bound, false)
	assert.match(status.lastError ?? '', /凭据|bind|adopt|wechat/i)
	await channel.stop()
})

test('关闭时不发送', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-wechat-'))
	const config = { stateDir: dir, channels: { wechat: { enabled: false, statePath: join(dir, 'state.json') } } }
	const { core, sends } = makeCore()
	const channel = createWechatChannel({ config, core, logger: { error() {} } })
	const result = await channel.send('nope')
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'disabled')
	assert.equal(sends.length, 0)
	assert.equal(existsSync(join(dir, 'wechat-peer.json')), false)
})
