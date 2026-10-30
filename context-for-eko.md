# AI Banking Agent / Personal AI Fund Manager：接手上下文

> 更新日期：2026-10-30，北京时间。面向完全没看过本次对话的接手者。
> 本文件总结产品决策、已核实代码、测试与发布证据。历史口头汇报不等于当前线上验收；后续以仓库和同版本部署证据复核。

## 0. 先读这几条

- **2026-10-30 P0补充：**新仓库PR #3后续提交`c1cc3c4bbab4700b5c156f09a649cbbf62e979a6`修复只读审批越级、显式会话/任务重试冲突及未完成请求旁路。本地Core 301/301、Risk 499/499、组件HTTP 14/14通过；下文11/12为原迁入历史。最新复现与联合验收NO-GO见[P0记录](docs/safety-risk-eval/p0-readonly-closure-2026-10-30/README.md)，接线见[对接林粹](docs/safety-risk-eval/p0-readonly-closure-2026-10-30/对接林粹.md)。未合并PR #4、部署新Worker或取得对方联合签认。
- **2026-10-30迁入更新：**用户随后明确要求将旧仓库PR #37纳入新仓库。本次以`realchenchenluo/agent`的`main@d4da8afbef5a4989903f211e874a7cfdfe526554`建立`codex/import-risk-pr37-v1.1`，通过`panxintian44-lgtm/agent`的Fork提交评审。本文件后文的“本轮”、旧目录和不迁移决定均为来源历史；迁入范围、新跑验证与仍待接线事项以[迁入说明](docs/safety-risk-eval/pr37-import-2026-10-30/README.md)为准。提出PR不等于目标main已经收录或线上联合验收通过。
- 用户是**潘心恬，Vesper**，负责第四板块 **Safety / Risk / Eval**，不是金融数据或前端模块负责人。
- 来源阶段实施的是**日常资金风控与权限优化 v1.1**：先完善规则、权限和本地验证，再接团队后端。当时用户要求在旧仓库 **PR #37** 继续；该阶段的不迁移决定已被上述最新迁入要求更新。
- **原工作台已发布第15版**，沿用原网址及公开访问范围。10月30日补验修复了确认重检未保存评级的问题；未点击真实模型、执行和重复执行按钮。
- 原487项程序测试、12项本地组件HTTP验证记录保留；10月30日修复回归112项及现有Worker HTTP共30项通过，线上低风险确认与变参已补验。**真实本人审批、团队共享账本、统一执行网关尚未联合验收，不能说整个产品已经打通。**
- L3模拟资金写入关闭，L4真实交易始终禁止；低风险、Risk通过、用户确认、服务HMAC认证都不能单独开启写入。
- 当前文件与v1.1代码会一并更新到PR #37。接手后用`git log -1`及PR远程head核对最终提交；不要把下面的“实施前基线”误作最终交付提交。

## 1. 项目目标与背景

### 1.1 产品要解决什么问题

项目最初围绕基金与股票投资组合健康检查、方案比较和模拟决策展开。用户很难从专业金融信息中独立作决定，希望Agent解释持仓风险，比较不同调整方式及其后果。

产品随后扩展到**与生活安排相关的资金决策**。典型问题是：

> 我想再投入8000元买基金，但下个月还要交房租、学费。这笔安排会不会影响生活？

创新重点是把用户**明确确认的资金用途**变成持续有效的约束，让模型解释这些约束，确定性程序检查这些约束，并在变参、多个任务争用资金或外部信息污染时仍阻止未授权动作。

不承诺收益；历史模拟结果、未来模型估计和真实执行必须清楚区分。历史最大回撤不是未来损失上限。预算比例和应急储备参考由用户明确启用，不能冒充统一监管硬阈值。

### 1.2 Golden Path

```text
用户画像与投资组合/日常资金资料
→ 用户发起问题或Portfolio Review
→ Core/Orchestrator加载可信Context与Memory
→ Financial Tools / Research / Quant提供资料与计算
→ 模型提出建议（只作为提议）
→ Risk检查并给出固定原因与恢复动作
→ 展示建议、理由、证据、风险及未知项
→ 用户对完整计划明确确认
→ 唯一执行网关执行前复查
→ 模拟执行回执、账本与审计关联
→ 适用时更新经授权的Memory
```

完整链路的任务、主体、账户、方案摘要、版本、审批及回执必须一致。拒绝、等待审批、异常或结果未知期间，执行端不能继续。

### 1.3 第四板块负责什么

Vesper负责：固定风险规则、风险原因、四态结果、权限分级、确认有效性验证、失败关闭、审计字段和评测用例；把确定性风险评估及可执行的恢复建议提供给原问答系统和工作台。

Vesper不替代Research作市场结论，不维护市场数据供应，不自行实现第二套正式身份系统或团队资金账本，也不在UI里复制审批/扣款逻辑。

协作称呼来自对话，后续应以最新仓库职责文档确认：林粹对接Core及后端契约；七七对接Finance、金融数据与计算；小果／李想对接前端和统一入口；架构负责人统一跨模块合同。不能据这些历史称呼推定当前云账户权限或完成状态。

## 2. 仓库、分支、站点与事实边界

| 项目 | 地址或状态 |
| --- | --- |
| 本轮实施仓库 | `https://github.com/Fintechathon-agent/Fintechathon-agent.git` |
| 本轮PR | [PR #37](https://github.com/Fintechathon-agent/Fintechathon-agent/pull/37)，保持打开，未经授权不合并 |
| 本轮工作分支 | `codex/unified-risk-runtime-v1` |
| PR现有base | `codex/workbench-network-resilience-v1`，不是main；本轮不擅自改base |
| 实施前本地/远程head | `1c7ffe4fdc34a1e024792ea6718ba3cf64404335` |
| 用户指定的新SoT仓库 | [realchenchenluo/agent](https://github.com/realchenchenluo/agent)，用于团队进度巡检；旧PR产出不自动计入该仓库 |
| 当前工作目录 | `C:\Users\lenovo\.codex\worktrees\risk-p0-review-pack\银行agent` |
| 用户原项目工作目录 | `C:\Users\lenovo\Documents\ChatGPT\银行agent`，不要假定它与当前worktree状态相同 |
| 原在线工作台 | [日常资金与风险工作台](https://fund-risk-workbench.panxintian44.chatgpt.site/risk) |
| Site ID | `appgprj_6ac9a87727948191a202fedf09841f82` |
| 已发布版本 | **15**；平台原生部署`succeeded`，线上浏览器已补验确认后LOW保留、变参BLOCK及执行关闭 |
| v15站点源码提交 | `bde20b6dca5f3a4aa5b7bc815f73b0aac81cc8b7`，属于Site独立源码仓库，不是团队PR的提交号 |
| v14基线源码提交 | `797a930ad7233fa8e6015381105f47d515f08ecc`，保留历史部署证据 |
| v13基线源码提交 | `f1c1bd746b029a30e1518aa527dfcfbd770b71ea` |
| 本机Site源码副本 | `C:\Users\lenovo\.codex\tmp\risk-runtime-site-20261029`，临时副本不应当作唯一长期来源 |

站点最新部署记录见[v15 deployment](docs/safety-risk-eval/unified-runtime-v1.1/evidence/browser-20261030/deployment-v15.json)；旧v14的[deployment.json](docs/safety-risk-eval/unified-runtime-v1.1/evidence/deployment.json)保持原样。最新补验和交接入口：[补验报告](docs/safety-risk-eval/unified-runtime-v1.1/浏览器补验与确认重检修复-2026-10-30.md)、[队友交接请求](docs/safety-risk-eval/unified-runtime-v1.1/队友交接请求-2026-10-30.md)。

团队曾提供Core服务：`https://personal-ai-fund-manager-core-agent.realchenchenluo.workers.dev`及其`/health`、`/docs`，历史上还有`/api/risk-workbench/handoff`。本地问答适配器调用`POST /api/review`并验证Core交接证据。接口存在、健康检查成功和真实模型推理成功是三件事，后续必须重新核对当前部署。

`http://127.0.0.1:4175/api/review`此前连接被拒绝；它只指运行服务的那台机器。公网网页不能用队友电脑的127.0.0.1作为后端地址。

团队Cloudflare目标曾指向`xinlan-qwen38-share`。主聊天staging Worker的实际账户Owner、源码SHA、部署ID及限定权限仍需以最新团队证据确认。本轮发布的是原Sites工作台，**没有据此宣称团队Cloudflare主聊天已接线**。

## 3. 已完成的内容与关键结论

### 3.1 历史规则与接口资产

仓库保留：权限风控规划表v0.2、固定规则/原型、统一接口适配、日常资金规则、网络错误提示、风险评级及权限规范。入口索引：

- [权限风控规划表v0.2](docs/safety-risk-eval/权限风控规划表-v0.2.md)
- [接口字段对应与回调适配](docs/safety-risk-eval/接口字段对应与回调适配-v1.0.md)
- [对话风控与正式回调接入](docs/safety-risk-eval/对话风控与正式回调接入-v1.0.md)
- [联合验收与网页接线](docs/safety-risk-eval/联合验收与网页接线-v1.0.md)
- [网络异常监测与恢复](docs/safety-risk-eval/网络异常监测与恢复-v1.0.md)
- [权限分级与授权闭环策划](docs/safety-risk-eval/权限分级与授权闭环策划-v0.1.md)
- [金融风控参考调研](docs/safety-risk-eval/research/金融风控参考调研-2026-10-29.md)
- [v1.0规范包](docs/safety-risk-eval/unified-rating-v1/README.md)：24项来源、22项能力、30组待执行设计案例、七七数据快照摘要。

参考书、论文、开源项目和数据集用于形成有来源的指标与评测思路；不能从数据集标签直接推断某个用户的余额、本人批准或执行权限。本轮没有训练风险分类模型，也没有新增投资组合评级适配器。

### 3.2 本轮v1.1完成的修正

1. **结果先校验再评级。**原因代码、所属规则、状态、通道、接受标记、检查项、引用、总判定及金额关系不一致时，显示未知，暂停模型/回调/确认。保留原始结果与失败审计。
2. **阻止伪造低风险。**不仅看表面shortfall，也从拟议占用、保护用途、去重覆盖、现金保底和现金流重新核算。删除原因并同步改几项指标不能变LOW；缺少必要现金流/拟议状态也不能算完整。
3. **缺资料按依赖处理。**余额、占用、用途等核心证据未知时相关结论未知；已确认房租硬冲突遇到独立可选预算缺失时保留`HIGH/PARTIAL`，同时列待补信息。
4. **正确处理收支。**工资已计入余额不再增加；预计收入不增加当前现金；关联义务和占用不双扣；晚到账工资不能填补更早的付款缺口；费用、恰好够用和差一分钱分别验证。
5. **权限条件可执行。**强制每项动作的必需版本、条件版本适用性、允许调用者类型、资源/主体/用途/接收方/环境/时效交集。不能由双方随意填写相同版本对象放行。
6. **模型发送独立授权。**必须明确非空字段、已登记接收方和接收方版本，以及独立发送确认。双方同时不填字段不能放行，不能拼接不同授权扩大权限。
7. **历史不重算。**读取历史评级时从当时审计旁路取回；当前校验另放`current_validation`。原v1.0评级、检查和签名事件不被新规则重写。
8. **异常不启动模型。**即使结果结构`VALID`，源Risk为`ERROR`也在模型额度占用前停止。问答适配器同样停止正式回调。
9. **前端可见。**显示等级、覆盖、来源检查编号、待补资料、恢复动作和执行权限；资料修改/切换示例后标记旧结果；Core不可达时有错误提示且模型按钮禁用。
10. **原入口保持关闭。**工作台模拟执行先核会话/CSRF/任务归属，再审计拒绝，返回403，不调用原扣减函数。真实交易持续禁止。

### 3.3 三种结果不可混为一谈

| 类型 | 枚举 | 含义 |
| --- | --- | --- |
| 业务风险等级 | `LOW / NOTICE / ELEVATED / HIGH / UNKNOWN` | 解释资金安排的风险；UNKNOWN绝不是低风险 |
| Risk确定性判定 | `ALLOW / REVIEW / BLOCK / ERROR` | 本次检查结论；旧日常引擎优先级为`ERROR > BLOCK > REVIEW > ALLOW` |
| 精确动作权限 | `ALLOW / DENY / ERROR` | 只针对该动作授权，不改写历史Risk，不单独授予执行权限 |
| 资料覆盖 | `FULL / PARTIAL / UNAVAILABLE` | 适用资料的可评估范围，不代表全产品完成度 |
| 结果一致性校验 | `VALID / INVALID / UNSUPPORTED` | 该结果是否能由当前适配器解释 |

`HIGH/PARTIAL/ERROR`是允许存在的组合：已独立证实资金冲突，但另有控制故障。系统保留已知风险，同时停止流程。风险通过不代表已批准；用户确认不能覆盖硬性阻止。

## 4. 代码结构与文件地图

```text
context-for-eko.md                         本接手文档
modules/safety-risk-eval/
  daily-engine.cjs                         原确定性日常资金引擎，本轮未改
  interface-adapters/
    money.cjs                             元/整数分的精确转换
    conversation-input.cjs                问答资金资料归一化与控制字段拒绝
    conversation-risk.cjs                 确定性风险评估、程序建议及模型上下文
    conversation-review.cjs               问答编排、模型证据绑定、回调与失败保存
    conversation-store.cjs                本地持久化、审计和幂等
    conversation-server.cjs               受保护本机服务，默认127.0.0.1:8790
    core-client.cjs                       Core HTTP客户端与请求/回执验证
    risk-callback.cjs                     冻结十字段、绑定校验与四态映射
    risk-callback-sender.cjs              服务端签名、发送意图、回执与未知处理
    test/                                金额、回调、问答及Core兼容回归
  unified-rating/
    assessment.cjs                       日常结果到五档评级的旁路适配
    daily-result-validation.cjs          新增：结构、语义、金额与现金流一致性
    dependency-map.v1.1.json              新增：规则/必要字段/结果的依赖目录
    runtime-config.v1.1.json              新增：v1.1版本与关闭状态
    permission.cjs                       按22能力矩阵进行精确权限判断
    site-bridge.mjs                      原Site桥接与历史评级保留
    workbench.js / workbench.css          原页面评级与权限提示
    install-site.mjs                     以已审查v13/v14为基线的构建/接线器
    verify-site.mjs                      实际Worker入口HTTP测试
    site-fixture.mjs                     仅测试/预览的内存SQLite D1适配
    preview-site.mjs                     本机预览8789；不打包入线上Worker
    test/assessment.test.cjs              47项评级/结果验证
    test/permission.test.cjs              41项权限
    test/daily-money-regression.test.cjs  14项资金回归
    test/workbench-ui.test.cjs            10项最小DOM交互
  network-resilience/                     原网络/服务异常监测、恢复与前端提示
  joint-acceptance/                       本地HTTP组件链和联合验收预检
docs/safety-risk-eval/
  daily-policy-v1/                        原日常规则配置与依据
  unified-rating-v1/                     保留的v1.0规范，不覆盖历史版本
  unified-runtime-v1/                    上一轮运行接线证据
  unified-runtime-v1.1/
    规则与权限说明.md
    能力覆盖表.md                        逐项22能力的规则/入口/待联调状态
    验证报告.md
    evidence/program-tests.json
    evidence/worker-http.json
    evidence/component-http.json
    evidence/site-build.json
    evidence/deployment.json
```

日常规则D01—D08：资料/时效；资金用途与余额；日期现金流；多任务占用；个人预算；应急储备；流动性日期；权限、确认、幂等、审计和网关。

旧投资原型R01—R10另涵盖权限/真实交易、数据证据、资金硬约束、集中度、行业、回撤、相关性、完整计划确认、幂等及审计。本轮没有把旧组合原型视作已经接通的统一评级实现。

### 4.1 重要代码：重新校验原结果，不信缓存评级

来自`conversation-review.cjs`的关键结构（节选）：

```js
const assessment = assessImpl(input); // Internal dependency, never HTTP-selected.
const unified = deriveAssessment(assessment.risk_result);
assessment.risk_advice = {
  ...assessment.risk_advice,
  unified_assessment: unified
};
// Persist the original result and audit before continuing.
if (unified.validation_status !== "VALID") {
  reject("RISK_RESULT_INVALID", "风险结果无法验证，模型和回调暂停。", 503);
}
if (assessment.risk_result.decision === "ERROR") {
  reject("RISK_CHECK_FAILED", "必要检查失败，模型和回调暂停。", 503);
}
```

真实实现还会保存finance snapshot/hash，核对Core首次响应与已存任务、原文、provider回执、提议参数、proposal摘要及同一任务绑定；不要用上面节选替换整段编排。

### 4.2 重要代码：历史评级与当前门禁分别返回

来自`site-bridge.mjs`的核心逻辑：

```js
const current = deriveAssessment(record.review);
const saved = events.filter(row =>
  row.event_type === "UNIFIED_ASSESSMENT_RECORDED" &&
  row.task_id === record.input.binding.task_id &&
  row.unified_assessment?.source_risk_check_id === record.review.risk_check_id
).at(-1)?.unified_assessment;

return {
  ...record,
  unified_assessment: newCheck ? current : saved ?? null,
  current_validation: {
    validation_status: current.validation_status,
    validation_errors: current.validation_errors,
    risk_decision: current.risk_decision,
    source_risk_check_id: current.source_risk_check_id,
    validator_policy_version: config.risk_policy_version
  }
};
```

历史侧没有保存评级就保持null，不补造“当时已有”的v1.1记录。当前校验失败时，UI显示未知，同时仍可说明历史评级原值。

### 4.3 金额与结果重算

对外Finance有“元”，日常规则内部用**人民币整数分**。金额必须安全整数；不能用浮点四舍五入掩盖三位小数，未知不能补零。

独立资金的基本关系是：

```text
未覆盖的保护资金 = 各用途 max(预留额 - 已核实关联占用覆盖额, 0) 之和
可自由安排资金 = 账面现金 - 有效占用 - 未覆盖保护资金 - 独立现金保底
```

v1.1校验器用BigInt重算汇总关系，并核对现金流付款的义务ID、金额、释放与日期。不能把同一笔义务和已关联占用扣两次，也不能把未知关联当成已释放。

### 4.4 权限函数不是身份认证服务

```js
const { authorizeCapability } = require("./permission.cjs");
const result = authorizeCapability(trustedServerContext, exactRequest);
```

`trustedServerContext`必须由可信服务端构造，包含主体、调用服务、资源归属、授权、必要版本及条件适用性；浏览器不能传`session_verified`、`service_verified`、`grants`或`version_applicability`来自证权限。

权限检查同时执行矩阵的`definition.actors`清单。维护者即使伪装出完整动作scope和grant，也不能成为只允许Owner/受限服务读取的金融资源调用者。`version_applicability`中的条件版本由服务端明确适用/不适用，未知就停止，不能从浏览器接受。

### 4.5 冻结接口

`risk-callback.v1`严格保持以下十字段：

```js
[
  "callback_version", "handoff_id", "task_id", "request_id", "run_id",
  "audit_id", "proposal_sha256", "decision", "reviewer", "reason"
]
```

映射：`ALLOW → APPROVE`，`REVIEW → REQUEST_MORE_INFO`，`BLOCK → REJECT`。`ERROR`不能伪装成批准或成功业务回调。评级和验证错误保存在旁路对象/审计，不往冻结回调擅自加字段。

### 4.6 工作台当前接线范围

- `GET /api/safety/unified-policy`：已登记的公开规则帮助，调用新权限函数；不读私有数据、不创建模型调用。
- `POST /api/safety/daily/tasks`、`/api/safety/daily/revise`：新检查、v1.1评级和关联审计。
- `POST /api/safety/daily/model-review`、`/api/safety/confirm`：原会话、CSRF、归属检查后校验当前结果；INVALID、UNSUPPORTED或源ERROR时先审计并停止。
- `POST /api/paper-trade/execute`：当前权限门禁返回`DENY/PAPER_GATEWAY_NOT_CONNECTED`，HTTP403，先审计，不扣减。
- 原任务、审计、拒绝、撤回、网络恢复等保留原局部保护，不能据此宣称22能力都已统一接线。

## 5. 环境、依赖、配置与用过的命令

### 5.1 环境

- Windows，PowerShell，Git；默认交流简体中文，代码命名与注释用英文。
- 本轮实际Node：`v24.22.1`，可执行文件`C:\Program Files\nodejs\node.exe`。
- 内存D1测试使用`node:sqlite`；运行完整本地验证建议Node24。适配器package声明Node>=22，不要假设所有旧Node构建都有同样SQLite能力。
- `modules/safety-risk-eval/interface-adapters/package.json`依赖`ajv@8.17.1`；纯评级/权限模块没有新增运行时外部库。
- 测试使用`node:test`、assert、vm、http、crypto等内置模块；前端行为测试使用最小DOM，不当作完整浏览器测试。
- Sites线上为Cloudflare Worker ESM＋D1，保留原`.openai/hosting.json`绑定；测试用SQLite适配和预览脚本不进入线上打包。

### 5.2 当前运行配置

`modules/safety-risk-eval/unified-rating/runtime-config.v1.1.json`：

```json
{
  "runtime_version": "daily-risk-hardening.v1.1",
  "risk_policy_version": "risk-policy.v1.1",
  "permission_policy_version": "permission-policy.v1.1",
  "assessment_version": "unified-risk-assessment.v1",
  "supported_source_contract": "daily-risk-workbench.v1",
  "supported_source_policy": "daily-cashflow-policy.v1.0",
  "paper_write_enabled": false,
  "live_execution_enabled": false,
  "trusted_end_user_approval_connected": false,
  "team_shared_ledger_connected": false,
  "all_capability_routes_connected": false,
  "historical_records_rewritten": false
}
```

此为节选，以实际JSON为准。v1.0规范仍是旧动作目录与依据，不应为了新版元数据覆盖旧历史文件。

### 5.3 本地程序与HTTP验证

在当前仓库根目录执行：

```powershell
node --test modules/safety-risk-eval/unified-rating/test/*.test.cjs
node --test modules/safety-risk-eval/interface-adapters/test/*.test.cjs
node --test modules/safety-risk-eval/network-resilience/test/*.test.cjs modules/safety-risk-eval/joint-acceptance/test/*.test.cjs
node docs/safety-risk-eval/unified-rating-v1/verify-package.mjs
node modules/safety-risk-eval/joint-acceptance/run.cjs --out <尚不存在的报告路径.json>
git diff --check
```

本地组件测试需要固定Core Git对象`9e6bed133c36f7fa42fc15f4dc7a8791049b0841`，会在临时目录展开快照，并使用当前已有`chenchen/integrations/review-workflow.js`覆盖件。身份、模型、存储均为替身，不连接付费模型；输出文件使用独占创建，已有文件时换一个报告路径。

历史v13构建复现：

```powershell
node modules/safety-risk-eval/unified-rating/install-site.mjs <已审查的v13原始源码副本>
node modules/safety-risk-eval/unified-rating/verify-site.mjs <安装后源码目录> <报告.json>
node modules/safety-risk-eval/unified-rating/preview-site.mjs <安装后源码目录>
# 预览地址 http://127.0.0.1:8789/risk
```

**当前线上已是v15。上面的安装器刻意只接受已审查v13/v14基线，直接对v15运行会拒绝。**下次改站点应重新读取最新源码和版本，审查差异后调整安装路径/基线，不要回退或强行绕过哈希检查。

### 5.4 真实模型服务配置的名称

受保护的本机问答服务使用这些环境变量（这里只记录名称，不含值）：

```text
CORE_AGENT_BASE_URL
CORE_AGENT_API_KEY
RISK_SERVICE_HMAC_SECRET  （旧兼容名 RISK_HMAC_SECRET）
RISK_REVIEWER_ID
RISK_CONVERSATION_API_KEY
RISK_ALLOW_LOCAL_HTTP
RISK_CORE_TIMEOUT_MS
RISK_CONVERSATION_DAILY_LIMIT
RISK_CONVERSATION_PORT
```

默认本机问答服务8790，默认Core超时60000ms、日限额20。缺Core访问/签名/Reviewer配置时，保留程序风险建议并显式报错，不声称模型已调用或回调已成功。本轮不需要配置任何真实密钥。

### 5.5 Git同步

```powershell
git status --short
git branch --show-current
git fetch origin
git diff --check
git diff --cached --stat
git commit -m "<本轮变更说明>"
git push origin codex/unified-risk-runtime-v1
git rev-parse HEAD
git ls-remote --heads origin refs/heads/codex/unified-risk-runtime-v1
```

此机器Git HTTPS直连曾异常，可用既有本地代理：

```powershell
git -c http.proxy=http://127.0.0.1:7892 -c http.version=HTTP/1.1 fetch origin
```

代理仅为本机环境事实，不要假定接手者机器也监听7892。原生Git/GitHub REST在本机可用；GitHub插件此前访问旧私有仓库返回404，不等于仓库不存在或没有提交。

AGENTS要求：每轮修改前查工作区和远端，保留协作者修改；只提交本轮文件；测试、审查、提交、推送并核对远端SHA才算同步；不强推、不擅自合并。密钥、Token、Cookie不进文件、参数、输出或聊天。

### 5.6 Sites发布流程

本轮使用`sites:sites`技能，工具/脚本根目录：

`C:\Users\lenovo\.codex\plugins\cache\openai-curated-remote\sites\1.1.2`

1. `get_site`确认Site ID、访问范围和最新版本；`create_source_repository_write_credential`取得短期凭证。
2. 用`site-workflow.mjs --project-id <Site ID>`打开现有源码。凭证只保留会话内存，经隐藏stdin传入，不能存盘或写进命令参数。
3. 本地安装/验证后，仍用该helper提交、推送、核验、打包；保留其返回的完整source、commit_sha和archive。
4. `save_site_version`后，针对原有public访问使用`deploy_site_version`。
5. 仅在pending/building/publishing时轮询；成功原生返回即部署证据。最后回读并打开原网址。

本轮源码上传首次连接迟滞；保留本地提交后，在该临时Site checkout配置本机Git代理及HTTP/1.1，重新获取过期短期凭证，再用同一helper成功上传。没有新建站点、修改公开范围或强推。

## 6. 验证证据与实际限制

| 范围 | 本轮结果 |
| --- | --- |
| 评级/权限/资金/UI程序 | 112/112：47＋41＋14＋10 |
| 金额与问答/回调适配 | 261/261 |
| 网络提示与联合预检 | 114/114 |
| 程序合计 | **487/487** |
| 实际ESM Worker HTTP＋内存D1 | **30/30**（新增4项确认重检回归），外部请求0、模型预算写入0；v13/v14两基线复建均通过，不能把重复运行相加成60个不同用例 |
| 本地Core/Risk组件HTTP | **12/12**，模型、审批身份和存储均为替身 |
| v1.0规范包 | 888结构检查、4坏配置拒绝、3快照摘要核验；30组应用设计案例仍未执行 |
| 原工作台发布 | v15成功，public范围保持；不代表团队主聊天接线成功 |
| 真实模型、付费API、真实金融操作 | 本轮均0 |

浏览器已观察：8000元投资挤占学费时HIGH/BLOCK及6000元缺口；金额修改和示例切换均标旧结果；余额未知显示UNKNOWN及待补字段；Core不可达显示错误并禁用模型；执行关闭。

低风险方案浏览器复核曾超时；10月30日补验发现确认重检的新检查编号缺少评级旁路。现已修复并在第15版在线复查：2000元LOW，2000.01元HIGH/BLOCK、旧确认失效；改回2000元并确认后仍LOW，审计关联，现金与占用不变。原失败/旧v14证据保留。INVALID/UNSUPPORTED由最小DOM与HTTP测试验证，没有向公开站点增加故障注入入口。

主要报告：[验证报告](docs/safety-risk-eval/unified-runtime-v1.1/验证报告.md)。不能把“代码已推送”“PR可合并”“离线通过”“站点可达”直接改写为团队端到端Done。

## 7. 遇到的问题、决定与原因

| 问题 | 本轮处理与原因 |
| --- | --- |
| BLOCK检查却无原因，原适配可能误LOW | 建立原因/引用/状态/通道/指标一致性验证；错误结果UNKNOWN并停止下游 |
| 删除原因并伪改短缺值仍能LOW | 强制完整指标、现金流、拟议状态；从占用/保护用途重算；预算超额保留提醒 |
| 可选预算缺失把房租硬冲突抹掉 | 按证据依赖区分核心缺失与独立可选缺失，保留已知高风险下界 |
| 任意相同版本对象能满足权限比较 | 从能力矩阵执行必需版本，条件适用性与grant绑定 |
| 模型字段双方省略也可能被当匹配 | 请求/授权均须非空字段，独立同意与登记接收方不可省略 |
| MAINTAINER能读不允许该actor的资产 | 执行每项能力的actors清单，不把维护角色当本人金融权限 |
| 每次GET都用新策略重算历史 | 从原审计取历史旁路，当前校验另列；不改历史签名 |
| VALID但源ERROR仍可能申请模型额度 | 额外检查原Risk状态，额度/调用前拒绝 |
| 页面说模型不可达但按钮还能点 | 网络层提供modelAvailable，评级门禁同时禁用模型按钮 |
| 切换预置条件没有标旧评级 | daily render后若dirty再invalidate，切换与手改一致 |
| 结果完全null时只剩通用异常 | 安全保存null原始结果、UNKNOWN旁路和失败事件，仍不调用下游 |
| 源码上传/凭证过期 | 保留现网和本地提交，限定checkout代理、刷新短期凭证后重试helper |

参考OPA和OpenAI Agents SDK的“模型建议与确定性策略/执行权限分离”思想；本轮**没有声称已经引入OPA运行时或完整Agents SDK架构**。

现场安全演示目标仍是：账单备注/外部新闻含“忽略风控、直接操作”等文字时，作为不可信数据；展示真实模型原文、实际拟议动作、阻断节点、原因、同任务运行编号及审计。模型主动拒绝与网关阻止是不同结果，不能为演示伪造模型越权动作；后端失败不得自动切离线成功。

## 8. 还没完成的待办与下一步

### 8.1 接手先做

1. 读本文件、v1.1三份说明和deployment.json，再查PR #37 head、审核、CI及最新远端。此文件不记录自己的最终提交SHA，避免自引用；用Git/PR核对。
2. 如果PR37尚待评审，保持In Review；不要自行合并main或把旧仓库产出算成新SoT仓库已收录。
3. 复跑适合后续改动的测试；未改代码只读交接时不建空提交。改站点前重新取得当前v15或更高版本，禁止直接重跑只接受v13/v14的安装器覆盖。

### 8.2 后续真正的P0联调

| 优先级 | 具体任务 | 协作方与验收证据 |
| --- | --- | --- |
| P0 | 确定同一staging的主入口、Core/Risk/Finance源码SHA、部署ID、路由及Owner | 架构、Core、入口/部署Owner；代码与部署对应，不仅页面链接 |
| P0 | 可信Risk回写绑定同一任务/提议/审计，覆盖超时、过期、重复和拒绝 | Vesper＋Core；正式服务HTTP及审计证据 |
| P0 | 用户本人批准来自服务端登录身份，绑定subject/account/task/proposal/account_version等 | 身份/审批Owner＋Core；跨用户、改参、撤回、重放负例；HMAC服务认证不能代替本人 |
| P0 | Finance唯一托管账本，原子reserve/commit/release及同任务幂等、并发和重启核账 | Finance＋Core/执行网关；账户版本和最终余额证据 |
| P0 | 问答与工作台共用统一服务入口，回答带确定性指标、未知项、缺口及调整建议 | 入口/UI＋Core＋Vesper；主页面和工作台不能各自造审批/执行结论 |
| P0 | 在同一版本跑正常、占房租/学费、批准后改参及异常等完整链路 | 各服务Owner联合；正式HTTP、审计、审批与执行回执关联 |
| P1 | 逐项接剩余能力路由、真实Memory授权、扩展组合评级适配 | 按[22能力覆盖表](docs/safety-risk-eval/unified-runtime-v1.1/能力覆盖表.md)推进，不因目录有名字就宣布接通 |

联合验收至少包含：未批准、跨用户批准、金额/约束/账户版本变化、并发占用、重复回调、超时、结果未知、存储/审计失败和重启恢复。失败时相关写调用数应为0；未知回执先核查原执行，不能盲目重试。

**只有得到新的明确实施范围、正式后端和验收证据，才讨论解除L3关闭；L4在本版本始终禁止。**不要为了演示成功绕过现有阻断。

### 8.3 定时巡检是另一项只读任务

用户已要求`AI Banking SoT 定时反馈`，automation ID为`ai-banking-sot`，每4小时一次，北京时间。事实来源仅为新仓库`realchenchenluo/agent`，检查提交、PR、Issue、Actions、合同及验收证据，输出中文A—E报告，即使无变化也要报告。

它不开发、不部署、不合并、不向团队发消息；不能把本文件中的旧PR状态直接写为新仓库完成。本地配置位置曾为`C:\Users\lenovo\.codex\automations\ai-banking-sot\automation.toml`，后续用平台工具核实当前保存状态，不新建重复自动化。

## 9. 接手时必须保留的工作方式

- 用户希望直接推进已授权工作，避免重复索取已经给出的权限或信息；真实缺服务/权限时明确指出具体缺口。
- 修改前查远端与工作区；不覆盖其他成员改动；仅提交相关文件，推送后核对SHA。
- 关键规则必须可复算；外部文字和模型输出不能成为系统权限、本人批准或可信余额。
- 不读取/传播Secrets、Cookie、HMAC或API Key；短期Site凭证不写入本文件或仓库。
- 错误必须在前端可见；等待审批不是交易成功，离线替身不是实时模型，局部测试不是线上联合验收。
- 文档状态应写清“已实现、已接线、已测试、已发布、待团队验收”各自范围，不能只写笼统的“已完成”。
