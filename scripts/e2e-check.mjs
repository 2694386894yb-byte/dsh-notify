#!/usr/bin/env node
/**
 * 独立验收脚本：不依赖实现者的自测。
 *
 * 造一棵假的 `~/.dsh/sessions`（真 zstd 多帧、故意把一行劈到两帧、故意放一个坏帧），
 * 跑 `bin/dsh-notify.mjs once`，按 SPEC 检查 alert；然后追加「已处理」事件，
 * 再跑一次，检查 pending 清空、历史不重复。最后起一个真 daemon，检查 HTTP /state、/test。
 *
 * 用法：
 *   node scripts/e2e-check.mjs
 * 退出码 0 = 全过。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const NODE = process.execPath
const CLI = join(ROOT, 'bin', 'dsh-notify.mjs')

const NOW = Date.UTC(2026, 9, 25, 15, 0, 0)
const MINUTE = 60_000

function entry(type, seq, time, data) {
	return `${JSON.stringify({ type, seq, time, data })}\n`
}

/** 把若干段文本压成首尾相接的 zstd 帧；`chunks` 里的字符串原样写入（可跨帧半行）。 */
function writeFrames(file, chunks) {
	mkdirSync(dirname(file), { recursive: true })
	const frames = chunks.map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')))
	writeFileSync(file, Buffer.concat(frames))
}

function appendFrame(file, text) {
	appendFileSync(file, zstdCompressSync(Buffer.from(text, 'utf8')))
}

function makeHome() {
	const home = mkdtempSync(join(tmpdir(), 'dsh-notify-e2e-'))
	const sessionsRoot = join(home, 'sessions')
	const stateDir = join(home, 'notify-state')
	mkdirSync(sessionsRoot, { recursive: true })
	mkdirSync(stateDir, { recursive: true })
	const workspacePath = '/Users/tester/Desktop/fixture'
	writeFileSync(
		join(home, 'workspace.json'),
		JSON.stringify({
			unit: { name: 'workspace', version: 2 },
			global: {},
			tables: { workspaces: { 'ws-1': { path: workspacePath, title: '测试项目' } } },
		}),
	)
	const projectDir = join(sessionsRoot, '--Users-tester-Desktop-fixture--')
	return { home, sessionsRoot, stateDir, workspacePath, projectDir }
}

function sessionFile(projectDir, sessionId) {
	return join(projectDir, sessionId, 'session.v4.jsonl.zstd')
}

function baseEvents(sessionTitle) {
	return [
		entry('session', 0, NOW - 30 * MINUTE, {}),
		entry('session/title', 1, NOW - 30 * MINUTE, { title: sessionTitle }),
	]
}

function writeSessions(projectDir) {
	const t0 = NOW - 15 * MINUTE

	// A：提问挂着（没有 result）→ 应 pending question
	const a = [
		...baseEvents('提问会话'),
		entry('turn/start', 2, t0, { turn: 1 }),
		entry('step/start', 3, t0 + 1000, { turn: 1, step: 1 }),
		entry('assistant/message', 4, t0 + 2000, {
			turn: 1,
			step: 1,
			message: {
				role: 'assistant',
				content: [
					{ type: 'reasoning', text: '不该出现在通知里的思考过程' },
					{ type: 'text', text: '我想确认一下开始时间。' },
				],
			},
		}),
		entry('tool/call', 5, t0 + 3000, {
			turn: 1,
			step: 1,
			callId: 'call-ask-1',
			name: 'ask_user_question',
			arguments: JSON.stringify({
				questions: [
					{
						id: 'start',
						header: '开始时间',
						question: '从今晚 23:00 开始排期可以吗？',
						options: [{ label: '可以' }, { label: '改到明天' }],
					},
				],
			}),
		}),
	]
	writeFrames(sessionFile(projectDir, 'session-aaa'), a)

	// B：审批挂着 → 应 pending approval
	const b = [
		...baseEvents('审批会话'),
		entry('turn/start', 2, t0 + 5 * MINUTE, { turn: 1 }),
		entry('tool/call', 3, t0 + 5 * MINUTE + 1000, { turn: 1, step: 1, callId: 'call-b1', name: 'bash', arguments: '{}' }),
		entry('approval/asked', 4, t0 + 5 * MINUTE + 2000, {
			id: 'apr-1',
			toolName: 'bash',
			callId: 'call-b1',
			reason: 'escalate sandbox to danger-full-access: 需要写入提醒事项',
		}),
	]
	writeFrames(sessionFile(projectDir, 'session-bbb'), b)

	// C：正常完成 → 应 recentDone（turn-done）
	const c = [
		...baseEvents('完成会话'),
		entry('turn/start', 2, t0, { turn: 1 }),
		entry('tool/call', 3, t0 + 1000, { turn: 1, step: 1, callId: 'call-c1', name: 'bash', arguments: '{}' }),
		entry('tool/result', 4, t0 + 60_000, { turn: 1, step: 1, toolCallId: 'call-c1', message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } }),
		entry('assistant/message', 5, t0 + 61_000, {
			turn: 1,
			step: 2,
			message: { role: 'assistant', content: [{ type: 'text', text: '做完了，结果在 report.md。' }] },
		}),
		entry('turn/end', 6, t0 + 62_000, { turn: 1, reason: { kind: 'completed' } }),
	]
	// 故意把最后一行劈到两帧：前半帧 + 后半帧。
	const textC = c.join('')
	const cut = textC.length - 20
	writeFrames(sessionFile(projectDir, 'session-ccc'), [textC.slice(0, cut), textC.slice(cut)])

	// D：出错 → 应 recentDone（turn-error）
	const d = [
		...baseEvents('出错会话'),
		entry('turn/start', 2, t0 + 3 * MINUTE, { turn: 1 }),
		entry('turn/end', 3, t0 + 3 * MINUTE + 30_000, { turn: 1, reason: { kind: 'error', error: { message: 'transport failed' } } }),
	]
	writeFrames(sessionFile(projectDir, 'session-ddd'), d)

	// E：审批已处理 → 不应 pending，也不应重复
	const e = [
		...baseEvents('已批准会话'),
		entry('turn/start', 2, t0 + 8 * MINUTE, { turn: 1 }),
		entry('approval/asked', 3, t0 + 8 * MINUTE + 1000, { id: 'apr-2', toolName: 'bash', reason: 'needs network' }),
		entry('approval/decided', 4, t0 + 8 * MINUTE + 2000, { id: 'apr-2', outcome: 'allowed-once' }),
		entry('turn/end', 5, t0 + 8 * MINUTE + 3000, { turn: 1, reason: { kind: 'completed' } }),
	]
	writeFrames(sessionFile(projectDir, 'session-eee'), e)

	// F：提问已答 → 不应 pending
	const f = [
		...baseEvents('已回答会话'),
		entry('turn/start', 2, t0 + 9 * MINUTE, { turn: 1 }),
		entry('tool/call', 3, t0 + 9 * MINUTE + 1000, { turn: 1, step: 1, callId: 'call-ask-2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '选哪个？' }] }) }),
		entry('tool/result', 4, t0 + 9 * MINUTE + 2000, { turn: 1, step: 1, toolCallId: 'call-ask-2', message: { role: 'tool', content: [{ type: 'text', text: '{"answers":[]}' }] } }),
		entry('turn/end', 5, t0 + 9 * MINUTE + 3000, { turn: 1, reason: { kind: 'completed' } }),
	]
	writeFrames(sessionFile(projectDir, 'session-fff'), f)

	// G：坏帧不该拖垮进程（中间插一个非 zstd 垃圾字节帧）
	const g = [
		...baseEvents('坏帧会话'),
		entry('turn/start', 2, t0 + 10 * MINUTE, { turn: 1 }),
		entry('turn/end', 3, t0 + 10 * MINUTE + 25_000, { turn: 1, reason: { kind: 'completed' } }),
	]
	writeFrames(sessionFile(projectDir, 'session-ggg'), g)
	appendFileSync(sessionFile(projectDir, 'session-ggg'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xde, 0xad, 0xbe, 0xef]))

	// H：子 agent 会话（header origin=subagent）——里面有 approval/question/turn-end，
	// 但默认必须全部忽略，不能进任何通道。
	const subId = 'sub-2dfb8e42-fbe8-48ee-87f9-a4119df08a1b'
	const sub = [
		`${JSON.stringify({ type: 'session', version: 4, id: subId, createdAt: NOW - 10 * MINUTE, cwd: '/Users/tester/Desktop/fixture', parentSession: 'session-ccc', isSeeded: false, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' })}\n`,
		entry('turn/start', 1, t0 + 12 * MINUTE, { turn: 1 }),
		entry('approval/asked', 2, t0 + 12 * MINUTE + 1000, { id: 'sub-apr', toolName: 'bash', reason: '子 agent 的审批不该通知' }),
		entry('tool/call', 3, t0 + 12 * MINUTE + 2000, { turn: 1, step: 1, callId: 'sub-ask', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '子 agent 的问题不该通知' }] }) }),
		entry('approval/decided', 4, t0 + 12 * MINUTE + 3000, { id: 'sub-apr', outcome: 'allowed-once' }),
		entry('tool/result', 5, t0 + 12 * MINUTE + 3000, { turn: 1, step: 1, toolCallId: 'sub-ask', message: { role: 'tool', content: [{ type: 'text', text: '{}' }] } }),
		entry('turn/end', 6, t0 + 13 * MINUTE, { turn: 1, reason: { kind: 'completed' } }),
	]
	writeFrames(sessionFile(projectDir, subId), sub)

	return { projectDir, subId }
}

function runOnce(env) {
	const result = spawnSync(NODE, [CLI, 'once', '--json'], {
		env: { ...process.env, ...env, DSH_NOTIFY_WECHAT: 'off', DSH_NOTIFY_DESKTOP: 'off' },
		encoding: 'utf8',
		timeout: 30_000,
	})
	if (result.status !== 0) {
		throw new Error(`once 退出码 ${result.status}\nstdout:${result.stdout}\nstderr:${result.stderr}`)
	}
	try {
		return JSON.parse(result.stdout)
	} catch (error) {
		throw new Error(`once 输出不是 JSON: ${error}\n${result.stdout}`)
	}
}

async function main() {
	const { home, sessionsRoot, stateDir } = makeHome()
	const { projectDir } = writeSessions(join(sessionsRoot, '--Users-tester-Desktop-fixture--'))
	const configFile = join(home, 'config.json')
	writeFileSync(configFile, JSON.stringify({ test: { demoAlertTtlMs: 1500 } }))

	const env = {
		DSH_NOTIFY_SESSIONS: sessionsRoot,
		DSH_NOTIFY_STATE_DIR: stateDir,
		DSH_NOTIFY_CONFIG: configFile,
		DSH_NOTIFY_WECHAT: 'off',
		DSH_NOTIFY_DESKTOP: 'off',
	}

	// ── 1. 首次扫描：只重建 pending；历史 turn/end 不能变成 done 通知 ──
	const first = runOnce(env)
	const pendingIds = (first.pending ?? []).map((alert) => alert.id)
	assert.ok(pendingIds.some((id) => id.startsWith('question:')), `缺 question pending：${JSON.stringify(pendingIds)}`)
	assert.ok(pendingIds.some((id) => id.startsWith('approval:')), `缺 approval pending：${JSON.stringify(pendingIds)}`)
	assert.equal((first.recentDone ?? []).length, 0, `启动时历史 turn/end 不应产生 recentDone：${JSON.stringify(first.recentDone)}`)
	assert.equal(
		[...pendingIds, ...(first.recentDone ?? []).map((alert) => alert.id)].some((id) => id.includes('sub-2dfb8e42')),
		false,
		'子 agent 会话不应产生任何 alert',
	)
	assert.equal(pendingIds.filter((id) => id.includes('apr-2')).length, 0, '已批准的审批不应 pending')
	assert.equal(pendingIds.filter((id) => id.includes('call-ask-2')).length, 0, '已回答的问题不应 pending')
	for (const alert of first.pending ?? []) {
		assert.equal(alert.status, 'pending')
		assert.ok(alert.project, 'alert 应带 project')
		assert.ok(!String(alert.body ?? '').includes('不该出现在通知里的思考过程'), 'reasoning 不应进通知')
	}

	// ── 2. 解除等待后再扫：pending 清空，resolved 的 approval/question 不进 recentDone ──
	const askResult = entry('tool/result', 6, NOW, {
		turn: 1,
		step: 1,
		toolCallId: 'call-ask-1',
		message: { role: 'tool', content: [{ type: 'text', text: '{"answers":[]}' }] },
	})
	appendFrame(sessionFile(projectDir, 'session-aaa'), askResult)
	appendFrame(sessionFile(projectDir, 'session-aaa'), entry('turn/end', 7, NOW + 1000, { turn: 1, reason: { kind: 'completed' } }))
	appendFrame(sessionFile(projectDir, 'session-bbb'), entry('approval/decided', 5, NOW + 2000, { id: 'apr-1', outcome: 'rejected' }))
	appendFrame(sessionFile(projectDir, 'session-bbb'), entry('turn/end', 6, NOW + 3000, { turn: 1, reason: { kind: 'aborted' } }))

	const second = runOnce(env)
	assert.equal((second.pending ?? []).length, 0, `解除后 pending 应为空：${JSON.stringify(second.pending)}`)
	assert.equal((second.recentDone ?? []).length, 0, `resolved 的 approval/question 不应进 recentDone：${JSON.stringify(second.recentDone)}`)

	// ── 3. 真 daemon：/state、/test 的 demo alert、启动后的新 turn/end ──
	const port = 19600 + Math.floor(Math.random() * 300)
	const child = spawn(NODE, [CLI, 'run'], {
		env: { ...process.env, ...env, DSH_NOTIFY_PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stderr = ''
	child.stderr.on('data', (chunk) => {
		stderr += chunk
	})
	const base = `http://127.0.0.1:${port}`
	const getJson = async (path, options = {}) => {
		const response = await fetch(`${base}${path}`, {
			method: options.method ?? 'GET',
			headers: options.body ? { 'content-type': 'application/json' } : undefined,
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal: AbortSignal.timeout(2500),
		})
		return { status: response.status, body: await response.json() }
	}
	const waitFor = async (label, predicate, timeoutMs = 6000) => {
		const started = Date.now()
		while (Date.now() - started < timeoutMs) {
			try {
				const state = (await getJson('/state')).body
				if (predicate(state)) return state
			} catch {
				/* 还没起来 */
			}
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
		throw new Error(`等待超时：${label}；stderr=${stderr.slice(-2000)}`)
	}
	try {
		const health = await waitFor('daemon 起来', () => true, 10_000).then(() => getJson('/health'))
		assert.equal(health.body.ok, true)
		const initial = await getJson('/state')
		assert.equal((initial.body.recentDone ?? []).length, 0, 'daemon 启动时不应有历史 done')

		// /test：demo alert 应进入 pending → 自动消失
		const tested = await getJson('/test', { method: 'POST', body: { title: 'E2E 自检', body: 'demo alert' } })
		assert.equal(tested.body.ok, true, `POST /test 应成功：${JSON.stringify(tested.body)}`)
		assert.ok(tested.body.demoAlertId, '/test 应返回 demoAlertId')
		const withDemo = await waitFor('demo alert 出现在 pending', (state) =>
			(state.pending ?? []).some((alert) => alert.id === tested.body.demoAlertId))
		assert.ok(withDemo.pending.length >= 1)
		await new Promise((resolve) => setTimeout(resolve, 2200))
		const afterDemo = await getJson('/state')
		assert.equal(
			(afterDemo.body.pending ?? []).some((alert) => alert.id === tested.body.demoAlertId),
			false,
			'demo alert 应在 TTL 后自动消失',
		)

		// 启动后新增一个 turn/end（completed）→ 应产生 1 条 turn-done
		const t = Date.now()
		appendFrame(
			sessionFile(projectDir, 'session-ccc'),
			entry('turn/start', 7, t, { turn: 2 }) +
				entry('tool/call', 8, t + 500, { turn: 2, step: 1, callId: 'call-new', name: 'bash', arguments: '{}' }) +
				entry('assistant/message', 9, t + 29_000, {
					turn: 2,
					step: 2,
					message: { role: 'assistant', content: [{ type: 'text', text: '新的这一轮也做完了。' }] },
				}) +
				entry('turn/end', 10, t + 30_000, { turn: 2, reason: { kind: 'completed' } }),
		)
		const doneState = await waitFor('新的 turn-done 出现', (state) =>
			(state.recentDone ?? []).some((alert) => alert.id === `turn-done:session-ccc:2`))
		const done = (doneState.recentDone ?? []).find((alert) => alert.id === 'turn-done:session-ccc:2')
		assert.equal(done.status, 'resolved')
		assert.ok(done.body.includes('新的这一轮也做完了') || done.title.includes('完成'), `done 内容不对：${JSON.stringify(done)}`)

		// 启动后新增一个 error turn → 正文必须是原因，不能是 [object Object]
		const te = Date.now()
		appendFrame(
			sessionFile(projectDir, 'session-ccc'),
			entry('turn/start', 13, te, { turn: 4 }) +
				entry('turn/end', 14, te + 2000, {
					turn: 4,
					reason: { kind: 'error', error: { message: 'transport failed' } },
				}),
		)
		const errState = await waitFor('新的 turn-error 出现', (state) =>
			(state.recentDone ?? []).some((alert) => alert.id === 'turn-error:session-ccc:4'))
		const errAlert = (errState.recentDone ?? []).find((alert) => alert.id === 'turn-error:session-ccc:4')
		assert.ok(String(errAlert.body).includes('transport failed'), `turn-error 正文丢了原因：${JSON.stringify(errAlert.body)}`)
		assert.ok(!String(errAlert.body).includes('[object Object]'), 'turn-error 正文不能是 [object Object]')

		// /ack 一个真实 pending（造一个新的 pending question，然后 ack 掉）
		appendFrame(
			sessionFile(projectDir, 'session-ccc'),
			entry('turn/start', 11, t + 20_000, { turn: 3 }) +
				entry('tool/call', 12, t + 21_000, {
					turn: 3,
					step: 1,
					callId: 'call-live-ask',
					name: 'ask_user_question',
					arguments: JSON.stringify({ questions: [{ id: 'q', question: '现在要回答吗？' }] }),
				}),
		)
		const livePending = await waitFor('新的 pending question 出现', (state) =>
			(state.pending ?? []).some((alert) => alert.id === 'question:session-ccc:call-live-ask'))
		const liveAlert = livePending.pending.find((alert) => alert.id === 'question:session-ccc:call-live-ask')
		assert.ok(liveAlert.body.includes('现在要回答吗'), 'question body 应含问题原文')
		const acked = await getJson('/ack', { method: 'POST', body: { id: liveAlert.id } })
		assert.equal(acked.body.ok, true, `ack 应成功：${JSON.stringify(acked.body)}`)
		const afterAck = await getJson('/state')
		assert.equal((afterAck.body.pending ?? []).some((alert) => alert.id === liveAlert.id), false, 'ack 后不应再 pending')
	} finally {
		child.kill('SIGTERM')
		await new Promise((resolve) => child.once('exit', resolve))
		rmSync(home, { recursive: true, force: true })
	}

	process.stdout.write(
		[
			'✅ E2E 全过',
			'  - 首次扫描：pending(question+approval) 识别；历史 turn/end 不产生 done 刷屏',
			'  - 解除等待后 pending 清空；resolved 的 approval/question 不进 recentDone',
			'  - 跨帧半行 / 坏帧容错 / 重复扫描去重',
			'  - daemon HTTP /health /state；/test 注入 demo alert 并 TTL 自动消失',
			'  - daemon 启动后新增 turn/end → recentDone 恰好一条；/ack 生效',
		].join('\n') + '\n',
	)
}

main().catch((error) => {
	process.stderr.write(`❌ E2E 失败：${String(error?.stack ?? error)}\n`)
	process.exit(1)
})
