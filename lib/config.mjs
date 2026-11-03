/**
 * 配置加载：默认值 + config.json + 环境变量覆盖。
 *
 * 设计原则：
 *  - 缺文件不是错误，全部走默认值（守护进程必须能"装完就跑"）；
 *  - 坏 JSON 是错误，但要报得具体（哪个文件、哪一行），不能静默吞掉；
 *  - 环境变量只覆盖"测试/诊断真的需要换"的那几项，其余一律走文件，
 *    免得出现"配置在文件里写了却不生效"的第二种真相。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HOME = homedir()

/** 把 `~/x` 展开成绝对路径；已是绝对路径就原样返回。 */
export function expandHome(value) {
	if (typeof value !== 'string') return value
	if (value === '~') return HOME
	if (value.startsWith('~/')) return join(HOME, value.slice(2))
	return value
}

/** 内置默认值。与 docs/SPEC.md §8 保持一致。 */
export function defaultConfig() {
	const stateDir = join(HOME, '.dsh', 'notify')
	return {
		stateDir,
		sessions: {
			root: join(HOME, '.dsh', 'sessions'),
			startupLookbackMinutes: 120,
		},
		server: { port: 19400, host: '127.0.0.1' },
		notify: {
			approval: true,
			question: true,
			turnDone: true,
			turnError: true,
			minTurnSeconds: 20,
			escalateAfterSeconds: [180, 600, 1800],
			pendingMaxAgeHours: 12,
			quietHours: null,
		},
		channels: {
			desktop: { enabled: true, fallbackWhenWidgetStale: true, widgetStaleSeconds: 30 },
			wechat: {
				enabled: true,
				statePath: join(HOME, '.dsh', 'wechat', 'state.json'),
				selfReplyThrottleMinutes: 10,
				maxQueue: 5,
				// 微信只推「需要人处理」+「最终汇报」；question（中间问答）默认不推。
				// `["*"]` 表示全部推送。
				events: ['approval', 'turn-done', 'turn-error'],
			},
		},
	}
}

function deepMerge(base, patch) {
	if (patch === null || patch === undefined) return base
	if (Array.isArray(patch) || typeof patch !== 'object') return patch
	const out = { ...base }
	for (const [key, value] of Object.entries(patch)) {
		const current = out[key]
		out[key] =
			current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)
				? deepMerge(current, value)
				: value
	}
	return out
}

/** 读 JSON；坏文件抛带路径的错误，不存在返回 null。 */
export function readJsonFile(file) {
	if (!existsSync(file)) return null
	let text
	try {
		text = readFileSync(file, 'utf8')
	} catch (error) {
		throw new Error(`读不了配置文件 ${file}：${String(error?.message ?? error)}`)
	}
	try {
		return JSON.parse(text)
	} catch (error) {
		throw new Error(`配置文件不是合法 JSON：${file}（${String(error?.message ?? error)}）`)
	}
}

/**
 * 生成生效配置。
 * @param env - 环境变量表（测试时可传假对象）
 */
export function loadConfig(env = process.env) {
	const configPath = env.DSH_NOTIFY_CONFIG ? expandHome(env.DSH_NOTIFY_CONFIG) : join(HOME, '.dsh', 'notify', 'config.json')
	const defaults = defaultConfig()
	const fileConfig = readJsonFile(configPath) ?? {}
	const config = deepMerge(defaults, fileConfig)

	// 路径统一展开 + 规范化，避免 "~" 在 fork/subprocess 里又被当成普通字符。
	config.stateDir = resolve(expandHome(String(config.stateDir)))
	config.sessions.root = resolve(expandHome(String(config.sessions.root)))
	config.channels.wechat.statePath = resolve(expandHome(String(config.channels.wechat.statePath)))

	if (env.DSH_NOTIFY_STATE_DIR) config.stateDir = resolve(expandHome(env.DSH_NOTIFY_STATE_DIR))
	if (env.DSH_NOTIFY_SESSIONS) config.sessions.root = resolve(expandHome(env.DSH_NOTIFY_SESSIONS))
	if (env.DSH_NOTIFY_WECHAT_STATE) config.channels.wechat.statePath = resolve(expandHome(env.DSH_NOTIFY_WECHAT_STATE))
	if (env.DSH_NOTIFY_PORT) {
		const port = Number(env.DSH_NOTIFY_PORT)
		if (Number.isInteger(port) && port > 0 && port < 65536) config.server.port = port
	}
	if (env.DSH_NOTIFY_WECHAT === 'off' || env.DSH_NOTIFY_WECHAT === '0') config.channels.wechat.enabled = false
	if (env.DSH_NOTIFY_DESKTOP === 'off' || env.DSH_NOTIFY_DESKTOP === '0') config.channels.desktop.enabled = false
	if (env.DSH_NOTIFY_QUIET === 'off') config.notify.quietHours = null

	config.configPath = configPath
	config.configExists = existsSync(configPath)
	return config
}
