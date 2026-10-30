# Core Agent + Memory P0 交付记录

日期：2026-10-30（北京时间）  
Owner：陈全宝（林粹）  
范围：Core Agent 主链路与 Memory；不重新计算 Quant，不绕过 Risk，不接真实资金执行。

## 1. 本轮结果

本轮把 Core 侧的 Memory 保护补齐，并用现有 Risk Handoff、审批和模拟执行测试做了回归。核心要求是：

- 未得到明确同意，Memory 不写入，也不创建持久化文件。
- 每个 Memory session 绑定 owner；换 owner 读取或写入会被拒绝。
- 用户撤回后保留撤回记录，但旧内容不可读、不可继续写入，重启后仍然阻断。
- Risk Handoff、审批、模拟回执继续使用同一个 `task_id`、`proposal_sha256`、`request_id`、`run_id` 和 `audit_id`。
- Risk 超时、身份签名错误、任务或方案哈希不匹配、审批缺失时，执行保持阻断。

本轮没有调用真实模型，没有使用真实账户，没有产生真实资金动作。Risk、模型和审批验证使用仓库内的合成替身；因此“本地通过”不等于线上联合验收通过。

## 2. 修改内容

| 文件 | 修改 |
| --- | --- |
| `core/memory.js` | 增加 owner 绑定、撤回墓碑、可选 JSON 持久化和重启读取；保留显式 consent 规则 |
| `core/harness.js` | 创建 task 时绑定 `owner_id`，Memory 写入携带 task 的 owner，避免跨用户串单 |
| `tests/core-memory-p0.test.js` | 覆盖未授权不写、owner/session 隔离、撤回、重启后仍阻断、task 绑定 |
| `contracts/examples/memory-consent.request.json` | Memory 同意写入样例 |
| `contracts/examples/memory-revoke.request.json` | Memory 撤回样例 |

原有 Risk、审批、模拟执行和审计实现保留；本轮没有修改 Memory 的“只收 preference/decision、必须显式 consent、source 为 user_confirmed”原则。

## 3. 统一接口约定

### 3.1 Core → Risk

Core 发送 `owner-bridge.v1` envelope，关键字段如下：

```json
{
  "adapter_version": "owner-bridge.v1",
  "contract_version": "risk-handoff.v1",
  "operation": "RISK_HANDOFF",
  "trace": {
    "task_id": "task-001",
    "session_id": "session-001",
    "run_id": "run-001",
    "audit_id": "audit-task-001",
    "handoff_id": "handoff-001"
  },
  "handoff": {
    "task_id": "task-001",
    "plan_hash": "sha256:proposal-hash",
    "data_mode": "SYNTHETIC_REPLAY",
    "execution_mode": "PAPER",
    "execution_allowed": false,
    "workflow_status": "PENDING_RISK"
  }
}
```

正式代码中的完整字段以 `contracts/risk-handoff.v1.schema.json` 和 `integrations/risk-handoff.js` 为准。Core 端签名使用 `X-Core-Agent-Signature`；服务端 secret 通过部署平台 Secret 管理，不能写入前端、仓库或聊天。

### 3.2 Risk → Core 回调

回调必须原样带回这组绑定字段：`handoff_id`、`task_id`、`request_id`、`run_id`、`audit_id`、`proposal_sha256`。签名放在 `X-Risk-Signature`，回调 body 只允许 `risk-callback.v1` 规定的字段。

```json
{
  "callback_version": "risk-callback.v1",
  "handoff_id": "handoff-001",
  "task_id": "task-001",
  "request_id": "request-001",
  "run_id": "run-001",
  "audit_id": "audit-task-001",
  "proposal_sha256": "sha256:proposal-hash",
  "decision": "APPROVE",
  "reviewer": "risk-owner",
  "reason": "合成测试：资金用途已核对"
}
```

只有同一组绑定字段全部匹配，回调才会被记录。重复且完全相同的回调返回 `DUPLICATE`；改过任务、方案或理由的回调会被拒绝并留下审计事件。

### 3.3 状态和阻断

| 情况 | 结果 |
| --- | --- |
| Risk 未返回、超时、服务未配置 | 任务失败或不可用；`execution_allowed=false` |
| Risk 签名缺失或错误 | 回调拒绝；不进入审批和执行 |
| 任务、方案哈希、审计号不一致 | `RISK_HANDOFF_MISMATCH`；不执行 |
| Risk `REJECT` | 任务拒绝；不执行 |
| Risk `REQUEST_MORE_INFO` | 继续等待信息；不执行 |
| Risk `APPROVE` 但没有人工审批 | `PENDING_APPROVAL`；不执行 |
| 人工审批通过且方案哈希仍一致 | 只允许 PAPER 模拟；回执 `side_effects=false` |

## 4. Memory 接口约定

Core 内部调用形式：

```js
memory.save(session_id, record, { owner_id });
memory.list(session_id, { owner_id });
memory.revoke(session_id, { owner_id, reason });
```

`record.consent` 必须是 `true`。撤回使用 `revoke`，不能用“清空后重新当成新 session”绕过；撤回记录会持久化，新的 MemoryStore 读取同一文件后仍返回空内容并拒绝写入。

## 5. 验证命令和结果

实际环境：Windows PowerShell、Node.js `>=22`，测试使用合成模型、合成 Risk、合成人工审批和 PAPER 模拟。

### P0 定向验证

```powershell
cd chenchen
node --test tests/core-memory-p0.test.js tests/core-tools.test.js tests/risk-handoff.test.js tests/owner-bridge.test.js tests/owner-transport.test.js
```

结果：31 tests passed，0 failed。

覆盖内容包括：

- Memory consent、owner/session 隔离、撤回、持久化和重启读取；
- Risk 签名、任务绑定、方案哈希、审计绑定；
- Risk 超时、响应体超时、未配置服务和错误回调；
- 人工审批前阻断，模拟回执无副作用，重复请求不重复产生副作用。

### 全量回归

```powershell
cd chenchen
npm test
```

原基线为 414 tests；本轮新增 4 个 Memory P0 用例，最终回归为 418 tests，417 passed，1 skipped，0 failed。定向日志见 `logs/core-agent-p0-20261030.targeted.log`，全量日志见 `logs/core-agent-p0-20261030.full.log`。

## 6. 交付和联合验收状态

- Core 修改候选 SHA：`c7f6a19f46af95e2f3dc1b25c6d2bb5e672a5902`
- 个人仓库分支：`codex/core-memory-p0-20261030`
- PR：[realchenchenluo/agent#4](https://github.com/realchenchenluo/agent/pull/4)（Draft，未合并）
- 团队 staging：应放入 `team-staging/core-agent/core-memory-p0-20261030/`，不修改 `team-release` 或其他 Owner 目录
- 模型证据：仅合成替身；真实模型调用未执行
- 实际 Risk 服务：本轮未把本地替身写成线上真实接通
- 线上身份和签名：需要双方服务端分别配置同一份 Secret 后才能验收
- Vesper（潘心恬）联合签认：`PENDING`
- 联合验收结论：`NO-GO`，原因是尚未拿到同一候选 SHA 上的 Risk 真实回调与对方 Owner 签认

达到 GO 的前置条件是：双方部署地址已确认、Core/Risk secret 名称已配置、各自服务端日志能核对同一 `task_id` 和 `proposal_sha256`，并在同一候选 SHA 上完成一条“输入 → 工具计算 → 独立 Risk → 人工确认 → PAPER 回执 → 审计”的重复流程。

## 7. 回滚

1. 停止使用本分支或回滚到上一个已确认 SHA。
2. 不删除旧分支和旧日志；保留审查记录。
3. 如果仅回滚 Memory 代码，恢复 `core/memory.js` 和 `core/harness.js` 即可；新增测试和样例不影响运行。
4. 不清空费用账本、不关闭 Risk 闸门、不把失败状态改成成功。
