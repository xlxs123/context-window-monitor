# dsh-context 源码适配

上游：[bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)。本次固定读取版本 **0.62.2**，commit [`42f84915617705ccd4f1f9a0112bd5113b6089fd`](https://github.com/bowenliang123/dsh-context/tree/42f84915617705ccd4f1f9a0112bd5113b6089fd)，不执行其运行脚本、不依赖 DSH SDK。

## 界面映射

| 上游组件 | Codex 插件适配 |
|---|---|
| `contextView.tsx` | 同样的双列排列：统计 / 信息、Token / 耗时、容量与趋势 / 浏览器、事件 / 文件、Agent 网络；黑色主题 |
| `donut.tsx` | `src/ui/dsh-donut.ts` 保留 SVG 环图几何与小切片间隙算法；去除 React / DSH 依赖，增加无效值检查 |
| `trendChart.tsx` | Codex 实际请求输入的缓存 / 未缓存柱图，步骤 / 轮次、全量 / 增量、悬停和固定范围 |
| `contextBrowser.tsx`、`dna.ts` | 按类别浏览保留日志；DNA 块按时间记录顺序及字符量排列，分类 Token 未提供 |
| `contextEvents.tsx` | 正式压缩、实际输入增长与下降，压缩前后请求对比；不把普通下降误报为压缩 |
| `fileActivity.ts`、文件卡片 | 解析明确 JSON 路径和标准多文件补丁；分类计数、行数、路径过滤 / 排序及记录检查 |
| `agentGraph.tsx` | 明确父子会话关系，可切换关联会话；未知容量显示中性轨道 |

上游有完整请求投影、Token 分类和执行计时数据。Codex 当前公开日志没有这些同等字段，因此不能直接搬用 DSH 的数据模型，也不能把日志记录当作仍处于模型上下文的完整 messages。

## 数据与隐私

- 当前 / 累计 Token 来自 Codex 上报，缓存是输入的子集，Reasoning 是输出的子集。累计分项缺失时环图明确退回最近请求的范围。
- 趋势联动按所选请求时间过滤保留日志；DNA 分类宽度按字符量，不用固定比例估算 Token。
- 耗时是保留日志首末时间跨度和可配对的调用至结果区间。并发区间合并，模型等待、思考、输出时间及费用均未提供。
- 文件活动只认明确结构化路径及补丁格式，不执行调用内容、不猜测 Shell 或 JavaScript 中的文件访问。同文件多个 hunk 只算一次工具调用，补丁行数不证明请求已成功落盘。
- 日志原文每次打开默认关闭；启用设置后仍需主动读取单条记录，切换会话或关闭权限会使旧响应失效。
- 截图和开发预览只包含独立生成的演示数据，不包含真实 Codex 会话或用户路径。

## 许可

`Copyright 2025 bowenliang123`。上游为 Apache-2.0，本次固定 commit 没有独立 NOTICE 文件。

移植的环图算法在源码与编译后的 UI 中保留版权、SPDX 和修改来源，并随发行包附带完整 [Apache-2.0 许可证](licenses/dsh-context-APACHE-2.0.txt)。本项目原有代码继续使用 MIT；该移植组件使用 Apache-2.0，不因项目根许可证变为 MIT。没有复制上游壁纸或图片素材。
