# REST 接口

所有路径前缀 `/api/days/:date`，`:date` 为业务日期（如 `2026-10-05`）。请求/响应均为 JSON。

## 1. 提交当日初始数据并求解（v1）

`POST /api/days/:date/initialize`

```json
{
  "workers": [{ "id": "w0", "idleCost": 0 }],
  "tasks": [{ "id": "t0", "delayCost": 10 }],
  "costs": [[3]],
  "idleCosts": [0],
  "delayCosts": [10]
}
```

- `costs` 为 `workers.length × tasks.length` 矩阵，元素为有限数或 `null`（禁止组合）。
- `idleCosts` / `delayCosts` 可写在顶层数组，也可写在每条 worker/task 上，顶层优先。
- 已初始化的日期返回 `409 DAY_EXISTS`。

响应（关键字段）：

```json
{
  "version": 1,
  "parentVersion": 0,
  "baseVersion": 0,
  "result": {
    "matches": [{ "workerId": "w0", "taskId": "t0", "cost": 3 }],
    "idleWorkers": [],
    "delayedTasks": [],
    "unassignableWorkers": [],
    "impossibleTasks": [],
    "totalCost": 3,
    "optimalCost": 3,
    "reassignedWorkers": [],
    "retainedPairs": 0,
    "certificate": {
      "workerPotentials": [0],
      "taskPotentials": [-20],
      "coveragePotential": 23,
      "coverage": 1
    },
    "solveMode": "scratch"
  },
  "diff": null,
  "change": null
}
```

## 2. 提交变动（生成新版本）

`POST /api/days/:date/changes`

```json
{ "baseVersion": 1, "change": { "type": "set-cost", "workerId": "w0", "taskId": "t0", "cost": 12 } }
```

变动类型：

| type | 额外字段 | 含义 |
| --- | --- | --- |
| `worker-unavailable` | `workerId` | 请假（从求解集合移除，其任务重新安排） |
| `worker-available` | `workerId` | 销假 |
| `add-worker` | `workerId`, `idleCost?` | 新增质检员 |
| `remove-worker` | `workerId` | 移除质检员 |
| `add-task` | `taskId`, `delayCost?`, `costs?` | 加急单；`costs=[{workerId,cost|null}]` 给初始允许边 |
| `remove-task` | `taskId` | 客户取消 |
| `set-cost` | `workerId`, `taskId`, `cost` | 改写代价；`cost: null` 改为禁止组合 |

响应为新版本对象，`diff` 为与父版本的差异，`result.solveMode` 通常为 `incremental`。

## 3. 结束当天

`POST /api/days/:date/close`，body：`{ "baseVersion": 2 }`。结束后再提交变动返回 `400 DAY_CLOSED`。

## 4. 查询当前方案

`GET /api/days/:date/current` → `{ found: true, version, parentVersion, result, diff, change }`；
日期不存在时 `{ found: false }`。

## 5. 历史版本

- `GET /api/days/:date/versions` → `{ date, versions: [{version, parentVersion, change, createdAt}] }`
- `GET /api/days/:date/versions/:v` → 该版本完整内容（同结构，`found:false` 表示不存在）

## 6. 比较任意两版差异

`GET /api/days/:date/diff?a=1&b=3`

```json
{
  "versionA": 1,
  "versionB": 3,
  "reassigned": [{ "workerId": "w0", "fromTaskId": "t1", "toTaskId": "t0" }],
  "workersRemoved": ["w1"],
  "workersAdded": [],
  "tasksUnassignedInB": [],
  "tasksNewlyAssignedInB": [],
  "reassignedCount": 1
}
```

## 7. 校验最优性证书

`POST /api/days/:date/verify/:v`

```json
{
  "version": 1,
  "valid": true,
  "violations": [],
  "dualObjective": 5,
  "primalObjective": 5,
  "coverage": 3,
  "checks": { "dualFeasibleEdges": 9, "tightMatchedEdges": 3, "forbiddenUsed": 0, "oneToOne": true }
}
```

`valid:false` 时 `violations` 逐条列出被违反的约束（对偶可行、紧约束、强对偶、禁止组合等）。

## 并发与错误

- 变动必须带正确的 `baseVersion`；过期提交返回 `409`：

```json
{ "error": { "code": "STALE_VERSION", "message": "...",
  "fields": { "date": "2026-10-05", "baseVersion": 1, "currentVersion": 3 } } }
```

  调用方应重新 `GET current`，在最新版本上重放变动后再提交。

- `400` 错误统一形如：

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...",
  "fields": { "field": "costs[0][1]" } } }
```

  错误码：`VALIDATION_ERROR`（非有限代价、维度不符）、`REFERENCE_NOT_FOUND`（人/任务不存在）、
  `DUPLICATE_WORKER` / `DUPLICATE_TASK`、`DAY_CLOSED`。
- 查询不存在的日期/版本返回 `404 NOT_FOUND`。
