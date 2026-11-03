/**
 * 一次性诊断：用存好的 bot 凭据跑 iLink 长轮询，等用户从微信发一条消息，
 * 记下 peerId / contextToken / syncBuf，并回一条测试消息证明「电脑 → 微信」是通的。
 *
 * 它不改 DSH、不接 agent、不执行任何指令——只验证双向链路里我们需要的两段。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChannelMonitor, StateStore, conversationKey, sendText } from '../wechat-core-dist/core/lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEV = join(ROOT, 'dev', 'wechat')
const WAIT_MS = Number(process.argv[2] ?? '240000')

mkdirSync(DEV, { recursive: true })
const seeds = JSON.parse(readFileSync(join(DEV, 'account-seed.json'), 'utf8'))
const account = {
  accountId: seeds.accountId,
  token: seeds.token,
  baseUrl: seeds.baseUrl,
  userId: seeds.userId,
  savedAt: new Date().toISOString(),
  boundAt: new Date().toISOString(),
}

const store = new StateStore(join(DEV, 'state.json'))
await store.update((state) => {
  state.accounts[account.accountId] = account
  state.autoStart = true
})

const peerFile = join(DEV, 'peer.json')
const ac = new AbortController()
let done = false
let stopReason = 'timeout'

const monitor = new ChannelMonitor({
  account,
  initialSyncBuf: (await store.read()).syncBufs[account.accountId],
  onSyncBuf: async (buf) => {
    await store.update((state) => { state.syncBufs[account.accountId] = buf })
  },
  onError: (error) => console.log('[monitor-error]', String(error?.message ?? error)),
  onStop: (reason, detail) => {
    stopReason = `${reason}${detail ? `:${detail}` : ''}`
  },
  onMessage: async (message) => {
    console.log('[inbound]', JSON.stringify({
      accountId: message.accountId,
      peerId: message.peerId,
      conversationId: message.conversationId,
      textLength: message.text?.length ?? 0,
      hasContextToken: Boolean(message.contextToken),
      receivedAt: new Date(message.receivedAt).toISOString(),
    }))
    const conversationId = message.conversationId || conversationKey(account.accountId, message.peerId, message.groupId)
    await store.update((state) => {
      if (message.contextToken) {
        (state.contextTokens[account.accountId] ??= {})[conversationId] = message.contextToken
      }
    })
    const peer = {
      accountId: account.accountId,
      peerId: message.peerId,
      conversationId,
      lastInboundAt: Date.now(),
      lastInboundMessageId: message.messageId ?? null,
    }
    writeFileSync(peerFile, `${JSON.stringify(peer, null, 2)}\n`, { mode: 0o600 })

    // 先证明「电脑 → 微信」：回一条明确的测试消息。
    try {
      await sendText({
        account,
        to: message.peerId,
        text: [
          '✅ DSH 通知通道已接通（仅单向）',
          '',
          '这条是电脑主动推来的测试消息。',
          '这条通道只负责「通知」：你给它发任何指令都不会被电脑执行，也不会进任何会话。',
        ].join('\n'),
        ...(message.contextToken ? { contextToken: message.contextToken } : {}),
      })
      console.log('[outbound-ok] test message sent')
      writeFileSync(join(DEV, 'probe-result.json'), `${JSON.stringify({ ok: true, at: Date.now(), peerId: message.peerId }, null, 2)}\n`)
    } catch (error) {
      console.log('[outbound-failed]', String(error?.message ?? error))
      writeFileSync(join(DEV, 'probe-result.json'), `${JSON.stringify({ ok: false, at: Date.now(), error: String(error?.message ?? error) }, null, 2)}\n`)
    }
    done = true
    ac.abort()
  },
})

console.log(JSON.stringify({ phase: 'listening', accountId: account.accountId, waitMs: WAIT_MS }))
const timer = setTimeout(() => ac.abort(), WAIT_MS)
const run = monitor.run(ac.signal)
await Promise.race([run, new Promise((resolve) => setTimeout(resolve, WAIT_MS + 5000))])
clearTimeout(timer)
if (!done) {
  console.log(JSON.stringify({ phase: 'timeout', stopReason }))
  process.exit(3)
}
const paused = monitor.paused
if (paused) console.log('[warn] token cooldown active:', monitor.remainingPauseMs)
await monitor.notifyStop().catch(() => {})
console.log('[done] probe finished')
process.exit(0)
