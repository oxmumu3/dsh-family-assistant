# 宿主兼容与版本维护

0.2.0-preview.32 是公开 preview.31 的兼容修复。支持精确验证的 Harness 0.2.1-rc.2、rc.3、rc.4、rc.5；不使用版本豁免。个人账号、微信送达及家庭权限仍需按实际连接分别验收。

`compatibility.json` 是版本清单；`node scripts/compatibility.mjs --latest` 检查官方 npm latest，出现未验证版本或声明偏离即失败，不自动扩大范围或安装。官方 alpha 独立通道不等于当前公开支持。Actions 工作流集成尚受仓库 workflow 权限阻挡，当前用独立工程跟进与发布前人工核验，不宣称服务器定时门禁已启用。

## 自动兼容门禁

GitHub Actions 对 main push、PR、手动及每天两次检查官方 npm latest。SDK 矩阵从 compatibility.json 的精确版本数组 生成；最新版本不在已验集合则失败，不自动扩大兼容范围。每项使用准确版本、空 HOME、无凭据公共依赖安装、禁生命周期脚本，并以 Node22/128MB/240秒运行宿主、Owner、微信协议和持久化的合成回归。真实 Cordis、ToolRuntime 和 HostConnectionService 合同另验路由权限、卸载和重新启用；不连接私人账号、不发消息。发布前 validate 必须等待此门禁通过；现有 OIDC 发布仅接收同 run 的已验 artifact。此门禁不是手机实收、多日稳定或私有服务验收，也不会自动发布或升级日常应用。

CI 运行时现在由操作系统隔离网络：Linux 在独立 network namespace 中恢复明确的合成环境并以原 runner 身份、no-new-privs 运行，macOS 使用 sandbox-exec。独立自测核对 loopback 可用，以及自定义 DNS 映射与非 Node 子进程的外连均被系统拒绝。显式 network-bind 规则用于允许 CI 自有监听；不将该规则的地址谓词单独当作严格监听地址证明。Node 测试受 128MB heap 与 240 秒上限约束，依赖获取仍在运行时边界之外、180 秒上限不变；没有使用生产配置或凭据。TAP 必须达到完整选定用例数且零失败、跳过、取消，发布打包前再检查官方 latest。
