import type { DecayNetwork, Scenario } from "../types.js";

const now = "2026-01-01T00:00:00.000Z";

/**
 * 固定示例网络（6 个核素）：
 *   A --1.0--> B --0.6--> D --1.0--> E(稳定)
 *                  \--0.3--> C --1.0--> E
 *   A 的剩余 0.0（演示分支和<1 用 F 示例）；
 *   F(长半衰期) --0.8--> B，0.2 未跟踪。
 * 这样覆盖：至少 6 核素、分支后汇合（B/C -> D/E；F->B）、稳定终点、未跟踪分支。
 */
export function exampleNetwork(): DecayNetwork {
  return {
    versionId: "net-example-v1",
    timeUnit: "s",
    createdAt: now,
    nuclides: [
      { id: "A", name: "示例核素A", halfLife: 10 },
      { id: "B", name: "示例核素B", halfLife: 20 },
      { id: "C", name: "示例核素C", halfLife: 40 },
      { id: "D", name: "示例核素D", halfLife: 15 },
      { id: "E", name: "稳定终点E", halfLife: null },
      { id: "F", name: "注入源F", halfLife: 80 },
    ],
    edges: [
      { parent: "A", child: "B", branchFraction: 1.0 },
      { parent: "B", child: "C", branchFraction: 0.3 },
      { parent: "B", child: "D", branchFraction: 0.6 },
      { parent: "C", child: "E", branchFraction: 1.0 },
      { parent: "D", child: "E", branchFraction: 1.0 },
      { parent: "F", child: "B", branchFraction: 0.8 },
    ],
  };
}

export function exampleScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    scenarioId: "scn-example-1",
    networkVersionId: "net-example-v1",
    label: "固定示例工况：A 初始 1000，F 分两段注入",
    initialAtoms: { A: 1000, B: 0, C: 0, D: 0, E: 0, F: 0 },
    injections: [
      { nuclide: "F", tStart: 0, tEnd: 30, rate: 5 },
      { nuclide: "F", tStart: 60, tEnd: 120, rate: 2 },
      { nuclide: "E", tStart: 0, tEnd: 50, rate: 1 },
    ],
    tStart: 0,
    tEnd: 200,
    nPoints: 201,
    createdAt: now,
    ...overrides,
  };
}

/** 相同半衰期母子链：用于退化分支数值检验 */
export function equalHalfLifeNetwork(): DecayNetwork {
  return {
    versionId: "net-equal-v1",
    timeUnit: "s",
    createdAt: now,
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
}

export function equalHalfLifeScenario(): Scenario {
  return {
    scenarioId: "scn-equal-1",
    networkVersionId: "net-equal-v1",
    label: "相同半衰期退化情形",
    initialAtoms: { P: 100, Q: 0, R: 0 },
    injections: [],
    tStart: 0,
    tEnd: 100,
    nPoints: 11,
    createdAt: now,
  };
}
