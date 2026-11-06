# 工具参数边界诊断：deviceId 为 null — 2026-11-07

续接[重复调用排查](repeated-tool-failures-20261107.md)。上一阶段确认执行器收到空参数，
本次继续区分模型服务返回、SDK 解析与 JSON 持久化的边界。

## 正式工具声明遗漏了参数类型

旧 Broker 只正式注册了 `action: string`，其他字段通过 `additionalProperties`
开放。`deviceId`、`command`、`query` 等字段的类型存在于 `toolFields` 和
`tool.search` 返回的详细说明中，没有进入每次请求的正式函数参数 schema。

这给模型服务及其中间兼容层留下了推断附加字段类型的空间。查询结果中的说明
不能代替正式函数声明。现在用同一份 `toolFields` 注册全部 58 个字段的类型，
仍只把 `action` 设为统一必填项；每项 action 的详细用法、条件必填和授权仍按需查询、
由 Core 检查。

声明的本地 Token 估算约为 911，测试上限调整为 1100；常用工具说明的 800 Token
上限保留。窗口估算与压缩逻辑本来就引用实际 Broker schema，也随之计入新声明。

## 真实模型服务的合成对照

时间：**2026-11-07 01:26–01:30（UTC+8）**。使用此前本地体验配置中的同一模型服务，
模型配置别名 `grok-4.7-build-fast`。只读取已保存的连接配置，在内存中使用其凭据。
没有复用真实聊天内容、修改配置或启动真实终端。

三轮共 **8 次**请求，均 HTTP 200，无自动重试。输入只含固定合成 UUID 和
`printf NEXBOT_SYNTHETIC_ONLY` 字符串，响应只用于检查参数，不派发给设备。

| 正式 schema | tool_choice | 返回形式 | 观察 |
| --- | --- | --- | --- |
| 仅 action | 指定 broker，流式，3 次 | 2 次没有标准 tool_calls；1 次有 tool_calls | 有调用的那次，原始 `deviceId` 是数字 `111111112222`，`command` 是数字 `4444` |
| 仅 action | 指定 broker，非流式，1 次 | 没有标准 tool_calls | 不作为字段解析对照 |
| 仅 action | auto，流式，1 次 | 正文 JSON | auto 允许正文，此行不能证明字段类型错误 |
| action/deviceId/command，后两项可选 | auto，流式，1 次 | 正文 JSON | 同上 |
| action/deviceId/command，三项必填 | 指定 broker，流式，1 次 | 标准 tool_calls | 原始 ID 为完整 36 字符字符串，命令也逐字正确 |
| 全部 58 项类型，仅 action 必填 | 指定 broker，流式，1 次 | 标准 tool_calls | 原始 ID、命令都是正确字符串，与 SDK 解析值一致 |

样本较小，schema、调用选择及流式条件按表变化，不把全部行当成单一因素的统计证明。
最后一对使用相同提示词和调用选择，对照原有声明与完整类型声明。
可以确认：至少一次错误类型已经存在于模型服务的原始返回中，SDK 没有将正确字符串
变成该次错误数字；补全字段类型的两次指定调用则都保留了正确字符串。
这支持修正正式 schema 的兼容缺陷，但不能仅凭 API 返回区分模型与其代理内部的责任。

## 一条可完整复现的 NaN → null 路径

对本仓库固定版本 SDK 的解析器做合成检查：

- 正常完整 JSON 的 UUID 和命令字符串保持不变。
- 字符串截断通常产生部分字符串或缺失字段，没有在这些样例中自动变成两个 null。
- 非法 JSON 数值 `NaN` 可被宽松解析成 JavaScript `NaN`。
- JavaScript 的 `JSON.stringify` 会把这种非有限数字写成 JSON `null`。

随后在完整的隔离 Core / SDK worker 中复现：

```text
合成模型原始参数：deviceId: NaN, command: NaN
worker 原始提案：两个 NaN，校验拒绝，没有执行工具
JSON 投影快照：deviceId: null, command: null
错误结果：deviceId 需要 string（收到 NaN）
```

新增错误标记保留 `NaN` 与实际 `null` 的区别；无须把命令值或凭据复制到错误信息。
历史快照没有原始 HTTP 流，不能倒推那 97 次空参数一定走了这条路径。
它解释了为什么只看快照中的 `null` 不足以确定最初来源，也为再次发生时提供了区分点。

## 保留原始提案，拒绝 SDK 自动转换后的错误值

补全 schema 后，SDK 会按已知字段规范化可选 null，并可能把数字转换成字符串。
worker 因此改为从会话中取回对应 call ID 的**原始提案**，再严格校验和提交 Core。
校验、授权快照及参数摘要以同一份原始参数为准。

回归分别覆盖 OpenAI 兼容和 Anthropic：

- 正式请求在第一次工具查询前就包含 `deviceId`、`command`、`query` 等字段类型。
- 详细 action 说明仍只在查询后进入上下文，声明字段不会授予工具权限。
- `query: 123` 不会因 SDK 转成 `"123"` 而执行；`deviceId: null` 不会因可选字段
  规范化而被悄悄省略。
- 长调用 ID 保持一致；连续三次相同失败仍停止，新输入可继续，末次结果不重放。
- 原始 NaN 被拒绝，JSON 快照虽显示 null，错误结果仍能保留实际类型标记。

## 验证与证据

- 修改前的正式 schema 回归 **3 失败、2 通过**：真实请求只声明 action。
- 补全类型及保留原始提案后，两个协议及工具目录回归 **15 项通过**。
- 加入完整 NaN 边界复现后，同组源测试 **16 项通过**。
- 连续上下文、模型容量与模型选择回归 **53 项通过，3 文件通过**。
- Core / CLI 路由及传输的最终构建产物回归 **66 通过、1 跳过，6 文件通过**。
- TypeScript、lint、locale 和 Core / Web UI 构建通过。

所有代码变更测试使用随机凭据、合成模型和一次性 Core / 设备，不访问真实项目。
真实服务对照不执行任何工具，其余模型测试不使用真实推理。
私有诊断脚本、脱敏参数形状、原始合成响应及日志位于原工作目录的忽略目录
`release/null-arguments-20261107-xpq2urch/`，不进入源码提交。

## 结论与边界

本次定位到正式 schema 缺字段这个具体兼容缺陷，也完整复现了 NaN 经 JSON 序列化后
显示为 null 的路径。历史每次 null 的上游原始内容已无法从现有快照恢复；Windows
对应会话和线上 Core 的原始响应仍未取得，不能宣称所有实例都完全同因。

修复保留在本地 `codex/repeated-tool-loop` 分支；尚未推送、部署线上 Core 或更新安装包。
