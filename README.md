# Codex 上下文监控插件

`context-window-monitor` **0.4.1**，用于 Codex Desktop / CLI。黑色上下文仪表盘，自动适配 Codex 中注册的所有本地项目。它是 Codex 插件，不依赖 DeepSeek Harness。

[下载 v0.4.1](https://github.com/xlxs123/context-window-monitor/releases/tag/v0.4.1) · [MIT 许可证](LICENSE) · [验证记录](docs/verification.md)

## 一键打开

安装后，点击 Codex 项目顶部操作菜单里的 **上下文监控**，即可在默认浏览器打开仪表盘。无需发送聊天指令，不调用模型，不逐个项目配置。

Windows 首次使用：

1. 安装 Codex Desktop 和 Node.js **22.13 或更新版本**。
2. 下载 Release 的 ZIP，完整解压，双击 **`Install.cmd`**。
3. 安装成功后切换项目，或重新打开 Codex 一次，让顶部操作刷新。

安装器会注册个人插件市场、安装启用插件，并立即启动自动接入。通过其他方式安装插件时，自动接入在 Codex 加载插件的 MCP 服务后启动；宿主尚未加载时需要重新打开 Codex。打开监控不要求 PATH 中存在 `codex`，不需要 Python。

自动接入每 3 秒读取 Codex 当前项目注册表。已有项目、新增项目和路径变化都会处理；移除项目后清理插件自己添加且未被用户编辑的入口。不扫描磁盘、不使用已删除项目的历史列表。仅支持本机可写的项目目录；ChatGPT 云端项目不属于此入口的范围。

入口使用 Codex 官方支持的 [本地环境操作](https://learn.chatgpt.com/docs/environments/local-environment)。插件在项目主根目录的 `.codex/environments/*.toml` 中维护标记块；没有配置时生成 `environment.toml`。保留已有 setup、其他操作和注释，修改前备份到 `CODEX_HOME/context-window-monitor/project-action-backups`。配置损坏、外部路径链接、用户修改的标记块会保留并报告，避免覆盖。

多个聊天和重复点击共享一个隐藏的本机服务。关闭页面后不再主动刷新日志，项目列表仍会同步。`scripts/open-dashboard.ps1 -Stop` 可停止服务；下次插件加载或点击入口会再次启动。`CONTEXT_MONITOR_DISABLE_AUTO_PROJECTS=1` 可关闭自动接入。开发时可运行 `npm run open`；`--ensure` 只启动服务和接入，不打开浏览器。

顶部操作不提供当前选中聊天的 ID，因此按工作目录选择**本项目最近活动的会话**，并在页面明确提示；可以通过 SESSION 切换。没有匹配时显示无数据，不跳到其他项目。程序支持 `node runtime/open-dashboard.mjs --session <session-id>` 精确打开指定会话；`--no-open` 只输出地址与启动耗时，供验证使用。

## 已实现

- 黑色双列总览：统计卡片、输入/输出环图、当前容量、增长柱状图、分类记录浏览器、近期事件、长内容列表、Agent 网络。
- Codex 实际 Token：最近模型输入、窗口容量、剩余量、缓存读取/写入、输出、Reasoning 输出及累计消耗。
- 时间线、全量/增量切换、选中快照查看详情、同会话或跨会话用量对比。
- 日志来源分类、工具调用与返回关联、带明确路径参数的文件活动、Top 5/10/20 长记录。
- SHA-256 完全重复长内容检测；字符数只表示文本长度，不转换为 Token。
- 正式压缩事件识别，包括新版 `compacted`；查看前后真实请求输入快照。
- 历史/近期 Session 选择；以明确 `parent_thread_id` 展示父子 Agent 关系并跳转。
- Inspector：类型、角色、时间、消息/调用 ID、字符数、路径；原文默认隐藏，需启用并主动读取单条记录。
- 手动 JSON 报告导出、选中记录导出、暂停刷新、紧凑模式、窄屏布局。

## 直接运行

发布包包含编译好的 `runtime/`，安装 Node.js 22.13+ 后无需先安装 npm 依赖：

```powershell
cd "C:\path\to\context-window-monitor"
node runtime/dashboard.mjs
```

终端会输出随机端口的 `http://127.0.0.1:.../随机路径/`。打开这个**完整地址**即可。可显式指定 Codex 会话：

```powershell
node runtime/dashboard.mjs <session-id>
```

服务仅监听本机回环地址，不调用模型、不需要 API key。关闭进程即停止仪表盘。默认读取本机 `CODEX_HOME/sessions`（未设置时为 `%USERPROFILE%\.codex\sessions`）。

## 作为 Codex 插件使用

插件包含 `.codex-plugin/plugin.json`、`.mcp.json`、`hooks/`、`skills/` 和已打包的 MCP 服务。

默认插件选择器为 `context-window-monitor@personal`。双击 `Install.cmd` 可首次安装或更新到 **0.4.1**，旧版本保留备份。

也可在 PowerShell 执行下面一行。脚本检查环境，备份旧版，注册市场、更新缓存、验证版本并启动自动接入；兼容 Windows PowerShell 5.1：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\context-window-monitor\scripts\install-local.ps1"
```

只检查环境而不安装时，在末尾加 `-CheckOnly`。无需管理员权限；执行策略选项只作用于这次脚本进程。解压包位于其他目录时，将 `-File` 后的路径改为实际脚本路径。

普通 PowerShell 的 `PATH` 可能找不到 `codex`。安装脚本会优先使用已有命令，否则在 `%LOCALAPPDATA%\OpenAI\Codex\bin` 的版本目录中定位 `codex.exe`，以完整路径调用；不会修改系统 PATH。只需 Node.js，无需 Python 或 Codex 内部的安装助手脚本。安装副本会使用唯一版本后缀刷新缓存，源码版本保持不变。

运行副本位于 `%USERPROFILE%\plugins\context-window-monitor`。安装器按 [官方插件格式](https://developers.openai.com/plugins/build/plugins) 创建或补充个人市场条目，保留已有其他插件并备份市场文件；已有同名条目指向别处时停止并说明，不覆盖它。Node.js 最低版本用于内置的只读 SQLite 项目发现，无需额外安装数据库或 npm 依赖。

配置完成后即可使用顶部操作。如果需要让模型分析数据，也保留了 **“打开上下文监控”** 指令：新聊天加载更新后的技能后，可调用 `show_context_monitor`，并在支持 `open_in_codex` 的宿主中打开返回的本地仪表盘地址。支持 MCP Apps 的宿主也能渲染同一界面。

入口为项目顶部操作，不修改 Codex 程序文件。操作默认打开系统浏览器；聊天工具也能在支持的宿主中打开 Codex 浏览器面板。CLI 可返回文本摘要和本地地址。自动接入不依赖 hooks 的信任状态；hooks 如需启用，请通过 Codex 的 `/hooks` 审核。

## 数据口径与边界

| 指标 | 实现与精度 |
|---|---|
| 当前占用 | 最近一次模型调用的 `input_tokens`，Exact；不是下一次请求的预测 |
| 窗口容量 | Codex 实际报告的 `model_context_window`；缺失为 Unavailable |
| 剩余量、占用率 | 对实际数值计算，不硬编码模型容量 |
| 缓存 | 输入的子集，不再加到 input 上 |
| Reasoning | 输出的子集，不再加到 output 上；不解密隐藏内容 |
| 累计消耗 | 独立显示，不当作当前窗口占用 |
| 日志分类、工具次数、字符数 | 只针对保留的日志范围，不声称仍全部处于模型上下文 |
| 分类 Token、完整模型 messages、子 Agent 结果 Token | 当前无法可靠获得，明确显示 Unavailable |
| 压缩节省量 | 正式事件两侧的请求输入差值；期间新增消息也会影响差值 |
| 重复检测 | 公开文本完全相同且至少 256 字符；不推断语义相似或历史价值 |

首次最多读取 2 MiB 日志尾部，此后只读新增字节。保留 80 个用量快照、500 条记录、20 个压缩事件；最多缓存 12 个会话。截取状态在页面可见。早于范围的压缩可能不显示；不会编造缺失的前后数据。

若未指定 Session，也没有可信 hook，使用最近日志回退，明确提示会话匹配需要确认。近期 Session 发现扫描最近两个年份中最近三个月、每月最近十四个日志日期目录；已注册的历史 Session 仍可直接打开。

## 核心数据流

```text
Codex hooks → SessionRegistry（定位与事件元数据）
                     ↓
Codex rollout → 有界增量读取 → 用量 / 事件 / 活动元数据
                     ↓
ContextMonitorService → MCP 工具 + 本机 HTTP 仪表盘
                     ↓
黑色总览 / Inspector / 趋势 / 工具 / 压缩 / 快照对比
```

`read_context_item` 只按已经观察到的记录 ID 回读该行的公开文本；不接受任意文件路径，不读取环境变量或凭据文件。

## 工程文件

- 新增 `src/providers/activity-tracker.ts`：结构分类、工具关联、重复检测、文件参数统计。
- 新增 `src/dashboard-server.ts`、`src/dashboard.ts`：本机仪表盘入口和访问边界。
- 新增 `src/ui/styles.ts`，重写 `src/ui/context-details-panel.ts`：黑色界面和交互。
- 扩展 `src/providers/rollout-event-parser.ts`、`rollout-context-provider.ts`：新版事件、增量读取、Session 发现、按需原文。
- 更新 `context-types.ts`、`context-monitor-service.ts`、`context-history-tracker.ts`、`context-usage-service.ts`、`mcp-server.ts`、`index.ts` 和构建脚本。
- 更新插件 manifest、技能、文档、预览；新增活动测试并扩展 MCP 集成测试。
- `runtime/` 是已编译的交付产物；测试、预览和验证依赖不进入插件运行包。

## 验证与开发

```powershell
npm ci
npm run check
npm run preview
```

重新打包：完成 `npm run check` 后运行 `python scripts/package.py`。产物为 `dist/context-window-monitor-0.4.1.zip` 及 SHA-256 校验文件，包含源码和编译好的运行文件。第三方许可证保留在 `docs/THIRD-PARTY-NOTICES.md`。

预览为 `http://127.0.0.1:4174`，明确标为**演示数据**，不会读取真实会话原文。`npm run dashboard` 才读取本机真实 Codex 数据。

已完成的验证见 [验证记录](docs/verification.md)；数据源与扩展边界见 [数据来源](docs/data-sources.md)。

隐私：元数据只在本机读取，原文不自动返回、持久化或导出。仪表盘使用随机访问路径并验证 Host/Origin，无外部网络依赖。报告可能包含模型、会话 ID、工具名和日志中明确记录的文件路径；导出由用户主动触发。
