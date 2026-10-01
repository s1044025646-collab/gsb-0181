import { createHash } from "node:crypto";
import type {
  CalculationSnapshot,
  DecayNetwork,
  NuclideCurve,
  Scenario,
} from "../types.js";
import { runCalculation } from "./engine.js";
import { topologicalOrder, validateNetwork } from "./validate.js";
import type { Store } from "../store/db.js";

/**
 * 计算 id 由“网络版本 + 工况内容 + 求解器容差”的规范化哈希确定，
 * 保证相同输入两次运行得到相同 id 与相同结果（稳定可比较）。
 */
export function deterministicCalculationId(
  network: DecayNetwork,
  scenario: Scenario,
  rtol: number,
  atol: number,
): string {
  const canonical = JSON.stringify({
    v: network,
    s: scenario,
    tol: { rtol, atol },
  });
  return "calc-" + createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export interface NetworkInspection {
  versionId: string;
  timeUnit: string;
  nuclideCount: number;
  stableNuclides: string[];
  unstableNuclides: string[];
  topologicalOrder: string[];
  branchSums: Record<string, { sum: number; untracked: number }>;
}

export function inspectNetwork(network: DecayNetwork): NetworkInspection {
  validateNetwork(network);
  const order = topologicalOrder(network);
  const sums = new Map<string, number>();
  for (const e of network.edges) sums.set(e.parent, (sums.get(e.parent) ?? 0) + e.branchFraction);
  const branchSums: Record<string, { sum: number; untracked: number }> = {};
  for (const nuc of network.nuclides) {
    const s = sums.get(nuc.id) ?? 0;
    branchSums[nuc.id] = {
      sum: Number(s.toFixed(12)),
      untracked: nuc.halfLife === null ? 0 : Number(Math.max(0, 1 - s).toFixed(12)),
    };
  }
  return {
    versionId: network.versionId,
    timeUnit: network.timeUnit,
    nuclideCount: network.nuclides.length,
    stableNuclides: network.nuclides.filter((n) => n.halfLife === null).map((n) => n.id),
    unstableNuclides: network.nuclides.filter((n) => n.halfLife !== null).map((n) => n.id),
    topologicalOrder: order,
    branchSums,
  };
}

export function submitCalculation(
  store: Store,
  networkVersionId: string,
  scenarioId: string,
  tol: { rtol?: number; atol?: number } = {},
): CalculationSnapshot {
  const network = store.getNetwork(networkVersionId);
  if (!network) throw new Error(`网络版本不存在: ${networkVersionId}`);
  const scenario = store.getScenario(scenarioId);
  if (!scenario) throw new Error(`工况不存在: ${scenarioId}`);
  if (scenario.networkVersionId !== networkVersionId) {
    throw new Error(
      `工况 ${scenarioId} 属于网络 ${scenario.networkVersionId}，与请求的 ${networkVersionId} 不一致`,
    );
  }
  const rtol = tol.rtol ?? 1e-10;
  const atol = tol.atol ?? 1e-15;
  const id = deterministicCalculationId(network, scenario, rtol, atol);
  const existing = store.getCalculation(id);
  if (existing) return existing;
  const snap = runCalculation(network, scenario, id, new Date(0).toISOString(), { rtol, atol });
  store.saveCalculation(snap);
  return snap;
}

export function getCurve(snap: CalculationSnapshot, nuclideId: string): NuclideCurve {
  const curve = snap.curves.find((c) => c.nuclideId === nuclideId);
  if (!curve) {
    throw new Error(
      `计算 ${snap.calculationId} 中不存在核素 ${nuclideId}；可选: ${snap.curves
        .map((c) => c.nuclideId)
        .join(", ")}`,
    );
  }
  return curve;
}

export interface ComparisonRow {
  t: number;
  atomsA: number;
  atomsB: number;
  deltaAtoms: number;
  activityA: number;
  activityB: number;
  deltaActivity: number;
}

export interface ComparisonResult {
  nuclideId: string;
  calculationA: string;
  calculationB: string;
  rows: ComparisonRow[];
  maxAbsDeltaAtoms: number;
  maxRelDeltaAtoms: number;
}

export function compare(
  snapA: CalculationSnapshot,
  snapB: CalculationSnapshot,
  nuclideId: string,
): ComparisonResult {
  const a = getCurve(snapA, nuclideId);
  const b = getCurve(snapB, nuclideId);
  if (a.points.length !== b.points.length) {
    throw new Error(
      `两个计算的网格点数不同（${a.points.length} vs ${b.points.length}），无法逐点比较`,
    );
  }
  const rows: ComparisonRow[] = [];
  let maxAbs = 0;
  let maxRel = 0;
  for (let k = 0; k < a.points.length; k++) {
    if (Math.abs(a.points[k].t - b.points[k].t) > 1e-9) {
      throw new Error(`第 ${k} 个网格点时间不一致: ${a.points[k].t} vs ${b.points[k].t}`);
    }
    const da = a.points[k].atoms - b.points[k].atoms;
    const dact = a.points[k].activity - b.points[k].activity;
    maxAbs = Math.max(maxAbs, Math.abs(da));
    const scale = Math.max(Math.abs(a.points[k].atoms), Math.abs(b.points[k].atoms), 1);
    maxRel = Math.max(maxRel, Math.abs(da) / scale);
    rows.push({
      t: a.points[k].t,
      atomsA: a.points[k].atoms,
      atomsB: b.points[k].atoms,
      deltaAtoms: da,
      activityA: a.points[k].activity,
      activityB: b.points[k].activity,
      deltaActivity: dact,
    });
  }
  return {
    nuclideId,
    calculationA: snapA.calculationId,
    calculationB: snapB.calculationId,
    rows,
    maxAbsDeltaAtoms: maxAbs,
    maxRelDeltaAtoms: maxRel,
  };
}

function csvEscape(x: number | string): string {
  const s = typeof x === "number" ? formatNumber(x) : String(x);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 固定精度输出，保证两次运行字节级稳定可比较 */
export function formatNumber(x: number): string {
  if (x === 0) return "0";
  const ax = Math.abs(x);
  if (ax !== 0 && (ax < 1e-4 || ax >= 1e15)) return x.toExponential(10);
  return x.toFixed(10);
}

export function curvesToCsv(snap: CalculationSnapshot): string {
  const header = [
    "t",
    ...snap.curves.flatMap((c) => [
      `${c.nuclideId}_atoms`,
      `${c.nuclideId}_activity`,
      `${c.nuclideId}_cum_decays`,
    ]),
  ];
  const lines = [header.join(",")];
  const n = snap.curves[0]?.points.length ?? 0;
  for (let k = 0; k < n; k++) {
    const row: (number | string)[] = [snap.curves[0].points[k].t];
    for (const c of snap.curves) {
      row.push(c.points[k].atoms, c.points[k].activity, c.cumulativeDecays[k]);
    }
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

export function comparisonToCvc(cmp: ComparisonResult): string {
  const header = [
    "t",
    "atomsA",
    "atomsB",
    "deltaAtoms",
    "activityA",
    "activityB",
    "deltaActivity",
  ];
  return (
    [header.join(",")]
      .concat(cmp.rows.map((r) => [r.t, r.atomsA, r.atomsB, r.deltaAtoms, r.activityA, r.activityB, r.deltaActivity].map(csvEscape).join(",")))
      .join("\n") + "\n"
  );
}
