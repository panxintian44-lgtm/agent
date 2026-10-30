# Safety / Risk / Eval：日常资金风控 v1.1

从[旧仓库PR #37](https://github.com/Fintechathon-agent/Fintechathon-agent/pull/37)导入，来源head为`43f28cbbf9a2335a965c2debe988eb2c76b1e761`。这是供新仓库评审、接线的确定性风控模块，**尚未挂载到本仓库的线上问答入口**。

原迁入提交`e17c881`的只读审批失败已由后续补丁在本地修复：Core 301项、Risk 499项、组件HTTP 14项通过，见[P0复现与验证](../../docs/safety-risk-eval/p0-readonly-closure-2026-10-30/README.md)。线上同版本验收仍NO-GO，资金写入口不因本地通过而开放。

先读[迁入说明与复现命令](../../docs/safety-risk-eval/pr37-import-2026-10-30/README.md)，以及[规则与权限](../../docs/safety-risk-eval/unified-runtime-v1.1/规则与权限说明.md)、[能力覆盖表](../../docs/safety-risk-eval/unified-runtime-v1.1/能力覆盖表.md)。

| 入口 | 用途 |
| --- | --- |
| `daily-engine.cjs` | 使用已确认资金事实进行确定性日常资金检查 |
| `unified-rating/assessment.cjs` | 结果一致性校验、五档评级与资料覆盖度 |
| `unified-rating/permission.cjs` | 主体、资源、用途、版本、有效期、接收方及字段范围校验 |
| `interface-adapters/conversation-risk.cjs` | 元/分适配、风险评估、原因与恢复建议 |
| `interface-adapters/conversation-review.cjs` | 同任务模型提议与可信Risk回调；异常时关闭下游调用 |
| `network-resilience/` | 网络状态与前端可见错误；当前入口是否接线须另行验证 |
| `joint-acceptance/` | 本地HTTP测试替身与预检；不等同团队线上联合验收 |

输出的`ALLOW/REVIEW/BLOCK/ERROR`与五档业务评级分别使用；Risk通过不授予执行权限。`risk-callback.v1`的十字段保持不变。L3模拟资金写入继续关闭，L4真实交易禁止。

`install-site.mjs`、`verify-site.mjs`和`preview-site.mjs`面向历史独立Sites工作台，需要外部源码及精确版本；不能直接部署到团队Cloudflare入口。旧Python桥接和旧UI验证依赖`qiqi/web`，本次未迁入该Finance入口。
