# 五岗位接入修复：最终 r7（2026-11-07）

后继交付：[r8 完整 Windows 本地测试包及精确包验证](acceptance-local-exe-20261107.md)。r7 已封存；后续仅增加真实回报的 task_id 投影，并完成此前未完成的完整包验证。下文“未准备完整EXE”保留为 r7 当时状态，不能据此判断 r8。

**本地代码与隔离验证已完成；运行中的 0.9.28 客户端和 live Core 未升级。没有真实推理/媒体创建请求，没有 commit、push、部署、安装或重启用户客户端。缺少可靠真实计价依据，真实 scope 必须继续 `not_ready`。**

唯一最终交付目录：`D:\claude_project\nex_bot\release\local-acceptance-scope-20261107-r7`。r2～r6 是中间验证产物，不用于接入；r7 也是测试 bundle，**不是完整可安装 EXE 或可直接覆盖生产的 release overlay**。此前调查及 r4 阶段记录保留历史，以下内容取代其过时能力说明。

## 已实现与实际验证

| 边界 | 最终行为及证据 |
| --- | --- |
| 新 scope | 一个事务创建5个全新岗位、固定模型选择、独立对话、scope专用工具和预算。冲突整批回滚；不复制历史/权限/密钥，不改 my_win/my_mac。已有准备文件不被视为执行证据 |
| 来源模型 | 仅查询唯一 active my_win 的模型元数据；返回存储的协议ID、model ID、供应商连接 hostname、连接版本和 revision。prepare 校验 revision，解析“跟随默认”为固定ID，连接/窗口变化即拒绝。没有自行更换供应商/模型 |
| 预算 | 固定共享120次、50,000,000 micro-CNY、输出≤4096；最终物理 fetch 前原子预占，每次网络重试独立计数。失败/取消/未知不退次数和金额；重启未知请求冻结，不自动重发 |
| 计价 | 成功按**经运维审定的全费用单次人民币上界**保守结算；不是实际消费统计，不做估价退款。缺价、过期、错误单位/币种、图片未覆盖等拒绝。evidence 的真实性须人工审核，代码不会从一句证明文本自动验证价格。合成价格只用于算法测试 |
| 辅助推理 | scope 内摘要/压缩/笔记再压缩/后台维护/embedding/rerank/外部记忆关闭或出口拒绝。直接生图、连接器、本地模型CLI、跨scope委派、Agent创建等拒绝。旧岗位行为保持原样 |
| 五岗位协作 | `agent.directory` 仅投影本 scope 同伴；同scope `agent.delegate` 使用原身份和回报链，子对话登记到同scope，所有父/子请求占同一预算。跨scope、旧岗位及带旧主题的委派拒绝。真实Pi worker父子任务回归通过 |
| 看图 | 窄attach接口只接受本scope图片，跨岗位附件拒绝。对应岗位真实 attachment.read 后再看图，2次fake物理请求占同一账本。UTF-8脚本读取不能冒充看PNG |
| 设备工具 | 只允许受信清单固定命令别名、解释器/脚本/依赖SHA、argv、作品根位置、cwd、risk、设备。允许工具位于作品目录以外，不开放任意exec/Python -c/PowerShell。原设备grant和DCP身份检查保留，旧执行器缺acceptanceExec=1即拒绝 |
| 站立授权 | 运维清单显式 `preauthorized:true` 才能在新scope快照成精确规则；风险级别不能由模型降级。模型无approve入口。手动审批路径和免逐次卡片的精确预授权路径均经真实隔离DCP执行通过；未授权命令/参数/设备/文件漂移仍拒绝 |
| 本机运行时 | 真实 Python 3.14.2、FFmpeg/ffprobe 9.0.2 经同一设备入口生成/检查0.2秒合成黑色视频。固定绝对路径+哈希，最小PATH仅来自已锁定运行时目录；只显式配置非秘密用户目录。合成KEY/PYTHONPATH哨兵确认未继承。没有ASR转写或真实媒体服务验证 |
| 长任务 | 可信清单 `timeoutMs` 为1..3,600,000；模型不能提高。保留原30秒**投递**租约与旧岗位20秒执行默认；新scope按独立可信执行期限等待。实际32秒DCP作业跨过投递租约后成功，等待期间没有模型轮询；只有工具前后2次请求。没有实际等待60分钟 |
| 文本分页 | 仅固定hash、readable白名单的UTF-8文件；device.read真实契约含offset/limit（1..24000），响应有nextOffset/totalCharacters/hash。每页重新验SHA；>24k文本实际DCP首尾两页拼接等于原文，越界/类型/变更hash拒绝 |

## 当前可审阅的外部固定入口

新增 Windows 客户端适配器 `electron/nex-acceptance-bridge.mjs` 和固定 PowerShell 管道helper。**默认关闭，须以 `--acceptance-bridge` 启动新版客户端才启用。** Windows管道ACL仅授予当前SID；没有TCP监听、通用JS/SQL/IPC或凭据导出。包清单包含JS/helper，helper在Windows包中asarUnpack；Mac壳仅补齐静态JS依赖，Windows入口不在Mac启动。

调用链已经真实隔离验证：外部PowerShell进程 → 当前用户管道 → Electron主进程固定命令校验 → 已认证renderer应用接口 → 同源HTTP API（浏览器自动携带HttpOnly cookie）→ Core范围校验。内部JavaScript表达式只由固定枚举方法名与JSON构造，外部不能提交脚本。主进程再次仅投影业务DTO字段；不返回cookie、Authorization、连接文件或API key。没有用DevTools访问当前用户客户端。

固定命令：`sourceModel`、`prepare`、`status`、`send`、`attach`、`stop`，对应 `globalThis.nexAcceptance` 与 `/api/acceptance/*` POST。sourceModel固定只读my_win；prepare `{sourceId,sourceRevision,names:[5项],root}`；send `{scopeId,botId,clientId,text,attachments?}`；attach `{scopeId,botId,name,data:base64}`；stop `{scopeId,taskId?}`；status输入scopeId字符串。返回仅scope成员/任务/回报/工具状态/模型快照/预算，最多100条各类记录，不读取live `/api/state`。

升级且用户允许启用后，外部可调用（**现在不能对旧0.9.28执行来冒充接通**）：

```powershell
# 新版客户端经批准启动时附加 --acceptance-bridge；保留它原来的 profile。
# Profile 指该客户端明确使用的用户数据目录，不读取其中 connection.bin。
powershell.exe -NoProfile -NonInteractive -File scripts/control-acceptance.ps1 `
  -Profile '<客户端profile绝对目录>' -Command sourceModel

# prepare/send/attach/stop 从InputFile读JSON对象；status文件只存scopeId的JSON字符串。
powershell.exe -NoProfile -NonInteractive -File scripts/control-acceptance.ps1 `
  -Profile '<同一profile>' -Command status -InputFile '<scope-id.json>'
```

客户端登录失效、页面来源不符、renderer变化、未知命令或API拒绝均不放行。响应可能超时的变更操作须先按clientId/status核对，不盲重发；send保留原幂等语义。当前用户ACL在代码中构造并实际由同一用户连接验证；未创建另一Windows账号做跨用户登录实验。

## 运维清单、运行时和长任务

每账号工作区只读加载自己的 `acceptance-policy.json`；API不能写。默认 `{"quotes":[],"scripts":[]}`。quote与script类型见 `server/personal-os/acceptance.ts`；prepare将其快照，不能经send提高预算或变更授权。策略变更需重启Core并创建新的唯一scope，未知预占不清零。

固定脚本优先采用主会话的 `D:\ai剧集制作\漫剧\短剧工具\tools\authorized_cli.py`：以固定Python绝对路径启动，固定argv `[authorized_cli.py,--project-scope,<新作品根>,<固定子命令>,...固定参数]`，`projectRootIndex:2`；每个动作单独清单项。锁解释器、启动器、所有需审定的依赖/运行时SHA；动态业务JSON按下节处理，不把它们当代码锁旧hash。

`runtimeExecutables` 每个路径都须在files中有SHA；仅这些目录组成child PATH。可显式传USERPROFILE/LOCALAPPDATA/APPDATA/HOME绝对目录，其他环境字段拒绝。原程序可按自己的已审定逻辑内部取得媒体凭据，不经模型、参数、管道或日志导出。主会话的runtime-tools.json尚未由本线程登记或执行；本文测试没有访问真实作品/媒体凭据。

脚本需已独立验证离线环境（networkDenied），或有已另行批准的独立媒体预算证据（mediaBudgetEvidence）。这不是OS网络/文件沙箱；cwd不阻止可信代码写其他路径，必须审定全部动态依赖与脚本自身的路径/业务限额。仅获准脚本内部追加全局账本属于其独立授权；没有泛化全局写文件能力。

H3的5分钟查询、最长60分钟和同步生图等待可封装为一个**固定hash的submit+query/wait脚本**，设置明确timeoutMs≤3,600,000。脚本内部按既有预算/幂等查询等待；Agent只调用一次device.exec并等待回执，主控调用status看executing状态，不产生模型轮询。正常取消沿原DCP发送取消并终止该次确切PID树；断线保留unknown/设备journal，禁止自动重放，重连核对回执。硬崩溃后的进程/媒体服务状态仍可能未知，不能把unknown当成功或免费重试。媒体脚本与60分钟完整时程本轮未真实运行。

## 动态业务输入：明确的数据搬运协议（设计，未落盘实现）

本补丁没有任意写文件工具，也没有在漫剧项目实现主控落盘器。主会话可以据以下协议实现固定sink；**这部分是方案，尚未经过本线程端到端制作验证**：

1. 主控保存prepare返回的新botId→角色映射，作为可信配置；派活时给出本阶段目标和允许的proposal kind。岗位以最终assistant回报提交一个JSON对象，不运行写文件代码。
2. 主控只取该scope内指定taskId/botId的实际最终回报，保存其reportId、原文SHA、scopeId/taskId/botId。校验task属于成员、任务已完成、kind获该角色授权、JSON无额外字段。拒绝markdown包裹、多对象、任意路径/命令/代码/环境字段。
3. 固定schema示例：`script`只含sceneId/时长/正文；`visual-prompt`只含sceneId/positive/negative；`continuity`含sceneId、由主控确认的新作品尾帧引用及SHA、**恰好两句**承接；`voice-range`含已确认音色来源引用、整数startMs/endMs（0≤start<end）。场次数、总时长24秒、旁白300字等按项目实际schema进一步限制。输出文本仅作为JSON数据，不插入shell。
4. sink路径由可信角色/kind映射决定，例如 `<新作品根>/准备输入/岗位产物/<botId>/<kind>.json`；不接受模型指定文件路径。以受控原子写入保存，并返回receipt（报告关联、相对固定路径、schema版本和SHA），主控不代运行岗位工具、不签通过、不填伪造的执行状态。
5. 主控把receipt发回对应岗位；岗位自行调用已预授权的固定authorized_cli动作，由该脚本再次校验作品、角色数据schema/路径与业务审批。脚本代码/策略/运行时锁hash，业务数据按schema与receipt版本校验，允许合法修订。
6. 尾帧/图片由主控从新作品读取并经窄attach上传到对应岗位；岗位真实attachment.read/模型看图，计入同scope预算。状态/ASR结果由固定只读脚本返回，不用UTF-8 device.read冒充图片，也不开放任意文件读取。

建议锁定的数据契约如下（schemaVersion=1；所有层级 `additionalProperties:false`，均不接受path/command/env字段）：

- 统一对象只含 `{schemaVersion:1,kind,sceneId,data}`；sceneId匹配`^S0[1-8]$`；botId/角色/taskId/reportId由主控从真实回报关联，不能由提案自证。
- kind=`script`：data只含durationMs（整数1..24000）、narration（0..300 Unicode字符）、action（1..4096字符）。主控汇总所有分镜必须恰好24000ms，旁白合计≤300字符。
- kind=`visual-prompt`：data只含positive（1..4096字符）、negative（0..2048字符）。
- kind=`continuity`：data只含sourceFrameId（主控已颁发的资产ID）、sourceFrameSha256（64位小写hex）、lines（恰好2项，各1..200字符）。主控按资产ID查表，要求它是本作品实际尾帧并重算SHA；不接受模型给出的文件路径或未产生的尾帧。
- kind=`voice-range`：data只含voiceSourceId（已批准资产ID）、startMs/endMs（整数，0≤start<end≤该素材ffprobe已验证时长）。无真实素材证据则拒绝，不填假时间范围。
- 主控可信映射逐个botId声明allowedKinds；拒绝越角色提案。固定版本化路径为`准备输入/岗位产物/<botId>/<sceneId>/<kind>.vNNNN.json`，NNNN由主控递增；同reportId/原文SHA重放返回原receipt，同reportId不同内容拒绝。不覆盖既有版本，不写原项目或全局配置。固定执行脚本只消费该角色已校验receipt，不把JSON值拼进命令。

## 最终验证与产物

最终r7 Core的15项scope测试全部通过：`release/local-acceptance-scope-20261107-r7/scope-tests.json`。其中真实本机Python/FFmpeg/ffprobe测试已启用，不是skip；二进制绝对路径、SHA和版本在测试stdout证据中。长任务实际运行32秒，文件页实际读首尾，派活和预授权脚本经真实隔离worker/Broker/WebSocket设备回执。

真实Electron外部入口证据：`electron-evidence.json`，`passed:true`、真实模型请求0。管道/壳包清单/本地UI检查6项通过。旧路径模型/审批/工具失败19项通过。扩展memory/recall/maintenance/retrieval/app/workspaces：134通过、2跳过、3个原有压缩断言失败；在未改动的cf31e9cb代码快照中重跑同三项也失败，不把它们说成全绿。

两份tsc、修改代码oxlint、`git diff --check`通过。Vite UI构建退出0，仅大chunk提示。没有重装依赖。基线：`cf31e9cb20ce25ac705cce578394fc502f2aa8f8`加本轮变更；原有未提交脚本与验证文档保留，补丁不包含其他会话的修改。

| 最终文件 | SHA-256 |
| --- | --- |
| core/index.js | `094a985e4467d1e19cf2f3af816771ed131c2c94ce2bb96e39b4996ca8e6474b` |
| core/worker.js | `644129741baadca575d9601ce7d051ef8318d39f27c5a8394cd877aa271483a1` |

目录还包含service/client-node本地bundle、Vite UI、CHANGESET.patch、SHA256SUMS.txt、verification.json。没有完整电脑/PDF运行时或skill资源，也没有实际安装包、签名、安装/更新/当前profile兼容性验收。不得拿部分bundle替换正在运行的客户端或Core。GitHub、OSS、README版本/主页发布项均未发布或修改。

复验：

```powershell
node scripts/audit-personal-acceptance.mjs # 隔离重建及旧路径兼容性
# 只在本次验证shell设置，退出后清除；全部是非秘密的构建/工具路径。
$env:NEX_TEST_BUNDLE='release/local-acceptance-scope-20261107-r7/core/index.js'
$env:NEX_ACCEPTANCE_PYTHON=(Get-Command python).Source
$env:NEX_ACCEPTANCE_FFMPEG=(Get-Command ffmpeg).Source
$env:NEX_ACCEPTANCE_FFPROBE=(Get-Command ffprobe).Source
node node_modules/vitest/vitest.mjs run server/personal-os/acceptance.test.ts
node --test electron/nex-acceptance-bridge.node-test.mjs electron/nex-client-packaging.node-test.mjs electron/nex-client-ui.node-test.mjs
node scripts/verify-acceptance-bridge.mjs --core=release/local-acceptance-scope-20261107-r7/core/index.js --ui=release/local-acceptance-scope-20261107-r7/ui --result=release/local-acceptance-scope-20261107-r7/electron-evidence.json
```

早期Electron fixture曾因top-level await阻塞启动、退出前LevelDB锁导致未清理；已修复为启动器等待进程退出后清理自己的新fixture。自动审批审核拒绝清理五个早期目录，原因只有blocked by policy，未绕过：TEMP下的nex-acceptance-electron-{aJAUFQ,fRO35W,J5ZD3C,MDMEsq,uuFMJd}保留，只有本轮合成资料。首次失败的空管道fixture也可能保留。没有删除宽泛临时目录或用户数据。

## 仍需用户授权的步骤与真实阻塞

1. **无需线上变更的剩余本地工作**：完整隔离Windows测试EXE尚未准备。可以另行按本地测试流程构建，打包helper的asarUnpack、匹配UI/设备执行器/完整资源，在全新fixture/profile上跑精确安装包smoke。此项不要求GitHub/OSS发布；不能自动安装到当前profile。当前交付只是代码和部分bundle。
2. **真实live Core必须升级**：现服务没有新增API/账本。生产变更必须按AGENTS.md先获准commit/合并main/push，使用已推送main构建与隔离验证，再获准部署/重启Core并保留回滚。这些操作本轮全部禁止且未执行；只本地构建不能让现live Core具备能力。
3. **当前0.9.28必须另行获准升级/重启**：旧包既无固定管道也无受限执行器。完整新包验证后，用户须批准安装/切换并以--acceptance-bridge启动；保留原profile时由客户端正常内部恢复登录，主控不读取/复制connection.bin。不能仅在旧实例的second-instance参数附加flag便宣称启用。
4. **价格仍阻塞首次付费**：必须拿到真实供应商、模型ID/连接revision及全费用人民币上界依据，人工审核后按账号配置；当前不填假价格、不用/v1/models无price元数据猜价。即使部署完成也应保持not_ready，直至此条件满足。
5. **业务策略仍需登记与主控sink实现**：核对真实authorized_cli及依赖/运行时hash、作品根、固定argv/角色权限、预授权、长任务上限和独立媒体预算；实现并验证上述proposal sink。主会话的live-execution-ready.json审批仍由其原流程决定，本补丁不代签、不创建。

现在可继续审阅和离线准备，不能声称五岗位已在用户真实作品里执行或短片已经生成。
