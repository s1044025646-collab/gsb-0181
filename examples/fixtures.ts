import { NetworkInput, ScenarioInput } from '../src/types.js';

// 教学示例网络（时间单位：任意一致单位，这里用秒）：
//   A(半衰期10) --0.6--> B(半衰期15) --0.5--> D(半衰期30)
//         \\--0.3--> C(半衰期10，与 A 相同) --0.8--> D
//                                          C --0.2--> E(半衰期20)
//   D 衰变 --> S（稳定终点）
// A 的分支总和 0.9，10% 为未跟踪分支；B 缺 50%；C 恰好 100%。
export const BRANCH_NETWORK: NetworkInput = {
  name: 'branch-demo',
  timeUnit: 's',
  nuclides: [
    { id: 'A', halfLife: 10 },
    { id: 'B', halfLife: 15 },
    { id: 'C', halfLife: 10 },
    { id: 'D', halfLife: 30 },
    { id: 'E', halfLife: 20 },
    { id: 'S', stable: true },
  ],
  edges: [
    { parent: 'A', child: 'B', branchingRatio: 0.6 },
    { parent: 'A', child: 'C', branchingRatio: 0.3 },
    { parent: 'B', child: 'D', branchingRatio: 0.5 },
    { parent: 'C', child: 'D', branchingRatio: 0.8 },
    { parent: 'C', child: 'E', branchingRatio: 0.2 },
    { parent: 'D', child: 'S', branchingRatio: 1 },
    { parent: 'E', child: 'S', branchingRatio: 1 },
  ],
};

// 基础工况：1000 个 A 原子，t∈[0,60]，含两段注入（向稳定核 S 与 B 注入）。
export function baseScenario(networkId: string, times?: number[]): ScenarioInput {
  return {
    name: 'base',
    networkId,
    timeUnit: 's',
    initialAtoms: { A: 1000 },
    injections: [
      { start: 0, end: 20, rates: { S: 5, B: 2 } },
      { start: 20, end: 40, rates: { S: 10 } },
    ],
    times: times ?? [0, 5, 10, 15, 20, 25, 30, 40, 60],
  };
}

// 修改半衰期（A: 10 -> 8）产生网络新版本，同样工况名重新计算。
export function modifiedNetwork(): NetworkInput {
  return {
    ...BRANCH_NETWORK,
    nuclides: BRANCH_NETWORK.nuclides.map((n) =>
      n.id === 'A' ? { ...n, halfLife: 8 } : n,
    ),
  };
}

// 单核解析链：X(半衰期10) -> Y(稳定)
export const SINGLE_NETWORK: NetworkInput = {
  name: 'single',
  timeUnit: 's',
  nuclides: [
    { id: 'X', halfLife: 10 },
    { id: 'Y', stable: true },
  ],
  edges: [{ parent: 'X', child: 'Y', branchingRatio: 1 }],
};

// 等半衰期链：P -> Q -> R（全稳定终点 R），半衰期完全相同，
// 专门检验“禁止 (lambda_i-lambda_j) 相除”的数值处理。
export const EQUAL_NETWORK: NetworkInput = {
  name: 'equal-half-life',
  timeUnit: 's',
  nuclides: [
    { id: 'P', halfLife: 12 },
    { id: 'Q', halfLife: 12 },
    { id: 'R', stable: true },
  ],
  edges: [
    { parent: 'P', child: 'Q', branchingRatio: 1 },
    { parent: 'Q', child: 'R', branchingRatio: 1 },
  ],
};
