# 宿主兼容与版本维护

0.2.0-preview.35 保留精确验证的 Harness 0.2.1-rc.2、rc.3、rc.4、rc.5，并新增 0.2.2-rc.1。Host engines、SDK peer 与 compatibility.json 必须使用同一组精确版本，不使用兼容豁免。个人账号、微信手机实收和家庭权限不属于 SDK 兼容证明。

`node scripts/compatibility.mjs --latest` 分别读取官方 npm latest 与官方 mac-arm64 Desktop 发行 feed，再独立取得 Desktop 对应的准确 SDK 元数据。两者均须在已验清单中，Desktop 与准确 SDK 名称/版本必须一致；不能因 npm latest 仍是 rc5 就忽略 Desktop rc1。无法读取、重复版本、未知版本及实验 alpha 均阻断发布，不自动改清单。0.2.2-rc.1 官方 SDK 要求 Node >=24.9.0；CI 与打包使用固定 Node 24.22.1，保留旧宿主的插件运行支持。

GitHub Actions 对 main push、PR、手动及每天两次执行该门禁，矩阵从 compatibility.json 生成。每项使用准确官方依赖、空 HOME、无凭据配置和禁生命周期脚本安装；运行时网络由操作系统拒绝，仅允许合成 loopback。Node heap 保持 128MB、套件上限 240秒、依赖获取上限 180秒，TAP 必须完整且零失败、跳过或取消。发布工作流先等此门禁通过，再构建并按公开白名单打包；OIDC 发布只接收同 run、相同 hash 的 artifact，打包前再次核对独立官方来源。

rc1 额外用真实官方 AgentRegistry、ToolRuntime、SystemPrompt 与作用域测试 Owner 工具隔离、政策完整装配、每轮复验、失败时保留内联政策及销毁清理。受控 Owner 资料请求使用官方 NativeToolExecutor，只在该 Owner agent 作用域选择，不修改部署或其他 agent 的 executor；能力缺失或与已有 agent executor 冲突时阻断该请求，不能退回不受控执行。rc1 的选择随 Owner scope 存续，任务结束后不恢复缓存的 PTC provider；卸载后选择不可用，避免落回其他 executor。旧 SDK 保留原 modeFor/presentAs 路径。

官方 native executor 在 rc1 由 Host 提供，按需解析 `@deepseek-ai/dsh-tool-executor-native`，发行包不捆绑 SDK 副本。发布前必须在真实官方隔离 Host 安装**最终 tgz**，验证内置模块实际可解析、作用域选择、调用、禁用、重启和卸载；源码 symlink 测试不能代替安装包证明。最终交付还须核对 npm exact/latest、canonical GitHub owner/源提交/资产 hash 与实际市场索引，分别报告这些状态。历史发行资产和版本不重打。
