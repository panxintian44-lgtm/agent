# PR #37 → 新仓库：迁入记录

日期：2026-10-30。用户授权：将旧仓库PR #37纳入新仓库。本次只提交工作分支及拉取请求，供团队审核，不自行合并或部署。

**后续安全修复：**本文及同目录manifest、报告保留`e17c881`迁入状态。随后`c1cc3c4`已在本地修复只读P0和显式跨上下文重试问题，最新结果为Core 301/301、Risk 499/499、组件14/14，见[独立P0记录](../p0-readonly-closure-2026-10-30/README.md)。原失败证据不改写，线上联合验收仍NO-GO。

## 来源与评审路径

| 项目 | 固定版本 |
| --- | --- |
| 来源PR | [Fintechathon-agent/Fintechathon-agent#37](https://github.com/Fintechathon-agent/Fintechathon-agent/pull/37) |
| 来源head | `43f28cbbf9a2335a965c2debe988eb2c76b1e761` |
| 来源PR base | `codex/workbench-network-resilience-v1@4b351560743fde5038eefef7cbd89413bddbe9cd` |
| 目标仓库 | [realchenchenluo/agent](https://github.com/realchenchenluo/agent) |
| 目标base | `main@d4da8afbef5a4989903f211e874a7cfdfe526554` |
| 提交分支 | `panxintian44-lgtm/agent:codex/import-risk-pr37-v1.1`，通过Fork发起目标main的PR |

目标主分支原先没有`modules/safety-risk-eval/`及`docs/safety-risk-eval/`。因此迁入PR的54个变更路径，并补齐73个原有依赖路径，共127个来源文件：

- `modules/safety-risk-eval/`：引擎、问答/金额/回调适配器、评级权限、网络错误提示、本地组件验证及测试。
- `docs/safety-risk-eval/`：策略配置、规则、接口样例、评测设计、历史证据及本轮v1.1说明。
- `context-for-eko.md`：交接上下文。

不覆盖目标仓库现有Core、Finance、UI、部署配置或根README；不迁入旧`AGENTS.md`、密钥、运行账本或`node_modules`。源文件逐一列于[manifest.json](manifest.json)，分别标记PR变更与前置依赖，记录来源/目标SHA-256。仅上下文和交接请求增加迁入语境；历史报告、截图、签名记录及来源代码保持原字节。

## 本次重新验证

使用Windows PowerShell、Node.js `v24.22.1`。适配器依赖锁定`ajv@8.17.1`，安装时关闭生命周期脚本。

```powershell
npm --prefix modules/safety-risk-eval/interface-adapters ci --ignore-scripts --no-audit --no-fund

node --test modules/safety-risk-eval/unified-rating/test/*.test.cjs modules/safety-risk-eval/interface-adapters/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.mjs modules/safety-risk-eval/joint-acceptance/test/*.test.cjs

node modules/safety-risk-eval/interface-adapters/write-examples.cjs --check
```

上述程序及测试替身回归**499/499通过**，包含原487项与显式纳入的12项`health.test.mjs`测试。回调四态与金额样例一致。原始输出见[program-tests.tap](program-tests.tap)，新的结果见[verification.json](verification.json)。499项包含对目标主分支现有Core辅助模块、工作流及契约的兼容测试，没有替换这些文件。

另外，以下两项历史验证需要旧仓库固定Git对象；只fetch PR head不能确保对象存在。这些对象仅用于本地复算，不作为新提交的父历史，不推送验证refs，也不把旧Core覆盖到目标工作区。执行者需有旧仓库读取权限：

```powershell
git fetch --no-tags https://github.com/Fintechathon-agent/Fintechathon-agent.git 96c7f5ac74a46998f5523745b640535e5ea1a504:refs/risk-validation/qiqi-96c7f5a
git fetch --no-tags https://github.com/Fintechathon-agent/Fintechathon-agent.git 9e6bed133c36f7fa42fc15f4dc7a8791049b0841:refs/risk-validation/core-9e6bed

node docs/safety-risk-eval/unified-rating-v1/verify-package.mjs
node modules/safety-risk-eval/joint-acceptance/run.cjs
```

规范包通过888项结构检查、拒绝4个坏配置，并核对3份固定数据摘要；30组应用验收案例仍为设计，运行数保持0。没有将原始数据复制进本次提交。

组件HTTP结果为**11/12通过、1项失败**，单列于[component-http.json](component-http.json)：它使用**固定旧Core Worker快照＋目标main当前工作流候选覆盖＋当前Core辅助模块和契约**。这不是目标main整份Worker验收，也不是线上同版本联合验收。

### P0：Core只读能力守卫缺失，执行接线被阻塞

`readonly_capability`失败：一个明确标记`REVIEW_ONLY`的任务在签名审批服务测试替身请求批准时返回了HTTP成功，而预期应拒绝。目标main工作流与固定旧Worker快照中的工作流字节相同；审批越级已在本地HTTP实证，模拟入口缺少能力检查来自静态核查，**未宣称取得该案例的执行回执**。

旧源修复位于[独立提交d9c261f](https://github.com/Fintechathon-agent/Fintechathon-agent/commit/d9c261fefaad61985bfe0f3cdef4a07546f8b6d4)，在Risk通过、审批与模拟入口检查显式模拟能力，并有`review-capability-guards.test.js`。这个提交不属于PR #37，本次不夹带替换目标Core，也不放宽测试让其变绿。

**给Core Owner的具体请求：**审查该修复并将等价守卫接入目标`chenchen/integrations/review-workflow.js`；只读任务在Risk通过后仍须只读，批准和模拟请求必须拒绝。补上未标记能力、只读能力、明确模拟能力的正反例，在同一目标版本复跑499项与12项组件验证。Owner和提交时间待团队确认。该项解决前不得开放执行接线或将此PR描述为完整安全链路验收通过。

## 证据边界与后续接线

- 原`unified-runtime-v1.1/evidence/`保留旧仓库及独立Site的验证记录；不能记为新仓库部署证据。本轮不操作云服务、不重新运行真实模型，不调用付费或金融操作。
- 原`install-site.mjs`、`verify-site.mjs`和`preview-site.mjs`依赖外部Sites源码，安装器只接受指定Site ID与v13/v14哈希；不能直接重装线上v15，更不能直接部署团队Cloudflare主入口。
- 旧Python桥和UI验证需要`qiqi/web`，本次未复制该Finance入口，也未运行这些历史工具。
- 下一步由团队审核迁入PR，再确认现有问答服务的服务端挂载点。Risk在回答前输出评级、原因、未知项和恢复建议；可信上下文、字段及版本映射由对应Owner对齐。
- 真实本人审批、共享账本、统一执行网关、跨用户/并发/重启/同任务staging验收仍未完成；资金写入口保持关闭。PR已提交、PR合并、离线通过分别记录，均不能替代完整业务链路验收。
