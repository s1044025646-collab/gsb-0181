# 放射性衰变链活度与累积衰变计算后端

仅用于**教学演示与计算校核**的本地后端：管理核素、半衰期、分支衰变关系、初始原子数与分段恒定注入率，在指定时间网格上计算各核素的**原子数、活度（A=λN）和累计衰变次数**。

不包含真实核素数据库，不做医学剂量换算。技术栈：TypeScript + Node.js（内置 `node:sqlite`），无 Docker / WSL / 外部在线服务依赖。

## 1. 环境与构建

- 要求 Node.js **>= 22.5**（开发与验证使用 Node 25；`node:sqlite` 需加 `--experimental-sqlite`，启动脚本已内置）。
- Windows PowerShell 下：

```powershell
npm install
npm run build       # tsc 编译到 dist/
npm test            # vitest，19 个测试
npm run demo        # 端到端演示（导入→检查→计算→改工况→比较→导出→重启复现）
npm start           # 启动 HTTP API（默认端口 8787）
```

可配置项（环境变量）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` 或 `DECAY_PORT` | `8787` | HTTP 端口 |
| `DECAY_DATA_DIR` | `./data` | 项目内数据目录（SQLite 与导出文件） |

## 2. 物理模型与约定

- 所有半衰期与时间使用**网络层统一单位** `timeUnit`（如 `"s"`）；核素不再各自携带单位，避免混用。
- 衰变常数 `λ = ln(2) / halfLife`；**稳定核素以 `halfLife: null` 显式表示**，`λ = 0`，活度恒为 0。
- 边 `parent -> child` 的 `branchFraction` 为分支比例；同一父核素出边比例之和**允许小于 1**，差额记为**未跟踪分支**（原子流出网络），在结果中逐父核素报告。
- 注入为分段常数率（原子/单位时间），区间 `[tStart, tEnd)`，允许任意多段、允许重叠。
- 禁止：负原子数 / 负注入率 / 负时间、自环、循环链（Kahn 拓扑排序检测）、分支和 > 1、超量采样点（上限 **100001** 点）。错误返回带核素 id 或 `{parent, child}` 边定位。

方程（`b_{p→i}` 为分支比例，`s_i(t)` 为分段注入率）：

```
dN_i/dt = -λ_i N_i + Σ_p b_{p→i} λ_p N_p + s_i(t)
```

## 3. 数值方法（自行实现）

- 直接积分上述线性 ODE 组，求解器为 **Cash–Karp 嵌入式 RK4(5) 自适应步长**（`src/core/solver.ts`），默认相对容差 **1e-10**、绝对容差 **1e-15**（提交计算时可通过 API/CLI 覆盖）。
- **不使用** Bateman 解析式里 `(λ_j - λ_i)` 接近相等时相减再相除的写法，因此**相同或极接近半衰期不会数值爆炸**；解析参考解 `src/core/analytic.ts` 在退化情形改用极限公式 `N2 = N10 λ t e^-λt` 校核。
- **累计衰变与状态演化严格一致**：把每个核素的累计衰变 `C_i`（`dC_i/dt = λ_i N_i`）和每个未跟踪父核素的累计流失 `U`（`dU/dt = u_i λ_i N_i`）作为**附加 ODE 状态同步积分**，由内部自适应步长保证精度——**不是**对输出采样点做粗略求和。
- 注入段起止时间作为积分断点，步长不跨越断点，保证分段源项处理正确。
- 适用范围：DAG 衰变网络（核素数量无硬性上限，受机器性能约束）、刚性不强于 RK45 在容差内可处理的程度；若内部被迫采用极小步长，结果中给出 `TINY_STEP` 警告。

## 4. 校验、诊断与非物理结果处理

每次计算返回：

- `diagnostics`：方法名、容差、内部接受/拒绝步数、质量极值、归一化误差估计；
- `conservation`：`totalInput = 初始原子 + Σ注入率×时长`，`totalAtomsEnd`、`untrackedLoss`、守恒残差与相对残差。守恒恒等式为
  `输入 = 网络内现存原子 + 未跟踪分支流失`（已跟踪衰变的原子仍在网络内，最终进入现存或后续衰变，不重复扣减）；
- `warnings`：`UNTRACKED_BRANCH`、`TINY_STEP`、`MASS_RESIDUAL`（相对残差 > 1e-6）、`NEGATIVE_CLIPPED`；
- **不把负数裁零当作通过**：积分中任何显著负数量（< -1e-9）都会产生带核素 id 的 `NEGATIVE_CLIPPED` 警告，快照 `status` 变为 `warning`；裁零仅发生在写出层。

## 5. 不可变版本与可复现性

- 网络按 `versionId` 不可变保存：同 id 改内容会被拒绝（需新版本号）；工况同理不可变。
- 计算快照保存**完整输入（网络+工况）与完整曲线**；`calculationId` 是“网络+工况+容差”规范化 JSON 的 SHA-256 前 16 位，**相同输入两次运行产生相同 id 与逐点相同结果**。改半衰期/初始条件必须走新版本或新工况，旧快照仍能按原参数复现。
- CSV 数值使用固定 10 位小数/科学计数法，保证字节级稳定、可 diff。

## 6. HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查与数据目录 |
| `POST /api/networks` | 导入（不可变）网络 |
| `GET /api/networks` / `GET /api/networks/:id` | 列表 / 详情+检查（拓扑序、稳定核素、分支和） |
| `POST /api/scenarios` | 导入工况 |
| `GET /api/scenarios?networkVersionId=` / `GET /api/scenarios/:id` | 列表 / 详情 |
| `POST /api/calculations` | 提交计算（body：`networkVersionId`,`scenarioId`,`rtol?`,`atol?`），返回诊断摘要 |
| `GET /api/calculations/:id` | 完整快照 |
| `GET /api/calculations/:id/curves/:nuclideId` | 按核素查询曲线 |
| `GET /api/calculations/:id/export?format=json|csv` | 导出 |
| `GET /api/compare?a=&b=&nuclide=&format=json|csv` | 两工况逐点比较 |

PowerShell 示例：

```powershell
Invoke-RestMethod -Method POST http://localhost:8787/api/networks -ContentType application/json -InFile examples/network.example.json
Invoke-RestMethod -Method POST http://localhost:8787/api/scenarios -ContentType application/json -InFile examples/scenario.example.json
Invoke-RestMethod -Method POST http://localhost:8787/api/calculations -ContentType application/json `
  -Body '{"networkVersionId":"net-example-v1","scenarioId":"scn-example-1"}'
```

## 7. CLI

```powershell
node --experimental-sqlite dist/cli.js help
node --experimental-sqlite dist/cli.js seed-examples
node --experimental-sqlite dist/cli.js inspect net-example-v1
node --experimental-sqlite dist/cli.js import-network examples/network.example.json
node --experimental-sqlite dist/cli.js import-scenario examples/scenario.example.json
node --experimental-sqlite dist/cli.js run net-example-v1 scn-example-1
node --experimental-sqlite dist/cli.js curve <calculationId> E
node --experimental-sqlite dist/cli.js compare <calcA> <calcB> E
node --experimental-sqlite dist/cli.js export <calculationId> result.csv
```
全局可用 `--data-dir <目录>`（放在命令末尾）。

## 8. 固定示例与自动校核

`src/core/examples.ts` 提供 6 核素网络（分支后汇合、稳定终点、未跟踪分支 F→0.2 / B→0.1、跨多注入段）与相同半衰期母子链。测试（`tests/`）覆盖：

- 单核素解析解逐点对照（含零时刻）；极长时间终点核素守恒；
- 母子链 Bateman 数值稳定版逐点对照；**相同半衰期**退化极限公式对照（误差 ~1e-10）；
- 0.6/0.3 分支汇合 + 0.1 未跟踪流失守恒；稳定核素分段注入 `N=N0+rt`；放射性核素恒速注入解析解；
- 极小时间步；错误分支比例、自环、循环链、负数量/负时间、采样点上限的错误与定位；
- **重启后**按旧 id 查询旧快照、改工况产生新结果且旧结果不变、同版本号网络不可变。

`npm run demo` 会打印关键数值与解析误差（示例运行：守恒相对残差 ~1e-15，A 核素全网格最大解析误差 ~1.6e-9）。

## 9. 限制与合理假设

- 教学/校核用途：未含真实核数据、不确定度传播、剂量学；分支与半衰期由调用方保证物理正确性。
- 确定性 ODE 求解器对中等刚性体系自适应加密；极端多尺度（如 λ 比值 > 1e12）可能步数很多并给出 `TINY_STEP` 警告，此时建议改用刚性求解器（本项目范围外）。
- 时间网格为等距网格（端点固定），采样点上限 100001；内部积分步长独立于输出网格。
- SQLite 为单文件本地库，未做并发写入压测；面向单机教学使用。
