# 五岗位：可信套餐次数预算与本地升级（2026-11-07）

本批包括 r8 受限验收桥接、外部 PowerShell UTF-8 修复与套餐次数模式。只交付 Core 和 Windows 本地验收包；不公开发布 GitHub/OSS、不更新其他平台下载，不启动真实五岗位或推理。原工作区的无关 dirty 与原 r8 EXE/补丁/校验文件保留。

用户已批准本批 main 提交/推送、从推送源码构建复验、Core 部署和重启，并明确将本次对话/看图的 50 元约束替换为固定套餐最多 120 次物理请求：不充值，配额不足即停，不作人民币换算。当前真实客户端的切换由主会话执行。

## 运维策略

默认仍使用原 `quotes` 人民币计费上界，缺价不得请求。本次新增可信、非 HTTP 的 `acceptance-policy.json` 配置 `prepaidQuotas`，每条格式如下（占位符不能直接使用）：

```json
{
  "prepaidQuotas": [{
    "mode": "prepaid-quota",
    "root": "D:/本次唯一新作品根",
    "fingerprint": "sourceModel.revision 的精确值",
    "authorization": {"approved": true, "evidence": "本次人类批准套餐120次、不充值、配额不足即停、不作人民币折算的可核查记录"},
    "calls": 120,
    "maxOutputTokens": 4096,
    "maxInputTokens": 90000,
    "supportsImages": true,
    "validUntil": 0
  }],
  "scripts": []
}
```

`maxInputTokens` 必须覆盖当前解析的模型窗口；`validUntil` 必须是有效、尚未到期的毫秒时间戳。连接指纹包含 provider、完整连接地址、连接版本、实际模型及窗口，但对外只返回不可逆指纹和供应商 hostname。授权只对精确作品根有效，不能用客户端参数切换模式或扩额度。策略启动时读取，准备 scope 时持久化快照；需要更新未准备的策略时由运维在无活动任务期间重启 Core。不得写合成报价或把套餐声称为 0 元。

五成员及同 scope 委派、附件看图共用一个持久计数，物理发送前原子预占；失败、取消、未知和重试均不退次数。重复许可不能再次发送；重启遇到未完成许可会冻结 scope，禁止自动重放。正常已完成 scope 重启后保留次数与锁定的授权。所有未审计辅助推理仍封闭。每次输出上限 4096，模型与连接版本锁定。

套餐模式 `budgetMode=prepaid-quota`，`limits.cnyMicros`、`heldCnyMicros`、`chargedUpperCnyMicros` 全部为 `null`；旧人民币表列不参与此模式的核算。新增迁移 44 仅创建套餐授权表，保留迁移 43 和原人民币账本。

HTTP 402/429 或可识别的配额/余额耗尽业务错误会持久冻结整个套餐 scope，返回通用 `quotaError`，不向外暴露供应商原始响应。已经发送的请求仍计数，尚未发送的同 scope 后续请求被拒绝；不会取消其他用户任务、自动充值或更换连接。

可信 `scripts` 可选 `allowedBotNames`。准备时只接受本次五个岗位的真实名字；执行及预授权按数据库中的 bot 名字核对，客户端提供的名字无效。字段缺省保留旧行为，锁定哈希的公共文档读取可共享。

固定 CLI 的 `sourceModel` 也返回当前 `workspaceId`、解析的 `contextWindow`，以及当前客户端自己已登记设备的 `id/name/platform/hostname/acceptanceExec/exec`。设备 ID 从正常本地 `deviceState` 自动取得，Core 仍核对设备属于当前 workspace 和 owner；不存在或不属于当前账号时返回 `device:null`。不返回 token、密钥、完整连接地址或旧会话，不新增通用查询入口。

## 验证与交付记录

所有开发验证使用独立临时数据、合成身份/模型及固定本地脚本，禁止真实推理。测试覆盖原人民币路径、共享并发 120 次、套餐授权绑定、看图同账本、失败/取消、重启、额度业务错误、岗位白名单，以及 schema-43 CNY 数据迁移。

源码阶段：完整 scope 回归 26 通过、1 个可选运行时未启用；随后补跑启用的 Python/FFmpeg/ffprobe 固定执行验证与新增的窄元数据验证，均通过。原生桥接 3/3 通过，服务端与前端类型检查通过。首次看图夹具错误传 data URL、首次跨 owner 夹具缺失外键用户，均修正夹具后复验，没有放宽产品边界。构建前的 Core 构建通过。额外兼容性组及推送 main 后的精确构建/包验证单独记录。

额外兼容性组：70 通过、1 跳过、1 失败。失败是 `sender-device.test.ts` 中要求系统提示词不包含 `currentClient` 的旧断言；未修改的 `cf31e9cb` 隔离基线复现同一行同一失败，不扩大本批修复范围。最终配额业务错误组 4/4 通过。lint 和 locale 检查通过；共享只读依赖目录导致 pnpm 的自动重装检查拒绝，改为本进程 `verify_deps_before_run=warn` 后正常运行检查，没有改锁文件或共享依赖。

本机缺少 Tokyo 的 SSH 目标与 `vps_get`，用户暂时无法提供。源代码交付不表示已完成生产部署；在取得连接前不改动线上服务和用户真实客户端。

精确构建、测试结果、main commit、包 SHA、部署 release 与回滚点以本次独立交付目录中的机器可读结果为准；不会将未执行的检查记为通过。生产验证仅使用健康、版本、认证边界、资源字节和必要活动计数/窄元数据，不读取 `/api/state` 旧历史或导出凭据。
