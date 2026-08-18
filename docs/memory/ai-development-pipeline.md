---
name: ai-development-pipeline
description: Note_Edit 项目的 AI 工程任务闭环与质量门槛
metadata:
  type: project
---

Note_Edit 的 AI 工程任务遵循 [AI 开发流水线](../process/ai-development-pipeline.md)：先从 [docs/README.md](../README.md) 进入，读取 `CONTEXT.md`、ADR、专题文档、memory 和代码，再澄清需求与验收标准，切分最小实现，开发并测试，更新仓库内 memory，最后只提交本次授权范围内的 Git 变更。

稳定质量门槛：代码修改前先读目标文件；模型写工具必须经过 `ChangePlan` 和用户确认；外部输入、模型输出和 Vault 路径在边界校验；相关测试、build、lint 和 `git diff --check` 通过后才提交；提交使用 Conventional Commits，不 amend、不改 Git 配置、不跳过 hooks。

流程可执行性的判断标准不是文档是否完整，而是每轮是否能回答“当前状态、已完成、下一步、阻塞/需确认”，以及任务是否有可勾选计划和可复核验证包。过长的原则应转化为任务卡字段、Gate 或命令检查。

当前 harness 阶段已具备 Agent Loop、OpenAI-compatible 工具调用解析、Vault 只读工具和 MetadataCache 出入链读取；下一阶段是把 Loop 接入对话 UI、Skill 加载和写工具确认卡片。该状态用于跨会话恢复，不替代代码和测试事实。
