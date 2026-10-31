# Core 4f98bcfb 与 Risk 候选对齐（2026-11-01）

状态：代码集成与本地验证；线上联合验收仍为 **NO-GO**。

## 对齐的来源

- Core：`4f98bcfbb45e3d8522484f5b446e498abd7b1ed1`，`realchenchenluo/agent` PR #5。
- Risk：本轮起点 `e8f01cc5a77077f87fbabb891c0e51de21b9b6b6`，同仓库 PR #6，原运行代码为 `6df8d34e40d56ba4acaa232f70fc4f45f52343bd`。
- 团队暂存：旧团队仓库 PR #39 的 `ef8dcd912bb2be2e709dedc685f307a66a003bca` 是另一仓库的暂存快照，不能冒充新仓库主分支或当前云部署。
- Core 更新了双方共同修改的两个文件，PR #6 因此产生合并冲突。本轮把 Core 功能分支合入 Risk 工作分支，保留两边历史，不合并 main，不覆盖线上 Worker。

最终共同运行代码 SHA 和新的构建摘要在 `verification.json` 中登记；10月31日的报告、签名和原始日志保持历史原样，不能沿用旧测试数或旧包摘要代表新候选。

本轮供双方审阅和确认的共同代码候选为 `4f97748dbb4c86a8bb751d66e0a145390e4ba39b`，同时保留上述 Core 与 Risk 两条提交历史。干净 Risk 云构建的 source_commit 也是该 SHA，bundle SHA-256 为 `cb5042bd1e6abc85a93cde7fa8511c82c513408ba64ddc02f2c4d442e6d133b2`。后续报告提交只补充证据，不代表双方已签认或已经部署。

同候选本地结果：Core 475 项中 474 通过、1 项既有跳过；固定审核身份专项 36/36（包含在 Core 总数中）；Risk 501/501；云适配 30/30；本机签名 HTTP 18/18（其包装测试包含在 Risk 中）。语法、样例和 Wrangler dry-run 通过，GitHub CI 与线上验收另行核对，真实模型及真实金融操作为零。

## 保留的共同约定

1. 严格 Risk 身份只使用主名称 `RISK_SERVICE_HMAC_SECRET`；仅有 `RISK_HMAC_SECRET` 的严格环境必须停止。非严格历史演示兼容不等于正式服务验收。
2. `REQUIRE_TRUSTED_ACTORS` 或 `REQUIRE_RISK_REVIEWER` 任一个启用，都要求固定审核人及服务签名。仅配置固定审核人也不能退回无签名演示。
3. `RISK_REVIEWER_ID` 由服务端指定，采用 Core 已公开的 1—200 字符、无前后空白及控制字符要求；Risk 云入口在模型请求前按同一条件校验。它不是金融评级阈值，也不是通用展示标签的长度上限。
4. 回调审核人精确匹配，不能通过修剪请求中的空白混淆身份。保留两边兼容的 `fixed_reviewer_verified` 和 `fixed_actor_verified`；两者均只表示固定服务身份。
5. 服务签名不证明本人身份。`identity_scope=SERVICE`、`end_user_identity_verified=false`；审批本人身份与账户归属必须由审批服务另外提供。
6. `risk-callback.v1` 十字段、HMAC 规范、四态映射、只读能力、跨上下文幂等拒绝、独立 `SIMULATION_ONLY` sender、存储故障队列拦截及构建快照校验均保留。

## 配置确认表

| 名称 | 代码约定 | 线上实际状态与跨端一致性 |
| --- | --- | --- |
| `RISK_REVIEWER_ID` | 两端使用同一个固定服务身份，格式校验已对齐 | 未核验；公开接口未提供实际绑定身份的验证证据 |
| `RISK_SERVICE_HMAC_SECRET` | 严格模式主名称；不使用兼容名替代 | Core 公开能力仍自报回调签名未配置；Risk 侧存在性及两端一致性未知 |
| `CORE_AGENT_API_KEY` | 服务间身份，不作为本人登录 | 两端配置状态及鉴权正负例未核验 |
| `REQUIRE_TRUSTED_ACTORS=true` | Core 严格门禁，Risk 云候选也要求为 true | 当前公开接口未明确报告此配置，不能从源码推断部署值 |
| `REQUIRE_RISK_REVIEWER=true` | Core 固定审核人门禁，Risk 云候选也要求为 true | 当前部署值未核验 |
| Worker 版本 ID／部署 ID／Git SHA | 分开记录并核对同一构建 | 尚无当前部署映射证据；历史 209a…、8f10… 仅作为历史版本 ID |

证据为本目录 `live-readonly-probes.json` 中的时间戳与公开 GET。没有读取 Secret 内容或以密钥摘要代替联合验签；“未知”不是已经配好，也不是断言永远缺少权限。

## 本地验证与复现

在仓库根目录、Node >=22（本轮实际 Node 版本记录在机器报告）执行：

```powershell
npm --prefix modules/safety-risk-eval/interface-adapters ci --ignore-scripts --no-audit --no-fund
npm --prefix modules/safety-risk-eval/cloudflare ci --ignore-scripts --no-audit --no-fund
node --test --test-reporter=tap chenchen/tests/trusted-risk-reviewer.test.mjs
Push-Location chenchen
node --test --test-reporter=tap
npm run check
Pop-Location
node --test --test-reporter=tap modules/safety-risk-eval/unified-rating/test/*.test.cjs modules/safety-risk-eval/interface-adapters/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.mjs modules/safety-risk-eval/joint-acceptance/test/*.test.cjs
node modules/safety-risk-eval/joint-acceptance/current-candidate-http.cjs --out <新报告路径>
npm --prefix modules/safety-risk-eval/cloudflare run build
node --test --test-reporter=tap modules/safety-risk-eval/cloudflare/test/*.test.mjs
git diff --check
```

正式 build 要求干净、已提交的共同候选；未提交调试使用 `build:local`，其 dirty 包不能发布。本轮 HTTP 使用完整当前 Worker 与真实 Risk 程序，模型、审批服务、内存 DO 和合成资金计划明确为测试替身，不证明本人审批、Cloudflare 运行时或 Finance 共享账本通过。

两项旧严格测试夹具原先未登记固定审核人，先于其预期的缺签名／缺地址断言被新配置检查拒绝；只补了原有合成身份，保留原拒绝断言与严格开关。首轮失败输出保存在 `core-before-fixture-alignment.tap`。

## 可发给林粹的回执

> 已核对 Core 4f98bcfb，并在 PR #6 保留双方改动、解决固定身份校验冲突。新的共同候选和本地验证证据见 verification.json。Risk 主签名名称、固定 reviewer、严格开关、只读与独立模拟边界已在代码层对齐；Risk 云配置的身份格式也已同步。但我不能确认两端实际配置值一致：公开 Core 仍自报回调签名未配置，公开 Risk 仍自报旧 PR27，当前部署 ID 与 Git SHA 未核验。请由有权限的服务 Owner 在各自服务端确认五项配置的存在性和正负例结果，不发送 Secret；提供同一候选的 Core/Risk URL、版本 ID、部署 ID及回滚目标。审批服务请独立提供本人登录、账户归属、任务与本人批准绑定证据；这些完成前继续 NO-GO。

云候选仍只支持授权服务端问答驱动的 `REVIEW_ONLY` 方向，不是 Core 主动 `owner-bridge.v1` 接收器，也未公开云端模拟回调入口。不能因本地 PAPER 通过就把该入口当成完整云执行链路。
