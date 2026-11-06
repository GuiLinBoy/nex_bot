# 自有分支整理与隔离验证 — 2026-11-07

本次范围是本地分支和 `GuiLinBoy/nex_bot`（`origin`），目标为自己的
`main`。以 `a743b57e` 为基线，检查了原有 9 个本地分支、9 个远端分支
（不计 `origin/HEAD`）。`upstream` 用作参考，其仓库分支不在清理范围。

## 合并与清理清单

| 分支 | 原提交 | 处理 |
| --- | --- | --- |
| `codex/local-agent-cli` | `b4c40894` | 合入 CLI 功能、Windows 停止修复与 Mac 复验记录；清理本地和 origin 分支 |
| `fix/mac-updater-quit-deadlock` | `cad209a4` | 单独合并，并补充下面的运行循环修复；保留本地和 origin 分支 |
| `fix/api-key-status` | `d17bc17a` | 已包含在 CLI 分支中；保留本地和 origin 分支 |
| `fix/limits-keep-draft-on-endpoint-edit` | `6fe570ef` | 已包含在 CLI 分支中；保留本地和 origin 分支 |
| `fix/smoke-model-picker-alignment` | `5edd7ecd` | 已包含在 CLI 分支中；保留本地和 origin 分支 |
| `test/combined-local` | `97f18fd4` | 已包含在 CLI 分支中；清理本地分支 |
| `backup/workspace-model-picker-smoke` | `e27ca53e` | 审查后合并历史，保留较新的实现；清理本地分支 |
| `fix/workspace-model-picker-smoke` | `e27ca53e` | 与上面的备份指向同一提交；清理本地分支 |
| `DarrenHoo-10/fix-computer-use` | `21e15a8f` | 已是原 main 的祖先；清理 origin 分支 |
| `codex/feature-personal-ai-os-design` | `89cdec3a` | 已是原 main 的祖先；清理 origin 分支 |
| `feat/init-mac-and-ios` | `08ec5701` | 已是原 main 的祖先；清理 origin 分支 |

旧备份合并时有三处重叠：模型设置、模型选择器烟测、模型发现记录。
有效改动已在较新提交中延续，冲突保留较新的“自定义地址切换协议保留 Key、
默认地址更换厂商时清除 Key”行为及对应检查。该合并没有额外改变文件内容。
通过 `git merge-base --is-ancestor` 逐个检查，原来的全部 18 个分支 tip
均为整理后提交树的祖先。

以下 PR 的源分支均保留，包括合入自己的 main 后 PR 状态可能发生变化的分支：

- [自己的仓库 #1：Mac 更新退出](https://github.com/GuiLinBoy/nex_bot/pull/1)
- [上游 #22：模型选择器烟测](https://github.com/DarrenHoo-10/nex_bot/pull/22)
- [上游 #23：API Key 状态](https://github.com/DarrenHoo-10/nex_bot/pull/23)
- [上游 #24：模型参数草稿](https://github.com/DarrenHoo-10/nex_bot/pull/24)

核对范围包括两个仓库全部状态的 PR，以及账号全部已创建 PR 中以本仓库为源的 PR。
清理规则是在 main 推送成功后，再核对 PR、远端 tip 和祖先关系，才删除清单中的
无 PR 分支。最终本地与 origin 各保留 main 和上述四个 PR 分支。

## 检查中补充的修复

`2189275a` 修正了 Mac 更新退出。原修复把 `terminate` 放进另一个 MainActor
Task；隔离 AppKit 进程在正常异步清理时仍触发 14 秒看门狗，清理任务没有开始。
改用零延迟的 selector 定时调用，将退出操作交回运行循环，正常清理可以完成，
卡住的清理仍由已有的十秒兜底退出。

新增 `apps/apple/Testing/updater-quit.node-test.mjs`：从真实源码提取退出调度和
应用委托，编译成无窗口的独立 AppKit 进程，用合成执行器检查空闲、正常异步清理、
清理卡住三种情况。不会运行安装器、替换应用或访问用户项目。
Apple 对 [terminateLater](https://developer.apple.com/documentation/appkit/nsapplication/terminatereply/terminatelater)
的说明记录了嵌套模态运行循环；[延迟 selector 调用](https://developer.apple.com/documentation/objectivec/nsobject-swift.class/perform(_:with:afterdelay:))
通过运行循环定时器执行。

`e011295e` 对齐工作区烟测。合并后的真实界面已采用只读定时任务详情，旧烟测仍在
点击已移除的新增、编辑、开关、立即执行和联系人置顶按钮。现在仅在一次性的 Core 中
用认证 API 准备计划和触发合成执行，通过真实界面检查详情、取消确认、确认关闭、
重载后的关闭状态及结果入口。报告不再声称覆盖旧编辑器或置顶操作。

本地未提交的两个 Swift 文件与 `cad209a4` 内容一致，已随该提交合入。
另将本地架构 HTML 纳入版本管理，为其中较早的 CLI 方案增加历史快照标记和
[当前实现记录](local-agent-cli.md)链接。

## 本机验证结果

环境：macOS arm64，Node 26.5.0，Electron 39.8.10 / Node 22.22.1，
Codex CLI 0.167.0，Claude Code 2.1.318。所有变更验证均使用独立工作目录、
临时 Core、合成身份与模型服务；正在运行的本机体验环境保留原目录和进程。

| 检查 | 结果 |
| --- | --- |
| CLI、审批、策略、进程树、模型发现与参数测试 | 13 文件通过；96 通过，12 跳过 |
| 构建后的 Core / executor、应用、传输与输入测试 | 4 文件通过；65 通过，1 跳过 |
| Electron 设备与 Apple executor-host 生命周期 | 12 通过 |
| Mac AppKit 退出回归 | 3 场景通过（Node 报告 4 tests）；正常清理约 0.14 秒，卡住清理约 10.56 秒退出 |
| 真实安装的 Codex / Claude 初始化和停止 | 均通过 |
| 真实 CLI + 构建后的 executor + 合成推理 | 均完成两个回合并续接原生会话 |
| 模型选择器隔离烟测 | 17 项通过 |
| 模型参数隔离烟测 | 7 项通过 |
| 工作区隔离烟测 | 47 项通过 |
| 开发壳登录、重启、登出与账号隔离 | 31 项通过，`packaged: false` |
| Core / Web UI、设备 executor / UI、固定版本 Electron 壳准备 | 通过 |
| TypeScript、lint、locale、Electron 语法、空白检查 | 通过 |
| 验证文档链接、CI 范围及工作流回归 | 3 文件通过；55 通过 |
| 新临时目录的 NexClientKit Swift 构建 | 通过 |
| AppUpdater 与实际 Theme / Hairline 依赖的 Swift 6 类型检查 | 通过；已有一处未使用 `try?` 结果警告 |

工作区烟测在旧定时任务入口、旧联系人置顶入口处的失败均有保留日志；对齐当前
界面后完整通过。Mac 退出原方案和 main-queue 方案的失败探针也保留在私有证据中。
壳烟测的 models.dev 公共元数据刷新曾超时，使用已有目录继续；身份及推理均为合成。

可复现的主要命令：

```sh
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm check:electron
node scripts/build-personal.mjs --core
node scripts/build-personal.mjs --shell
node --experimental-strip-types scripts/smoke-model-picker.mjs
node --experimental-strip-types scripts/smoke-model-limits.mjs
node --experimental-strip-types scripts/smoke-personal-workspace.mjs
node --experimental-strip-types scripts/smoke-shell-login.mjs --account-workspaces --expect-local-ui
node --experimental-strip-types scripts/verify-local-agent-cli.ts
node --experimental-strip-types scripts/smoke-local-agent-cli.mjs
node --test electron/nex-client-device.node-test.mjs apps/apple/Executor/executor-host.node-test.mjs
node --test apps/apple/Testing/updater-quit.node-test.mjs
```

CLI 测试和构建产物测试的完整命令见
[macOS CLI 复验记录](local-agent-cli-macos-followup-20261106.md)，本次源测试另外包含
`server/personal-os/model-catalog.test.ts` 和 `server/personal-os/model-limits.test.ts`。
Node 26 的 renderer 测试使用 `NODE_OPTIONS=--no-experimental-webstorage`。

私有证据在原工作目录的忽略路径
`release/branch-consolidation-20261106-5y_9qpao/`：完整 Git bundle、原分支 SHA、
未提交补丁和架构文件备份、PR 清单、祖先检查及各项执行日志。

## 验证边界

本次是源码与分支整理。Windows 原生进程终止未在本次 Mac 上重新验证，
既有 Windows 记录见 [Windows CLI 复验](local-agent-cli-windows-20261106.md)。
Apple 验证包含共享包构建、更新器类型检查和独立 AppKit 退出场景；完整 Xcode
工程、iOS 模拟器、签名及实际 DMG 应用替换尚未验证。
GitHub / OSS 客户端发布和线上部署不属于本次任务。
