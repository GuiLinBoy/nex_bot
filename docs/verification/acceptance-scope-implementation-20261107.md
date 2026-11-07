# 五岗位验收 scope：本地实现与隔离证据（2026-11-07）

**阶段记录，已归档。** 本页描述 r4 阶段；其中“外部入口未实现”“禁止所有委派”“约20秒执行”等限制已在后续源码中修复。最终能力、r7 唯一交付目录和仍需批准的步骤以 [最终记录](acceptance-scope-final-20261107.md) 为准。首次审计和本页保留用于追溯，不能据此判断最终源码能力。

已实现可审阅源码和隔离构建，**未部署，当前 0.9.28 客户端和 live Core 尚不具备这些新增能力**。真实供应商、模型 ID、连接版本仍须由升级后的 Core 返回，不能把 UI 的“跟随默认（grok 4.7 build fast）”显示文本当作协议 ID。主会话未获得可靠价格，所以本轮没有填写真实价格，任何默认创建的 scope 都是 `not_ready`。

没有读取真实 connection.bin、cookie、模型 key 或旧聊天；没有调用真实推理或媒体创建，没有修改漫剧项目，没有创建 live-execution-ready.json，没有操作原有岗位、全局设置、当前安装包或线上服务。所有生成/执行结果均为隔离 fixture 的合成结果。没有 commit、push、部署或发布；GitHub 与 OSS 发布均跳过。

## 代码与行为

`server/personal-os/acceptance.ts` 独立实现 schema 43、预算、范围成员、模型快照、窄投影和受控脚本清单；`store.ts` 只增加迁移/实例化及输入对话范围检查。新 scope 固定 5 个新岗位，和 120 次 / 50,000,000 micro-CNY / 输出 4096 上限，不接受客户端价格、预算或工具清单。

- `prepare` 在同一 SQLite `BEGIN IMMEDIATE` 事务中创建 scope、岗位、固定模型选择、独立 conversation 及收窄工具权限。名称冲突回滚整个批次。已准备但未执行的新作品根可绑定，不会把其已有文件当作执行证据。根目录在 scopes 中唯一，禁止祖先/子目录重叠；本轮不在真实设备检查/创建作品目录。
- `source-model` 只读取唯一 active `my_win` 的模型元数据，无须读取 API key。返回确切存储的 model ID、协议、连接的 hostname（不是完整 URL/路径/查询）、connectionVersion 和不透明 revision。hostname 用来标识配置连接，不代表已验证品牌或价格。
- 跟随默认会在 prepare 时解析成固定 model ID，写入新岗位自己的 model selection；同时锁定连接版本和 contextWindow。之后全局默认、连接或窗口改变会拒绝继续，不能静默改模型；prepare 也拒绝过期 sourceRevision。
- `worker.ts` 在真正 fetch 前发送 `dispatch`，Core 校验该 run 的 invoice、最终 payload 的 model/output、图片价格覆盖和 scope 状态，成功预占后才返回许可。每次物理请求单独占一个 attempt。普通 request 只提供最新 prompt，不被误当成已经扣费或发包。
- 五岗位共享一行预算条件更新。已用次数不退；成功把全额收费上界从 held 转为 chargedUpper；失败、取消、无可靠结果保留全额 held。重复结算或未知后的迟到成功不会退款。重启把 dispatched 变为 unknown，并冻结存在 dispatched/unknown 的 scope，禁止自动重发。
- 采用**保守上界结算**，没有实现基于真实 token 单价的差额退款。`chargedUpperCnyMicros` 不是实付金额。需要经确认、全费用覆盖且有效的人民币单次请求收费上界；若服务没有可证明的上界，不得用平均价格或估算替代。缺价、过期、币种/单位不符、输入覆盖不足均不就绪。
- 压缩/摘要/后台整理/工作笔记再压缩统一在 assistantCompletion 出口拒绝；embedding/rerank 出口拒绝；scope 关闭自动 recall、长期记忆整理和外部记忆传输。生图、CLI、连接器、Agent 创建/委派、例行任务等在策略层拒绝，不改旧岗位行为。
- 图片理解可经 scope 附件接口和自身 `attachment.read` 完成，物理图片请求占同一账本。quote 未明确覆盖图片时，上传和图片 payload 都拒绝；跨岗位附件拒绝。scope 上传跳过全局旧附件清理，避免触及其他岗位数据。

## 已认证 renderer 的实际入口

`src/personal/main.tsx` 启动时安装只读 `globalThis.nexAcceptance`，实现在 `src/personal/acceptance-bridge.ts`。固定命令仅请求 `/api/acceptance/*`，自动使用浏览器的同源 HttpOnly cookie，完全没有读取/导出认证数据的 accessor。没有通用 URL、JS、SQL 或设备 exec 入口。

| renderer 方法 | HTTP POST | 参数 |
| --- | --- | --- |
| `sourceModel()` | `source-model` | 固定 `{sourceName:"my_win"}` |
| `prepare(data)` | `prepare` | `{sourceId,sourceRevision,names:[五个唯一新名称],root}` |
| `status(scopeId)` | `status` | scopeId |
| `send(data)` | `send` | `{scopeId,botId,clientId,text,attachments?:[id]}` |
| `attach(data)` | `attach` | `{scopeId,botId,name,data:base64}`；只接受图片 |
| `stop(data)` | `stop` | `{scopeId,taskId?}`；缺 taskId 则停止整个 scope |

使用顺序（**只适用于升级后的已认证 renderer；本轮没有在 live 执行**）：

```js
const source = await globalThis.nexAcceptance.sourceModel();
const prepared = await globalThis.nexAcceptance.prepare({
  sourceId: source.sourceId,
  sourceRevision: source.revision,
  names: ['验收导演-唯一批次', '验收编剧-唯一批次', '验收画师-唯一批次', '验收剪辑-唯一批次', '验收审核-唯一批次'],
  root: 'D:\\ai剧集制作\\漫剧\\作品\\全链验收-雪夜推门-20261107-7dd4e916',
});
// prepared.ready === false 时停止在这里；不得调用真实模型或媒体提交。
const status = await globalThis.nexAcceptance.status(prepared.scopeId);
```

`status` 只返回此 scope 的成员、任务、回报、工具状态、模型快照和预算；不查询 `/api/state`、全局消息、旧岗位历史或记忆。所有范围/任务/附件 ID 均在服务端核对。API 保留原认证并再检查提交时身份；未认证 401、跨站 JSON 请求 403。

**外部 Node/PowerShell 仍没有直接无凭据调用运行中客户端的入口。** 本轮没有开启 CDP、加入 named pipe/HTTP 本地代理或替换 preload，也没有把普通 JS 函数宣称成外部进程通道。若必须由外部自动化驱动当前登录 session，仍须另做并验证客户端原生适配器：只接收上述六个固定命令，通过 renderer 应用接口执行，核对主窗口 sender/origin 和本机当前用户访问控制，不返回 cookie/token。该适配器、新包安装与重启均需另行批准，不能向现运行 EXE 注入代码绕过。

## 设备脚本边界与固定工具目录

新 scope 不允许任意 device.exec。Core 只从**服务端运维策略**选择精确命令别名；固定 executable、argv、项目根参数位置、cwd、risk 和文件 SHA-256 都进入 canonicalEnvelope，沿用原 DCP 身份、设备 grant、审批、租约、取消与回执。

`acceptance-execution.ts` 在设备端核对 root、清单文件与解释器的绝对路径/realpath/哈希，以 `shell:false` 启动固定 argv，排除用户模型凭据环境变量。读取仅允许标记 readable 的精确哈希文件；不允许读取解释器或其他任意路径。执行可使用作品目录**以外**的已审阅工具路径，不会因为它不在作品根下就扩大到任意命令。模型不能替换命令、增加参数、降级清单 risk、更换设备或作品根。

设备 hello 新增 `acceptanceExec:1`。Core 在 proposal/recheck 和发送设备调用前检查该能力；旧客户端不支持时拒绝，不会向旧执行器发送可能被它忽略约束的 shell 命令。`node.ts` 的普通非 scope 终端路径不变。执行器仍受既有约 20 秒设备执行租约限制；长任务必须使用已批准的提交/查询方式，不能通过延长或旁路租约解决。

原生固定清单的参数结构示意（**不是实际授权清单；没有填写真实哈希/价格，也没有执行**）：

```text
command: 固定业务别名，如 acceptance:state-read
deviceId: 本次获准设备 ID
root: 新作品绝对根
executable: 已核对的 Python/FFmpeg/ffprobe/ASR 解释器或可执行文件绝对路径
args: [D:\ai剧集制作\漫剧\短剧工具\tools\authorized_cli.py,
       --project-scope, <同一新作品根>, <一个固定子命令>, ...固定参数]
projectRootIndex: 2
risk: standard 或 dangerous；运行时不能降级
files: 解释器、authorized_cli.py 及所有需锁定的依赖脚本，逐一真实 SHA-256
credentialsExcluded: true
immutable: true
networkDenied: true（已独立验证的离线执行环境）
或 networkDenied:false + mediaBudgetEvidence（已另行批准且独立限额的媒体提交）
```

主会话的 authorized_cli.py 可作为固定入口；pipeline_state 的岗位字段、H3/TTS/image 各批准批次、FFmpeg/ASR 均须展开为**不同的完整固定 argv 清单项**，不接收自由拼接参数。只有该清单中已审阅脚本自身获准的路径写入（包括受控全局账本追加）可以由它执行；模型不能请求任意全局文件写入。

这是可信脚本与运维清单边界，**不是通用 OS 文件/网络沙箱**。哈希核对不能证明脚本的所有动态依赖都已审阅，cwd 也不构成写入沙箱。运维必须验证全部依赖和离线环境，或验证独立媒体预算。Core 不读取/验证漫剧项目凭据，也不能证明其媒体限额实现已经生效。本轮没有登记这些真实脚本、解释器或 deviceId，不能宣称真实媒体执行已接通。

## 运维配置和默认拒绝

每个 Core 账号工作区在自己的数据目录只读加载 `acceptance-policy.json`，启动时读取一次，HTTP 无写入接口。缺失/格式错误仅禁用 acceptance，不影响原岗位。最安全的初始内容是：

```json
{"quotes":[],"scripts":[]}
```

quote 类型与校验见 acceptance.ts：fingerprint 使用 source-model 的 revision；currency 固定 CNY、unit 固定 request-upper-bound、boundCnyMicros 是有证据的全费用上界、maxInputTokens 覆盖该 contextWindow、maxOutputTokens 固定4096、有效期和 evidence 必填；图片另需 supportsImages。不能把 fixture 的合成价格复制到此文件。缺少真实计价依据时保持空 quotes。

prepare 将 quote/scripts 快照到 scope，此后不能通过 send/status 提高限额或变更脚本。补好策略须重启 Core 后另建新的唯一 scope；未知预占不会被重新加载策略清除。此配置读取代码未在 live 数据目录运行。

## 验证和产物

源码基线 `cf31e9cb20ce25ac705cce578394fc502f2aa8f8`，保留用户原有未提交脚本/文档。无真实模型调用。新增主套件 `server/personal-os/acceptance.test.ts`：源码 11/11 通过；最终 r4 Core bundle 的相同 11 项回归通过（最终结果与 SHA256SUMS 放在产物目录）。

覆盖：窄投影/旧聊天哨兵不泄漏；批次回滚；认证/跨站拒绝；缺价零发包；五岗位共享120/121边界；50元精确边界；重复许可/回执；失败/取消/迟到回执不退款；重启未知冻结；源模型/版本锁定；五个真实 worker 流程；五个并发 worker 仅一个获得最后金额额度；图片理解共享账本；辅助/跨范围/未经审阅脚本拒绝；真实隔离 WebSocket 设备执行、原审批与 hash 变化拒绝。

其他回归：模型选择/审批/工具失败 19 项通过；设备命令/客户端传输/当时 scope 套件合计18项通过。扩展 memory/recall/maintenance/retrieval/app/workspaces 共139项：134通过、2跳过、3失败。失败是 memory-recall.test.ts 的三个超长工作笔记压缩断言；在 release/acceptance-baseline-cf31e9cb-20261107 中用 `git archive HEAD server shared package.json` 导出的未修改基线，定向复跑同三项也全部失败（期望压缩次数>0，实际0），属于已存在问题；本次没有修改这些测试或原压缩逻辑。不得把整个扩展套件描述为全绿。

构建产物：`release/local-acceptance-scope-20261107-r4/`，包括隔离 Core index/worker、client-node bundle、Vite UI、精确变更补丁和 SHA-256 清单。此前 r2/r3 与空的首轮 artifact 目录均是中间尝试，不可用作最终接入版本。r4 不是可安装 EXE，也不是完整发布 overlay；不包含完整 PDF/电脑运行时或内置 skill 文件，不应复制替换生产安装。

最终 Core bundle：

| 文件 | SHA-256 |
| --- | --- |
| core/index.js | `b44037465eb58cf5b26159ae1b4eb31cfef4f342976601acd5a1baa51c4f8429` |
| core/worker.js | `644129741baadca575d9601ce7d051ef8318d39f27c5a8394cd877aa271483a1` |

Core 本地重建/兼容性审计命令：`node scripts/audit-personal-acceptance.mjs --build-output=release/<新的唯一目录>/core`。只允许写仓库 release 下尚不存在的目录；不改 dist-personal。脚本仍验证旧岗位没有被新增限额约束（8192输出、legacy字段1却允许工具往返），这是兼容性证据，不是新 scope 闸门失败。

最终 bundle 套件命令（PowerShell，执行后恢复原环境变量）：设置 `NEX_TEST_BUNDLE=release/local-acceptance-scope-20261107-r4/core/index.js`，运行 `node node_modules/vitest/vitest.mjs run server/personal-os/acceptance.test.ts`。两份 TypeScript 配置检查、修改代码 oxlint 和 `git diff --check` 通过；Vite 有已有的大 chunk 提示，构建退出0。依赖未重装。

## 尚需批准/补齐的真实接入步骤

1. 审阅本地补丁；确认真实供应商全费用价格上界及币种、单位、有效期。当前没有可靠依据，scope 必须继续不就绪。
2. 按 AGENTS.md 走 main 提交、推送、完整 Core/UI 构建及隔离验证，再批准部署到真实 Core。本轮明令禁止这一步，未执行。
3. 将受限执行器编入新的 Windows 客户端本地测试包，并在隔离包中验证后，另行批准安装/重启用户客户端。现运行0.9.28不支持 acceptanceExec；不能只部署 Core 就宣称设备链完整。
4. 如需外部进程自动化，另行实现并隔离验证上述固定命令原生适配器/当前用户访问控制，授权后才启用。现在只有升级后已认证 renderer 内部的固定入口。
5. 由运维按该账号部署已核对的脚本/依赖/解释器哈希、固定参数、媒体预算证据；保留原设备审批。主会话另行检查媒体 live-execution-ready.json 条件，不由本补丁代签或创建。

在这些条件完成前，主会话可以继续准备输入、离线验证和审阅；不能把 scope 创建、UI 构建或 fixture 通过当成真实派活/生成成功。
