# 五岗位接入 r8：完整 Windows 本地测试包（2026-11-07）

已完成独立构建的完整 Windows x64 便携 EXE 和精确包隔离验收。**没有安装/替换原0.9.28、操作其profile或重启用户客户端；没有commit、push、部署Core、发布GitHub/OSS，也没有真实模型/媒体创建请求。真实价格尚无可靠依据，真实scope仍须not_ready。**

## 唯一最终包

`D:\claude_project\nex_bot\release\local-windows-0.9.29-acceptance-r8-20261107\output\NexBot-0.9.29-local-acceptance-r8-x64-Client-Portable.exe`

| 字段 | 值 |
| --- | --- |
| 应用版本 | 0.9.29（仅本地测试） |
| Windows文件版本 | 0.9.29.1107 |
| 大小 | 199,615,342 字节 |
| SHA-256 | `b96ba94bee327d6ac7cc2fd8a308c43aade497bdcbd68ec4b5f9c7f6f7ca42cf` |
| app.asar SHA-256 | `ebf8fd60ba3036bf80e35d48ce381c30af6778f668d03d0123184c737be6d6f0` |
| Authenticode | NotSigned；未签名本地测试包 |

该包物理完整，包含匹配UI、设备执行器、电脑/PDF/native canvas运行时以及原生管道helper；可以单文件运行。它不是已发布版本，未用此包连接真实Core；不能把“包已准备”解释成已获准切换当前profile。旧的r2～r7部分bundle不再作为安装包候选；r7封存历史未覆盖。

## 相对r7的唯一功能补齐

scope `status.reports`、共享DTO及主进程窄投影新增数据库 `task_id`。新增回归证明：同bot两次完成任务的回报分别关联各自succeeded task，模型在proposal内容里填另一个task_id不能改写报告元数据。实际EXE管道→scope→Agent/Broker→设备执行→最终回报也核对task_id。没有增加泛化写文件或其他功能；proposal sink由主会话在漫剧项目独立实现，未由本线程操作其真实输入/账本。

预算、同scope委派、固定脚本预授权、≤60分钟受信等待、固定hash文本分页、最小运行时环境等沿用 [r7最终能力记录](acceptance-scope-final-20261107.md)。外部实际入口仍是新版客户端显式 `--acceptance-bridge` + 当前用户ACL管道 + `scripts/control-acceptance.ps1`；现在已有可运行完整包，当前正在运行的旧0.9.28仍没有该入口。没有通用DevTools/JS/SQL/IPC业务入口；测试用CDP仅连接本轮新建fixture/profile做合成登录，不接触现有客户端。

## 构建隔离与来源

基线 `cf31e9cb20ce25ac705cce578394fc502f2aa8f8`，叠加本地未提交r8补丁。用git archive导出到本包目录的source，覆盖本轮源码和已有烟测修正，独立输出source/dist-personal与output。主工作区dist未写；node_modules和固定Electron39.8.10仅以只读复用方式使用，构建前核对Electron版本一致，不重装依赖。用户原有dirty保留。

仅在副本配置覆盖0.9.29/文件版本/独立输出名和local-acceptance-test元数据，不改正式版本文件或任何公开下载入口。BUILD_CONTEXT明确是base commit加未提交源码，未伪称已推送提交。执行独立副本的图标生成、build-personal --core、--shell、electron-builder portable/publish:never，完整资源真实构建。

pnpm collector最初因清洗环境缺ComSpec/PATHEXT而输出为空。补回非秘密Windows系统字段，使用构建目录内的固定pnpm shim直达已安装真实pnpm后成功；没有伪造依赖JSON，没有改全局PATH或原node_modules。真实pnpm list诊断输出456,197字符，保留日志。构建环境不继承模型/媒体/signing key，HOME/profile为构建隔离目录，仅复用已下载的工具cache。`pwd`探测失败由builder正常fallback处理，未虚构workspace结果。

## 精确文件与工作流证据

| 验证 | 最终结果 |
| --- | --- |
| r8 scope suite（含report.task_id） | **16/16通过**，合成价格/模型，真实Python/FFmpeg/ffprobe启用，实际32秒等待/分页/委派/预授权均通过 |
| 实际EXE原生链路 | **10项通过**：未登录拒绝、合成登录及0.9.29版本、缺价零请求、实际asarUnpack helper、设备acceptanceExec、精确预授权脚本、共享预算/4096/task_id回报、停止、实际解包资源、实际内部Electron Node设备生命周期 |
| 最终EXE原有shell登录/设置/多账号套件 | 最后一次 **31项通过**，packaged:true、accountWorkspaces:true。原始失败记录及限制见下文 |
| 实际内部Electron Node + 包内执行器 | **10项通过**，含PDF worker/native canvas、授权文件边界、保存文件、进程树停止、撤销、账号隔离与会话失效 |
| 包内代码 | 15个应用文件逐字节匹配独立source；package.json版本/来源状态另核对；PS helper确实asarUnpack |
| 包内UI/执行器资源 | 23个UI文件、579个执行器/运行时文件逐字节匹配构建；并在**实际便携包正在运行的解包目录**重复核对，不只检查win-unpacked |
| EXE稳定性 | 全部测试后SHA仍为上表值；没有重新打包掩盖失败 |
| 静态 | 两份tsc、定向oxlint、git diff --check通过 |

实际EXE新链路在全新profile/临时Core/合成身份中运行：先用空quotes确认send拒绝且0物理模型请求，再仅对fixture注入合成上界和精确脚本manifest，经外部管道真实派活。本机设备真正执行隔离Node脚本写入fixture结果，回报2次fake物理请求、4096输出、正确task_id，站立授权无卡片、未登录仍拒绝。没有读取/导出真实cookie、connection.bin、API key或旧聊天。

最初多账号套件曾在第二合成账号等待workspace-brand时出现白屏并超时（先前27项已完成）。保留shell-login-final.log，没有改断言、延长30秒等待、跳过账号步骤或修改产品代码。添加Runtime错误采集后，相同EXE完整31项通过（shell-login-diagnostic.log）。另做“首账号→Core重启/撤销→第二账号”定向3项对照，新包与原0.9.28均在独立fixture通过。**初次超时根因仍未确定，不能宣称已修复或从未发生；保留为间歇问题。** 本轮未出现可复现的scope/管道/预算失败。

扩展源码回归仍保留r7记录的3个既有memory-recall压缩断言失败（未修改cf31e9cb基线同样失败），不能说全仓全绿。ASR转写、真实媒体API、60分钟完整等待、真实价格、live Core/现有账号均未验证。

## 产物与复验文件

包根保留：build-local.mjs、build/package诊断日志、verify-payload.mjs、payload-verification.json、smoke-native-package.mjs、native-package-smoke.json、native-package-final.log、packaged-device-lifecycle.log、shell-login-smoke.log、shell-login-final.log（失败）、shell-login-diagnostic.log（31通过）、account-edge-r8.log、account-edge-0928.log、about.png/about-final.png、SHA256SUMS.txt、SOURCE_CONTEXT/补丁/验证摘要。

scope编译验证报告位于`release/local-acceptance-scope-20261107-r8/scope-tests.json`，将其复制到包根供审阅；该目录仅是测试Core，不是第二个安装包候选。包根source是独立构建/测试副本，不应作为用户原项目checkout。

复验命令使用该包根绝对路径，所有fixture均新建：

```powershell
node release/local-windows-0.9.29-acceptance-r8-20261107/verify-payload.mjs
node release/local-windows-0.9.29-acceptance-r8-20261107/smoke-native-package.mjs
# 原套件在独立source目录运行，参数为精确EXE并加 --expect-local-ui --account-workspaces；目录保留已做过的非秘密fixture环境设置。
```

原0.9.28 EXE仅在基线对照时以新的临时profile启动，未操作用户现有实例/profile。早期被自动审批拒绝清理的五个Electron合成临时目录未再次删除或绕过审核；详情见r7记录。后续启动器在自己的进程退出后正常清理自己创建的新fixture。

## 当前仍禁止及仍需批准

- **本地构建与精确包验证已完成**，无需为此commit/push，也未发布GitHub/OSS；根README和网站版本/下载清单保持原样。
- **用户现有0.9.28保持运行状态不变**。切换到新包、使用原profile、启用--acceptance-bridge或重启用户客户端，仍需明确批准；本轮没有这些操作。
- **真实Core必须升级**才有新增接口与账本。生产升级须另外允许commit/合并main/push，按已推送main完整重建、隔离验证、部署/重启/回滚流程执行；当前未授权且未做。不能把未提交本地EXE/bundle直接作为线上发布源。
- **可靠价格仍是硬阻塞**。没有真实全费用人民币上界证据时，不得填fixture价格或解除not_ready；也不创建媒体live-execution-ready审批文件。
- 真正业务还须把主会话已核对的runtime-tools/固定CLI/角色输入协议/独立媒体预算登记到该账号可信配置，复核已实现的proposal sink对真实scope DTO的关联；本包未接通用户真实作品或声称短片完成。

一次31项通过不消除初次间歇超时的证据。若后续准备正式发布，应先复核该账号切换场景；当前交付用于审阅和隔离本地测试。
