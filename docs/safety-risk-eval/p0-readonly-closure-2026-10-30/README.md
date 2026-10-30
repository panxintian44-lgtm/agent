# Risk安全P0：复现、修复与联合验收

日期：2026-10-30。负责人：Vesper。对应[PR #3](https://github.com/realchenchenluo/agent/pull/3)。

最新接线进展见[林粹回执核对与Risk侧确认](Core回执核对与Risk确认-2026-10-30.md)：源码候选、Worker版本和部署记录分开登记；补齐Secret不等于完整模拟链路已就绪。

**本地修复已验证；线上联合验收仍为NO-GO。**修复提交为[`c1cc3c4bbab4700b5c156f09a649cbbf62e979a6`](https://github.com/panxintian44-lgtm/agent/commit/c1cc3c4bbab4700b5c156f09a649cbbf62e979a6)，基线为原迁入提交`e17c881c1b7d24747c039a25a8bf7447009f0456`。未合并main、未部署云端。

## 失败复现

原组件HTTP为11/12，`readonly_capability`因签名审批未拒绝`REVIEW_ONLY`而失败。[原验证报告](../pr37-import-2026-10-30/verification.json)和[原HTTP记录](../pr37-import-2026-10-30/component-http.json)保持原样。

本轮另从Git基线导出隔离Core源文件，仅加入新增的两份测试，运行17项定向检查：**3通过、14失败**，见[修复前输出](before-targeted.tap)。这些是基线对新增安全断言的实际结果，不是线上故障注入。

## 修复内容

- `chenchen/integrations/review-workflow.js`：Risk通过后不能把只读任务变为模拟就绪；批准和模拟入口分别检查顶层及受审查输入的显式`SIMULATION_ONLY`。缺失、未知、不一致或只读能力不能升级，返回`SIMULATION_CAPABILITY_REQUIRED`。
- 同一文件的幂等比较拒绝同一个键改换**显式声明的**`session_id/task_id`，返回409 `IDEMPOTENCY_CONTEXT_MISMATCH`，不向调用方返回旧record/trace；历史摘要、记录和签名不重算。
- `chenchen/integrations/review-reservation.js`：未完成请求也在摘要比较及“结果未知”响应前检查显式上下文，封住最终记录丢失时的旁路。同上下文结果未知仍503，要求核查，不重复模型调用。

新增9项能力测试、8项上下文测试。原来用于合法模拟的测试与两份实验夹具逐项补上显式模拟能力，未改变默认权限或删除拒绝断言；未改资金算法。

兼容状态仍可能显示`PENDING_APPROVAL`，但只读批准调用会被拒绝。UI须结合`capability`展示“仅风险复核”，不能只按状态文字开放批准/执行按钮。

## 验证与复现

环境：Windows PowerShell、Node.js `v24.22.1`、锁定`ajv@8.17.1`。模型、Risk和审批使用测试替身；HTTP仅本机，存储为内存/临时测试存储。

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| Core完整回归，包含新增17项 | 301/301 | [core-tests.tap](core-tests.tap) |
| Risk完整回归 | 499/499 | [risk-tests.tap](risk-tests.tap) |
| 本地组件HTTP | 14/14 | [component-http.json](component-http.json) |
| 规范结构 | 888项、4个坏配置拒绝、3份摘要匹配 | [verification.json](verification.json) |
| 金额/回调样例 | 12项金额、4态回调、10文件一致 | 原样例校验器 |
| 语法、差异 | 通过 | 下述命令 |

新增17项已包含在301项中。规范包30组应用案例仍是设计，运行数0。真实模型、付费模型及真实金融操作均为0。

TAP日志保留非法金额测试名称中的故意空格及Node断言原格式；本目录`.gitattributes`仅对TAP关闭行尾空格检查，不修改日志、摘要或代码/Markdown的检查规则。

```powershell
npm --prefix modules/safety-risk-eval/interface-adapters ci --ignore-scripts --no-audit --no-fund
cd chenchen
node --test --test-reporter=tap
npm run check
cd ..
node --test --test-reporter=tap modules/safety-risk-eval/unified-rating/test/*.test.cjs modules/safety-risk-eval/interface-adapters/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.mjs modules/safety-risk-eval/joint-acceptance/test/*.test.cjs
node modules/safety-risk-eval/interface-adapters/write-examples.cjs --check
node modules/safety-risk-eval/joint-acceptance/run.cjs
node docs/safety-risk-eval/unified-rating-v1/verify-package.mjs
git diff --check
```

组件和规范工具仍需要两个固定旧Git对象，准备命令见[迁入说明](../pr37-import-2026-10-30/README.md)。组件使用固定旧Worker、当前工作流覆盖与当前辅助模块，不等于当前整份Worker或线上部署验收。复现修复前断言请在隔离checkout使用`e17c881`的Core源文件，仅加入修复提交的两份新增测试，不覆盖正在联调的工作区。

## 新任务用例覆盖

| 要求 | 本地证据 | 限制 |
| --- | --- | --- |
| 只读不能升级 | `review-capability-guards.test.js`、HTTP `readonly_capability` | 签名替身也不能升级 |
| 审批过期 | Core过期HTTP测试、HTTP `approval_expired` | 过期后无回执、无资金占用，重读仍过期 |
| 方案/数据变化 | HTTP `approval_parameter_change`、`confirmed_purpose_revision` | 金额、哈希及演示计划版本改变后不能沿用旧批准 |
| 跨会话/任务 | `review-context-binding.test.js`、HTTP `cross_session_callback_binding` | 显式错绑拒绝，不是本人身份认证 |
| 重复请求/未知结果 | Core并发/恢复测试、HTTP `normal_confirmed_plan`、`unknown_callback_response` | 单回执；结果未知先核查 |
| 伪造回调 | Owner签名测试、HTTP `wrong_signature_and_cross_task` | 真实服务端配置仍待双方核对 |
| Risk断网/超时 | `owner-bridge.test.js`、`owner-transport.test.js`、Risk sender超时/断连测试 | 本地故障替身停止，不是公网联合验收 |

历史请求若**省略**`session_id/task_id`仍可沿旧幂等逻辑重试。这不是会话认证；统一后端必须由可信服务端登录会话构造身份与上下文，不能信任浏览器自述、HMAC服务身份或测试替身作为本人身份。跨会话拒绝的正式服务端安全审计也须联合确认，不能只凭HTTP错误完成签认。

## 同版本联合验收

[联合验收记录](joint-acceptance.json)为`NO_GO`，尚无双方正式签认。本轮没有合入PR #4的Memory候选或严格身份分支：PR #4实际head为`6b69fa3`，其文档仍列`c7f6a19`；严格身份分支为`a8877ad`。须由Sean和林粹确定组合后的唯一SHA，再保存双方部署、请求与审计证据。

截图要求的四项信息及可转发请求见[对接林粹](对接林粹.md)。旧服务health可达不代表新候选已部署。原迁入`manifest.json`只描述`e17c881`的文件字节，本次由独立修复提交与新验证记录说明，不拿旧manifest冒充当前分支校验。
