# Core + Risk P0 集成候选（2026-10-30）

## 当前结论

这是一条保留旧版本的新集成分支，候选基线为 Core Memory/身份修复 `fe3a4ba`，合入 Risk PR #3 的源码与安全提交：

- Risk v1.1 导入：`e17c881c1b7d24747c039a25a8bf7447009f0456`
- Risk 只读阻断与跨上下文重试修复：`c1cc3c4bbab4700b5c156f09a649cbbf62e979a6`
- Risk 证据与线上差异记录：`b15dbc2da0bcb59aa0394d86ad3383e90ffe2925`
- 本候选最终 SHA：以本文件所在提交的 `git rev-parse HEAD` 为准

旧 Core PR #4、旧 Risk PR #3、正式发布区和线上 Worker 都没有被覆盖。

## 已接通的本地能力

1. Core 仍负责模型提议、任务状态、方案哈希、Memory、Risk Handoff、人工审批、PAPER 模拟和审计。
2. Risk 只能给出提议结果。Risk 超时、签名错误、任务或方案不一致、审批缺失时，执行保持阻断。
3. `REVIEW_ONLY` 只能走只读回写；签名的 Risk 回写不能把它升级为模拟任务。
4. `SIMULATION_ONLY` 必须在任务创建时明确声明，单独使用模拟回写器；之后仍要人工审批，最终只生成 `SIMULATED` 回执，`side_effects=false`、`execution_allowed=false`。
5. 重复请求必须使用相同任务上下文；更换 `session_id` 或 `task_id` 会得到 `IDEMPOTENCY_CONTEXT_MISMATCH`，不会读取旧任务结果。
6. Risk 回写统一使用 `CORE_AGENT_API_KEY` 和 `RISK_SERVICE_HMAC_SECRET` 的服务端配置名称，密钥值不进入聊天、前端、日志或 GitHub。
7. Risk reviewer 必须来自服务端固定配置 `RISK_REVIEWER_ID`。签名正确但 reviewer 不一致返回 `OWNER_ACTOR_MISMATCH`；`REQUIRE_RISK_REVIEWER=true` 缺固定身份或配置非法时直接停止。
8. `approval.trusted_identity_ready` 不再表示 Secret 是否存在。服务签名只能证明服务端调用者；本人登录、账户归属、任务绑定和本人批准必须由审批服务单独提供证据。本轮合成签名测试不计作本人批准。

## 本地验证结果

| 检查 | 结果 |
|---|---:|
| Core 全量 Node 测试 | 435 项：434 通过、1 跳过、0 失败 |
| Core 语法检查 | 通过 |
| Risk interface-adapters | 262 通过、0 失败 |
| Risk examples check | 通过，10 个样例文件 |
| 联合预检 | 20 通过、0 失败 |
| Core Golden Path | 12 步通过；外部模型 0 次、付费模型 0 次、真实执行网关 0 次 |
| 模拟链路 | `SIMULATION_ONLY → Risk → 人工审批 → SIMULATED` 通过 |
| 依赖审计 | `ajv` 已升级到 8.20.0，当前审计 0 漏洞 |
| 固定 Risk reviewer | 正确签名 + 正确固定身份通过；正确签名 + 错误身份返回 `OWNER_ACTOR_MISMATCH` |
| 严格配置 | 缺 `RISK_REVIEWER_ID`、只配置 `RISK_HMAC_SECRET`、非法开关值均安全停止 |
| 审批身份边界 | 配置审批服务签名后 `trusted_identity_ready` 仍为 false，等待独立本人身份与批准证据 |

推荐复核命令：

```powershell
cd chenchen
npm test
npm run check
node --input-type=module -e "import {runGoldenPath} from './experiments/golden-path-v1/run.mjs'; const {result}=await runGoldenPath({writeArtifacts:false}); console.log(result.status)"

cd ..\modules\safety-risk-eval\interface-adapters
npm ci --ignore-scripts
npm test
npm run examples:check
npm run test:joint-preflight
```

## 线上状态与阻塞

线上尚不能标记为联合验收通过。已知公开 Risk 地址仍返回旧 PR27 的健康信息，尚未确认 v1.1 候选部署；历史 Worker 版本 ID `209a…` 和 `8f10…` 也不能直接当作当前部署 ID。需要双方在同一候选 SHA 上重新部署并回查：

- Core Worker URL、Risk Worker URL、两边部署 ID 与 Git SHA 映射；
- Core 是否配置 `CORE_AGENT_API_KEY`；
- Core 与 Risk 是否都配置同名 `RISK_SERVICE_HMAC_SECRET`，并且值一致；
- Risk 是否启用固定 reviewer 和严格身份校验；
- 当前线上 Risk 是否具备明确的模拟能力接线；只读任务不得升级；
- 用同一个合成任务跑 HTTP：模型提议 → Risk → 人工审批 → PAPER 模拟 → 审计回放。

这些线上条件未完成前，状态保持 `NO-GO`；本地替身测试不能替代线上联合验收，也不能把旧 PR27 报告成新版本。本轮只确认配置名称、是否配置和校验结果；真实 `RISK_REVIEWER_ID` 固定值、两边 Secret 是否一致、登录/账户归属/本人批准证据仍需双方通过安全渠道核对，不能把合成测试身份当成线上身份。

## 回滚

只需停止使用本分支或 PR，继续使用原 Core PR #4、Risk PR #3 和已有线上版本；本候选没有改写历史提交。部署时以候选 SHA 做版本映射，发现线上健康信息仍显示 PR27 就立即停止联调，不发送真实资金请求。
