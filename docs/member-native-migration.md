# 家人侧迁移到宿主原生 agent：分步计划

本文件描述把家人对话从插件自写循环迁到宿主原生 agent 的路径。**当前仓库只实现了第一步（只读盘点），没有切换任何运行时行为。**

## 为什么要迁

家人链路现在自己实现流式解析、工具循环、上下文预算和记忆账本，因此拿不到宿主的原生工具、审批与会话持久化。迁移后家人侧能力与 Owner 侧对齐，维护面也小一半。

## 迁移对象（只读盘点已覆盖）

- 每个家人按绑定隔离的工作区：`member-workspaces/<personId>/<bindingHash>/`，`bindingHash` 由成员 + 账号/联系人/绑定版本哈希得出；换绑后自然指向新目录，不会继承旧账本。
- 其中 `.member-agent.json` 是任务账本，记录 `prepared / queued / running / cancelling / succeeded / failed / needs_input / unknown` 等状态。
- 对话内容本身在家庭 store 的消息里（`family.json` 热窗口 + `messages.log` 全量）。

## 阻塞规则

以下状态视为**未结清**，挡在切换外：`prepared`、`queued`、`running`、`cancelling`、`needs_input`、`unknown`。`succeeded`、`failed`、`cancelled` 不阻塞。

`planMemberMigration()` 返回 `ready: false` 时不能切，必须先人工处理这些请求（继续、取消或确认结果）。

## 四阶段灰度

1. **影子盘点**：每次启动只读跑一遍 `planMemberMigration`，把结果写进状态接口的 `migration` 字段，不改变任何行为。
2. **单成员灰度**：选一位家人，把新会话切到原生 agent，旧账本保留只读；观察一轮真实对话与日报。
3. **全量**：其余家人逐个切换；旧账本进入只读归档，保留回滚窗口。
4. **收尾**：确认无回滚需求后，旧工作区归档，`member-agent.mjs` 降级为兼容路径。

## 回滚

任何一步异常，把该成员的开关切回旧链路即可；旧账本未删、消息未动，接管与恢复都以绑定版本为界。迁移不做破坏性写入，也不改动微信绑定。

## 当前状态

- 已实现：`src/member-native-migration.mjs` 的盘点与阻塞判定（6 项测试）。
- 未实现：影子字段接线、原生链路本体、灰度开关。这些改动会碰真实家人对话，单独排期与验收。
