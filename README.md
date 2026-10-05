# 当日派工服务 (dispatch-service)

面向第三方检测机构的当日派工后端：早上把质检员指派到现场检验任务（带禁止组合的矩形指派，自研求解器，产出可自证最优的对偶证书），白天的人员请假 / 加急单 / 任务取消 / 代价改写都按版本重排，重排在总代价与改派人数之间做显式取舍，并利用上一版的解与对偶值做增量修复。

技术栈：Node.js 20 · TypeScript · NestJS · MongoDB 7 · Jest。无页面，纯 REST。

## 运行

```bash
docker compose up --build        # api: http://localhost:3000, mongo: 27017
```

本地开发：

```bash
npm install
npm test                         # 全部测试（含内存 MongoDB 的集成测试）
npm run build && npm start       # 需要 MONGODB_URI（默认 mongodb://localhost:27017）
```

环境变量：`MONGODB_URI`（默认 `mongodb://localhost:27017`）、`MONGODB_DB`（默认 `dispatch`）、`PORT`（默认 `3000`）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/dispatch/days` | 提交当日初始数据并求解，生成版本 1 |
| POST | `/dispatch/days/:date/changes` | 提交一个变动，生成下一版本 |
| GET | `/dispatch/days/:date/current` | 当前方案（最新版本） |
| GET | `/dispatch/days/:date/versions` | 版本历史（摘要） |
| GET | `/dispatch/days/:date/versions/:n` | 某版本详情（含对偶证书） |
| GET | `/dispatch/days/:date/diff?from=a&to=b` | 两个版本之间谁被改派 |
| POST | `/dispatch/days/:date/versions/:n/verify` | 校验某版本的最优性证书 |
| POST | `/dispatch/days/:date/close` | 结束当日（之后变动被拒绝） |

### 提交当日数据

```json
POST /dispatch/days
{
  "date": "2026-10-05",
  "workers": [{ "id": "w1" }, { "id": "w2" }, { "id": "w3" }],
  "tasks": [
    { "id": "t1", "delayCost": 50 },
    { "id": "t2", "delayCost": 50 },
    { "id": "t3", "delayCost": 50 }
  ],
  "costMatrix": [[4, 1, 3], [2, 0, 5], [3, 2, 2]],
  "forbidden": [{ "workerId": "w3", "taskId": "t1" }],
  "reassignmentPenalty": 10
}
```

- `costMatrix[i][j]` 必须是非空有限数；禁止组合用 `forbidden` 单独标出（引用必须存在）。
- `delayCost`：任务排不上（顺延）的代价，每个任务各自独立。
- `reassignmentPenalty`（可选，默认 10）：重排时"每改派一人"的代价 ρ，见 `docs/DESIGN.md`。

响应为版本 1：分配方案、延误任务、空闲人员、无法安排的人/任务、总代价，以及对偶证书（`certificate.alpha/beta/effectiveCosts`）。

### 提交变动

```json
POST /dispatch/days/2026-10-05/changes
{ "baseVersion": 1, "change": { "type": "cost_override", "workerId": "w3", "taskId": "t3", "cost": 40 } }
```

变动类型：

- `worker_unavailable`：`{ "workerId": "w2" }`
- `task_added`：`{ "task": { "id": "t4", "delayCost": 30 }, "costs": [{ "workerId": "w1", "cost": 3 }, ...] }`（必须给齐当前所有工人；`cost: null` 表示禁止）
- `task_cancelled`：`{ "taskId": "t1" }`
- `cost_override`：`{ "workerId": "w3", "taskId": "t3", "cost": 40 }`（`cost: null` 表示改为禁止）

并发规则（已选定）：**`baseVersion` 必填，且必须等于提交时的当前版本；否则拒绝并返回 409 与 `currentVersion`，不做自动重放。** 并发提交由 `(date, version)` 唯一索引串行化，同一 base 上只有一个胜出。

### 校验证书

`POST /dispatch/days/:date/versions/:n/verify` 逐条核对：所有允许组合满足对偶可行（`beta[j] - alpha[i] <= cost[i][j]`）、被选中组合满足紧约束（等号）、空闲工人 `alpha = 0`、延误任务 `beta = delayCost`、对偶目标值等于总代价，以及"惩罚目标 = 真实代价 + ρ×改派人数"。调用方可用版本详情里的 `certificate` 独立重算这些等式/不等式。

### 错误

400 带字段名：`{ "statusCode": 400, "message": "validation failed", "errors": [{ "field": "costMatrix[1][2]", "message": "..." }] }`。
覆盖：代价非有限数（`costMatrix[i][j]`、`tasks[k].delayCost`、`change.cost`）、矩阵维度不符（`costMatrix`、`costMatrix[i]`）、引用不存在的人或任务（`change.workerId` 等）、对已结束日期提交变动（`date`）。
409：版本过期（`currentVersion` 字段）或当日已存在。404：日期或版本不存在。

## 设计文档

见 [docs/DESIGN.md](docs/DESIGN.md)：求解器与对偶证书、重排规则及其可验证性质与偏离分析、增量修复的正确性论证、版本与并发模型、不变量及对应测试。
