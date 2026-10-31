# 固定审核身份与同任务联调证据（2026-10-31）

本轮在 PR #5 的 `75dcfa269f63ef2fe81394277a0ce537b4feb9aa` 上继续修复，不覆盖 PR #3、PR #4 或线上 Worker。运行代码候选、报告摘要及文件摘要以本目录 `verification.json` 为准。

最终运行代码候选为 `6df8d34e40d56ba4acaa232f70fc4f45f52343bd`；后续证据提交仅修改本目录文档和报告，不改变运行代码。该 SHA 的干净构建已连续两次核对 bundle 与 manifest 摘要相同，Wrangler `--dry-run` 通过；仍未部署。原始证据禁用 Git 换行转换，确保机器报告中的文件摘要可在远端复算。

## 当前可交付范围

- Risk 回调除 HMAC 外，按服务端 `RISK_REVIEWER_ID` 核对固定审核身份。签名正确但身份不符仍拒绝；严格配置缺失或非法时安全停止。
- `REQUIRE_TRUSTED_ACTORS=true` 或 `REQUIRE_RISK_REVIEWER=true` 均要求签名和固定审核身份；配置固定审核人本身也会启用对应校验。未配置的非严格历史演示仍明确标记为未验证。
- 能力响应分开表示服务签名配置与本人身份。配置审批服务 HMAC 不再被表示为已验证最终用户本人；本人身份字段仍为 `false`。
- PR #5 中的 `REVIEW_ONLY` 与 `SIMULATION_ONLY` 分离保持不变。Risk 通过或人工确认不能升级只读任务；模拟回执保持 `SIMULATED`、真实执行关闭。
- 回调保持 `risk-callback.v1` 十字段、现有 HMAC 算法和 ALLOW/REVIEW/BLOCK/ERROR 映射。ERROR 不发送业务批准回调。
- 新增完整当前 Core Worker 的本地签名 HTTP 验证，替代仅使用旧 Worker 快照所能证明的有限范围；模型、审批身份、Durable Object 和资金账本仍明确使用测试替身。
- 新增 Risk 云端候选打包目录，具体支持方向、存储边界、构建步骤和未完成项见 `modules/safety-risk-eval/cloudflare/README.md`。可构建不等于已经部署。
- 存储持久化失败后在出队和外部调用前再次拦截，已排队请求也不能继续。构建结束重新核对 HEAD、工作区和输入摘要，拒绝混入未提交源码的发布产物。
- 提供只读权限的 GitHub Actions 验证工作流；本地检查不等于该工作流已经运行，实际 CI 状态以 PR 的运行链接为准。

## 必须区分的身份

| 项目 | 本轮含义 | 不能据此声称 |
| --- | --- | --- |
| `X-Core-Agent-Key` | 服务调用方持有机器凭证 | 当前操作者是账户本人 |
| `X-Risk-Signature` | Risk 回调正文的服务端 HMAC | 用户已经批准计划 |
| 固定 `reviewer` | 已签名服务必须使用配置中的审核身份 | 最终用户登录已核验 |
| `X-Approval-Signature` | 审批服务签署了正文 | 本人会话、账户归属和授权范围已联验 |
| 本地合成批准 | 验证审批状态机和任务绑定 | 正式用户审批通过 |

## 配置与交接

| 配置名称 | 配置位置 | 要求 |
| --- | --- | --- |
| `CORE_AGENT_API_KEY` | Core、调用 Core 的 Risk 服务 | 由两端 Owner 在服务端配置；不发送值 |
| `RISK_SERVICE_HMAC_SECRET` | Core 与 Risk | 首选统一名称；通过签名正负例验证一致性，不公开值 |
| `RISK_HMAC_SECRET` | 部分历史 Node/Core 路径 | 兼容名；不能推断所有云适配器都读取它 |
| `RISK_REVIEWER_ID` | Core 与 Risk | 两端共同确认同一个固定服务身份；不是请求方可选字段 |
| `REQUIRE_TRUSTED_ACTORS` | Core | staging 应显式设为 `true` |
| `REQUIRE_RISK_REVIEWER` | Core | staging 应显式设为 `true` |
| `CORE_AGENT_BASE_URL` | Risk | 明确指向本次同版本 Core，不沿用旧独立验证地址 |
| `RISK_CONVERSATION_API_KEY` | Risk 及其服务端调用方 | 只读问答入口的独立机器凭证，不进入公开前端 |
| `APPROVAL_SERVICE_HMAC_SECRET` | Core、审批服务 | 独立于 Risk 密钥；本人认证另行验收 |

正式环境不能仅复制演示 ID 或补一个 Secret 就认定身份接通。Worker 版本 ID、部署记录 ID、Git SHA 必须分别登记。当前公开 GET 与本机发布身份检查见 `live-readonly-probes.json`；本轮没有读取或写入线上 Secret，也没有部署生产服务。

## 复现

在仓库根目录使用 Node >=22；本次实际环境与依赖记录在 `verification.json`。

```powershell
npm --prefix modules/safety-risk-eval/interface-adapters ci --ignore-scripts --no-audit --no-fund
node --test --test-reporter=tap chenchen/tests/trusted-risk-reviewer.test.mjs
Push-Location chenchen
node --test --test-reporter=tap
npm run check
Pop-Location
node --test --test-reporter=tap modules/safety-risk-eval/unified-rating/test/*.test.cjs modules/safety-risk-eval/interface-adapters/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.mjs modules/safety-risk-eval/joint-acceptance/test/*.test.cjs
node modules/safety-risk-eval/joint-acceptance/current-candidate-http.cjs --out docs/safety-risk-eval/p0-trusted-handoff-2026-10-31/current-candidate-http-recheck.json
node modules/safety-risk-eval/interface-adapters/write-examples.cjs --check
git diff --check
```

HTTP 脚本仅绑定 loopback，报告明确区分真实 Risk 程序、合成模型、签名审批服务替身、内存存储适配和独立合成资金计划。不得以该报告证明 Cloudflare SQLite、真实登录、Finance 共享账本或正式用户页面已通过。

## 证据阅读顺序

1. `baseline-core-tests.tap`：隔离 PR #5 原候选实际复跑的 435 项原始输出，补齐此前只有汇总的问题。
2. `trusted-reviewer-before.tap` 与 `trusted-reviewer-tests.tap`：新增安全测试的修复前后输出，不是线上攻击结果。
3. `core-tests.tap`、`risk-tests.tap`：本轮代码的完整回归，最终数量见机器报告，不混加历史范围。
4. `current-candidate-http.json`：同一任务的模型提议、风险、确认、模拟回执、审计以及拒绝路径。
5. `verification.json`：来源 SHA、运行文件摘要、命令、结果、未完成项和调用计数。

`cloud-queue-before.tap` 留存排队绕过修复前的失败，`cloud-queue-tests.tap` 留存对应修复后的测试；`cloud-tests.tap` 为最终候选的云适配完整回归。构建快照校验另含源码变化、HEAD 变化和工作区变化的拒绝用例。

`risk-before-fixture-alignment.tap` 保留严格身份新增后旧测试夹具未登记固定审核人所导致的失败；随后只补齐原有合成身份，没有关闭严格开关、放宽断言或改写原日志。开发过程若另有测试预期修订记录，不得冒充产品漏洞修复前证据。

## 发布与联合验收仍需完成

状态保持 **NO-GO**。本地程序和 HTTP 验证不等于团队线上联合验收。

- 林粹与 Vesper 审阅本轮补丁，冻结唯一 Core/Risk 候选版本及配置名称。
- 有团队 Cloudflare 权限的 Owner 构建并发布限定的 staging Worker，记录 URL、Git SHA、版本 ID、部署 ID 和回滚目标；未授权不覆盖现行生产。
- 核对 Risk 不再自报旧 PR27；核对 Core 固定审核人和签名校验真实生效。失败、未知或等待审批时保持阻断。
- 补真实登录会话所绑定的本人审批、Finance 同账本及执行前复查证据；不能把本地 `funding-demo` 视为团队共享账本。
- 在现有统一用户页面对同一个任务完成正常、只读、拒绝、过期、改参、错绑、断网、重复和结果未知的正负例，保存审计回执并由双方 Owner 签认。
- 真实模型另经费用 Owner 确认后受限运行并独立留证；本轮真实模型、付费模型及真实金融操作均为零。
