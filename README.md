# 当日派工调度服务

第三方检测机构的**当日现场检验派工**后端：把质检员一对一派到现场检验任务，带资质
禁止组合、任务顺延代价、人员闲置代价；重点支持白天的请假/加急/取消/改价等变动下的
**稳定重排**。服务返回的每份方案都附带可独立验证的最优性对偶证书。

- 技术栈：Node.js 20 + TypeScript + NestJS + MongoDB 7（Mongoose），无任何优化库。
- 接口：纯 REST，无页面。

## 目录结构

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 求解器 | `src/solver/mcmf.ts` | 自实现最小费用流（字典序三元组权、SPFA 最短路增广、负环消去） |
| 指派模型 | `src/solver/assignment.ts` | 矩形指派补零、覆盖奖励、热启动、结果提取 |
| 对偶证书 | `src/solver/certificate.ts` | 独立证书校验器（逐条核对可行/紧约束/强对偶） |
| 领域模型 | `src/domain/state.ts` | 当日状态、变动类型、变动应用、序列化 |
| 输入校验 | `src/domain/validation.ts` | 有限数、矩阵维度、引用、重复 id |
| 重排策略 | `src/solver/` + [docs/REASSIGNMENT_POLICY.md](docs/REASSIGNMENT_POLICY.md) | 字典序“先最优、再最少改派、再规范序” |
| 版本差异 | `src/versions/diff.ts` | 任意两版谁被改派 |
| 持久化 | `src/persistence/` | Mongoose：days（当前状态）、versions（不可变历史） |
| 调度核心 | `src/scheduler/scheduler.service.ts` | 按日串行锁、乐观版本号、增量/从头双解核对 |
| 接口层 | `src/api/dispatch.controller.ts`、`errors.filter.ts` | REST、统一错误格式 |

## 快速开始

```bash
docker compose up --build
# 服务监听 http://localhost:3000，MongoDB 在 mongo:27017
```

本地开发（自行提供 Mongo 7）：

```bash
npm install
MONGO_URL=mongodb://127.0.0.1:27017/dispatch npm run start:dev
```

测试：

```bash
npm test                 # 全部 Jest 测试（含性质证明、穷举核对、E2E）
```

E2E 测试使用 `mongodb-memory-server`，首次运行自动下载 MongoDB 7.0.21；
aarch64 主机会自动改用 ubuntu2204 构建。

## 问题模型

- m 个质检员、t 个任务；代价矩阵 `cost[i][j]`：有限数 = 允许组合，`null` = 资质不符
  的禁止组合（永远不可能被派到）。
- 每个人至多一个任务、每个任务至多一个人。`idleCost[i]`（人员闲置代价，缺省 0）、
  `delayCost[j]`（任务顺延代价，缺省 0）。
- **业务规则：尽可能派满。** 求解器按字典序优化：
  1. **配对数最大**（能派的人一定派出，任务多于人时多余任务顺延）；
  2. 在最大配对数下**业务总代价最小**；
  3. 在 1、2 相同的方案里**相对上一版改派人数最少**（见重排策略文档）；
  4. 仍并列时取唯一的**规范序方案**（BigInt 超递增序键，保证同输入必同输出）。

实现上把矩形问题补零为 `(m+t)×(m+t)` 方阵（虚拟行承接顺延、虚拟列承接闲置），
真人-真任务边权取 `c_ij − M`（M 大于全部业务费用绝对值之和，使覆盖在字典序上
绝对优先），用自实现的最小费用流（SPFA 最短路增广 + 负环消去）求字典序最优完美
匹配。补零结构保证每条增广路恰好经过一条“行→列”边，残量轮换天然是合法交错轮换。
禁止组合不连边；全禁止的人/任务只能落到虚拟边，被 `unassignableWorkers` /
`impossibleTasks` 如实报告。

### 必须成立的性质（均有自动化测试）

- 给某一行（含该行闲置代价）或某一列（含该列延误代价）整体加常数，最优分配不变；
- 转置问题（人↔任务、闲置↔延误）最优总代价与真人配对集合相同；
- 最优总代价不大于任何同口径贪心分配；
- 禁止组合绝不出现；
- 所有组合都被禁止的人/任务如实报告；
- 同一份输入（含同一参照版）每次返回完全相同的解。

## 最优性证书

每个版本的方案都带 `certificate: { workerPotentials, taskPotentials, coveragePotential, coverage }`。
求解器先在补零方阵上得到最优完美匹配的行势 `u_r`、列势 `v_c`（由匹配边等号连通
分量 + 跨分量 Bellman-Ford 平移构造，所有方阵边满足 `u_r + v_c ≤ W_rc`、匹配边
取等），再线性映射为固定配对数 k 的矩形松弛指派外部对偶 `(p_i, q_j, λ=M)`，满足：

- 对偶可行：每个允许组合 `p_i + q_j + λ ≤ c_ij`；
- `p_i ≤ idleCost_i`、`q_j ≤ delayCost_j`；
- 选中边/闲置者/顺延任务全部取等号（紧约束）；
- 强对偶：`Σp_i + Σq_j + k·λ = 总代价`。

调用方可以不依赖本服务、只凭问题数据 + 方案 + 证书逐条验证
（`POST /api/days/:date/verify/:v`，校验逻辑在 `src/solver/certificate.ts`）。
全部成立即证明该方案在该配对数下全局最优，而配对数本身取到了可行最大值。

## 版本管理与并发

- 早上 `POST /initialize` 生成 **v1**；之后每一次变动生成一个**不可变新版本**，
  记录触发变动、问题快照、方案、证书、与父版本的差异。
- `GET /versions`、`GET /versions/:v`、`GET /diff?a=&b=` 可查任意历史与差异。
- 变动必须带 `baseVersion`（提交时看到的版本）。同一天的提交在服务内**串行执行**，
  版本号严格递增；**基于过期版本的提交一律拒绝**：`409 STALE_VERSION`，
  响应中给出 `currentVersion`，调用方读取最新版后重放自己的变动再提交。
- 每份新版本落库后才更新当前状态；服务重启后从 MongoDB 完整恢复当天状态、全部版本与
  当前方案（有 E2E 验证）。
- `POST /close` 结束当天，之后的变动返回 `400 DAY_CLOSED`。

## 变动类型

`worker-unavailable`（请假）、`worker-available`（销假）、`add-worker`、`remove-worker`、
`add-task`（加急单，可同时给各人员对该任务的代价）、`remove-task`（客户取消）、
`set-cost`（调度员改写某组合代价；`cost: null` 即把组合改为禁止）、`close-day`。

## 错误格式

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "fields": { "field": "costs[0][1]" } } }
```

涵盖：代价为非有限数、矩阵维度与人员/任务列表不符、引用不存在的人或任务、
对已结束日期提交变动、重复 id、乐观版本冲突。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MONGO_URL` | `mongodb://127.0.0.1:27017/dispatch` | MongoDB 连接串 |
| `PORT` | `3000` | HTTP 端口 |
| `DISPATCH_CROSSCHECK` | `0` | 置 `1` 开启每次变动的“增量 vs 从头”运行时双解核对（默认由测试保证） |
