# 日常资金风控与权限执行适配 v1.1

负责人：Vesper。2026-10-29。当前交付为日常资金评级、权限判断模块及现有工作台接线；团队主聊天、正式用户审批和唯一托管账本尚未联合验收。

v1.1 增加确定性结果一致性校验、必要版本和模型发送范围校验。余额等核心证据缺失显示未知；已确认硬冲突伴随独立可选预算缺失显示高／部分覆盖。详见[规则与权限说明](../../../docs/safety-risk-eval/unified-runtime-v1.1/规则与权限说明.md)、[22项能力覆盖表](../../../docs/safety-risk-eval/unified-runtime-v1.1/能力覆盖表.md)和[验证报告](../../../docs/safety-risk-eval/unified-runtime-v1.1/验证报告.md)。v1.0 规范与历史审计保持原样。

2026-10-30补验修复：完整计划确认会产生新检查，现为确认重检另存评级审计，避免确认后评级丢失。原工作台第15版已在线复查；Worker HTTP现为30项。见[补验及交接报告](../../../docs/safety-risk-eval/unified-runtime-v1.1/浏览器补验与确认重检修复-2026-10-30.md)。

## 本轮已实现

- `assessment.cjs` 消费现有 `daily-engine.cjs` 的确定性检查结果，输出 `LOW / NOTICE / ELEVATED / HIGH / UNKNOWN` 及资料覆盖 `FULL / PARTIAL / UNAVAILABLE`。不从模型 `risk_level` 或外部数据集标签推导权限、余额或本人批准。
- `conversation-risk.cjs` 把同一份 `unified_assessment` 放入 `risk_advice` 和模型上下文；程序回答直接显示中文等级，问答审计记录该扩展字段。Core 访问仍沿用原服务端配置及冻结回调。
- `permission.cjs` 校验精确动作、用户、调用者、资源归属、用途、接收方、环境、有效期和版本交集。独立授权不能相互拼接，管理员身份不自动获得用户资产权限。
- 原工作台 `/risk` 新增评级、资料覆盖、来源检查编号和权限说明。`/api/safety/unified-policy` 仅提供已登记公开规则帮助，不读取私人资料，不创建会话或模型调用。
- `/api/paper-trade/execute` 在既有会话、CSRF 和任务归属核验后调用权限模块。当前 `paper.commit` 返回 `DENY / PAPER_GATEWAY_NOT_CONNECTED`，先审计再响应 403，不扣款、不调用原执行函数。原网关保留为后续独立防线。
- 新评级在日常任务创建/修改时以 `UNIFIED_ASSESSMENT_RECORDED` 关联保存；历史读取返回当时保存的评级。当前一致性校验另列 `current_validation`，异常时显示未知并暂停模型和确认；源结果为 `ERROR` 时也暂停。执行权限拒绝以 `UNIFIED_PERMISSION_CHECKED` 保存，不改写既有金融风险结果。

## 评级的含义和边界

| 结果 | 当前日常资金实现 |
| --- | --- |
| 低 | 本次必需资料和计算完整，没有适用财务风险发现；不保证安全 |
| 关注 | 只有用户确认启用的预算或应急目标软提醒 |
| 较高 | 软提醒被用户配置为逐项接受且仍在复核；不能直接执行 |
| 高 | 已核实的资金保护、余额、日期、跨任务资金或流动性硬冲突 |
| 未知 | 余额、占用、用途、必要数据或计算不完整；或者结果尚无适配器 |

金融硬冲突与独立审计/网关错误同时存在，可显示“高／部分覆盖”。如果必要资金证据本身未核实，不能仅因为旧引擎仍计算出了数值就标为已验证的高风险，显示“未知”。压力情景提醒单列，不能冒充已发生的实际缺口或概率。

**兼容处理：** 旧日常引擎的判定优先级仍为 `ERROR > BLOCK > REVIEW > ALLOW`，`check_complete` 也保持原契约。新层不只依赖这个布尔值，还检查缺资料原因、八项检查和核心金额。`unified_assessment.risk_decision` 保留原判定；不会为了统一等级而修改签名回调。已知财务冲突与控制错误共存时，可能是 `HIGH / PARTIAL / ERROR`，不能误读为允许执行。

`risk-callback.v1` 仍为原十字段，未加入评级、权限或用户审批字段。扩展存于旁路对象与审计，跨模块正式扩展须架构与 Core Owner 确认。

组合集中度、行业、回撤和相关性的演示阈值仍在既有 v1.0 规范中；本轮没有把旧组合原型包装成已验证的统一评级适配器。传入未适配目标或未知规则版本返回 `UNKNOWN`。不得把这次日常适配宣称为 R01—R10 全量线上验收。

## 权限接线范围

L0—L4 是动作分类。L1/L2 的成立需要当前资源和明确授权；L3 不继承 L1 的其他资源。模型发送、画像/约束写入、Memory、导出、删除、审计导出、发布和部署都是独立能力。

本模块是策略判断函数，不认证浏览器、不校验服务签名、不签发 grant。调用方须从可信服务端构建 `context`，绝不能把 HTTP 提交的 `session_verified`、`service_verified`、`resource_owner` 或 `grants` 透传进去。

当前工作台只把公开规则读取和现有模拟写入入口接到新模块。其他既有只读接口继续保留原有会话归属、CSRF、审计和限额检查；没有声称所有 22 项能力路由均已逐项接线。未实现的 Memory/导出等能力不能因目录有名字就调用。真实金融操作始终拒绝。

演示会话不是银行本人认证，已签 HMAC 的服务也不是最终用户本人。现有确认交互可保留用于评审，不能开启当前关闭的资金写入。可信原执行核账必须绑定原用户、任务、执行编号和方案，不得借恢复权限发起新投资。

## 运行与验证

```powershell
node --test modules/safety-risk-eval/unified-rating/test/*.test.cjs
node --test modules/safety-risk-eval/interface-adapters/test/*.test.cjs
node --test modules/safety-risk-eval/network-resilience/test/*.test.cjs modules/safety-risk-eval/joint-acceptance/test/*.test.cjs
node modules/safety-risk-eval/unified-rating/install-site.mjs <已审查的工作台v13或v14源码目录>
node modules/safety-risk-eval/unified-rating/verify-site.mjs <准备发布的源码目录> <报告路径>
```

安装器仅接受指定 Site ID、已审查v13/v14入口和底座哈希；当前线上v15不能直接重装，后续先读取最新源码与审查差异，不覆盖队友修改。纯程序的本地依赖静态编译为 ESM，无运行时 `eval`。原网络监测、前端错误提示、CSRF、会话和归属核验保持。模型服务未核实可用时禁用模型按钮；切换示例也标记旧结果。

`site-fixture.mjs` 与 `preview-site.mjs` 使用本机内存 SQLite 作为 D1 测试替身，不打包到 Worker。HTTP 验证不连接外部服务、不调用模型。规范包的 30 项验收设计仍为设计清单，不把 888 项配置检查或本轮子集测试改称 30 项联合验收。

## 下一接线依赖

1. 林粹／Core：冻结同任务的真实用户身份、完整计划批准、撤回及版本契约。
2. 七七／Finance：提供唯一托管账本的版本和原子预留、提交、释放、核账。
3. 小果／入口 Owner：在团队现有入口部署同一份问答适配器，不在 UI 自行重算等级或批准操作。
4. Vesper／Quant：为组合指标建立明确结果适配器及双口径边界测试，再逐项推进剩余能力路由。
5. 全体 Owner：同一 staging 部署复跑跨用户、变参、并发、重复、超时、异常和重启恢复。完成前不解除 L3 门禁。
