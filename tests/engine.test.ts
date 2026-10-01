import { describe, it, expect } from "vitest";
import { runCalculation } from "../src/core/engine.js";
import {
  motherDaughter,
  singleNuclide,
  singleNuclideInjection,
  stableInjection,
} from "../src/core/analytic.js";
import type { DecayNetwork, Scenario } from "../src/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

function makeNetwork(): DecayNetwork {
  return {
    versionId: "t1",
    timeUnit: "s",
    createdAt: NOW,
    nuclides: [
      { id: "N1", halfLife: 10 },
      { id: "N2", halfLife: 30 },
      { id: "S", halfLife: null },
    ],
    edges: [
      { parent: "N1", child: "N2", branchFraction: 1 },
      { parent: "N2", child: "S", branchFraction: 1 },
    ],
  };
}

function makeScenario(partial: Partial<Scenario> = {}): Scenario {
  return {
    scenarioId: "s1",
    networkVersionId: "t1",
    label: "test",
    initialAtoms: { N1: 1000 },
    injections: [],
    tStart: 0,
    tEnd: 100,
    nPoints: 101,
    createdAt: NOW,
    ...partial,
  };
}

function atoms(snap: ReturnType<typeof runCalculation>, id: string, k: number): number {
  const c = snap.curves.find((x) => x.nuclideId === id)!;
  return c.points[k].atoms;
}

describe("单核素解析解", () => {
  it("N(t)=N0 e^-λt 在整个网格上吻合", () => {
    const net = makeNetwork();
    net.nuclides = [{ id: "N1", halfLife: 7 }];
    net.edges = [];
    const scn = makeScenario({ networkVersionId: "t1" });
    const snap = runCalculation(net, scn, "c1", NOW);
    for (let k = 0; k < scn.nPoints; k++) {
      const t = scn.tStart + ((scn.tEnd - scn.tStart) * k) / (scn.nPoints - 1);
      expect(atoms(snap, "N1", k)).toBeCloseTo(singleNuclide(1000, 7, t), 7);
    }
    expect(snap.conservation.relativeResidual).toBeLessThan(1e-9);
  });

  it("零时刻状态等于初始原子数", () => {
    const snap = runCalculation(makeNetwork(), makeScenario(), "c2", NOW);
    expect(atoms(snap, "N1", 0)).toBe(1000);
    expect(atoms(snap, "N2", 0)).toBe(0);
    expect(snap.curves.find((c) => c.nuclideId === "N1")!.cumulativeDecays[0]).toBe(0);
  });

  it("极长时间后放射性核素趋近 0，原子进入稳定终点", () => {
    const snap = runCalculation(
      makeNetwork(),
      makeScenario({ tEnd: 2000, nPoints: 11 }),
      "c3",
      NOW,
    );
    expect(atoms(snap, "N1", 10)).toBeLessThan(1e-20);
    expect(atoms(snap, "N2", 10)).toBeLessThan(1e-15);
    expect(atoms(snap, "S", 10)).toBeCloseTo(1000, 8);
    expect(snap.conservation.relativeResidual).toBeLessThan(1e-9);
  });
});

describe("母子链解析对照", () => {
  it("Batman 解（数值稳定版）逐点一致", () => {
    const snap = runCalculation(makeNetwork(), makeScenario(), "c4", NOW);
    const l1 = Math.LN2 / 10;
    const l2 = Math.LN2 / 30;
    for (let k = 0; k <= 100; k++) {
      const t = k;
      const [a1, a2] = motherDaughter({ n10: 1000, n20: 0, lambda1: l1, lambda2: l2 }, t);
      expect(atoms(snap, "N1", k)).toBeCloseTo(a1, 7);
      expect(atoms(snap, "N2", k)).toBeCloseTo(a2, 7);
    }
  });
});

describe("相同半衰期退化情形", () => {
  it("N2=N10 λt e^-λt，无数值爆炸，无负数量", () => {
    const net: DecayNetwork = {
      versionId: "eq",
      timeUnit: "s",
      createdAt: NOW,
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
    const scn: Scenario = {
      scenarioId: "eqs",
      networkVersionId: "eq",
      label: "eq",
      initialAtoms: { P: 100 },
      injections: [],
      tStart: 0,
      tEnd: 100,
      nPoints: 201,
      createdAt: NOW,
    };
    const snap = runCalculation(net, scn, "ceq", NOW);
    const lambda = Math.LN2 / 10;
    for (let k = 0; k < 201; k++) {
      const t = (100 * k) / 200;
      const expectQ = 100 * lambda * t * Math.exp(-lambda * t);
      expect(atoms(snap, "Q", k)).toBeCloseTo(expectQ, 7);
      expect(atoms(snap, "P", k)).toBeGreaterThanOrEqual(0);
      expect(atoms(snap, "Q", k)).toBeGreaterThanOrEqual(0);
    }
    expect(snap.warnings.filter((w) => w.code === "NEGATIVE_CLIPPED")).toHaveLength(0);
    expect(snap.conservation.relativeResidual).toBeLessThan(1e-9);
  });
});

describe("分支汇合与未跟踪分支", () => {
  it("0.6/0.3 分支、汇合到稳定终点、0.1 流失守恒正确", () => {
    const net: DecayNetwork = {
      versionId: "br",
      timeUnit: "s",
      createdAt: NOW,
      nuclides: [
        { id: "A", halfLife: 10 },
        { id: "B", halfLife: 20 },
        { id: "C", halfLife: 20 },
        { id: "S", halfLife: null },
      ],
      edges: [
        { parent: "A", child: "B", branchFraction: 0.6 },
        { parent: "A", child: "C", branchFraction: 0.3 },
        { parent: "B", child: "S", branchFraction: 1 },
        { parent: "C", child: "S", branchFraction: 1 },
      ],
    };
    const scn: Scenario = {
      scenarioId: "brs",
      networkVersionId: "br",
      label: "br",
      initialAtoms: { A: 1000 },
      injections: [],
      tStart: 0,
      tEnd: 2000,
      nPoints: 5,
      createdAt: NOW,
    };
    const snap = runCalculation(net, scn, "cbr", NOW);
    expect(snap.untracked[0]).toEqual({ parent: "A", untrackedFraction: 0.1 });
    expect(snap.conservation.untrackedLoss).toBeCloseTo(100, 7);
    expect(atoms(snap, "S", 4)).toBeCloseTo(900, 6);
    expect(snap.conservation.relativeResidual).toBeLessThan(1e-9);
  });
});

describe("注入：分段与稳定核素", () => {
  it("稳定核素恒速注入 N=N0+rt，跨多个时间段", () => {
    const net: DecayNetwork = {
      versionId: "inj",
      timeUnit: "s",
      createdAt: NOW,
      nuclides: [{ id: "S", halfLife: null }],
      edges: [],
    };
    const scn: Scenario = {
      scenarioId: "injs",
      networkVersionId: "inj",
      label: "inj",
      initialAtoms: { S: 5 },
      injections: [
        { nuclide: "S", tStart: 0, tEnd: 10, rate: 2 },
        { nuclide: "S", tStart: 20, tEnd: 30, rate: 3 },
      ],
      tStart: 0,
      tEnd: 40,
      nPoints: 41,
      createdAt: NOW,
    };
    const snap = runCalculation(net, scn, "cinj", NOW);
    expect(atoms(snap, "S", 10)).toBeCloseTo(25, 9);
    expect(atoms(snap, "S", 20)).toBeCloseTo(25, 9);
    expect(atoms(snap, "S", 30)).toBeCloseTo(55, 9);
    expect(atoms(snap, "S", 40)).toBeCloseTo(55, 9);
  });

  it("放射性核素恒速注入解析解一致", () => {
    const net: DecayNetwork = {
      versionId: "inj2",
      timeUnit: "s",
      createdAt: NOW,
      nuclides: [{ id: "X", halfLife: 5 }],
      edges: [],
    };
    const scn: Scenario = {
      scenarioId: "injs2",
      networkVersionId: "inj2",
      label: "inj2",
      initialAtoms: { X: 10 },
      injections: [{ nuclide: "X", tStart: 0, tEnd: 100, rate: 4 }],
      tStart: 0,
      tEnd: 50,
      nPoints: 51,
      createdAt: NOW,
    };
    const snap = runCalculation(net, scn, "cinj2", NOW);
    for (let k = 0; k <= 50; k++) {
      expect(atoms(snap, "X", k)).toBeCloseTo(singleNuclideInjection(10, 5, 4, k), 8);
    }
    void stableInjection;
  });
});

describe("极小时间步与网格", () => {
  it("极短区间与长期区间衔接仍守恒", () => {
    const snap = runCalculation(
      makeNetwork(),
      makeScenario({ tStart: 0, tEnd: 1e-6, nPoints: 3 }),
      "ctiny",
      NOW,
    );
    expect(atoms(snap, "N1", 0)).toBe(1000);
    expect(snap.conservation.relativeResidual).toBeLessThan(1e-8);
  });
});
