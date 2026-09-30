# Changelog

## 0.3.0 - 2026-09-30

- 新增一键启动器和 Windows PowerShell 入口，可绑定 Codex 官方项目顶部操作，无需模型调用。
- 隐藏启动本机服务，并发和重复点击复用；校验本机地址、版本和健康状态，支持停止服务。
- 按项目目录选择最近活动的会话，明确提示选择依据；无匹配时不跳到其他项目。
- 安装脚本分发一键启动脚本，补充并发、服务复用、陈旧启动锁恢复和项目隔离的集成测试。
- 修复 Windows PowerShell 管道等待后台进程、多 Node 路径匹配；安装更新不再依赖 Codex 内部 Python 助手。

## 0.1.0 - 2026-09-01

- 首次实现 Codex 原始 token usage 读取。
- 添加可折叠 MCP Apps Context Usage 卡片。
- 添加生命周期 hooks、多会话定位与最近变化记录。
- 添加 Context Compaction 精确事件检测。
- 添加辅助模型快照过滤与 fail-soft 降级。
- 添加 build、type check、lint、单元测试和 MCP 协议集成测试。
# 0.2.0

- 黑色双列 Codex 仪表盘，加入 9 个页面、真实用量趋势与快照对比。
- 新版 token_usage_record / compacted 日志支持，以及有界增量活动分析。
- 工具关联、文件参数统计、公开日志原文按需读取、重复长内容检测。
- 本机回环仪表盘入口、MCP Apps 初始化、详细元数据与模型上下文分离。
- 保留真实 Token 口径，未知分类和完整模型请求仍标为 Unavailable。
