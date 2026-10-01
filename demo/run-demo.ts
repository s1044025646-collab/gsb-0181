import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import {
  compare,
  comparisonToCvc,
  curvesToCsv,
  deterministicCalculationId,
  inspectNetwork,
  submitCalculation,
} from "../src/core/service.js";
import { exampleNetwork, exampleScenario } from "../src/core/examples.js";
import { singleNuclide } from "../src/core/analytic.js";
import { runCalculation } from "../src/core/engine.js";

const dataDir = join(process.cwd(), "data", "demo");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

function line(title: string): void {
  console.log("\n=== " + title + " ===");
}

async function main(): Promise<void> {
  const dbPath = join(dataDir, "demo.sqlite");
  const store = await Store.open(dbPath);

  line("1. 导入网络（6 核素 / 分支汇合 / 稳定终点 / 未跟踪分支）");
  const network = exampleNetwork();
  store.saveNetwork(network);
  console.log(JSON.stringify(inspectNetwork(network), null, 2));

  line("2. 导入工况并计算");
  const scenario = exampleScenario();
  store.saveScenario(scenario);
  const snap1 = submitCalculation(store, network.versionId, scenario.scenarioId);
  console.log("calculationId:", snap1.calculationId);
  console.log("status:", snap1.status);
  console.log("内部接受步数:", snap1.diagnostics.internalSteps, "拒绝步数:", snap1.diagnostics.rejectedSteps);
  console.log("相对守恒残差:", snap1.conservation.relativeResidual.toExponential(3));
  console.log("未跟踪流失原子:", snap1.conservation.untrackedLoss.toFixed(4));

  line("3. 关键数值：t=20 时各核素原子数与活度");
  for (const c of snap1.curves) {
    const p = c.points[20];
    console.log(
      `  ${c.nuclideId}: N=${p.atoms.toExponential(6)}  A=${p.activity.toExponential(6)}  cumDecays=${c.cumulativeDecays[20].toExponential(6)}`,
    );
  }

  line("4. 解析校核：对 A 使用 N0 e^-λt 对照（该区间 A 无注入）");
  const curveA = snap1.curves.find((c) => c.nuclideId === "A")!;
  let maxErr = 0;
  for (const p of curveA.points) {
    maxErr = Math.max(maxErr, Math.abs(p.atoms - singleNuclide(1000, 10, p.t)));
  }
  console.log("  A 全网格最大绝对误差:", maxErr.toExponential(3));

  line("5. 修改工况（A 初始 5000，新工况 id），产生新结果");
  const scenario2 = exampleScenario({
    scenarioId: "scn-example-2x",
    label: "初始量放大 5 倍",
    initialAtoms: { A: 5000, B: 0, C: 0, D: 0, E: 0, F: 0 },
  });
  store.saveScenario(scenario2);
  const snap2 = submitCalculation(store, network.versionId, scenario2.scenarioId);
  console.log("旧 calculationId:", snap1.calculationId);
  console.log("新 calculationId:", snap2.calculationId, "(不同 -> 旧结果保持不变)");

  line("6. 比较两个工况在核素 E（稳定终点）上的差异");
  const cmp = compare(snap1, snap2, "E");
  console.log("  最大绝对差:", cmp.maxAbsDeltaAtoms.toFixed(6), " 最大相对差:", cmp.maxRelDeltaAtoms.toExponential(3));
  console.log("  t=200 终点 E: 工况1 =", cmp.rows.at(-1)!.atomsA.toFixed(4), " 工况2 =", cmp.rows.at(-1)!.atomsB.toFixed(4));

  line("7. 导出 JSON / CSV");
  const jsonPath = join(dataDir, snap1.calculationId + ".json");
  const csvPath = join(dataDir, snap1.calculationId + ".csv");
  const cmpPath = join(dataDir, "compare-E.csv");
  writeFileSync(jsonPath, JSON.stringify(snap1, null, 2));
  writeFileSync(csvPath, curvesToCsv(snap1));
  writeFileSync(cmpPath, comparisonToCvc(cmp));
  console.log("  写出:", jsonPath);
  console.log("  写出:", csvPath);
  console.log("  写出:", cmpPath);

  line("8. 重启复现：重新打开数据库并按旧 id 查询");
  store.close();
  const store2 = await Store.open(dbPath);
  const reopened = store2.getCalculation(snap1.calculationId)!;
  const rerun = submitCalculation(store2, network.versionId, scenario.scenarioId);
  console.log("  重启后同输入计算 id 一致:", rerun.calculationId === snap1.calculationId);
  console.log("  旧快照初始条件仍为 A=1000:", reopened.inputs.scenario.initialAtoms.A === 1000);
  store2.close();

  line("9. 相同输入稳定性（确定性 id）");
  console.log(
    "  id 一致:",
    deterministicCalculationId(network, scenario, 1e-10, 1e-15) === snap1.calculationId,
  );

  line("10. 相同半衰期退化示例（验证无数值爆炸）");
  const eqNet = {
    versionId: "demo-eq",
    timeUnit: "s",
    createdAt: "2026-01-01T00:00:00.000Z",
    nuclides: [
      { id: "P", halfLife: 10 },
      { id: "Q", halfLife: 10 },
      { id: "R", halfLife: null },
    ],
    edges: [
      { parent: "P", child: "Q", branchFraction: 1 },
      { parent: "Q", child: "R", branchFraction: 1 },
    ],
  };
  const eqScn = {
    scenarioId: "demo-eq-s",
    networkVersionId: "demo-eq",
    label: "equal half life",
    initialAtoms: { P: 100 },
    injections: [],
    tStart: 0,
    tEnd: 100,
    nPoints: 11,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const eqSnap = runCalculation(eqNet as any, eqScn as any, "demo-eq-calc", new Date(0).toISOString());
  const lambda = Math.LN2 / 10;
  const qAt10 = eqSnap.curves.find((c) => c.nuclideId === "Q")!.points[1].atoms;
  const exact = 100 * lambda * 10 * Math.exp(-lambda * 10);
  console.log(`  Q(10) 数值=${qAt10.toFixed(10)} 解析=${exact.toFixed(10)} 误差=${Math.abs(qAt10 - exact).toExponential(3)}`);

  console.log("\n演示完成。数据目录:", dataDir);
}

void main();

