import type {
  AccuracyDiagnostics,
  CalculationSnapshot,
  ConservationReport,
  DecayNetwork,
  NuclideCurve,
  Scenario,
  UntrackedInfo,
  Warning,
} from "../types.js";
import { validateNetwork, validateScenario } from "./validate.js";
import { integrateAdaptive, type OdeSystem } from "./solver.js";

export interface EngineTuning {
  rtol?: number;
  atol?: number;
}

const NEG_WARN_THRESHOLD = -1e-9;

/**
 * 运行一次完整计算。状态向量布局：
 *   [0, n)        各核素原子数 N_i
 *   [n, 2n)       各核素累计衰变 C_i
 *   [2n, 2n + m)  每个“存在未跟踪分支的父核素”的累计流失 U
 */
export function runCalculation(
  network: DecayNetwork,
  scenario: Scenario,
  calculationId: string,
  nowIso: string,
  tuning: EngineTuning = {},
): CalculationSnapshot {
  validateNetwork(network);
  validateScenario(scenario, network);

  const rtol = tuning.rtol ?? 1e-10;
  const atol = tuning.atol ?? 1e-15;

  const nuclides = network.nuclides;
  const n = nuclides.length;
  const index = new Map(nuclides.map((x, i) => [x.id, i]));
  const lambda = nuclides.map((x) => (x.halfLife === null ? 0 : Math.LN2 / x.halfLife));

  // 出边：parents[j] = 向 j 供料的父核素下标；branchFraction 对应
  const incoming: { from: number; frac: number }[][] = Array.from({ length: n }, () => []);
  const outFracSum = new Array(n).fill(0);
  for (const edge of network.edges) {
    const p = index.get(edge.parent)!;
    const c = index.get(edge.child)!;
    incoming[c].push({ from: p, frac: edge.branchFraction });
    outFracSum[p] += edge.branchFraction;
  }

  const untrackedFrac = outFracSum.map((s, i) =>
    lambda[i] === 0 ? 0 : Number(Math.max(0, 1 - s).toFixed(12)),
  );
  const untrackedParents = nuclides
    .map((x, i) => i)
    .filter((i) => untrackedFrac[i] > 1e-12);
  const m = untrackedParents.length;
  const uIndex = new Map<number, number>();
  untrackedParents.forEach((pi, k) => uIndex.set(pi, k));

  // 注入分段：按断点排序
  const inj = scenario.injections
    .filter((s) => s.tEnd > scenario.tStart && s.tStart < scenario.tEnd)
    .map((s) => ({
      i: index.get(s.nuclide)!,
      a: Math.max(s.tStart, scenario.tStart),
      b: Math.min(s.tEnd, scenario.tEnd),
      rate: s.rate,
    }));

  const sourceAt = (i: number, t: number): number => {
    let rate = 0;
    for (const seg of inj) {
      if (seg.i === i && t >= seg.a && t < seg.b) rate += seg.rate;
    }
    return rate;
  };

  const totalDim = 2 * n + m;
  const sys: OdeSystem = {
    n: totalDim,
    f(t, y, out) {
      for (let i = 0; i < n; i++) {
        let dy = -lambda[i] * y[i] + sourceAt(i, t);
        for (const inc of incoming[i]) {
          dy += inc.frac * lambda[inc.from] * y[inc.from];
        }
        out[i] = dy;
        out[n + i] = lambda[i] * y[i];
      }
      for (let k = 0; k < m; k++) {
        const pi = untrackedParents[k];
        out[2 * n + k] = untrackedFrac[pi] * lambda[pi] * y[pi];
      }
    },
  };

  // 初始状态
  const y = new Float64Array(totalDim);
  let totalInput = 0;
  for (const nuc of nuclides) {
    y[index.get(nuc.id)!] = scenario.initialAtoms[nuc.id] ?? 0;
    totalInput += scenario.initialAtoms[nuc.id] ?? 0;
  }
  for (const seg of scenario.injections) {
    const lo = Math.max(seg.tStart, scenario.tStart);
    const hi = Math.min(seg.tEnd, scenario.tEnd);
    if (hi > lo) totalInput += seg.rate * (hi - lo);
  }

  // 时间网格
  const grid: number[] = [];
  const { tStart, tEnd, nPoints } = scenario;
  if (nPoints === 1) {
    grid.push(tStart);
  } else {
    for (let k = 0; k < nPoints; k++) {
      grid.push(tStart + ((tEnd - tStart) * k) / (nPoints - 1));
    }
  }

  // 注入断点
  const breakpoints = Array.from(
    new Set(inj.flatMap((s) => [s.a, s.b]).filter((x) => x > tStart && x < tEnd)),
  ).sort((a, b) => a - b);

  const warnings: Warning[] = [];
  const accumNeg = new Array(n).fill(0);
  let minMass = Infinity;
  let maxMass = 0;

  const record: number[][] = Array.from({ length: n }, () => []);
  const recordDecay: number[][] = Array.from({ length: n }, () => []);

  const snapshotMass = (yy: Float64Array): number => {
    let mass = 0;
    for (let i = 0; i < n; i++) mass += Math.max(0, yy[i]);
    return mass;
  };

  const recordAt = (yy: Float64Array) => {
    let mass = 0;
    for (let i = 0; i < n; i++) {
      if (yy[i] < NEG_WARN_THRESHOLD) accumNeg[i] = Math.min(accumNeg[i], yy[i]);
      if (yy[i] < 0) yy[i] = 0; // 仅在输出层记录后处理，绝不把裁零当作校验通过
      record[i].push(yy[i]);
      recordDecay[i].push(yy[n + i]);
      mass += yy[i];
    }
    minMass = Math.min(minMass, mass);
    maxMass = Math.max(maxMass, mass);
  };

  recordAt(y);

  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let errorAccum = 0;
  let tiny = false;

  for (let k = 1; k < grid.length; k++) {
    const res = integrateAdaptive(sys, grid[k - 1], grid[k], y, breakpoints, {
      rtol,
      atol,
    });
    acceptedSteps += res.acceptedSteps;
    rejectedSteps += res.rejectedSteps;
    errorAccum += res.errorAccum * res.errorAccum * res.acceptedSteps;
    tiny = tiny || res.tinyStepEncountered;
    recordAt(y);
  }

  for (let i = 0; i < n; i++) {
    if (accumNeg[i] < 0) {
      warnings.push({
        code: "NEGATIVE_CLIPPED",
        nuclideId: nuclides[i].id,
        message: `核素 ${nuclides[i].id} 数值积分中出现负原子数（最小值 ${accumNeg[i].toExponential(3)}），仅输出层归零，不视为物理校验通过`,
      });
    }
  }
  if (tiny) {
    warnings.push({
      code: "TINY_STEP",
      message: "积分器为满足容差采用了极小步长，体系可能刚性，结果可用但建议检查时间尺度",
    });
  }

  const untracked: UntrackedInfo[] = untrackedParents.map((pi) => ({
    parent: nuclides[pi].id,
    untrackedFraction: untrackedFrac[pi],
  }));
  if (untracked.length) {
    warnings.push({
      code: "UNTRACKED_BRANCH",
      message: `存在 ${untracked.length} 个未跟踪分支（分支比例总和 < 1），相应原子计入流失`,
    });
  }

  let untrackedLoss = 0;
  for (let k = 0; k < m; k++) untrackedLoss += y[2 * n + k];

  const atomsEnd = record.map((r) => r[r.length - 1]);
  const totalAtomsEnd = atomsEnd.reduce((a, b) => a + b, 0);
  // 守恒：输入 = 现存 + 未跟踪流失（已跟踪衰变的原子仍在网络内，现存或继续衰变，故不重复扣减）
  const residual = totalInput - totalAtomsEnd - untrackedLoss;
  const relativeResidual = Math.abs(residual) / Math.max(1, totalInput);

  if (relativeResidual > 1e-6) {
    warnings.push({
      code: "MASS_RESIDUAL",
      message: `原子数守恒相对残差 ${relativeResidual.toExponential(3)} 偏大（阈值 1e-6）`,
    });
  }

  const trackedDecaysTotal = nuclides.reduce((sum, x, i) => sum + (y[n + i] as number), 0);

  const conservation: ConservationReport = {
    totalInput,
    totalAtomsEnd,
    trackedDecays: trackedDecaysTotal,
    untrackedLoss,
    residual,
    relativeResidual,
  };

  const diagnostics: AccuracyDiagnostics = {
    method:
      "自适应 Cash-Karp RK4(5) 直接积分线性衰变 ODE；累计衰变与流失作为附加 ODE 状态同步积分",
    solver: "Cash-Karp RK45 embedded pair, PI-free step control",
    rtol,
    atol,
    internalSteps: acceptedSteps,
    rejectedSteps,
    minMass: Number.isFinite(minMass) ? minMass : 0,
    maxMass,
    errorEstimate: Math.sqrt(errorAccum / Math.max(1, acceptedSteps)),
  };

  const curves: NuclideCurve[] = nuclides.map((nuc, i) => ({
    nuclideId: nuc.id,
    points: grid.map((t, k) => ({
      t,
      atoms: record[i][k],
      activity: lambda[i] * record[i][k],
    })),
    cumulativeDecays: recordDecay[i],
  }));

  return {
    calculationId,
    networkVersionId: network.versionId,
    scenarioId: scenario.scenarioId,
    status: warnings.some((w) => w.code === "NEGATIVE_CLIPPED" || w.code === "MASS_RESIDUAL")
      ? "warning"
      : "ok",
    method: diagnostics.method,
    createdAt: nowIso,
    curves,
    untracked,
    diagnostics,
    conservation,
    warnings,
    inputs: { network, scenario },
  };
}
