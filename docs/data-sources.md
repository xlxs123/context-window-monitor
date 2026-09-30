# 数据来源与扩展边界

## 已验证接口

本机验证版本：Codex CLI `0.158.0-alpha.2.1`。通过 `codex app-server generate-ts --out output/protocol` 生成协议并核对：

- `thread/tokenUsage/updated`：`last`、`total`、`modelContextWindow`。
- `TokenUsageBreakdown`：`inputTokens`、`cachedInputTokens`、`cacheWriteInputTokens`、`outputTokens`、`reasoningOutputTokens`、`totalTokens`。
- `SessionSource` / `SubAgentSource`：`subagent.thread_spawn.parent_thread_id`、`agent_nickname`。

Codex 插件的 MCP 服务不能自动订阅宿主现有 App Server transport。因此当前实现继续使用原插件的 hooks 定位和 rollout 增量读取；`AppServerContextProvider` 保留给拥有连接的自定义客户端。

## 已核实的本地日志

- `event_msg.payload.type = token_count`：旧版兼容的实际用量。
- `token_usage_record.payload.usage` / `thread_token_usage`：新版请求用量和累计用量。
- `task_started.model_context_window`：当前运行报告的容量。后续 `token_count` 同样会校准容量。
- `turn_context.model`：模型名，保留主模型匹配规则。
- `compacted`：新版正式压缩记录，只把 `message` 当作可显式读取的公开摘要。不会把 `replacement_history` 擅自声明为最终模型请求。
- `response_item`：公开记录的角色消息、function/custom tool call、tool output、reasoning summary。

同一实际报告同时出现 `token_usage_record` 和 `token_count` 时，根据完整的 last / cumulative 字段去重；不是再次累加用量。`item/started` 不当作压缩成功，避免失败尝试被计入节省量。

日志 envelope 是内部格式，未来可能变化；未知字段不猜测。数值缺失时显示 Unavailable。辅助模型过滤仍沿用 `turn_context.model` 与活动 hook 模型匹配，这不等于掌握供应商最终请求序列化。

## 没有可靠来源的字段

| 不可用字段 | 原因 | 当前替代 | 未来需要 |
|---|---|---|---|
| 完整当前模型上下文 | rollout 不是最终请求生成接口 | 明确标注的日志记录浏览器 | 宿主正式的请求前只读 messages hook |
| System / 用户 / Tool / 文件分别的 Token | API Usage 只有请求级聚合 | 分类条目数、字符量和实际聚合用量 | 宿主逐消息 token attribution |
| 子 Agent 的 Prompt/Result 回写 Token | 会话关联不等于归因信息 | 查看独立子会话实际用量 | 父子调用的正式上下文归因数据 |
| 精确内容 Snapshot Diff | 缺少每次请求完整规范化内容 | 真正用量字段的 A/B 与跨 Session 对比 | 完整、稳定的请求快照 ID 与内容 |
| 剩余几轮、费用、耗时分解 | 缺少可靠预测或计费/计时字段 | 不显示伪造数据 | 正式定价与完整计时数据 |

## 性能和隐私

日志只读；不改变聊天、模型请求、轨迹或压缩逻辑。首次最多 2 MiB，后续读取增量；解析按文件串行，保留完整 UTF-8 行边界。仅按需读取单条原文，最多返回 32,768 字符，长内容显式标记截断。不会读取 encrypted reasoning。

MCP `get_context_usage` 默认返回紧凑报告；UI 通过 `details:true` 或本地 API 取得详细元数据。`show_context_monitor` 的详细 UI 数据放在 `_meta`，避免自动把全部日志元数据注入模型上下文。导出报告不包含原文；单条原文导出必须由用户点击。

## 官方参考

- [OpenAI 插件 MCP 与 UI 快速入门](https://developers.openai.com/plugins/build/app-quickstart)：MCP 工具和可选 UI 的组合。
- [为 MCP 服务添加 UI](https://developers.openai.com/plugins/build/chatgpt-ui)：MCP Apps 是兼容宿主上的可选界面，不能据此保证 Codex 有原生 UI 插槽。
- [MCP Apps 2026-01-26 协议](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)：UI 初始化、工具调用、结果通知与销毁。

本插件保留 `.codex-plugin/plugin.json`，使用本机 `plugin-creator` 提供的校验器验证；不把别的宿主 manifest 规范直接套到当前 Codex 版本。
