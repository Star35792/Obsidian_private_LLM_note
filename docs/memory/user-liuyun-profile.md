---
name: user-liuyun-profile
description: 用户 liuyun 的背景与协作偏好：中文交流，个人项目 Note_Edit，决策时倾向采纳推荐方案
metadata:
  type: user
---

用户 liuyun 以中文交流，在个人项目 Note_Edit（Obsidian 插件，AI 笔记助手）上工作，目标是把笔记软件做成类 Claude Code 的 agent harness（2026-08-18 经 grilling 确定，决策已记录在仓库 CONTEXT.md 与 docs/adr/）。协作风格：喜欢带推荐选项的决策问答，多数直接采纳推荐；重视文档纪律（中文文档、Conventional Commits、TDD）。

用户希望 Note_Edit 在文件编辑、会话上下文与跨会话 memory 方面参考仓库内 `kimi-code-main/` 的设计思路。参考应以机制和边界为主，不照搬通用 CLI 的权限模型：优先采用“先读后改、精确文本替换、旧内容/版本校验、上下文压缩保留用户原始意图与待办、持久状态与业务逻辑分层、目录级 `AGENTS.md` 就近生效”；同时保留 Note_Edit 的核心边界：Vault 写操作必须经过 `ChangePlan` 预览、修订校验和用户确认。
