# Vendored WeChat iLink core

来源：`dsh-wechat-plugin@0.46.0`（npm tarball，MIT License）
- 仓库：https://github.com/xcisxc29/dsh-wechat
- 本目录只包含该包的 `dist/`（`@dsh-wechat/core` 的构建产物），未修改。
- 用途：`dsh-notify` 只用它做**单向发消息**（以及保活/记录回复窗口用的长轮询）。
- 升级方式：下载新版本 tarball，替换本目录并重跑 `node --test test/wechat.test.mjs`。

注意：上游 `package.json` 里的 `dependencies`（qrcode）只被插件的 UI/CLI 用到；
这里的单向通道与 core 不需要额外依赖。
