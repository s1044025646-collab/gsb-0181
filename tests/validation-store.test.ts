import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runCalculation } from "../src/core/engine.js";
import { ValidationError } from "../src/core/validate.js";
import { Store } from "../src/store/db.js";
import {
  deterministicCalculationId,
  submitCalculation,
} from "../src/core/service.js";
import { exampleNetwork, exampleScenario } from "../src/core/examples.js";

const NOW = "2026-01-01T00:00:00.000Z";
const TMP = join(process.cwd(), "data", "test-tmp");

describe("校验错误定位", () => {
  const base = () => JSON.parse(JSON.stringify(exampleNetwork())) as ReturnType<typeof exampleNetwork>;

  it("自环报错且带边定位", () => {
    const net = base();
    net.edges.push({ parent: "A", child: "A", branchFraction: 1 });
    expect(() => runCalculation(net, exampleScenario(), "x", NOW)).toThrow(/自环/);
    try {
      runCalculation(net, exampleScenario(), "x", NOW);
      throw new Error("should fail");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).locator?.edge).toEqual({ parent: "A", child: "A" });
    }
  });

  it("循环链报错", () => {
    const net = base();
    net.edges.push({ parent: "E", child: "A", branchFraction: 0.1 });
    expect(() => runCalculation(net, exampleScenario(), "x", NOW)).toThrow(/循环/);
  });

  it("分支和 > 1 报父核素", () => {
    const net = base();
    net.edges.push({ parent: "A", child: "C", branchFraction: 0.5 });
    expect(() => runCalculation(net, exampleScenario(), "x", NOW)).toThrow(/超过 1/);
  });

  it("负初始数量、负时间报错", () => {
    const scn = exampleScenario({ initialAtoms: { A: -1 } });
    expect(() => runCalculation(exampleNetwork(), scn, "x", NOW)).toThrow(/非负/);
    expect(() =>
      runCalculation(exampleNetwork(), exampleScenario({ tStart: -1 }), "x", NOW),
    ).toThrow(/非负/);
  });

  it("稳定核素带半衰期字段异常路径：半衰期为 0 报错", () => {
    const net = base();
    net.nuclides[0].halfLife = 0 as unknown as number;
    expect(() => runCalculation(net, exampleScenario(), "x", NOW)).toThrow(/半衰期/);
  });

  it("采样点超过上限被拒绝", () => {
    expect(() =>
      runCalculation(exampleNetwork(), exampleScenario({ nPoints: 999999 }), "x", NOW),
    ).toThrow(/上限/);
  });
});

describe("持久化与复现", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("服务重启后旧快照仍可按原参数查询，且结果稳定", async () => {
    const dbPath = join(TMP, "a.sqlite");
    let store = await Store.open(dbPath);
    store.saveNetwork(exampleNetwork());
    store.saveScenario(exampleScenario());
    const snap1 = submitCalculation(store, exampleNetwork().versionId, exampleScenario().scenarioId);
    const id1 = snap1.calculationId;
    store.close();

    store = await Store.open(dbPath);
    const snapAgain = store.getCalculation(id1)!;
    expect(snapAgain.inputs.network).toEqual(exampleNetwork());
    expect(snapAgain.curves).toEqual(snap1.curves);

    const snap2 = submitCalculation(store, exampleNetwork().versionId, exampleScenario().scenarioId);
    expect(snap2.calculationId).toBe(id1);
    store.close();
  });

  it("改初始条件产生新工况和新结果，旧结果不变", async () => {
    const store = await Store.open(join(TMP, "b.sqlite"));
    store.saveNetwork(exampleNetwork());
    const scn1 = exampleScenario();
    store.saveScenario(scn1);
    const snap1 = submitCalculation(store, scn1.networkVersionId, scn1.scenarioId);

    const scn2 = exampleScenario({
      scenarioId: "scn-example-2",
      initialAtoms: { A: 5000 },
    });
    store.saveScenario(scn2);
    const snap2 = submitCalculation(store, scn2.networkVersionId, scn2.scenarioId);
    expect(snap2.calculationId).not.toBe(snap1.calculationId);

    const old = store.getCalculation(snap1.calculationId)!;
    expect(old.inputs.scenario.initialAtoms.A).toBe(1000);
    const a1 = old.curves.find((c) => c.nuclideId === "A")!.points[10].atoms;
    const a2 = snap2.curves.find((c) => c.nuclideId === "A")!.points[10].atoms;
    expect(a2).toBeCloseTo(5 * a1, 6);
    store.close();
  });

  it("同版本号网络内容变更被拒绝（不可变）", async () => {
    const store = await Store.open(join(TMP, "c.sqlite"));
    store.saveNetwork(exampleNetwork());
    const changed = exampleNetwork();
    changed.nuclides[0].halfLife = 11;
    expect(() => store.saveNetwork(changed)).toThrow(/不可变/);
    store.close();
  });

  it("计算 id 对相同输入稳定", () => {
    const net = exampleNetwork();
    const scn = exampleScenario();
    expect(deterministicCalculationId(net, scn, 1e-9, 1e-12)).toBe(
      deterministicCalculationId(net, scn, 1e-9, 1e-12),
    );
  });
});


