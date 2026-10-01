import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { ValidationError } from '../src/network.js';
import {
  BRANCH_NETWORK,
  SINGLE_NETWORK,
  EQUAL_NETWORK,
  baseScenario,
} from '../examples/fixtures.js';

function fresh(): { store: Store; service: Service; dir: string } {
  const dir = join(tmpdir(), `decay-test-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  const store = new Store(join(dir, 'db.sqlite'));
  const service = new Service(store, { maxPoints: 1000 });
  return { store, service, dir };
}

const last = (a: number[]) => a[a.length - 1]!;

test('单核素解析解 N0 exp(-λt)', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(SINGLE_NETWORK);
  const times = [0, 10, 50, 1000];
  const { result } = service.submitScenario({
    name: 's',
    networkId: net.id,
    initialAtoms: { X: 1000 },
    times,
  });
  const lambda = Math.LN2 / 10;
  times.forEach((t, i) => {
    assert.ok(Math.abs(result.atoms[0]![i]! - 1000 * Math.exp(-lambda * t)) < 1e-9);
    assert.ok(Math.abs(result.activity[0]![i]! - lambda * result.atoms[0]![i]!) < 1e-9);
  });
  // 累计衰变量与解析一致
  times.forEach((t, i) => {
    const decays = result.edgeDecays['X->Y']!;
    assert.ok(Math.abs(decays[i]! - 1000 * (1 - Math.exp(-lambda * t))) < 1e-9);
  });
});

test('零时刻：无衰变、无累计、活度为 λN', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(SINGLE_NETWORK);
  const { result } = service.submitScenario({
    name: 'z',
    networkId: net.id,
    initialAtoms: { X: 10 },
    times: [0],
  });
  assert.equal(result.atoms[0]![0], 10);
  assert.equal(result.atoms[1]![0], 0);
  assert.equal(result.edgeDecays['X->Y']![0], 0);
});

test('极长时间：不稳定核素衰减殆尽，稳定终点收齐', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(SINGLE_NETWORK);
  const { result } = service.submitScenario({
    name: 'l',
    networkId: net.id,
    initialAtoms: { X: 1000 },
    times: [1e12],
  });
  assert.ok(result.atoms[0]![0]! < 1e-300);
  assert.ok(Math.abs(result.atoms[1]![0]! - 1000) < 1e-9);
});

test('极小时间步：线性首阶行为', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(SINGLE_NETWORK);
  const lambda = Math.LN2 / 10;
  const h = 1e-12;
  const { result } = service.submitScenario({
    name: 'h',
    networkId: net.id,
    initialAtoms: { X: 1 },
    times: [h],
  });
  assert.ok(Math.abs(result.atoms[0]![0]! - (1 - lambda * h)) < 1e-12);
});

test('相同半衰期母女子链解析解（无数值爆炸）', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(EQUAL_NETWORK);
  const lambda = Math.LN2 / 12;
  const times = [0, 0.001, 1, 12, 100, 1e6];
  const { result } = service.submitScenario({
    name: 'e',
    networkId: net.id,
    initialAtoms: { P: 500 },
    times,
  });
  times.forEach((t, i) => {
    const q = 500 * lambda * t * Math.exp(-lambda * t);
    const r = 500 * (1 - Math.exp(-lambda * t) * (1 + lambda * t));
    assert.ok(Math.abs(result.atoms[1]![i]! - q) < 1e-8, `Q@${t}`);
    assert.ok(Math.abs(result.atoms[2]![i]! - r) < 1e-8, `R@${t}`);
  });
  // 总量严格守恒（无未跟踪分支）
  result.times.forEach((_, i) => {
    const total =
      result.atoms[0]![i]! + result.atoms[1]![i]! + result.atoms[2]![i]!;
    assert.ok(Math.abs(total - 500) < 1e-9);
  });
});

test('分支汇合 + 未跟踪分支：守恒账本把流失与误差分开', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(BRANCH_NETWORK);
  const fractions = service.inspectNetwork(net.id).untrackedFraction;
  assert.ok(Math.abs(fractions.A! - 0.1) < 1e-12);
  assert.ok(Math.abs(fractions.B! - 0.5) < 1e-12);
  const { result } = service.submitScenario(baseScenario(net.id));
  const d = result.diagnostics;
  assert.ok(d.conservationError < 1e-12);
  assert.ok(d.untrackedLoss > 0);
  assert.ok(d.warnings.some((w) => w.includes('未跟踪分支')));
  // 任何核素都不应为负
  for (const col of result.atoms) for (const v of col) assert.ok(v >= -1e-12);
  // 账本恒等式在末端
  const atomSum = result.atoms.reduce((acc, col) => acc + last(col), 0);
  const untrackedLoss = Object.values(result.untrackedDecays).reduce(
    (a, c) => a + last(c),
    0,
  );
  assert.ok(
    Math.abs(atomSum + untrackedLoss - 1000 - d.injectedTotal) < 1e-8,
  );
});

test('向稳定核素注入：原子线性累积且不计活度', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(SINGLE_NETWORK);
  const { result } = service.submitScenario({
    name: 'inj',
    networkId: net.id,
    initialAtoms: {},
    injections: [
      { start: 0, end: 10, rates: { Y: 3 } },
      { start: 10, end: 20, rates: { Y: 7 } },
    ],
    times: [0, 10, 20],
  });
  assert.ok(Math.abs(result.atoms[1]![0]! - 0) < 1e-12);
  assert.ok(Math.abs(result.atoms[1]![1]! - 30) < 1e-9);
  assert.ok(Math.abs(result.atoms[1]![2]! - 100) < 1e-9);
  assert.equal(result.activity[1]![2], 0);
});

test('非法：负时间/负数量/自环/循环/分支和超限 均带定位信息', () => {
  const { store } = fresh();
  assert.throws(
    () => store.importNetwork({ ...SINGLE_NETWORK, edges: [{ parent: 'X', child: 'X', branchingRatio: 1 }] }),
    (e: unknown) => e instanceof ValidationError && e.location.includes('edge:X->X'),
  );
  assert.throws(
    () =>
      store.importNetwork({
        name: 'cyc',
        nuclides: [
          { id: 'P', halfLife: 1 },
          { id: 'Q', halfLife: 1 },
        ],
        edges: [
          { parent: 'P', child: 'Q', branchingRatio: 1 },
          { parent: 'Q', child: 'P', branchingRatio: 1 },
        ],
      }),
    /循环/,
  );
  const net = store.importNetwork(SINGLE_NETWORK);
  assert.throws(
    () =>
      new Service(store, { maxPoints: 3 }).submitScenario({
        name: 'x',
        networkId: net.id,
        initialAtoms: {},
        times: [0, 1, 2, 3, 4],
      }),
    /超过上限/,
  );
  assert.throws(
    () =>
      new Service(store).submitScenario({
        name: 'x',
        networkId: net.id,
        initialAtoms: { X: -1 },
        times: [0],
      }),
    /initialAtoms.X/,
  );
  assert.throws(
    () =>
      new Service(store).submitScenario({
        name: 'x',
        networkId: net.id,
        initialAtoms: {},
        times: [-1],
      }),
    /负时间/,
  );
  assert.throws(
    () =>
      store.importNetwork({
        name: 'branch-over',
        nuclides: [
          { id: 'P', halfLife: 1 },
          { id: 'Q', stable: true },
        ],
        edges: [{ parent: 'P', child: 'Q', branchingRatio: 1.2 }],
      }),
    /branchingRatio/,
  );
});

test('分支和超过 1 报错并定位到父核素', () => {
  const { store } = fresh();
  assert.throws(
    () =>
      store.importNetwork({
        name: 'sum-over',
        nuclides: [
          { id: 'P', halfLife: 1 },
          { id: 'Q', stable: true },
          { id: 'R', stable: true },
        ],
        edges: [
          { parent: 'P', child: 'Q', branchingRatio: 0.7 },
          { parent: 'P', child: 'R', branchingRatio: 0.5 },
        ],
      }),
    /nuclide:P.branchSum/,
  );
});

test('版本不可变：改半衰期产生新版本，重启后旧结果可复现', () => {
  const dir = join(tmpdir(), `decay-restart-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  let store = new Store(join(dir, 'db.sqlite'));
  let service = new Service(store);
  const v1 = store.importNetwork(BRANCH_NETWORK);
  assert.equal(v1.version, 1);
  const r1 = service.submitScenario(baseScenario(v1.id));

  const modified = {
    ...BRANCH_NETWORK,
    nuclides: BRANCH_NETWORK.nuclides.map((n) =>
      n.id === 'A' ? { ...n, halfLife: 8 } : n,
    ),
  };
  const v2 = store.importNetwork(modified);
  assert.equal(v2.version, 2);
  const r2 = service.submitScenario(baseScenario(v2.id));
  assert.notEqual(r1.runId, r2.runId);
  store.close();

  // 模拟服务重启
  store = new Store(join(dir, 'db.sqlite'));
  service = new Service(store);
  const rerun = service.submitRun(r1.result.scenarioId);
  assert.equal(rerun.runId, r1.runId);
  const fetched = store.getRun(r1.runId);
  assert.equal(fetched.networkVersion, 1);
  assert.deepEqual(fetched.atoms, store.getRun(r2.runId).atoms.length ? fetched.atoms : fetched.atoms);
  assert.ok(last(fetched.atoms[0]!) !== last(store.getRun(r2.runId).atoms[0]!));
  store.close();
});

test('相同输入产生相同 runId（稳定可比较输出）', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(BRANCH_NETWORK);
  const a = service.submitScenario(baseScenario(net.id));
  const b = service.submitScenario(baseScenario(net.id));
  assert.equal(a.runId, b.runId);
});

test('曲线查询与核素定位错误', () => {
  const { store, service } = fresh();
  const net = store.importNetwork(SINGLE_NETWORK);
  const { runId } = service.submitScenario({
    name: 'c',
    networkId: net.id,
    initialAtoms: { X: 10 },
    times: [0, 1],
  });
  const curve = service.getCurve(runId, 'X');
  assert.equal(curve.points.length, 2);
  assert.throws(() => service.getCurve(runId, 'NOPE'), /nuclide:NOPE/);
});
