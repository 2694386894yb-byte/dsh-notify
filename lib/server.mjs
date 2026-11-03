/**
 * 本机 HTTP 服务（SPEC §6）。
 *
 * 只绑定 127.0.0.1，不做鉴权（本机用）。挂件每 3s 拉 `/state`；CLI 用
 * `/health`、`/test`。所有响应 `application/json; charset=utf-8`。
 *
 *   GET  /health  → {ok, uptimeMs, watcher:{...}, channels:{...}}
 *   GET  /state   → {generatedAt, pending, recentDone, counts, channels}
 *   POST /test    → {desktop, wechat}
 *   POST /ack     → {ok, alert}
 *
 * 服务起不来（端口被占）不应该拖垮通知：错误由 daemon 记录，通知循环继续。
 */
import { createServer } from 'node:http'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 64 * 1024

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload)
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	})
	response.end(body)
}

function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		request.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				const error = new Error('请求体太大')
				error.statusCode = 413
				request.destroy()
				reject(error)
				return
			}
			chunks.push(chunk)
		})
		request.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim()
			if (!text) {
				resolve({})
				return
			}
			try {
				const parsed = JSON.parse(text)
				resolve(parsed && typeof parsed === 'object' ? parsed : {})
			} catch {
				const error = new Error('请求体不是合法 JSON')
				error.statusCode = 400
				reject(error)
			}
		})
		request.on('error', (error) => reject(error))
	})
}

function isLoopback(request) {
	const address = request.socket?.remoteAddress ?? ''
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 创建 HTTP 服务。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.daemon - 至少提供 health()/getState()/test()/ack()
 * @param {object} [options.logger]
 */
export function createHttpServer({ config, daemon, logger = console } = {}) {
	if (!daemon) throw new TypeError('createHttpServer 需要 daemon')

	const desiredPort = Number(config?.server?.port)
	const port = Number.isInteger(desiredPort) && desiredPort >= 0 && desiredPort < 65536 ? desiredPort : 19400
	let server = null
	let startError = null
	let boundPort = null

	async function handle(request, response) {
		if (!isLoopback(request)) {
			sendJson(response, 403, { ok: false, error: '只接受本机请求' })
			return
		}
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const route = url.pathname.replace(/\/+$/, '') || '/'

		if (route === '/health') {
			if (request.method !== 'GET') {
				sendJson(response, 405, { ok: false, error: '只支持 GET' })
				return
			}
			sendJson(response, 200, daemon.health())
			return
		}

		if (route === '/state') {
			if (request.method !== 'GET') {
				sendJson(response, 405, { ok: false, error: '只支持 GET' })
				return
			}
			sendJson(response, 200, daemon.getState())
			return
		}

		if (route === '/test') {
			if (request.method !== 'POST') {
				sendJson(response, 405, { ok: false, error: '只支持 POST' })
				return
			}
			const payload = await readJsonBody(request)
			sendJson(response, 200, await daemon.test(payload))
			return
		}

		if (route === '/ack') {
			if (request.method !== 'POST') {
				sendJson(response, 405, { ok: false, error: '只支持 POST' })
				return
			}
			const payload = await readJsonBody(request)
			const id = typeof payload.id === 'string' ? payload.id : ''
			if (!id) {
				sendJson(response, 400, { ok: false, error: '需要 id' })
				return
			}
			const result = await daemon.ack(id)
			sendJson(response, result?.ok ? 200 : 404, result)
			return
		}

		if (route === '/' || route === '/help') {
			sendJson(response, 200, {
				ok: true,
				service: 'dsh-notify',
				endpoints: ['GET /health', 'GET /state', 'POST /test', 'POST /ack'],
			})
			return
		}

		sendJson(response, 404, { ok: false, error: `没有这个接口：${route}` })
	}

	/** @returns {Promise<number>} 实际监听端口 */
	function start() {
		if (server) return Promise.resolve(boundPort)
		return new Promise((resolve, reject) => {
			const instance = createServer((request, response) => {
				Promise.resolve()
					.then(() => handle(request, response))
					.catch((error) => {
						const status = Number(error?.statusCode) || 500
						logger?.error?.(`[server] ${request.method} ${request.url} 出错：${String(error?.message ?? error)}`)
						try {
							sendJson(response, status, { ok: false, error: String(error?.message ?? error) })
						} catch {
							/* 响应可能已发出 */
						}
					})
			})
			instance.on('error', (error) => {
				startError = String(error?.message ?? error)
				logger?.error?.(`[server] 监听 ${LOOPBACK_HOST}:${port} 失败：${startError}`)
				if (!server) reject(error)
			})
			instance.listen(port, LOOPBACK_HOST, () => {
				server = instance
				startError = null
				boundPort = instance.address()?.port ?? port
				logger?.info?.(`[server] HTTP 已监听 http://${LOOPBACK_HOST}:${boundPort}`)
				resolve(boundPort)
			})
		})
	}

	function stop() {
		if (!server) return Promise.resolve()
		const instance = server
		server = null
		return new Promise((resolve) => {
			instance.close(() => resolve())
			// 挂件/CLI 的 keep-alive 连接不能把进程卡在 close 上。
			instance.closeAllConnections?.()
		})
	}

	return {
		start,
		stop,
		address: () => (server?.address() ?? null),
		get port() {
			return boundPort ?? port
		},
		get listening() {
			return Boolean(server?.listening)
		},
		get error() {
			return startError
		},
	}
}
