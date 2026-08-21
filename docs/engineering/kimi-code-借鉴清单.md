# Kimi Code 借鉴清单

最后同步：2026-08-21

`kimi-code-main/` 是本地只读参考仓库（已 gitignore，不参与构建、测试和 lint）。本文记录从它的 `packages/agent-core` 读到的机制里，哪些值得搬进本插件、哪些明确不搬，以及理由。出处路径都相对 `kimi-code-main/`。

判断标准只有两条：是否解决本项目**已经存在**的问题；是否能在不削弱「模型只能提议、写回必须确认」这一不变量的前提下落地。

## 已借鉴（历史周期）

| 机制 | kimi 出处 | 本项目落点 |
| --- | --- | --- |
| 精确文本替换（唯一匹配 + 显式 `replace_all`） | `packages/agent-core/src/tools/builtin/file/edit.ts` | `editNote` 工具与 `createExactReplaceChanges` |
| 上下文压缩与持久摘要标记 | `packages/agent-core/src/agent/compaction/` | `compactAgentHistory` 与 `persist` 消息 |
| 会话快照与恢复 | `packages/agent-core/src/agent/session/` | `SessionRuntime` 与 `PluginDataStore` |

## 本周期借鉴（TASK-20260821-02，已实现）

1. **工具结果预算与分页读取**。kimi 在 `agent/turn/tool-result-budget.ts` 给每条工具结果设 5 万字符上限，超限只回预览并附 `output_path` 与「用 Read 分页取余下部分」的明确下一步。本项目 `readNote` 返回整篇正文且无上限，`listNotes` 无条数上限，而历史压缩只按消息条数裁剪，单条超大结果完全防不住。落点：`src/agent/tool-result-budget.ts` 与 `readNoteWindow`；本项目不落盘完整结果，因此截断文案给的是 `offset`/`limit` 与缩小 `query`/`scope` 两条取回路径。
2. **技能渐进披露**。kimi 的 `skill/registry.ts:133 getModelSkillListing()` 只把名称、说明、`whenToUse` 和路径给模型，正文等技能被真正调用时才展开。本项目 `buildSkillPrompt` 每轮把所有技能正文拼进系统提示，成本随技能数量线性增长。落点：`buildSkillPrompt` 只输出清单，正文改由 `useSkill` 工具按需返回。
3. **动态上下文改为 append-only**。`agent/injection/manager.ts:19` 的注释点明：动态提示一律追加到尾部，绝不改前缀，否则既丢 prompt 缓存又让上下文按平方增长。本项目把每轮都在变的运行环境提示插到系统提示之后（索引 1），等于每轮让整条前缀失效。落点：`AgentLoop.run` 把运行环境提示追加到历史之后、当前用户消息之前，返回前仍从历史中剔除。
4. **重复工具调用去重与熔断**。`agent/turn/tool-dedup.ts`：同一步内相同 `(工具名, 参数)` 复用首次结果；跨步连续重复时逐级升级 system-reminder，到上限强制结束本轮。本项目撞到 `maxTurns` 时抛异常，用户拿到的是报错而不是答案。落点：`AgentLoop` 的参数规范化去重键、连续 3 次提示、连续 6 次或到达轮数上限转入收尾轮；收尾轮仍需发送工具定义（OpenAI-compatible 端点拒绝空 `tools`），并为悬空调用补齐结果以保持历史合法。

## 待评估（下一周期起按产品优先级）

- **结构化澄清提问工具**。出处 `tools/builtin/collaboration/ask-user.md`：1-4 个问题、每问 2-4 个互斥选项、推荐项排第一并标注、永远自带「其他」、用户忽略时不得当作选了推荐项且不许重复问。本项目的「待澄清问题」目前只是 Proposal 里的只读字段，做成工具才能闭环，且挂起与恢复的形状与现有 `pendingChangePlan` 一致。产品价值高于任何上下文优化。
- **计划模式与 TODO**。出处 `tools/builtin/planning/`、`tools/builtin/state/todo-list.md`、`agent/injection/plan-mode.ts`（首次 full、间隔 sparse、恢复会话 reentry 三档提醒）与 `agent/injection/todo-list.ts`（距上次写入满 10 轮且距上次提醒满 10 轮才提醒一次）。对应场景是多笔记批量整理，plan 文件天然可以就是一篇 Vault 笔记。单篇整理不应引入 TODO，`todo-list.md` 里「什么时候不要用」必须一起搬。
- **按 token 触发压缩**。出处 `agent/compaction/strategy.ts`：上下文窗口 85% 或加上预留输出即将溢出时触发，同一轮内 overflow 重压缩最多 3 次。本项目 `historyLimit` 是消息条数，与真实占用无关。
- **交接式压缩摘要**。出处 `agent/compaction/compaction-instruction.md`：要求模型用第一人称写「给自己的交接笔记」，区分已定决策与未决问题、保留实际执行过的动作与返回值、点名从未确认过的空白、把未验证结论老实标为未验证。可直接作为提示词蓝本，现有启发式摘要留作回退。

## 明确不借鉴

- **事件日志与 transcript 分层**（`agent/records/`、`packages/transcript/`，含 `granularity/grade.ts` 的 off/turn/block/delta 分级与分页）：对应多会话列表和过程折叠展示。当前只有单个 active session，现在做是过度设计。
- **权限规则 DSL 与会话级免确认**（`agent/permission/types.ts`：`Read(/etc/**)` 形式的 pattern、`session-runtime` 作用域）：「本次会话都允许」会削弱本项目的核心信任边界，不采纳。其中 **deny 规则**（例如模板目录永不允许写入）风险低价值高，可单独评估。
- **子 agent 与 swarm、后台任务、cron、MCP、goal**：与单笔记助手的定位不匹配。
- **DI 容器、minidb、`scripts/check-no-comments.mjs` 的禁注释规范**：与本项目的规模和注释风格相反，不引入。
