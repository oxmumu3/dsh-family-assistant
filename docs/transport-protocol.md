# 微信传输层：协议与验证边界

本实现独立保存家庭助手自己的凭据，不读其他微信桥接、OpenClaw 或日常微信客户端的登录资料。一个成员对应一个 account/peer 绑定；手机扫码与确认由用户本人完成。

协议依据为腾讯发布的 [`@tencent-weixin/openclaw-weixin@2.4.10`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin/v/2.4.10)，直接只读检查 npm 官方 registry tarball 中的 `src/api/api.ts`、`src/api/types.ts`、`src/auth/login-qr.ts` 与 `package.json`，没有执行第三方包。已有 `dsh-dot-wechat-bridge` 仅用于交叉检查协议和历史错误处理边界。协议实现是此包自己的代码，不依赖外部桥接运行时。

## 登录

- `POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3`，body 为 `{"local_token_list":[]}`，不携带其他产品的 token。
- `GET /ilink/bot/get_qrcode_status?qrcode=...`，必要时携带 `verify_code=...`。
- 公共头包括 `iLink-App-Id: bot` 与兼容 2.4.10 的数字版本。JSON POST 使用 `AuthorizationType: ilink_bot_token` 以及随机 uint32 十进制字符串的 base64 `X-WECHAT-UIN`。
- 状态 `wait / scaned / need_verifycode / confirmed / expired` 映射到用户可见状态。`submitCode(personId, code)` 只接受 1–12 位数字，验证码仅短暂保留内存。验证码错误时再次等待人工输入；`verify_code_blocked` 停止本次登录。
- `scaned_but_redirect` 按该二维码独立记录 Tencent IDC 地址；`baseurl`、`redirect_host` 和所有携带凭据的请求必须为 HTTPS 的 `*.weixin.qq.com`，不允许 URL 用户信息、非默认端口、路径、查询或 fragment，不自动跟随 HTTP redirect。
- 登录最长五分钟，不自动新开二维码、不无限轮转。重复登录使该成员上一轮失效，不影响其他成员。`binded_redirect` 仅能恢复该成员已存在的独立凭据；没有凭据时报告错误。

`login()` 返回二维码后后台轮询，不等待手机操作。`connect()` 回调 `onBound` 恢复域模型提供的完整 route；域模型决定 generation，同一身份恢复不应人为增加 generation。

## 收发与持久化

`POST /ilink/bot/getupdates` 携带独立 `get_updates_buf`。只接受绑定 peer 的私聊、用户消息；忽略其他 peer、group 以及不匹配的目标 account。正文支持文本和腾讯已返回转写文字的语音；图片、文件、无转写语音等标为 `unsupported`，不下载媒体。

每个成员的 `<directory>/<personId>/auth.json` 以原子替换保存，权限 0600，成员目录 0700；保存其 token、account、peer、cursor 和最新 context token。最新 context token 在处理当前消息前保存，允许当前消息处理器立即回复；cursor 必须等该页所有已接受消息的 `onMessage` 完成后才保存。回调失败时重新轮询原 cursor，域模型承担持久去重。

每个成员有自己的 longpoll 与 outbound mutex，不同成员可并行发送。发送前与获得锁后都核对 `personId/accountId/peerId/generation`；没有默认接收人。断开只终止指定成员的任务并保留其凭据。

`POST /ilink/bot/sendmessage` 按腾讯 BOT/FINISH/text item 结构发送，并携带当前 context token。只有明确 `ret:0`、`errcode:0` 或有效 message ID 才记录 `api_accepted`；任何非零业务码优先判失败。网络中断、HTTP 异常、空或不明确响应归为 `uncertain`，从不自动重发。`api_accepted` 仅证明微信 API 接受，不能证明手机实际送达或已读。

## 测试 seam 与已验证范围

`createWeixinApi({fetchImpl})` 是显式假 fetch seam；URL 安全校验在测试中也不放宽。`createChannelManager({api})` 可注入独立协议适配器。测试全部使用临时目录和合成身份、token、消息；没有真实登录或发送，也没有操作微信客户端。

运行 `node --test test/weixin.test.mjs test/channels.test.mjs`，覆盖三个并行账号隔离、外来 peer/group、断开一个账号、错误 route generation、发送串行化、业务拒绝和不明确结果、cursor 回调顺序、恢复连接、验证码及有限超时、二维码 IDC 路由与并发替换登录。真实扫码授权、真实服务端互通和手机显示仍需用户本人做验收。
