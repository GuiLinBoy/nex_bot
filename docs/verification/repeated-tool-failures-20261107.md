# 重复回复：无效工具调用循环 — 2026-11-07

用户报告 Mac 和 Windows 安装的 NexBot 都会重复回答，并提到 Bot 自称可能是 ID
截断。检查采用只读数据快照及隔离 Core / 模型复现；没有向用户真实会话发送测试消息。

## 找到的实际记录

这台 Mac 先前启动的本地体验 Core 保留了 2026-11-07 **00:33–00:47（UTC+8）**
的相关任务：用户询问本地 Claude CLI 的模型、要求重试，随后要求 Bot 检查为何重复。
两个重复任务最后均由用户取消。

读取 Core 和 SDK projection 的一致快照，得到：

| 项目 | 结果 |
| --- | --- |
| 工具调用及结果 | 102 次；调用与结果的 ID 集合完整匹配 |
| 成功调用 | 3 次：读取设备技能、查询工具、读取设备目录 |
| 参数校验错误 | 99 次；均为原有的通用“工具参数类型无效”错误 |
| 其中 `device.exec` | 97 次；`deviceId` 与 `command` 都是 JSON `null` |
| 另外两次失败 | `tool.search` 参数错误 |
| 设备目录中的 ID | 完整的 36 字符 UUID，与 `currentClient.deviceId` 一致 |
| 原生工具调用 ID 长度 | 43–45 字符；没有未配对的调用或结果 |
| 相同回复文字 | 某一句原文出现 14 次，其他相近的“重新查配置”承诺也反复出现 |
| 真正执行的终端命令 | 此段记录为 0；无效调用在 worker 类型检查处被拒绝 |

当时配置的模型别名为 `grok-4.7-build-fast`，走 OpenAI 兼容链路。此名称是配置
记录，不作为底层模型实现的独立证明。SDK assistant 消息的 provider 为 `nex`。

## 直接原因与 ID 结论

调用进入执行器时的参数为：

```json
{"action":"device.exec","deviceId":null,"command":null}
```

worker 的 `toolFields` 要求这两个字段在提供时必须是字符串。类型检查拒绝后，SDK
把通用错误作为 tool result 交回模型。模型继续生成相近的“现在重新检查”文字和相同
空参数，运行器持续允许下一次模型请求，直到用户取消。客户端显示的是多次真实生成
的流式文字；本地记录里没有重复发送用户消息或复制最终回复的证据。

本次找到的记录不支持 ID 截断的解释。设备 ID 完整，工具调用和结果一一匹配。
SDK 的内部 entry ID 本来就是较短的另一类标识，不能当成设备 UUID 被截短的证据。
隔离协议测试另验证了 43 字符调用 ID 经 OpenAI 兼容及 Anthropic 往返保持一致。

**证据边界：**projection 记录的是 SDK 解析后的参数，没有保留原始 HTTP 流。
因此可确认参数到达执行器时已为 null，不能仅凭这份快照确定最初由模型、模型代理
还是流式解析的哪一层产生。没有使用真实模型凭据重发推理请求。

## 本地修复

在 `codex/repeated-tool-loop` 独立工作目录中完成：

- 参数错误列出实际错误字段、所需类型和收到的类型，例如
  `deviceId 需要 string（收到 null）`，不复制命令、凭据或其他参数值。
- Broker 提示需要真实的必填值，可选且不用的字段应省略。
- 以工具名称、参数及错误结果的摘要识别连续失败，忽略新生成的调用 ID 和进度话术。
  相同调用、相同错误连续三次后，在下一次模型请求前停止本轮并显示明确原因。
- 成功工具结果、不同参数或错误以及新的用户输入允许继续；正常长任务和成功轮询没有
  新增总调用次数限制。
- 停止前先确认持久化最后一次 tool result，避免后续用户重试恢复并重放一个看似
  没有结果的调用。SDK 的网络错误包装不能覆盖实际停止原因。

这修复了不明确反馈及无进展循环，不保证模型服务之后必定生成正确命令。
相关参数校验、审批及设备权限仍按原有流程执行。

## 隔离验证

环境：macOS arm64、Node 26.5.0。全部变更测试使用独立临时 Core、随机 vault key、
合成模型和禁用真实设备的 fixture；模型目录后台网络刷新也禁用。

- 修复前四项协议复现全部失败：重复无效调用仍不断请求下一轮，直到合成服务提供
  预置最终回复；字段错误也没有指出 null 字段。
- 修复后工具失败、字段反馈及工具目录测试共 **13 项通过**。
- 现有 Core、设备传输、模型切换、审批、模型错误、输入及消息归并回归：
  **71 通过、1 跳过，7 文件通过**。
- 新增四项端到端复现也已通过构建后的 Core / worker，覆盖两个协议；都只发送三次
  无效调用，最后结果保留，用户下一次输入可正常完成，旧无效调用不重放。
- 最终构建产物与工具回归完整复核：**59 通过、1 跳过，5 文件通过**；验证文档检查
  **7 项通过**。
- Core / Web UI 构建、TypeScript、lint、locale 及空白检查通过。

首次扩展构建产物回归中，终端取消的 `disconnect=false` 场景在六秒等待预算内未
观察到进程退出；其余 49 项通过、1 跳过。随后把该取消场景的两个分支分别对照
未修改的 Core 构建与本次构建，两边各两项通过，保留首次超时与对照日志。
本次没有据此调整终端实现或放宽等待时间。

复现命令：

```sh
pnpm exec vitest run server/personal-os/tool-failure.test.ts server/personal-os/tool-failure.e2e.test.ts server/personal-os/tool-catalog.test.ts
node scripts/build-personal.mjs --core
NEX_TEST_BUNDLE=dist-personal/server/core/index.js pnpm exec vitest run server/personal-os/tool-failure.e2e.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

Node 26 的 DOM 回归设置 `NODE_OPTIONS=--no-experimental-webstorage`。
私有诊断快照、统计和测试日志保留在原工作目录的忽略目录
`release/repeated-replies-20261107-e7ze03ma/`，不随源码提交。

## 尚未核实及发布范围

安装在本机的原生 Mac App 元数据为 0.2.20（22）；这里找到的具体重复记录来自
此前的本地体验 Core，不能用它直接证明原生安装版或另一台 Windows 机器同一时段
的每个故障都有相同原因。

按 `manage-vps` 的连接资料，对 Tokyo Core 进行只读检查时，公网与 ZeroTier SSH
均在建立会话时关闭连接，因此未取得线上 Core 或 Windows 对应会话的原始证据。
本次未操作线上服务、用户安装的应用、真实登录与会话，也未发布安装包。
修复位于本地独立分支，部署及 Windows 实机复测不在上述通过项中。
