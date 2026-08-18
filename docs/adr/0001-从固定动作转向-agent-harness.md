# 从固定动作单轮提案转向 Agent Harness

产品原设计为"六个固定动作 + 单轮 JSON Proposal"：用户点动作，插件跑固定流程，模型单次输出结构化提案。现决定转向 agent harness 形态（类比 Claude Code）：全自由对话的 Agent Loop 是唯一运行时，模型在 loop 中自主调用工具、多轮推进；六个动作退化为 Skill（Markdown 行为说明，存于笔记库、用户可编辑），支持 `/命令` 显式触发与模型自主加载双通道。引擎为纯 TS 库（不依赖 Obsidian API），插件 bundle 之，另暴露 CLI 入口。模型协议以 OpenAI 兼容为底，Anthropic 原生适配排后期。

原最高不变量"AI 永远不能直接调用 mutation 工具"以新形式保留：**工具调用即计划**——模型可发起写工具调用，引擎在确认边界拦截并转为 ChangePlan 预览，用户确认才落盘。

## Considered Options

- **双模式并存**（六动作维持单轮实现 + 旁边新做 agent 模式）：否决。两套运行时长期并存，自用维护不起；单轮版的一半工作（只读工具、LinkContext）在 loop 版里几乎要重写。
- **严格保留字面规则**（loop 中模型只能用只读工具，写操作仍只能产 ChangePlan JSON）：否决。模型探索完想写要切换输出模式，loop 断掉；确认边界由引擎拦截同样完整保留 invariant 的语义。
- **动作保持硬编码流程**：否决。技能化后工作流只是提示词数据，迭代不用改代码，且用户可在笔记库里直接编辑技能——这是笔记软件做 harness 的独特优势。

## Consequences

- 单轮 Proposal JSON 契约（`proposal-validator`）退役，结构化输出格式改写进各技能的说明。
- 原 `main.ts` 的编排逻辑收进引擎；插件 UI 从六按钮面板改为对话流 + 过程流 + 确认卡片。
- 会话沉淀为笔记库 `_sessions/` 笔记；一期不做子代理，引擎接口预留。
- 文档体系随之迁移，见 [0002](0002-文档体系迁移至-docs.md)。
