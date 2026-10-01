// 领域类型：衰变网络、工况、计算结果

/** 核素定义。半衰期单位由网络层的 timeUnit 统一指定，核素自身不再携带单位。 */
export interface NuclideDef {
  id: string;
  name?: string;
  /** 半衰期（以网络统一时间单位计）。null 表示稳定核素（λ=0）。 */
  halfLife: number | null;
}

/** 有向衰变边：parent 以 branchFraction 的分支比例衰变为 child。 */
export interface DecayEdge {
  parent: string;
  child: string;
  /** 分支比例，0 < branchFraction <= 1。同一父核素所有出边之和 <= 1。 */
  branchFraction: number;
}

/** 一段恒定外部注入率区间 [tStart, tEnd)。 */
export interface InjectionSegment {
  nuclide: string;
  tStart: number;
  tEnd: number;
  /** 原子/单位时间，必须 >= 0 */
  rate: number;
}

export interface DecayNetwork {
  versionId: string;
  timeUnit: string;
  nuclides: NuclideDef[];
  edges: DecayEdge[];
  createdAt: string;
}

export interface Scenario {
  scenarioId: string;
  networkVersionId: string;
  label: string;
  /** 初始原子数，键为核素 id；未列出者视为 0。 */
  initialAtoms: Record<string, number>;
  injections: InjectionSegment[];
  /** 输出时间网格 [tStart, tEnd]，等距 nPoints 个点。 */
  tStart: number;
  tEnd: number;
  nPoints: number;
  createdAt: string;
}

export interface NuclidePoint {
  t: number;
  atoms: number;
  /** 活度 A = λN（稳定核素恒为 0），单位 衰变/单位时间。 */
  activity: number;
}

/** 单个核素在整个时间网格上的曲线，以及到各网格点为止的累计衰变。 */
export interface NuclideCurve {
  nuclideId: string;
  points: NuclidePoint[];
  /** cumulativeDecays[k] = 该核素在 [t0, t[k]] 内的累计衰变次数。 */
  cumulativeDecays: number[];
}

export interface UntrackedInfo {
  parent: string;
  /** 未跟踪分支比例 = 1 - 该父核素全部出边分支比例之和。 */
  untrackedFraction: number;
}

export interface AccuracyDiagnostics {
  method: string;
  solver: string;
  /** 求解器内部相对容差 */
  rtol: number;
  /** 求解器内部绝对容差 */
  atol: number;
  /** 内部积分步数总数 */
  internalSteps: number;
  /** 被拒绝的试探步数 */
  rejectedSteps: number;
  /** 数值上出现过的最小质量标度 */
  minMass: number;
  maxMass: number;
  /** 累计积分器误差估计（误差平方和开方的归一值），供精度诊断 */
  errorEstimate: number;
}

export interface ConservationReport {
  /** 累计：初始原子 + 注入原子 */
  totalInput: number;
  /** 终态现存原子 */
  totalAtomsEnd: number;
  /** 已跟踪（落入网络内）衰变事件对应原子去向的核素现存原子 + 全部已衰变计数修正见 README */
  trackedDecays: number;
  /** 经未跟踪分支流出网络的原子总数 */
  untrackedLoss: number;
  /** 守恒残差 = 输入 - (现存 + 未跟踪流失) - Σ累计衰变(已跟踪, 仍在网络中反复衰变需按净流出计算) */
  residual: number;
  /** |residual| / max(1, totalInput) */
  relativeResidual: number;
}

export interface Warning {
  code:
    | "NEGATIVE_CLIPPED"
    | "STIFF"
    | "UNTRACKED_BRANCH"
    | "TINY_STEP"
    | "MASS_RESIDUAL"
    | "GRID_LIMIT";
  message: string;
  nuclideId?: string;
}

export interface CalculationSnapshot {
  calculationId: string;
  networkVersionId: string;
  scenarioId: string;
  status: "ok" | "warning";
  method: string;
  createdAt: string;
  curves: NuclideCurve[];
  untracked: UntrackedInfo[];
  diagnostics: AccuracyDiagnostics;
  conservation: ConservationReport;
  warnings: Warning[];
  /** 快照对应的完整输入（网络 + 工况），保证可复现 */
  inputs: { network: DecayNetwork; scenario: Scenario };
}

export const MAX_GRID_POINTS = 100001;
