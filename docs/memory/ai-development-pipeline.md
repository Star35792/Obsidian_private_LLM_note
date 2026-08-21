---
name: ai-development-pipeline
description: Note_Edit 项目的 AI 工程任务闭环与质量门槛
metadata:
  type: project
---

Note_Edit 的 AI 工程任务遵循 [AI 开发流水线](../process/ai-development-pipeline.md)：先从 [docs/README.md](../README.md) 进入，读取 `CONTEXT.md`、ADR、专题文档、memory 和代码，再澄清需求与验收标准，切分最小实现，开发并测试，更新仓库内 memory，最后只提交本次授权范围内的 Git 变更。

稳定质量门槛：代码修改前先读目标文件；模型写工具必须经过 `ChangePlan` 和用户确认；外部输入、模型输出和 Vault 路径在边界校验；相关测试、build、lint 和 `git diff --check` 通过后才提交；提交使用 Conventional Commits，不 amend、不改 Git 配置、不跳过 hooks。

流程可执行性的判断标准不是文档是否完整，而是每轮是否能回答“当前状态、已完成、下一步、阻塞/需确认”，以及任务是否有可勾选计划和可复核验证包。过长的原则应转化为任务卡字段、Gate 或命令检查。

当前 harness 阶段已具备 Agent Loop、OpenAI-compatible 工具调用解析、Vault 只读工具和 MetadataCache 出入链读取；对话 UI、`skills/` Markdown 技能加载、`updateNote` 版本校验预览和确认写回已经接通。自然语言 Agent 对话首轮只提供用户请求和活动笔记路径，不自动外发正文；模型优先用 `searchNotes` 获取有界命中片段，确需全文或编辑时才调用 `readNote`。下一阶段是 LinkContext 候选筛选、双链建议与逐条确认。该状态用于跨会话恢复，不替代代码和测试事实。

2026-08-19 的 Kimi Code 借鉴切片已加入 `editNote` 精确编辑：默认要求旧文本唯一匹配，重复匹配需显式 `replace_all`，生成的差异仍经过 `ChangePlan` 和源版本校验。`AgentLoop` 新增可配置历史上限与持久压缩摘要，摘要标记为可保留系统消息，避免后续轮次重建提示时丢失；未提供摘要时会保留被压缩区间的首尾用户请求并合并早期摘要，调用方也可以提供更高质量的摘要。当前不自动把模型摘要写入 Vault。

Agent 会话现由 `SessionRuntime` 通过小型 `SessionStore` interface 管理，并由 `PluginDataStore` adapter 写入 Obsidian 插件数据的 `activeSession`。插件重载和侧栏重开会恢复同一个版本化消息快照；旧版扁平 settings 保持兼容，设置与会话写入串行化，损坏或未知版本的快照按无会话处理。当前只维护一个 active session；带执行闭包的待确认 `ChangePlan` 不可序列化，因此不会跨重载恢复，后续需先把执行逻辑改造成可序列化计划与独立 executor，才能安全持久化。
