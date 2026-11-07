# 五岗位真实验收：接入和付费闸门调查（2026-11-07）

本页保留首次调查时的证据与方案；后续已完成的本地代码和回归见 [scope 实现记录](acceptance-scope-implementation-20261107.md)。以下“没有实装”描述首次调查时状态；运行中的客户端/Core 仍未升级。

结论：**当前不能安全开始真实付费验收**。Personal Core 有业务 HTTP API，当前客户端没有受限业务自动化 IPC；Personal Core 也没有五岗位共享的 120 次 / 50 元 / 每次输出 4096 token 闸门。本记录提供隔离复现和可实施方案，**没有实装该闸门或桥接，没有升级 live Core**。

源码基线：`cf31e9cb20ce25ac705cce578394fc502f2aa8f8` 加当前已有工作区修改。本次只增加审计脚本和本记录，在验证索引增加链接；原有未提交脚本与文档保留。没有读取运行中客户端、connection.bin、真实 cookie、凭据、旧消息或实际 my_win/my_mac 配置，因而没有获得真实模型名和供应商。没有连接 NexorAI、H3、IndexTTS 或任何真实模型，没有重启/替换客户端，没有 commit、push、部署、发布。

## 已有入口及边界

`electron/nex-client-preload.cjs` 的 `window.nex` 暴露设备状态、连接、登录、模型目录和更新功能；没有业务 send/create/query 接口。`listModels` 是目录查询，不是读取某个岗位的当前选择；它可能访问供应商，不应拿来绕过“零真实请求”。禁止通过 `connection()` 或 `rememberLogin()` 提取/重用真实会话。

Personal HTTP 路由在 `server/personal-os/index.ts`；`Authorization: Bearer …` 或 HttpOnly `nex` cookie 鉴权。已登录页面可以用浏览器自动携带同源 cookie，代码无须读取 cookie。**外部 Node/PowerShell 不能因此获得认证**；当前版本没有已验证的、免导出会话的本地程序入口，也不能假设运行中的 EXE 启用了 CDP。不要临时注入脚本、开启远程调试或修改 preload 来冒充受支持入口。

| 已有协议 | 用途 | 本次证据 / 限制 |
| --- | --- | --- |
| `POST /api/bots {name,instructions}` | 新建岗位，返回 `{id}` | 隔离 cookie 请求通过；不复制其他岗位历史 |
| `POST /api/bots/model {id,provider,endpoint,model,version}` | 设置岗位模型 | 源码确认；endpoint 属于连接设置，不应从 live 数据导出；新桥接应在 Core 内复制选择 |
| `POST /api/agents/input {botId,text,clientId,attachments?}` | 连续对话，返回 `{taskId}` | 五岗位实际 worker 跑通；相同 clientId/内容幂等；相同 ID 不同内容拒绝 |
| `GET /api/agents/messages?bot=<id>&after=<seq>` | 指定岗位回报 | 隔离新岗位回报读取得到；只能对新 ID 使用 |
| `POST /api/conversations {botId}` + `POST /api/input {conversationId,text,clientId}` | 显式独立对话 | 源码确认，审计脚本没有覆盖此组合；不要与 agents/input 的绑定混用 |
| `POST /api/agents/topic {botId}` | 标记新话题 | **不是独立空白对话**；原上下文可能保留，不可用于隔离旧岗位 |
| `POST /api/cancel {taskId}` | 停止任务 | 源码确认；当前仅拟议用于 scope 内任务 |
| Broker `device.inventory` / `device.info` / `device.exec` 等 | Agent 工具 | 实际 Pi worker → Broker 的 inventory 通过；没有操作真实设备或执行真实命令 |

不要请求 live `/api/state`（包括 `?view=summary`）：`store.state()` 返回任务 objective/result_summary；`agents.contacts()` 返回各岗位 last_message。summary 只去掉记忆正文和 journal，不能满足“不读取旧聊天”。先下载完整状态再过滤，也已经越界。没有现成的独立任务查询或只读单岗位模型投影 API。本轮未新增无范围工具执行端点。

当前可用的非凭据业务方式是操作客户端可见 UI；只查看 my_win 模型控件及供应商标签，不打开旧聊天、不点击测试模型。该 UI 方式尚未在本轮驱动或验证，不能描述为已接通。程序化主会话目前只能运行下面的**离线审计命令**，不能向 live 发送任务。

## 可复验的隔离证据

在仓库根目录运行：

```powershell
node scripts/audit-personal-acceptance.mjs
```

脚本不接受 live URL、数据目录或凭据参数。默认在新建 `nex-acceptance-audit-*` 目录以 esbuild 打包 Core index 和 worker（ESM、Node 22、`PI_BUNDLED_NODE=true`，与正式 Core 构建参数一致），复制 schema，启动一次独立 Core HTTP listener。`identity:false`、`memoryRuntime:false`、`hostDevice:false`、模型目录联网关闭，模型只指向新启动的 loopback fake provider，所有密钥均为合成值。退出关闭本轮实例、验证绝对清理路径后只清理自己创建的目录；不改 dist-personal 或安装包。

这不是完整 `build-personal --core`、UI 构建或客户端包验收。内置技能文件未打包（Windows 下复制 skills 目录得到 EIO，之后删去未使用的复制步骤）；测试没有调用 skill.read。也没有验证原 EXE `acf598be` 的实际服务端代码与当前 HEAD 一致。

最终命令退出 0；fixture `C:\Users\郭桂林\AppData\Local\Temp\nex-acceptance-audit-NL7Abg` 已清理。最终 bundle SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| index.js | `d541ab4f2c869474fd08db2ad02e55d5d8d9881d32d87ab4ca4018850993a637` |
| worker.js | `d34686a9e4a729c52eb6e334f9e8218f557d87b224dc9aa67d739296fc22a3a8` |

最终结果摘要（原始 JSON 同时输出到命令结果，不包含合成认证值）：

```json
{"cases":["unauthenticated-api-401","cookie-authenticated-business-protocol","five-fresh-assistants-and-distinct-conversations","actual-Pi-worker-and-broker-device-inventory","scoped-reports","idempotent-clientId-no-extra-request","synthetic-existing-assistants-unchanged"],"liveRequests":0,"gaps":{"legacyLimitOneAllowsTwoRequests":true,"configuredOutput8192ReachesProvider":true,"sharedMonetaryGateImplemented":false,"scopedAutomationBridgeImplemented":false},"syntheticRequests":10,"passed":true}
```

五岗位分别收到 fake 工具指令、经真实 worker/Broker 成功调用 inventory，再收到 fake 回报；各任务成功、五个 conversationId 不同。重复提交没有增加请求；合成 my_win/my_mac 的 bots 行逐字段不变。**这只证明协议与缺口，不代表 live 接入成功，也不是预算修复测试**。没有模拟真实制作短片成功。

首次直接用 Node 运行源码因 TS parameter property 不支持失败；`--experimental-transform-types` 源码模式通过后，脚本改为默认隔离打包模式，最终普通 Node 命令通过。SQLite 的 ExperimentalWarning 不影响结果。

静态检查：`node --check scripts/audit-personal-acceptance.mjs`、`node node_modules/oxlint/bin/oxlint --deny-warnings scripts/audit-personal-acceptance.mjs`、`git diff --check` 均退出 0。`pnpm exec oxlint` 因 pnpm 自动依赖检查要求非交互重装而中止，未强制重装；改用已安装的 oxlint 直接检查通过。最后仅将清理路径检查改用断言以消除 no-unsafe-finally 警告，不改变被打包的 Core/worker。

## 预算真实缺口与出口清单

1. `runtime.ts` request 分支在登记 `model_invocations` 后返回 permit，没有金额/总次数检查。此次实际证明 task 的 `legacy_max_model_calls=1` 仍发出两次物理请求；legacy 字段不能用作闸门。
2. `worker.ts` 的 fetch hook 每次请求拿 permit，但随后才构造最终 prompt 和输出上限。设为 8192 的上限实际到达 fake provider；全局或提示词里写 4096 不够。看图随回答请求走同一出口，但须覆盖图片计费与重试。
3. `assistant-model.ts:assistantCompletion` 独立直连 fetch，登记 `assistant_usage`；部分后台路径有每天 token 限额，不是五岗位共享计价限额。整理、工具摘要、工作笔记再压缩、归档、后台维护均经过这里，不经过普通 request permit。
4. `retrieval.ts`、`embeddings.ts`、`rerank.ts` 有独立调用和用量，不能只数聊天表。外部记忆 Hindsight 的 retain/recall 等服务还可能在服务内部多次推理，客户端无法保证逐次计数。
5. `image-models.ts` 单独 `/images/generations`；`local-agent.ts` 启动本地模型 CLI；device.exec、连接器和委派也可能从其他进程/旧岗位发起付费。仅在 runtime.request 加 if 会漏记。
6. 现有只统计 succeeded 的使用视图会漏掉失败和未知调用；它是展示，不是扣费总账。Enterprise `spend-cap.md` 不能证明 Personal 支持该功能。

## 待实施的最小受限桥接（协议草案，当前不存在）

先在 Core 实装预算后，再提供以下高层入口；不用通用 URL 代理、JS eval、SQL 或任意 IPC。把桥接放在已认证 renderer 的应用组件中，调用同源 API，凭据由浏览器自动携带。若需要外部进程自动化，另加明确启用的客户端 IPC/本地管道命令适配器；验证 sender/frame/origin，输出 DTO，禁止向调用者返回 token、cookie、连接原始配置。不得认为只加 Core API 就已经解决外部进程认证。

建议 API 均位于 `/api/acceptance/*`，沿用 owner/workspace 鉴权并强制同源 JSON/CSRF 检查：

| 拟议命令 | 输入 | 只允许返回/执行 |
| --- | --- | --- |
| `source-model` | `{sourceName:"my_win"}` | Core 内精确匹配唯一 active 岗位；返回 model、协议类型、已审定的供应商显示名。无 endpoint、key、instructions、last_message。重名/缺供应商信息拒绝，不猜供应商 |
| `prepare` | `{sourceId,names:[五个唯一名称],root,limits:{calls:120,cnyMicros:50000000,maxOutput:4096}}` | 一笔事务创建新预算、新五岗位及新独立 conversation；Core 内复制 model selection，不复制历史/记忆/权限，不能覆盖原岗位或改全局设置；返回 scopeId、新 IDs、预算和未就绪原因。root 必须为批准目录下全新子目录 |
| `status` | `{scopeId,after?}` | 只投影此 scope 的任务/报告/设备操作状态、累计次数、已结算金额、未决预占，不返回其他岗位、旧消息或提示词 |
| `send` | `{scopeId,botId,clientId,text,attachments?}` | 只允许新五岗位；输入幂等；ready 前拒绝，不能改预算或指向旧 conversation |
| `stop` | `{scopeId,taskId}` | 只取消该 scope 任务；保留未知预占 |

Scope ID 是隔离标识，不是认证凭据。所有 IDs 必须服务端查 membership，不能仅靠 renderer 过滤。设备工具仍通过真实 Agent → Broker → 已登录设备执行器，继承审批、取消、回执；不得开一个旁路 `exec` 假装完成派活。设备访问限制在新验收目录；不修改既有设备 root、授权或全局配置。原本客户端设备登录即自动控制的行为保持不变。

外部自动化桥接不是已有能力，本轮没有制作并注入临时 preload；其安装/启用会改变运行中客户端，超出本轮边界。Core 高层入口也须代码实装、隔离验证、单独获准部署后才能调用。

## 待实施的共享预算设计（当前不存在）

新增持久表 `inference_budgets`、`inference_budget_members`、`inference_attempts`；金额用整数 micro-CNY（50 元=50,000,000），价格单位用有理数，向上取整；禁止 JS 浮点金额。预算绑定 workspace/owner 及五个新岗位，原岗位无 membership，走原行为。`prepare` 同一事务绑定，不能先建可运行岗位再补预算。

所有新岗位推理经过统一 `reserve → network → settle` 服务；worker 必须在最终 payload 形成后、实际 fetch 前提交元数据请求许可，Core 独立验证模型/连接版本及可计费上界。辅助请求、每次重试及每次 fallback 都算独立 attempt；缓存写入/读取、推理 token、图片和额外请求费都要包含在有依据的最坏金额内。每次物理请求 output cap≤4096，覆盖提供商的 max_tokens/max_completion_tokens 等真实计费参数，不能只截断最终显示文本。

- 预占事务用 SQLite 写事务/条件更新，确保 `attempts+1≤120` 且 `settled+reserved+newWorstCase≤50,000,000`，成功后才可发送。attemptKey 唯一；重复拿 permit 不重复扣，但不能重复网络发送，已有发送/未知 attempt 拒绝再次发送。五岗位同时竞争同一预算行。
- 价格快照必须有确切 provider/model/版本/币种/单位/有效期及经确认的汇率依据；不能从模型名猜、不填假价格。缺价、过期、币种不明、收费项无可靠上界、模型输出控制不覆盖 billable reasoning 或服务内部多次推理不可审计时，拒绝网络访问，标记 not_ready。不能用估算 tokens 当金额硬上界；输入预占采用已证实的计费上界（必要时按全 contextWindow，且图片另计）。
- 只有可验证的完整用量和固定价格结算才释放差额；失败、取消、HTTP 错误、断线、无 usage 或异常回执，次数不退，金额保留整个最坏预占。只允许可信结算一次；重复/迟到回执不能重复退款。异常账单越界立刻冻结并报告，但事后冻结不能被宣称为事前硬保证。
- 重启将发送中 attempt 标 unknown，保留次数和预占；不重发、不恢复成免费额度。scope 状态、成员绑定、价格快照、output cap、停止状态随 DB 持久化。上线前对历史未知 attempt 禁止自动“清零”。
- 对这五岗位禁用外部不可审计 Hindsight 推理、付费连接器、本地模型 CLI、跨 scope 委派和 agent 创建；不改变其他岗位功能。若必须使用，先让其每个底层模型请求接入同一预占账本。单靠 memoryRuntime:false 测试参数不能当作 live 按岗禁用实现。
- 设备任意终端命令可绕过 Core 发请求，所以验收 scope 只能执行获准的本地渲染/FFmpeg 等确定脚本，限制网络、凭据继承、文件根目录及子进程；不能授予任意 device.exec 后宣称覆盖所有推理。H3/IndexTTS/NexorAI 等仍保持本轮禁止调用。
- 记忆检索、embedding/rerank 和后台整理必须携带 scope；无法归属到该 scope 的共享后台工作不得为它启动或记到别的岗位。不能为了这一点关闭全局记忆或改 my_win/my_mac 配置。

实装后最低验收矩阵：未知价格零发包、120/121 边界、50 元精确边界、五岗位并发最后一份额度、失败/未知/取消仍计数、重复 permit/回执、预占提交后崩溃/发送后崩溃/重启、辅助路径/重试/看图/output≤4096、连接/模型漂移拒绝、跨 scope 工具/委派拒绝、旧岗位逐字段不变。全部用独立 fixture 与合成单价；合成单价只能测试算法，不能当真实价格依据。

## 主会话下一步

目前只能读本记录和运行离线命令，暂停真实付费派活。若仅需人工查看 my_win 的模型/供应商，可通过现有可见 UI 单独读取相应控件，不读取旧聊天；本轮未执行，供应商实际价格仍未知。

真正继续全链需要：先实现上述 Core 预算及窄接口、完成隔离矩阵；确认真实单价/收费单位/汇率/服务端上界；再明确授权部署该已审阅修改（按 AGENTS.md 从 pushed main 发布）以及必要的客户端桥接安装/重启。部署前不能把本地 fixture 通过当成线上能力。没有这些条件，不应先创建能执行付费任务的岗位或调用任何真实模型。
