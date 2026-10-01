// 端到端演示：导入 -> 计算 -> 修改工况/半衰期 -> 比较 -> 导出，
// 并打印关键解析校验数值与误差。可直接 `npm run demo` 运行。
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import {
  BRANCH_NETWORK,
  SINGLE_NETWORK,
  EQUAL_NETWORK,
  baseScenario,
  modifiedNetwork,
} from './fixtures.js';
import { runToCSV } from '../src/export.js';

const dataDir = join(tmpdir(), `decay-demo-${process.pid}`);
rmSync(dataDir, { recursive: true, force: true });
const store = new Store(join(dataDir, 'demo.sqlite'));
const service = new Service(store);

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function maxAbs(a: number[], b: number[]): number {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
}

// 1) 单核解析解校验
section('1. 单核解析解  N(t)=N0 exp(-lambda t)');
const sNet = store.importNetwork(SINGLE_NETWORK);
const sRun = service.submitScenario({
  name: 'single-case',
  networkId: sNet.id,
  initialAtoms: { X: 1000 },
  times: [0, 10, 50, 1000],
});
const lx = Math.LN2 / 10;
const expectX = sRun.result.times.map((t) => 1000 * Math.exp(-lx * t));
const errSingle = maxAbs(sRun.result.atoms[0]!, expectX);
console.log('X 原子数 :', sRun.result.atoms[0]!.map((v) => v.toPrecision(10)));
console.log('解析值   :', expectX.map((v) => v.toPrecision(10)));
console.log('最大绝对误差:', errSingle.toExponential(3));

// 2) 相同半衰期母女子链解析解校验
section('2. 相同半衰期链  N_Q = N0 λ t exp(-λt)');
const eNet = store.importNetwork(EQUAL_NETWORK);
const eTimes = [0, 0.001, 1, 12, 100, 1e6];
const eRun = service.submitScenario({
  name: 'equal-case',
  networkId: eNet.id,
  initialAtoms: { P: 500 },
  times: eTimes,
});
const le = Math.LN2 / 12;
const expectQ = eTimes.map((t) => 500 * le * t * Math.exp(-le * t));
const expectR = eTimes.map((t) => 500 * (1 - Math.exp(-le * t) * (1 + le * t)));
console.log('Q 最大绝对误差:', maxAbs(eRun.result.atoms[1]!, expectQ).toExponential(3));
console.log('R 最大绝对误差:', maxAbs(eRun.result.atoms[2]!, expectR).toExponential(3));

// 3) 分支汇合网络 + 多段注入，守恒账本
section('3. 分支汇合 / 稳定终点 / 跨注入段');
const net = store.importNetwork(BRANCH_NETWORK);
console.log('网络:', net.id, 'version', net.version);
const run1 = service.submitScenario(baseScenario(net.id));
const d1 = run1.result.diagnostics;
console.log('runId:', run1.runId);
console.log('守恒账本相对误差:', d1.conservationError.toExponential(3));
console.log('未跟踪分支累计流失:', d1.untrackedLoss.toFixed(6));
console.log('累计注入原子数:', d1.injectedTotal);
console.log('矩阵指数最大对易残差:', d1.maxCommutatorResidual.toExponential(3));
console.log('警告:', d1.warnings);
const last = (arr: number[]) => arr[arr.length - 1]!;
console.log('t=60 各核素原子数:', run1.result.nuclideIds.map((id, i) =>
  `${id}=${last(run1.result.atoms[i]!).toPrecision(8)}`).join(' '));

// 4) 改半衰期 -> 新版本；旧结果仍可复现
section('4. 修改半衰期生成新版本，旧快照不变');
const net2 = store.importNetwork(modifiedNetwork());
console.log('新网络:', net2.id, 'version', net2.version, net.reused ? '' : '');
const run2 = service.submitScenario(baseScenario(net2.id));
const oldRun = store.getRun(run1.runId);
console.log('旧 run 的网络版本:', oldRun.networkVersion, ' 新 run 版本:', run2.result.networkVersion);
console.log('旧 run 最终 A 原子数:', last(oldRun.atoms[0]!).toPrecision(10));
console.log('新 run 最终 A 原子数:', last(run2.result.atoms[0]!).toPrecision(10));

// 5) 修改初始条件（内容寻址 -> 新工况/新 run），比较
section('5. 修改初始条件并比较工况');
const run3 = service.submitScenario({
  ...baseScenario(net.id),
  name: 'base-double',
  initialAtoms: { A: 2000 },
});
const cmp = service.compareRuns([run1.runId, run3.runId]);
console.log('公共核素最大原子数差:', JSON.stringify(cmp.maxAtomDifference));

// 6) 幂等：相同输入稳定输出
section('6. 相同输入稳定/幂等');
const run1Again = service.submitScenario(baseScenario(net.id));
console.log('重复提交复用 run:', run1Again.runId === run1.runId, run1Again.runId);

// 7) 导出 CSV
section('7. 导出 CSV/JSON');
const csvPath = join(dataDir, 'curve.csv');
writeFileSync(csvPath, runToCSV(run1.result));
console.log('CSV 已写:', csvPath);
console.log(runToCSV(run1.result).split('\n').slice(0, 4).join('\n'));

section('校验结论');
const ok =
  errSingle < 1e-9 &&
  maxAbs(eRun.result.atoms[1]!, expectQ) < 1e-8 &&
  d1.conservationError < 1e-12;
console.log(ok ? '全部关键校验通过 ✔' : '存在校验偏差，请检查 ✘');
console.log('演示数据目录:', dataDir);
store.close();
if (!ok) process.exit(1);
