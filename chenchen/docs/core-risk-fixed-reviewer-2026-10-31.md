# Core Risk 固定审核人校验（2026-10-31）

## 结论

本修复已放在 Core + Risk 集成候选分支中，和只读权限、跨上下文重试修复保持同一候选。它只交流配置名称、配置状态和校验结果，不记录任何 Secret 内容。

## 校验规则

- 主签名配置名：`RISK_SERVICE_HMAC_SECRET`。
- `RISK_HMAC_SECRET` 仅保留兼容读取；当 `REQUIRE_TRUSTED_ACTORS=true` 或 `REQUIRE_RISK_REVIEWER=true` 时，不能只配置兼容名。
- 严格开关：`REQUIRE_TRUSTED_ACTORS=true`、`REQUIRE_RISK_REVIEWER=true`。
- 固定审核人：`RISK_REVIEWER_ID`，由服务端配置，不能从用户请求决定。
- HMAC 正确且 reviewer 正确：通过，并记录 `fixed_reviewer_verified=true`。
- HMAC 正确但 reviewer 错误：返回 `OWNER_ACTOR_MISMATCH`，HTTP 403，任务不变更。
- 缺固定审核人、Secret 主配置缺失、开关值非法、审核人配置含前后空格或控制字符：安全停止，不进入业务回写。

## 审批身份边界

Core 的能力状态现在把以下信息分开：

- `approval.signature_configured`：只表示审批服务签名配置存在。
- `approval.trusted_identity_ready`：本项目不凭服务签名推断本人身份，当前保持 `false`。
- `approval.trusted_identity_evidence=APPROVAL_SERVICE_REQUIRED`：提示需要审批服务单独提供本人登录、账户归属、任务绑定和本人批准证据。

因此，本轮 Risk 签名正确的测试只能证明服务端验签和固定审核人门禁，不能证明最终用户本人已经批准，也不能替代审批服务留证。

## 本地验证

- `tests/owner-bridge.test.js`：9 项通过，覆盖正确/错误固定审核人、缺配置、非法开关、兼容密钥名和脱敏状态。
- `tests/cloudflare-review.test.mjs`：21 项通过，覆盖审批服务签名不等于本人身份。
- `tests/review-capability-guards.test.js`：23 项通过，原只读与跨上下文能力门禁保持有效。
- Risk interface-adapters：262 项通过。
- 真实模型调用、真实资金操作和本人批准：0 次。

## 双方需要确认的内容

潘心恬（Vesper）与陈全宝（林粹）只需在安全渠道确认以下状态，不发送值：

| 项目 | 需要确认 |
|---|---|
| `RISK_REVIEWER_ID` | 两端固定值是否一致 |
| `RISK_SERVICE_HMAC_SECRET` | 两端是否已配置、是否一致；不发送 Secret |
| `CORE_AGENT_API_KEY` | Core/Risk 是否已配置；不发送值 |
| `REQUIRE_TRUSTED_ACTORS` | Core 是否为 `true` |
| `REQUIRE_RISK_REVIEWER` | Core 是否为 `true` |
| Worker 版本 | 当前部署 ID 与 Git SHA 是否对应本候选 |
| 审批证据 | 是否有本人登录、账户归属、任务绑定和本人批准记录 |

线上没有完成上述核对前，联合验收继续保持 `NO-GO`。
