# dev/ 只放一次性验证痕迹

这里**不再保留任何微信 bot 凭据**（token 只保存在 `~/.dsh/wechat/state.json`，0600）。
首次安装时按主 README 的说明准备运行环境；已装好的机器不会再读取本目录。

`scripts/wechat-listen.mjs` 是一次性诊断脚本，需要手工把 token 放进
`dev/wechat/account-seed.json` 才能跑；日常不要用。
