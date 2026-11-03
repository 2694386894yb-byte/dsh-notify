# dsh-notify — DSH 通知守护进程

把 DSH 的三种「需要人」时刻变成看得见的通知：

| 事件 | 电脑（挂件 / 系统通知） | 手机（微信） |
|---|---|---|
| 需要你批准（`approval/asked`） | ✅ 原生通知 + 挂件红条 | ✅ 微信消息 |
| 需要你回答（`ask_user_question`） | 挂件红条（**不弹系统通知**） | —（默认不推） |
| 每轮做完 / 出错（`turn/end`） | ✅ 原生通知 | ✅ 微信消息（最终汇报） |
| 同一条还挂着 | approval 每 3 / 10 / 30 分钟再提醒 | 同左 |

> **降噪优先（用户 2026-10-25 反馈）**：微信只推「批准/授权」和「最终汇报」；
> 中间问答、子 agent（teammate / subagent）的完成一律不推。要改：
> `~/.dsh/notify/config.json` → `channels.wechat.events`（如 `["*"]` 全推）。

**微信通道是单向的**：微信只负责收通知；你发给机器人的任何内容都不会被执行、不会进 agent。
（这条通道复用了腾讯 iLink / WeChat ClawBot 的官方 bot 协议，客户端代码以 MIT 许可 vendored 在
`wechat-core-dist/`，来自 [`dsh-wechat-plugin@0.46.0`](https://github.com/xcisxc29/dsh-wechat)。）

---

## 架构

```
~/.dsh/sessions/**/session.v4.jsonl.zstd        （DSH 自己写的会话日志，实时落盘）
        │  每秒 stat，变了才读；多 zstd 帧增量解压
        ▼
dsh-notify  daemon  ── 127.0.0.1:19400 /state /health /test /ack
        │                    │
        │                    └──▶ DSHWidget 每 3s 拉取：挂件「需要你处理」区块
        │                          + 原生 UNUserNotification（点击激活 DSH）
        │
        └──▶ 微信单向通道：StateStore(~/.dsh/wechat/state.json)
              · 长轮询保活 + 记录 contextToken（回复窗口）
              · 每窗口最多 10 条；超出排队，等你下次发消息自动补发
```

### 为什么读会话日志，而不是装 DSH 插件

- DSH 的审批/提问是**宿主进程内存里**的交互，没有对外的通知接口；
- 但两者都会落盘成 `approval/asked`、`ask_user_question` 的 `tool/call` 事件，**毫秒级**可见；
- 读日志不需要重启 DSH、不改 DSH 内部、DSH 升级也不会把通知系统弄坏。

### 为什么微信只做单向

微信 bot 的双向版本等于「手机 = 这台电脑的 Shell」。`dsh-notify` 刻意**不接 agent**：
入站消息只用来记录 peer / 重开回复窗口，并回一句固定文案。想双向操作时再另装官方插件，
与本工具互不依赖。

---

## 安装（macOS）

```bash
node bin/dsh-notify.mjs doctor   # 自检：会话日志 / 配置 / 权限（在仓库根目录执行）
node bin/dsh-notify.mjs run        # 前台试跑，按 Ctrl-C 退出
```

确认能收到通知后，把 `run` 放进 `~/Library/LaunchAgents/` 的 LaunchAgent（KeepAlive），
或交给任意进程守护工具托管。运行时会读写：

- `~/.dsh/notify/config.json`：配置（示例见 `config.example.json`）
- `~/.dsh/notify/state.json`：alert 状态（自动生成）
- `~/.dsh/notify/wechat-peer.json`：微信 peer / 队列（0600，自动生成）
- `~/.dsh/wechat/state.json`：微信 bot 凭据（0600，与官方插件同格式，不随仓库分发）

桌面挂件（desktop-widget 仓库）**不是必需的**；没有挂件时只发系统通知。

## 日常命令

在仓库根目录执行：

```bash
NODE="$(command -v node)"
CLI="bin/dsh-notify.mjs"

"$NODE" "$CLI" doctor          # 自检：日志/微信/挂件心跳/daemon
"$NODE" "$CLI" state           # 当前 pending + 最近完成
"$NODE" "$CLI" test            # 发一条测试通知（桌面 + 微信）
"$NODE" "$CLI" once            # 扫一遍，只打印不发送
"$NODE" "$CLI" wechat-status   # 微信通道状态（窗口用量/队列/最后错误）
```

## 配置

`~/.dsh/notify/config.json`（示例见 `config.example.json`）：

- `notify.minTurnSeconds`：短于这个秒数的轮次不推「完成」（默认 20）
- `notify.escalateAfterSeconds`：同一 pending 的升级提醒时间点（默认 180/600/1800 秒）
- `notify.quietHours`：`{"start":"23:30","end":"07:30"}`；审批/提问不受限，完成/出错静默
- `channels.wechat.enabled`：关掉手机推送（仍保留电脑通知）
- `channels.wechat.events`：默认 `["approval","turn-done","turn-error"]`；`["*"]` 全推
- `notify.includeSubagents`：默认 `false`，子 agent 会话整体不通知
- `notify.pendingMaxAgeHours`：僵尸 pending 自愈上限（默认 12 小时）
- `channels.desktop.fallbackWhenWidgetStale`：挂件没开时 daemon 用 osascript 兜底

环境变量（测试用）：`DSH_NOTIFY_STATE_DIR`、`DSH_NOTIFY_SESSIONS`、`DSH_NOTIFY_PORT`、
`DSH_NOTIFY_WECHAT_STATE`、`DSH_NOTIFY_WECHAT=off`、`DSH_NOTIFY_DESKTOP=off`、`DSH_NOTIFY_CONFIG`。

## 微信通道维护

- **换 bot / 旧凭据失效**：`node "$CLI" wechat-bind`（会打开二维码图片，手机微信扫码确认），
  然后给机器人发一句话，让通道记下 peer 与回复窗口；
- **已有 token**：`node "$CLI" wechat-adopt --token "<accountId>:<secret>"`；
- **窗口用完**（`wechat-status` 里 `windowUsed=10`）：在微信里给机器人随便发一句话即可重开；
  排队中的通知会自动补发。
- 凭据文件 `0600`；本工具只连腾讯 `ilinkai.weixin.qq.com` 与微信 CDN，没有第三方中转。

## 已知限制（诚实版）

1. **微信回复窗口**是平台限制：每个窗口最多 10 条、只有你发消息才会重开。通知多时会排队，
   不是丢了，但需要你在微信里回一句。
2. **电脑通知需要挂件在跑**；挂件没开时 daemon 用 osascript 兜底（通知归属「脚本编辑器」，
   点击不会激活 DSH）。挂件首次运行要在系统弹窗里允许通知。
3. 会话日志是内部格式，DSH 大版本升级可能变；`doctor` + `test` 是最快的回归检查。
4. 只覆盖「审批 / 轮次结束」。子 agent、后台 job、中间问答默认不推（避免噪音）。
5. 待处理项超过 12 小时未解决会自动过期（防僵尸红条）；可用 `notify.pendingMaxAgeHours` 调整。
