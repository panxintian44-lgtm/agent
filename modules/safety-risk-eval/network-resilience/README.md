# 工作台网络异常监测与恢复

为已有 `/risk` 的日常资金和投资攻防两种模式增加连接状态、请求时限和结果待查保护。保留原 Worker 业务处理与 Risk／审批／执行资格判断。

## 文件

| 文件 | 用途 |
| --- | --- |
| `network.js` | 同源 JSON 请求、全程时限、错误分类、未知结果通知；从不自动重试 |
| `connection.js` | 前台健康检查、状态栏、发送前标记、暂停提交和只读核查 |
| `connection.css` | 原奶油／绿色界面下的连接、警告与错误状态 |
| `feedback.js` | 当前视口内常驻中文错误提示；不自动消失、不显示服务原文、不自动重试 |
| `health.mjs` | 只读存储探测与固定 Core `/health` 探测，限时及缓存 |
| `install-site.mjs` | 对已核实 Site 基线安装薄适配层，保留原处理器 |
| `verify-site.mjs` | 使用健康测试替身验证候选 Worker；不会调用模型或发布 |
| `test/` | 106 项自动测试（包含 30 项错误提示与 3 项接线回归） |

## 运行测试

```powershell
node --test modules/safety-risk-eval/network-resilience/test/*.test.*
```

## 已有站点安装

本安装器只接受现有项目 `appgprj_6ac9a87727948191a202fedf09841f82` 的已核实版本 10 Worker 基线。先通过 Sites 源码助手取得授权源码，保留 `.openai/hosting.json` 与数据库绑定；密钥不能写进代码或 Git。

```powershell
node modules/safety-risk-eval/network-resilience/install-site.mjs <原站点源码绝对目录>
node modules/safety-risk-eval/network-resilience/verify-site.mjs <原站点源码绝对目录> <新的证据JSON绝对路径>
```

安装器校验原 Worker 哈希及后续适配入口哈希；遇到其他人修改过的未知入口停止。它不适用于任意团队 Worker，不能用于覆盖后续版本。版本变化时应重新审查接线锚点。

部署继续使用原 Site 的源码推送、打包、保存版本、发布流程，不创建新站点，不调整访问范围。生产部署由 Sites 管理；本目录不会复制生产业务数据或原大型打包代码。

## 行为边界

- 前台约 30 秒只读检查；离线事件即时提示；后台暂停，不是 24 小时监控。
- 模型请求失败显示失败；健康响应不证明推理、审批或执行成功。
- 错误提示显示原因、当前状态与恢复办法；健康检查成功不会覆盖用户操作错误，关闭提示不会清除待查锁。
- 提交前在同标签页 `sessionStorage` 保存 `IN_FLIGHT`；保存失败不发送。
- 结果不确定保留原任务与幂等编号，暂停后续提交；恢复网络不会重放请求。
- 只有匹配原幂等编号的执行终态可解除相应执行待查状态；无编号或不匹配交 Owner 核查。
- 该标记不是跨设备持久账本，服务端网关仍须独立校验幂等、版本、授权及资金。

验证及发布记录见 [网络异常监测与恢复说明](../../../docs/safety-risk-eval/网络异常监测与恢复-v1.0.md)。
