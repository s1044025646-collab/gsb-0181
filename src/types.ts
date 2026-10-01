// 领域类型定义。

export type TimeUnit = 's' | 'min' | 'h' | 'd' | 'a';

// 统一内部时间单位为秒的换算因子（年取 365.25 d 的儒略年）。
export const TIME_TO_SECONDS: Record<TimeUnit, number> = {
  s: 1,
  min: 60,
  h: 3600,
  d: 86400,
  a: 365.25 * 86400,
};

export interface NuclideInput {
  id: string;
  halfLife?: number | null; // 秒或 network.timeUnit 指定单位；稳定核素省略/null
  stable?: boolean;
}

export interface DecayEdgeInput {
  parent: string;
  child: string;
  branchingRatio: number; // 0 < b <= 1；同一父核各分支之和 <= 1
}

export interface NetworkInput {
  name: string;
  timeUnit?: TimeUnit;
  nuclides: NuclideInput[];
  edges: DecayEdgeInput[];
}

export interface InjectionSegment {
  start: number;
  end: number;
  rates: Record<string, number>; // 原子数/时间（与时间网格同单位）
}

export interface ScenarioInput {
  name: string;
  networkId?: string;
  initialAtoms: Record<string, number>;
  injections?: InjectionSegment[];
  times: number[]; // 输出时间网格（与工况时间单位一致），需 >=0 且单调不减
  timeUnit?: TimeUnit;
}

export interface NuclideView {
  id: string;
  stable: boolean;
  lambda: number; // s^-1，稳定核素为 0
  halfLifeSeconds: number | null;
}

export interface EdgeView {
  parent: string;
  child: string;
  branchingRatio: number;
}

export interface NetworkView {
  id: string;
  version: number;
  name: string;
  timeUnit: TimeUnit;
  nuclides: NuclideView[];
  edges: EdgeView[];
  untrackedFraction: Record<string, number>; // 父核 id -> 未跟踪分支比例
  topologicalOrder: string[];
}

export interface SeriesPoint {
  t: number;
  atoms: number;
  activity: number; // Bq（衰变/秒，按核素总衰减常数）
}

export interface RunDiagnostics {
  method: string;
  padeOrder: number;
  maxSquarings: number;
  maxCommutatorResidual: number;
  minNegativeAtoms: number; // 任何负原子数（极小负值）都会被报告，不裁零
  conservationError: number; // 与严格守恒账本的相对偏差
  untrackedLoss: number; // 未跟踪分支造成的原子流失（账目内，非数值误差）
  injectedTotal: number;
  warnings: string[];
  segmentCount: number;
  pointCount: number;
}

export interface RunResult {
  runId: string;
  networkId: string;
  networkVersion: number;
  scenarioId: string;
  timeUnit: TimeUnit;
  nuclideIds: string[];
  times: number[]; // 秒
  atoms: number[][]; // [nuclide][point]
  activity: number[][];
  edgeDecays: Record<string, number[]>; // "parent->child" -> [point] 累计衰变次数
  untrackedDecays: Record<string, number[]>; // 父核 -> [point] 未跟踪分支累计流失
  diagnostics: RunDiagnostics;
}
