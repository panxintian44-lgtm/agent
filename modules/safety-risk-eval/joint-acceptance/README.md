# 同任务风险与审批联合验收

本轮是**实际本机 HTTP 的组件联调**：Core Worker Handler、日常 Risk 规则、官方回调契约与 HMAC 都使用项目代码；模型、审批用户和 Core 存储为显式测试替身。不会调用付费模型、部署网站或执行真实资金操作。

## 运行

仓库根目录，Node.js 22+、Git、tar：

```powershell
git fetch origin
npm --prefix modules/safety-risk-eval/interface-adapters ci --ignore-scripts
npm --prefix modules/safety-risk-eval/interface-adapters run test:joint
npm --prefix modules/safety-risk-eval/interface-adapters run test:joint-preflight
```

保存新报告：

```powershell
$jointReportPath = Join-Path $env:TEMP ('risk-joint-' + [guid]::NewGuid().ToString('N') + '.json')
node modules/safety-risk-eval/joint-acceptance/run.cjs --out $jointReportPath
```

输出文件必须不存在；已有报告不会被覆盖。缺少固定 Core Git 对象时停止，不能静默换用另一份 Core。

## 范围

- `core-snapshot.cjs` 导出固定 PR28 提交，仅覆盖本轮候选 `review-workflow.js`，分别记录源码哈希；临时目录只在自身创建范围内清理。
- `run.cjs` 覆盖正常确认、房租／学费冲突、审批后资金版本变化，以及拒绝、重复、串单、错误签名、未知回执和存储失败。
- 模拟案例显式声明 `SIMULATION_ONLY`，使用官方回调草稿及签名直接发 HTTP；只读与回执未知两例复用完整 PR27 Reviewer／Sender。
- 原问答入口保持 `REVIEW_ONLY`。不放宽原发送器，不提供生产凭据输入，不连接真实账户。
- 正常回执仅为 Core 内部 `SIMULATED`、`side_effects:false`，不能当作 PAPER 账户交易成交。
- 本地通过时仍保留 `joint_acceptance:false`、`production_connected:false`、`real_model_calls:0`。

## 只读线上预检

```powershell
node modules/safety-risk-eval/joint-acceptance/preflight.cjs
```

只 GET 固定的 Core／Risk 健康地址及原网页状态，无会话、无认证凭据、无模型请求；拒绝重定向和无界响应。仍存在联合验收阻碍时返回退出码 2。网络需要代理时使用本机配置，不将代理认证或业务密钥写入仓库。

详细运行结果、责任交接与当前线上阻碍见 [联合验收与网页接线](../../../docs/safety-risk-eval/联合验收与网页接线-v1.0.md)。
