# Risk interface adapters v1

第四板块接线提案：金额转换、四态到 Core 回调草稿、虚构样例及本地兼容测试。

完整字段表与边界：[接口字段对应与回调适配-v1.0](../../../docs/safety-risk-eval/接口字段对应与回调适配-v1.0.md)。

```powershell
node --test modules/safety-risk-eval/interface-adapters/test/*.test.cjs
node modules/safety-risk-eval/interface-adapters/write-examples.cjs --check
```

- `money.cjs`：人民币元/整数分精确转换，保留未知值，旧JSON数值往返校验。
- `risk-callback.cjs`：核对 Core 交接、规则结果和关联标识；生成严格10字段草稿，ERROR输出null。
- `fixture-data.cjs / write-examples.cjs`：生成可复现的四态结构样例，全部为虚构测试替身。
- `test/core-compat.test.cjs`：直接验证当前 Core 的校验器和工作流门禁，不联网。

所有草稿始终 `dispatch_allowed=false / execution_allowed=false`。草稿函数本身没有发送或签名行为。

## 对话与正式回调接线

本轮新增独立的 `risk-callback-sender.cjs`、原问答服务端代理和资金核对交互；不会把旧草稿变成执行授权。

说明与启动步骤：[对话风控与正式回调接入-v1.0](../../../docs/safety-risk-eval/对话风控与正式回调接入-v1.0.md)。

- `conversation-risk.cjs`：复用日常D01—D08规则，生成可复算数字和建议，模型不能改写风险结论。
- `conversation-review.cjs`：关联用户确认的虚构快照、实际Core提议、风险检查和回调回执。
- `risk-callback-sender.cjs`：当前状态双次核验、HMAC签名、意图先落盘、回执验证；未知结果先核查。
- `conversation-server.cjs`：只监听本机，供原Python问答服务携带服务端凭据调用。
- `verify-python-bridge.cjs`：本地真实Python→Node HTTP与Core工作流兼容验证，模型是明确标记的替身。

全部入口只分析，不能审批或执行。线上启用需Core Owner配置可信签名和服务身份；缺配置不降级为成功。私人快照和运行日志仅保存在被忽略的 `.runtime/`。
