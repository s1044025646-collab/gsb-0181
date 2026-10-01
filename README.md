# 放射性衰变链活度与累积衰变计算后端

面向教学与计算校核的**纯后端**服务：管理核素、半衰期、分支衰变关系、初始原子数与分段恒定
外部注入率，在指定时间网格上计算各核素的**原子数**、**活度（Bq）**与**时间区间累计衰变次数**。

技术栈：TypeScript + Node.js（仅内置模块，HTTP 使用 `node:http`）+ SQLite（Node ≥22.5 内置
`node:sqlite`，**无需编译原生模块、无需 Docker/WSL、无外部在线 API**）。

> 本项目不包含真实核素数据库，也不做医学剂量换算。半衰期与分支比例由使用者自行提供并负责。

## 适用范围与重要假设

- 衰变网络必须是**有向无环图（DAG）**：禁止自环、禁止循环；稳定核素显式以 `stable: true`
  （或缺省半衰期）表示，不能作为衰变父核。
- 每个父核的分支比例之和允许 **小于 1**，差额记为**未跟踪分支**（在检查与结果中明确报告），
  超过 1 直接报错。
- 内部统一使用**秒**与 **s⁻¹**：网络半衰期按其 `timeUnit` 换算为秒（年取 365.25 天），
  工况时间网格与注入率按工况 `timeUnit` 换算。返回的 `times` 始终为秒。
- 原子数、初始数量、注入率均要求**非负有限数值**；负时间、非单调网格、注入段重叠都会被拒绝。
- 只计算“子体原子即时生成”的 Bateman 型线性演化，不含反馈、不含化学迁移、不含不确定度传播。

## 数值方法、精度与诊断

演化方程为线性分段定常系统

```
ḟ N = M N + v(t)
```

其中 `M_ii = -λ_i`，`M_ij = b_{j→i} λ_j`（支持多父汇合，入边贡献相加）；`v(t)` 在每个注入
区间内为常数。每个“输出网格点 ∪ 注入段边界”形成的子区间内，采用**增广状态矩阵指数的严格
分段解析解**：

```
| M  h·v |
| 0   1   |  的矩阵指数给出  N₁ = E N₀ + w，  E = exp(Mh)， w = ∫₀ʰ exp(Ms) v ds
```

矩阵指数用 **缩放–平方法 + 13 阶对角 Padé 逼近**（系数按
`c_{k+1}/c_k = (m-k)/((2m-k)(k+1))` 运行时递推生成，部分选主元 LU 解线性方程组）。

- **刻意避免**经典 Bateman 闭式解中 `1/(λ_i - λ_j)` 的相减相除——因此**完全相等的半衰期**
  也不会出现数值爆炸。
- **累计衰变与状态演化严格一致**：每条分支边、每个未跟踪分支都作为增广状态的一个“只增不减”
  积分分量，按 `b·λ_parent·N_parent` 在**整个子区间内精确积分**，不是对输出采样点做矩形/梯形
  粗加。采样点再密也不改变累计衰变的精度。

每次计算返回 `diagnostics`：

| 字段 | 含义 |
| --- | --- |
| `method` | 使用的数值方法说明 |
| `padeOrder` / `maxSquarings` | Padé 阶数（13）与实际缩放次数 |
| `maxCommutatorResidual` | `‖EM−ME‖` 相对量，矩阵指数内部一致性诊断，通常 ≲ 1e-15 |
| `conservationError` | 守恒账本相对偏差（见下） |
| `untrackedLoss` | 未跟踪分支造成的累计原子流失（物理账目，**不是数值误差**） |
| `injectedTotal` | 全时段累计注入原子数 |
| `minNegativeAtoms` | 最小原子数；出现负值时告警，**绝不静默裁零** |
| `warnings` | 非物理解/未跟踪分支/精度告警列表 |

守恒账本（每个输出点检查）：

```
现存原子总数 + 未跟踪累计流失 − 累计注入 = 初始原子总数
```

已跟踪衰变产生的子体仍留在系统内，因此不重复计入流失；`edgeDecays` 沿链会对同一原子多次
计数，只用于回答“某条边发生了多少次衰变”，不用于守恒校验。

## 快速开始（Windows PowerShell）

要求 Node.js ≥ 22.5（开发机实测 v25.5.0）。

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行 12 个固定校验测试
npm run demo      # 端到端演示：导入→计算→改工况→比较→导出，打印解析误差
npm start         # 启动 HTTP 服务（默认 http://localhost:8080）
```

配置（环境变量）：

- `PORT` 或 `DECAY_PORT`：HTTP 端口，默认 `8080`。
- `DECAY_DATA_DIR`：项目内数据目录，默认 `./data`；SQLite 文件为 `<目录>/decay.sqlite`。

```powershell
$env:PORT="9000"; $env:DECAY_DATA_DIR="$PWD\data"; npm start
```

## 不可变版本与可复现性

- 网络按**规范化 JSON 的 SHA-256** 去重；同名网络改任意参数（如半衰期）会生成 `version 2、3…`
  的**新记录**，旧版本与旧结果永不被覆盖。
- 工况、计算结果同样内容寻址；相同输入重复提交返回**同一个 runId**，两次运行输出可直接 diff。
- 结果快照保存了完整数值、网络版本、工况 id 与诊断，重启服务后可按原参数查询、复现、导出。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与数据库路径 |
| POST | `/api/networks` | 导入网络（幂等，返回 id/version） |
| GET | `/api/networks/:id` | 网络检查：拓扑序、λ、未跟踪比例 |
| GET | `/api/networks` | 列出网络 |
| POST | `/api/scenarios` | 保存工况（body 需含 `networkId`） |
| GET | `/api/scenarios?networkId=` | 列出工况 |
| POST | `/api/runs` | `{scenarioId}` 提交，或直接内联完整工况 |
| GET | `/api/runs` / `/api/runs/:id` | 列出/获取完整计算快照 |
| GET | `/api/runs/:id/curves/:nuclide` | 按核素查询原子数/活度曲线 |
| POST | `/api/compare` | `{runIds:[...]}` 工况比较 |
| GET | `/api/runs/:id/export?format=json\|csv` | 导出；`&kind=edges` 导出累计衰变 CSV；`&nuclide=` 过滤 |

采样点数硬上限默认 **100000**（可在代码 `DEFAULT_MAX_POINTS` 调整），超限返回带定位的 400。
校验错误返回 HTTP 400 与定位信息，例如：

```json
{ "error": "[edge:P->Q.branchingRatio] 分支比例必须在 (0,1] 内，收到 1.4",
  "location": "edge:P->Q.branchingRatio" }
```

### curl / PowerShell 调用示例

```powershell
$net = Invoke-RestMethod http://localhost:8080/api/networks -Method Post `
  -ContentType 'application/json' -InFile examples/branch-network.json
$sc = Get-Content examples/base-scenario.json -Raw | ConvertFrom-Json
$sc | Add-Member -NotePropertyName networkId -NotePropertyValue $net.id
$run = Invoke-RestMethod http://localhost:8080/api/runs -Method Post `
  -ContentType 'application/json' -Body ($sc | ConvertTo-Json -Depth 6)
Invoke-RestMethod "http://localhost:8080/api/runs/$($run.runId)/curves/A"
Invoke-RestMethod -Method Post http://localhost:8080/api/compare `
  -ContentType 'application/json' -Body (@{runIds=@($run.runId)} | ConvertTo-Json)
```

## CLI

数据目录同样由 `DECAY_DATA_DIR` 控制。参数可直接给 JSON 字符串，或用 `@文件路径`。

```powershell
node dist/src/cli.js import '@examples/branch-network.json'
node dist/src/cli.js list networks
node dist/src/cli.js inspect branch-demo-87d18044

# 工况文件内需含 "networkId"；这里演示先取 id 再写入
$id = (node dist/src/cli.js import '@examples/branch-network.json' | ConvertFrom-Json).id
$sc = (Get-Content examples/base-scenario.json -Raw | ConvertFrom-Json)
$sc | Add-Member -NotePropertyName networkId -NotePropertyValue $id
$sc | ConvertTo-Json -Depth 6 | Set-Content examples/base-scenario.linked.json
node dist/src/cli.js submit '@examples/base-scenario.linked.json'

node dist/src/cli.js run <runId>
node dist/src/cli.js curve <runId> A
node dist/src/cli.js compare <runIdA> <runIdB>
node dist/src/cli.js export <runId> csv  curve.csv
node dist/src/cli.js export <runId> csv-edges edges.csv
```

## 固定示例与验证内容

示例定义见 `examples/fixtures.ts`：

1. **单核素解析解** `X(t10)→Y(稳定)`：与 `N₀e^(−λt)`、`λN`、`N₀(1−e^(−λt))` 对比。
2. **母子链 + 完全相同半衰期** `P→Q→R`（半衰期均为 12）：与 `N_Q = N₀λt e^(−λt)`、
   `N_R = N₀(1−(1+λt)e^(−λt))` 对比，覆盖相等衰变常数这一最易数值爆炸的情形。
3. **六核素分支汇合网络**：`A` 分支到 `B/C`，`B、C` 汇合到 `D`，另有 `C→E`，`D/E→S(稳定)`；
   `A` 有 10%、`B` 有 50% 未跟踪分支；注入跨 `[0,20)` 与 `[20,40)` 两段，并向稳定核 `S`
   注入，检验线性累积且活度恒为 0。
4. **边界**：零时刻、极长时间（10¹² s 衰减殆尽、稳定终点收齐）、极小步长（1e-12 s 首阶线性）。
5. **错误路径**：负时间、负数量、自环、循环、分支和超限，均断言错误信息含核素/边定位。
6. **重启复现**：关闭并重新打开同一 SQLite 文件后，旧 runId 仍返回 version 1 的旧数值。

实测（本机）：单核与等半衰期链最大绝对误差约 `1e-13 ~ 1e-14`，守恒账本相对偏差约 `1e-15`。

## 项目结构

```
src/
  types.ts        领域类型与时间单位换算
  network.ts      网络校验：DAG 拓扑、自环/循环、分支比例、单位、定位错误
  math/linalg.ts  稠密矩阵、LU、缩放–平方 13 阶 Padé 矩阵指数、增广积分
  solver.ts       分段求解、时间网格、注入合并、累计衰变、守恒与诊断
  store.ts        SQLite 持久化（不可变版本 + 内容哈希）
  service.ts      提交计算、曲线、比较
  export.ts       JSON / CSV（稳定数字格式）
  server.ts       HTTP API
  cli.ts          命令行
examples/         固定示例、演示脚本、可直接导入的 JSON
test/             node:test 校验测试
data/             运行时生成（SQLite + WAL）
```

## 限制

- 稠密矩阵实现，核素规模适合教学（数十到数百量级）；超大规模需稀疏化。
- Padé 缩放次数上限 60；极端 `λ·h`（远超教学范围）可能告警。
- 输出时间统一为秒；CSV 时间列为 `t_seconds`，活度为 Bq。
