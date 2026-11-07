# 外部验收 CLI：隐藏 PowerShell 的 UTF-8 修复（2026-11-07）

本次只修复 `scripts/control-acceptance.ps1` 的进程编码边界：明确设置 Console 输入、输出与 PowerShell `$OutputEncoding` 为无 BOM UTF-8。输入文件、命名管道原先已经使用 UTF-8；隐藏 Windows PowerShell 的 stdout 原先会使用系统代码页，导致中文和 emoji 在外部调用方解码失败。没有更改 Core、UI、Electron 桥接或打包内容。

## 验证

- 新增 `electron/nex-acceptance-bridge.node-test.mjs` 回归：使用 `windowsHide:true` 启动真实 Windows PowerShell，以严格 UTF-8 解码检查 `sourceModel`、`prepare`、`status`；覆盖中文和 emoji 模型名、岗位名、目录、状态原因及嵌套 JSON 报告，检查无 BOM 和真实 DTO `task_id`。
- 修复前该测试在 `sourceModel` 报 `ERR_ENCODING_INVALID_ENCODED_DATA`；修复后桥接测试 3/3 通过。
- 原封存 0.9.29 r8 portable EXE 配合当前外部脚本，在全新临时 profile、独立 Core、合成身份及合成模型服务中验证通过。没有更新封存源码副本中的脚本。通过真实客户端登录及命名管道读取中文模型名，创建五个中文岗位，并返回含中文、emoji、引号的 JSON 报告；报告字符串和 `task_id` 与隔离 Core 的 `agent_messages` 数据逐项一致。
- 同一隔离链保留缺价 `not_ready` 且零模型请求、已授权本地合成脚本执行、共享预算、停止 scope 的检查；总计仅 2 次本地合成模型请求，真实模型及媒体服务请求均为 0。
- 首次精确 EXE 验证的测试数据重复使用了未报价 scope 的岗位名，第二个 `prepare` 被拒绝；给两组 fixture 使用不同名字后通过。失败日志已保留，没有为此修改产品代码。
- 原 r8 `SHA256SUMS.txt` 中全部 9 项重新核对一致，包括 EXE、asar、原补丁及原验证结果。EXE SHA-256：`b96ba94bee327d6ac7cc2fd8a308c43aade497bdcbd68ec4b5f9c7f6f7ca42cf`；原补丁 SHA-256：`7d35c795cb383aba8b1179b107006a0b5e5d9eba637a06a67fffd92fa81a30df`。

## 独立交付与范围

后继目录：`release/acceptance-cli-utf8-20261107/`。其中 `CHANGESET.patch` 只包含本次外部 CLI、回归测试、本记录及索引增量；相对于本次修复前工作树生成，不是整个未提交项目的补丁。另附脚本副本、精确 EXE 测试脚本、测试日志、`exact-exe-utf8.json`、`sealed-r8-verification.json` 与独立 `SHA256SUMS.txt`。

可立即用仓库当前 `scripts/control-acceptance.ps1` 对接既有 r8 EXE，无需重打包。调用方按 UTF-8 解码 stdout。

仅运行拥有的临时 fixture，并在退出后清理；没有访问 live 配置、凭据或历史，没有安装或重启用户真实客户端，没有提交、推送、部署及发布。GitHub 与 OSS 发布均跳过。没有重跑整库、其他平台或真实付费服务；本记录不扩展 r8 原有验证结论，也不宣称上游完整 proposal sink 集成已经通过，该集成需使用此脚本另行复验。
