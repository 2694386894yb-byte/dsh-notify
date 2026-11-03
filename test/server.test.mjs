import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { createDaemon } from '../lib/daemon.mjs'
import { fakeDesktop, fakeWechat, makeConfig, makeSandbox, mk, openLog, silentLogger } from './_helpers.mjs'

let sandbox
let daemon
let wechat
let desktop
let clock
let base

function api(path, options = {}) {
	return fetch(`${base}${path}`, options)
}

function jsonPost(path, body) {
	return api(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
}

before(async () => {
	sandbox = makeSandbox('server')
	clock = { value: Date.now() }
	wechat = fakeWechat()
	desktop = fakeDesktop()
	const config = makeConfig(sandbox, { server: { port: 0 }, test: { demoAlertTtlMs: 100 } })
	const log = openLog(sandbox)
	log.entries(
		mk('session/title', { title: '导出课表' }, clock.value - 1100),
		mk('turn/start', { turn: 1 }, clock.value - 1000),
		mk('approval/asked', { id: 'ap-1', toolName: 'bash', reason: '需要放宽沙箱' }, clock.value - 990),
	)
	daemon = createDaemon({
		config,
		channels: { wechat },
		logger: silentLogger(),
		desktop,
		now: () => clock.value,
	})
	await daemon.start()
	const address = daemon.address()
	assert.ok(address?.port)
	base = `http://127.0.0.1:${address.port}`
})

after(async () => {
	await daemon?.stop()
	sandbox?.cleanup()
})

describe('HTTP: /health 与 /state', () => {
	it('GET /health 形状正确', async () => {
		const response = await api('/health')
		assert.equal(response.status, 200)
		assert.match(response.headers.get('content-type') ?? '', /application\/json/)
		const body = await response.json()
		assert.equal(body.ok, true)
		assert.equal(typeof body.uptimeMs, 'number')
		assert.equal(body.watcher.sessions, 1)
		assert.equal(typeof body.watcher.lastScanAt, 'number')
		assert.ok(body.watcher.lastEventAt === null || typeof body.watcher.lastEventAt === 'number')
		assert.equal(typeof body.channels.desktop, 'object')
		assert.equal(typeof body.channels.wechat, 'object')
		assert.equal(body.server.listening, true)
	})

	it('GET /state 形状符合 SPEC §6', async () => {
		const response = await api('/state')
		assert.equal(response.status, 200)
		const body = await response.json()
		assert.equal(typeof body.generatedAt, 'number')
		assert.equal(Array.isArray(body.pending), true)
		assert.equal(Array.isArray(body.recentDone), true)
		assert.equal(body.pending.length, 1)
		assert.deepEqual(body.counts, { pending: 1, todayDone: 0 })
		assert.equal(typeof body.channels.desktop.mode, 'string')
		assert.equal(typeof body.channels.wechat.mode, 'string')

		const alert = body.pending[0]
		for (const key of [
			'id',
			'kind',
			'status',
			'sessionId',
			'sessionTitle',
			'project',
			'projectPath',
			'title',
			'body',
			'detail',
			'createdAt',
			'detectedAt',
			'updatedAt',
			'notified',
			'escalatedAt',
			'resolvedAt',
			'resolution',
		]) {
			assert.ok(key in alert, `alert 缺字段 ${key}`)
		}
		assert.equal(alert.id, 'approval:session-demo-1:ap-1')
		assert.equal(alert.kind, 'approval')
		assert.equal(alert.status, 'pending')
		assert.deepEqual(alert.notified, { desktop: true, wechat: true })
	})
})

describe('HTTP: /test 与 demo alert', () => {
	it('POST /test 发桌面通知 + 注入 demo pending alert（挂件可见），60s(测试用 100ms) 后自动移除', async () => {
		const response = await jsonPost('/test', { title: '自检标题', body: '自检正文' })
		assert.equal(response.status, 200)
		const body = await response.json()
		assert.equal(body.ok, true)
		assert.match(body.demoAlertId, /^demo:/)
		assert.equal(body.desktop.mode, 'osascript')
		assert.equal(body.wechat.ok, true)
		assert.equal(desktop.delivered.length >= 2, true)

		const state = await (await api('/state')).json()
		const demo = state.pending.find((alert) => alert.id === body.demoAlertId)
		assert.ok(demo, 'demo alert 应出现在 /state.pending 里')
		assert.equal(demo.status, 'pending')
		assert.equal(demo.kind, 'question')
		assert.equal(demo.project, '通知自检')
		assert.equal(demo.sessionTitle, '端到端测试')
		assert.equal(demo.title, '自检标题')
		assert.equal(demo.body, '自检正文')

		await new Promise((resolve) => setTimeout(resolve, 220))
		const afterState = await (await api('/state')).json()
		assert.equal(afterState.pending.some((alert) => alert.id === body.demoAlertId), false)
		assert.equal(afterState.recentDone.some((alert) => alert.id === body.demoAlertId), false)
	})

	it('POST /ack 可以把 demo alert 直接删掉；approval 走 resolved', async () => {
		const demo = await (await jsonPost('/test', {})).json()

		const ackDemo = await jsonPost('/ack', { id: demo.demoAlertId })
		assert.equal(ackDemo.status, 200)
		const ackDemoBody = await ackDemo.json()
		assert.equal(ackDemoBody.ok, true)
		assert.equal(ackDemoBody.removed, true)

		const approvalId = 'approval:session-demo-1:ap-1'
		const ackApproval = await jsonPost('/ack', { id: approvalId })
		assert.equal(ackApproval.status, 200)
		const ackApprovalBody = await ackApproval.json()
		assert.equal(ackApprovalBody.ok, true)
		assert.equal(ackApprovalBody.alert.status, 'resolved')
		assert.equal(ackApprovalBody.alert.resolution, 'acknowledged')

		const state = await (await api('/state')).json()
		assert.equal(state.pending.length, 0)
		assert.equal(
			state.recentDone.some((alert) => alert.id === approvalId),
			false,
			'ack 掉的 approval 不该出现在 recentDone（挂件会当新 alert 再弹）',
		)
		assert.equal(state.counts.pending, 0)

		const repeat = await jsonPost('/ack', { id: approvalId })
		assert.equal(repeat.status, 404)
		const repeatBody = await repeat.json()
		assert.equal(repeatBody.ok, false)
		assert.equal(repeatBody.reason, 'not-found')
	})
})

describe('HTTP: 错误处理', () => {
	it('405 / 404 / 400 / 403 语义', async () => {
		const wrongMethod = await api('/test')
		assert.equal(wrongMethod.status, 405)
		assert.equal((await wrongMethod.json()).ok, false)

		const notFound = await api('/nope')
		assert.equal(notFound.status, 404)
		assert.equal((await notFound.json()).ok, false)

		const badJson = await jsonPost('/test', '{not json')
		assert.equal(badJson.status, 400)
		assert.equal((await badJson.json()).ok, false)

		const noId = await jsonPost('/ack', {})
		assert.equal(noId.status, 400)
		assert.equal((await noId.json()).ok, false)
	})

	it('所有响应都是 application/json; charset=utf-8', async () => {
		for (const path of ['/health', '/state', '/nope']) {
			const response = await api(path)
			assert.match(response.headers.get('content-type') ?? '', /^application\/json; charset=utf-8/)
		}
	})
})
