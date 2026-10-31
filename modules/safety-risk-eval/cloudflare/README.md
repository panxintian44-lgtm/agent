# Risk v1.1 Cloudflare 候选适配

状态：**可构建、本地测试；未部署，正式联合验收 NO-GO**。本目录是服务端适配，不新增用户展示站点，不修改已有 Worker 或前端入口。

范围固定为 `SINGLE_SERVICE_SYNTHETIC`：使用一个服务 actor、一个 DO 和机器密钥，未实现最终用户/账户的授权隔离。health/status 明示 `user_isolation_verified=false`，不是可直接接入真实多用户前端的后端；本轮不扩展多租户。

## 支持的方向与权限

复用当前同一 Git 候选中的金额适配、日常资金引擎、v1.1 评级一致性校验、问答整理、Core Schema 和签名回调。方向为：

`授权问答服务 → Risk /api/review → Core /api/review → 原任务 Handoff → 确定性 Risk → risk-callback.v1 → Core 只读回执`

- `/api/assess`：仅程序测算与审计，不调用模型或发送回调。
- `/api/review`：仅 `REVIEW_ONLY`。模型开关默认关闭；打开也不授予审批、模拟写入或真实交易权限。
- 原 `sendRiskCallback()` 的只读限制保留。PR #5 的独立 `sendSimulationCallback()` 仍存在，但**本云适配不暴露模拟回调 HTTP 入口**。需要受审的模拟计划及同任务执行前检查，不能把只读问答升级为模拟。
- 本适配**不接收 Core 主动 `owner-bridge.v1` 派发包**。不能将 `/api/review`、`/api/assess` 当作 `RISK_SERVICE_URL`；显式 `/api/risk-handoff` 返回 `501 OWNER_BRIDGE_RECEIVER_NOT_IMPLEMENTED`。
- Handoff、回调十字段及四态映射沿用当前模块；`ERROR` 不发送业务回调。结果未知时先核查，不能换请求编号盲目重试。

## 本地复现

Node >=22.13（测试使用 `node:sqlite`，SQLite 只模拟 Durable Object 的 SQL 接口）；无真实模型或 Cloudflare 账户调用。

```powershell
npm --prefix modules/safety-risk-eval/interface-adapters ci --ignore-scripts --no-audit --no-fund
cd modules/safety-risk-eval/cloudflare
npm ci --ignore-scripts --no-audit --no-fund
npm run build:local
npm test
```

`build:local` 显式允许未提交源码，并在 health/manifest 标记 `source_dirty=true`，不可作为发布产物。

完成审查、提交并确认工作区干净后，运行 `npm run build`。该命令遇到未提交/未追踪源码会拒绝。产物位于忽略的 `dist/`，不把依赖和大体积 bundle 提交到仓库。

`source-manifest.json` 记录实际 Git SHA、dirty 状态、编译依赖版本、参与构建文件 SHA-256 与 bundle SHA-256。构建结束再次核对 HEAD、Git 状态及实际读取源码摘要；干净发布还核对固定提交内容。输入或版本在构建中变化则拒绝，并删除旧 manifest，不留下声称可发布的未核验产物。bundle/manifest 使用临时文件，核验成功后才发布到 dist。build 不写死 PR27；复用官方 Handoff Schema，构建期使用 Ajv standalone 编译，避免 Workers 运行期 `eval`。同一源码和依赖下可复算 bundle。

## 接口

| 接口 | 身份 / 行为 |
|---|---|
| `GET /health` | 公开只读；实际源码 SHA、dirty、规则版本；不证明下游可达或正式验收 |
| `GET /docs` | 公开 JSON 接口说明；不是产品页面 |
| `GET /api/status` | 机器鉴权；本地配置完整度；`core_connection_verified=false`、本人身份仍未验证 |
| `POST /api/assess` | 机器鉴权；确定性资金测算、评级与 SQLite 审计 |
| `POST /api/review` | 机器鉴权＋模型开关＋严格配置；复用现有只读问答与回调 |
| `GET /api/records/assess/{id}` | 机器鉴权；测算记录与关联审计 |
| `GET /api/records/review/{id}` | 机器鉴权；问答记录与关联审计 |

兼容旧 `/api/records/{id}`，仅查询 `assess` 记录。所有业务接口拒绝带 `Origin` 的浏览器调用，不提供 CORS；前端必须经过团队统一服务端入口，不可持有机器密钥。

POST 输入沿用 `question、daily_finance_yuan、idempotency_key`。金额是明确单位的十进制元字符串，程序转换整数分；不接受浏览器传入 capability、批准、Risk 结果或数据来源权威声明。只允许虚构资金联调，不能当作真实账本。

## 服务端配置（只交换名称和状态）

`wrangler.example.toml` 仅为模板，默认虚构域名，不能直接投入使用。复制为本目录已忽略的 `wrangler.staging.toml`，保持 `main` 相对路径指向本目录的 `dist/risk-worker.mjs`。不要将实际配置、`.dev.vars` 或 `.wrangler` 状态提交到仓库。由服务 Owner 选择已确认的团队 staging Worker，核对已有 Durable Object 绑定、迁移历史和回滚版本；不要覆盖生产服务或复制不匹配的迁移标签。

| 名称 | 要求 |
|---|---|
| `CORE_AGENT_BASE_URL` | Owner 确认的 HTTPS 源站，无路径、查询、凭据或片段；无隐式默认值 |
| `CORE_AGENT_API_KEY` | 服务端 Secret；Core 机器访问，不能代替本人登录 |
| `RISK_SERVICE_HMAC_SECRET` | 服务端 Secret；与 Core 主名称一致；本云适配不自动使用旧别名 |
| `RISK_CONVERSATION_API_KEY` | 服务端 Secret；`X-Risk-Conversation-Key` 机器调用鉴权，24—200 ASCII 字符 |
| `RISK_REVIEWER_ID` | 固定服务审核者，与 Core 校验值一致；沿用 Core 候选的 1—200 字符、无前后空白及控制字符要求 |
| `REQUIRE_TRUSTED_ACTORS` | 必须为 `true`，否则 `/api/review` 暂停 |
| `REQUIRE_RISK_REVIEWER` | 必须为 `true`，否则 `/api/review` 暂停 |
| `RISK_MODEL_CALLS_ENABLED` | 默认为 `false`；需要费用与服务 Owner 明确确认后才可开启 |
| `RISK_CONVERSATIONS` | SQLite Durable Object，类名 `RiskConversationService` |

Risk 侧开关只表示本适配要求严格配置，**不能证明 Core 已实现同名规则**。Core 必须部署固定 reviewer 的实际校验代码并独立留证。`fixed_reviewer_configured` 也不代表本人审批或联合验收通过。

现有 DO 名称沿用 `risk-validation-v1`，防止升级时静默切换为空白账本而遗失旧未决请求；本存储只是风控联调记录，**不是团队共享资金账本**。单实例队列串行请求，限排队数4、记录1000、事件20000。达到上限暂停，不能自动删除审计。

## 数据持久化与失败处理

- 每次模型请求和签名回调前先 `storage.sync()`，确保审计意图与状态已确认持久化。
- flush 未确认则禁止网络调用；该实例后续请求暂停，已入队请求在出队时也重新检查失败标记，不能因下一次 sync 恢复而继续。需 Owner 核查。
- 重启把 `RUNNING` 转为 `UNKNOWN`；同一请求不得继续调用模型或回调。
- 请求编号相同但内容不同返回409；`COMPLETE` 可复用保存的回执，`UNKNOWN` 不自动重试。
- 审计 hash 链损坏时启动失败。无效存储或缺少绑定时不降级到内存成功。
- 模板用 `version_metadata` 的 `CF_VERSION_METADATA` 绑定提供 health 的平台 `worker_version_id`；本地或平台未提供时仍为 `null`。`deployment_id` 保留 `null`。版本 ID、部署 ID 与 Git SHA 必须由发布 Owner 分开核对。

## 验证边界与团队待办

本地测试包含构建后 Worker 与当前 Core 的合成同任务回调、只读不可执行、未知回执、SQL/flush 故障、重启与审计篡改。属于 **Node / SQLite / HTTP fetch 测试替身**，不是已部署 Cloudflare、真实模型、本人审批或共享账本联合验收。

仍待：团队 staging 账号/Worker/部署权限确认；同候选 Core 与 Risk 云构建/部署映射；固定 reviewer 跨端验证；Core 主动派发接收器或正式选择问答反向驱动；显式模拟计划云接线；本人登录审批；同账本原子资金接口；统一网页接线；双方 Owner 签认。此前执行保持关闭。
