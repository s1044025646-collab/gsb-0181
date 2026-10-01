import {
  RunResult,
  RunDiagnostics,
  ScenarioInput,
  TIME_TO_SECONDS,
  TimeUnit,
} from './types.js';
import { BuiltNetwork, ValidationError } from './network.js';
import { expmWithInput } from './math/linalg.js';

export const DEFAULT_MAX_POINTS = 100_000;

export interface SolveOptions {
  maxPoints?: number;
}

function fail(message: string, location: string): never {
  throw new ValidationError(message, location);
}

export function solve(
  built: BuiltNetwork,
  scenario: ScenarioInput,
  runId: string,
  networkId: string,
  scenarioId: string,
  options: SolveOptions = {},
): RunResult {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const { view, nuclideIndex, counters, untrackedCounters } = built;
  const n = view.nuclides.length;
  const ne = counters.length;
  const nu = untrackedCounters.length;
  const total = n + ne + nu;

  const timeUnit: TimeUnit = scenario.timeUnit ?? view.timeUnit;
  if (!(timeUnit in TIME_TO_SECONDS))
    fail(`未知时间单位 "${timeUnit}"`, 'scenario.timeUnit');
  const toSec = TIME_TO_SECONDS[timeUnit];

  if (!Array.isArray(scenario.times) || scenario.times.length === 0)
    fail('时间网格为空', 'scenario.times');
  if (scenario.times.length > maxPoints)
    fail(
      `时间网格点数 ${scenario.times.length} 超过上限 ${maxPoints}`,
      'scenario.times',
    );
  const timesSec: number[] = [];
  let prev = -1;
  scenario.times.forEach((t, idx) => {
    if (typeof t !== 'number' || !Number.isFinite(t))
      fail(`时间点必须为有限数值，收到 ${String(t)}`, `scenario.times[${idx}]`);
    if (t < 0) fail(`不允许负时间，收到 ${t}`, `scenario.times[${idx}]`);
    if (t < prev) fail('时间网格必须单调不减', `scenario.times[${idx}]`);
    prev = t;
    timesSec.push(t * toSec);
  });

  const initial = new Float64Array(total);
  for (const [key, value] of Object.entries(scenario.initialAtoms ?? {})) {
    const idx = nuclideIndex.get(key);
    if (idx === undefined)
      fail(`初始原子数引用了未知核素 "${key}"`, `scenario.initialAtoms.${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      fail(
        `初始原子数必须为非负有限数值，收到 ${String(value)}`,
        `scenario.initialAtoms.${key}`,
      );
    initial[idx] = value;
  }

  const tEnd = timesSec[timesSec.length - 1]!;
  interface Seg {
    start: number;
    end: number;
    rate: Float64Array; // 原子/秒
  }
  const segs: Seg[] = [];
  const injections = scenario.injections ?? [];
  for (let si = 0; si < injections.length; si++) {
    const inp = injections[si]!;
    const loc = `scenario.injections[${si}]`;
    if (typeof inp.start !== 'number' || typeof inp.end !== 'number')
      fail('注入段起止时间必须为数值', loc);
    if (inp.start < 0 || inp.end < 0)
      fail('注入段不允许负时间', loc);
    if (!(inp.end >= inp.start))
      fail('注入段 end 必须不小于 start', loc);
    if (inp.start > tEnd) continue;
    const rate = new Float64Array(n);
    for (const [key, value] of Object.entries(inp.rates ?? {})) {
      const idx = nuclideIndex.get(key);
      if (idx === undefined)
        fail(`注入率引用了未知核素 "${key}"`, `${loc}.rates.${key}`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        fail(
          `注入率必须为非负有限数值，收到 ${String(value)}`,
          `${loc}.rates.${key}`,
        );
      rate[idx] = value / toSec;
    }
    segs.push({
      start: inp.start * toSec,
      end: Math.min(inp.end * toSec, tEnd),
      rate,
    });
  }
  // 检测注入段重叠。
  const sortedSegs = [...segs].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedSegs.length; i++) {
    if (sortedSegs[i]!.start < sortedSegs[i - 1]!.end)
      fail(
        `注入段时间区间重叠: [${sortedSegs[i - 1]!.start / toSec}, ${
          sortedSegs[i - 1]!.end / toSec
        }) 与 [${sortedSegs[i]!.start / toSec}, ${sortedSegs[i]!.end / toSec})`,
        'scenario.injections',
      );
  }

  // 组装增广演化矩阵 M（时间单位：秒）。计数器行只累加不衰减。
  const m = new Float64Array(total * total);
  const M = (i: number, j: number, v: number) => {
    m[i * total + j] = v;
  };
  for (let i = 0; i < n; i++) {
    const nuc = view.nuclides[i]!;
    M(i, i, -nuc.lambda);
  }
  for (const e of counters) {
    const pi = nuclideIndex.get(e.parent)!;
    const ci = nuclideIndex.get(e.child)!;
    const v = e.ratio * view.nuclides[pi]!.lambda;
    M(ci, pi, (m[ci * total + pi] ?? 0) + v);
  }
  let row = n;
  for (let k = 0; k < ne; k++, row++) {
    const e = counters[k]!;
    const pi = nuclideIndex.get(e.parent)!;
    M(row, pi, e.ratio * view.nuclides[pi]!.lambda);
  }
  for (let k = 0; k < nu; k++, row++) {
    const u = untrackedCounters[k]!;
    const pi = nuclideIndex.get(u.parent)!;
    M(row, pi, u.ratio * view.nuclides[pi]!.lambda);
  }

  // 合并断点：输出网格点 + 注入段边界。每个子区间注入率恒定，
  // 因而单次增广矩阵指数给出严格的精确分段解，累计衰变不依赖采样点间距。
  const breakSet = new Set<number>([0, tEnd]);
  for (const t of timesSec) breakSet.add(t);
  for (const s of segs) {
    breakSet.add(Math.min(s.start, tEnd));
    breakSet.add(s.end);
  }
  const breaks = [...breakSet].sort((a, b) => a - b);

  const rateAt = (t: number): Float64Array => {
    // 取区间中点查询，边界归属不影响积分。
    for (const s of segs) if (t >= s.start && t < s.end) return s.rate;
    return new Float64Array(n);
  };

  const points = timesSec.length;
  const atoms: number[][] = view.nuclides.map(() => new Array(points).fill(0));
  const activity: number[][] = view.nuclides.map(() => new Array(points).fill(0));
  const edgeDecays: Record<string, number[]> = {};
  for (const e of view.edges)
    edgeDecays[`${e.parent}->${e.child}`] = new Array(points).fill(0);
  const untrackedDecays: Record<string, number[]> = {};
  for (const u of untrackedCounters)
    untrackedDecays[u.parent] = new Array(points).fill(0);

  let state = new Float64Array(initial);
  let injectedTotal = 0;
  let maxResidual = 0;
  let maxSquarings = 0;
  let segmentCount = 0;
  const initialSum = sumAtoms(initial, n);
  let conservationError = 0;
  let minNegative = 0;

  const sampleIndex = new Map<number, number[]>();
  timesSec.forEach((t, i) => {
    if (!sampleIndex.has(t)) sampleIndex.set(t, []);
    sampleIndex.get(t)!.push(i);
  });

  const record = (t: number, z: Float64Array) => {
    for (const idxs of sampleIndex.get(t) ?? []) {
      let atomSum = 0;
      for (let i = 0; i < n; i++) {
        const a = z[i]!;
        atoms[i]![idxs] = a;
        activity[i]![idxs] = view.nuclides[i]!.lambda * a;
        atomSum += a;
        if (a < minNegative) minNegative = a;
      }
      let untracked = 0;
      for (let k = 0; k < nu; k++) untracked += z[n + ne + k]!;
      // 严格账本：现存原子 + 未跟踪流失 - 累计注入 = 初始总数。
      // 已跟踪衰变仍以子体原子留在系统内，edgeDecays 仅作输出不重复入账。
      const residualLedger = atomSum + untracked - injectedTotal - initialSum;
      const scale = Math.max(1, initialSum + injectedTotal);
      const rel = Math.abs(residualLedger) / scale;
      if (rel > conservationError) conservationError = rel;
      let ek = 0;
      for (const e of view.edges) {
        edgeDecays[`${e.parent}->${e.child}`]![idxs] = z[n + ek]!;
        ek++;
      }
      let uk = 0;
      for (const u of untrackedCounters) {
        untrackedDecays[u.parent]![idxs] = z[n + ne + uk]!;
        uk++;
      }
    }
  };

  record(0, state);
  for (let bi = 0; bi < breaks.length - 1; bi++) {
    const a = breaks[bi]!;
    const b = breaks[bi + 1]!;
    const h = b - a;
    if (h <= 0) continue;
    segmentCount++;
    const mid = (a + b) / 2;
    const rate = rateAt(mid);
    const v = new Float64Array(total);
    for (let i = 0; i < n; i++) v[i] = rate[i]!;
    const { e, w, diag } = expmWithInput(m, v, total, h);
    if (diag.commutatorResidual > maxResidual) maxResidual = diag.commutatorResidual;
    if (diag.squarings > maxSquarings) maxSquarings = diag.squarings;
    const next = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      let acc = w[i]!;
      for (let j = 0; j < total; j++) acc += e[i * total + j]! * state[j]!;
      next[i] = acc;
    }
    let rateSum = 0;
    for (let i = 0; i < n; i++) rateSum += rate[i]!;
    injectedTotal += rateSum * h;
    state = next;
    record(b, state);
  }

  let untrackedLoss = 0;
  for (let k = 0; k < nu; k++)
    untrackedLoss += state[n + ne + k]!;

  const warnings: string[] = [];
  if (conservationError > 1e-9)
    warnings.push(`守恒账本相对偏差 ${conservationError.toExponential(3)} 超过 1e-9`);
  if (minNegative < -1e-9 * Math.max(1, initialSum + injectedTotal))
    warnings.push(`出现显著负原子数，最小值 ${minNegative.toExponential(6)}，未裁零`);
  else if (minNegative < 0)
    warnings.push(
      `存在机器精度量级负原子数（最小 ${minNegative.toExponential(3)}），保留原值未裁零`,
    );
  if (Object.keys(view.untrackedFraction).length > 0)
    warnings.push(
      `存在未跟踪分支，累计流失 ${untrackedLoss.toExponential(6)} 原子（账目内流失，非守恒误差）`,
    );
  if (maxResidual > 1e-9)
    warnings.push(`矩阵指数对易残差偏大: ${maxResidual.toExponential(3)}`);

  const diagnostics: RunDiagnostics = {
    method:
      '分段常数注入 + 增广状态矩阵指数（缩放-平方法，13 阶 Pade 逼近），步内严格解析；累计衰变作为增广状态分量积分',
    padeOrder: 13,
    maxSquarings,
    maxCommutatorResidual: maxResidual,
    minNegativeAtoms: minNegative,
    conservationError,
    untrackedLoss,
    injectedTotal,
    warnings,
    segmentCount,
    pointCount: points,
  };

  return {
    runId,
    networkId,
    networkVersion: view.version,
    scenarioId,
    timeUnit,
    nuclideIds: view.nuclides.map((x) => x.id),
    times: timesSec,
    atoms,
    activity,
    edgeDecays,
    untrackedDecays,
    diagnostics,
  };
}

function sumAtoms(z: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += z[i]!;
  return s;
}
