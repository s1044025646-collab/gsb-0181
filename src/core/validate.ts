import type { DecayEdge, DecayNetwork, InjectionSegment, NuclideDef, Scenario } from "../types.js";
import { MAX_GRID_POINTS } from "../types.js";

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly locator?: { nuclideId?: string; edge?: { parent: string; child: string } },
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(message: string, nuclideId?: string, edge?: DecayEdge): never {
  throw new ValidationError(message, {
    nuclideId,
    edge: edge ? { parent: edge.parent, child: edge.child } : undefined,
  });
}

const ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

function assertFiniteNonNeg(x: number, label: string, nuclideId?: string): void {
  if (!Number.isFinite(x) || x < 0) {
    fail(`${label} 必须是非负有限数，收到 ${x}`, nuclideId);
  }
}

export function validateNetwork(network: DecayNetwork): void {
  if (!network || typeof network !== "object") fail("网络定义缺失");
  if (!ID_RE.test(network.versionId)) fail(`versionId 非法: ${network.versionId}`);
  if (!network.timeUnit || typeof network.timeUnit !== "string") {
    fail("timeUnit 必须是非空字符串（时间与半衰期共用该单位）");
  }
  if (!Array.isArray(network.nuclides) || network.nuclides.length === 0) {
    fail("网络至少需要一个核素");
  }

  const ids = new Set<string>();
  for (const nuc of network.nuclides) {
    if (!ID_RE.test(nuc.id)) fail(`核素 id 非法: "${nuc.id}"`, nuc.id);
    if (ids.has(nuc.id)) fail(`核素 id 重复: ${nuc.id}`, nuc.id);
    ids.add(nuc.id);
    if (nuc.halfLife !== null) {
      if (!Number.isFinite(nuc.halfLife) || nuc.halfLife <= 0) {
        fail(`核素 ${nuc.id} 的半衰期必须为正数或 null（稳定）`, nuc.id);
      }
    }
  }

  const outSum = new Map<string, number>();
  for (const edge of network.edges) {
    if (!ids.has(edge.parent)) fail(`衰变边父核素不存在: ${edge.parent}`, edge.parent, edge);
    if (!ids.has(edge.child)) fail(`衰变边子核素不存在: ${edge.child}`, edge.child, edge);
    if (edge.parent === edge.child) fail(`禁止自环: ${edge.parent} -> ${edge.child}`, edge.parent, edge);
    if (!Number.isFinite(edge.branchFraction) || edge.branchFraction <= 0 || edge.branchFraction > 1) {
      fail(
        `分支比例必须在 (0, 1] 内，边 ${edge.parent}->${edge.child} 收到 ${edge.branchFraction}`,
        edge.parent,
        edge,
      );
    }
    outSum.set(edge.parent, (outSum.get(edge.parent) ?? 0) + edge.branchFraction);
  }
  for (const [parent, sum] of outSum) {
    if (sum > 1 + 1e-12) {
      fail(`核素 ${parent} 的出边分支比例之和为 ${sum}，超过 1`, parent);
    }
  }

  detectCycle(network);
}

/** Kahn 拓扑排序；同时检测环（含经汇合路径形成的环）。 */
export function topologicalOrder(network: DecayNetwork): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const nuc of network.nuclides) {
    indeg.set(nuc.id, 0);
    adj.set(nuc.id, []);
  }
  for (const edge of network.edges) {
    adj.get(edge.parent)!.push(edge.child);
    indeg.set(edge.child, (indeg.get(edge.child) ?? 0) + 1);
  }
  const queue = network.nuclides.map((n) => n.id).filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of adj.get(id) ?? []) {
      const d = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  if (order.length !== network.nuclides.length) {
    fail("衰变网络存在循环链，禁止");
  }
  return order;
}

function detectCycle(network: DecayNetwork): void {
  topologicalOrder(network);
}

export function validateScenario(scenario: Scenario, network: DecayNetwork): void {
  const ids = new Set(network.nuclides.map((n) => n.id));
  if (!ID_RE.test(scenario.scenarioId)) fail(`scenarioId 非法: ${scenario.scenarioId}`);
  if (scenario.networkVersionId !== network.versionId) {
    fail(
      `工况引用网络版本 ${scenario.networkVersionId}，与当前版本 ${network.versionId} 不一致`,
    );
  }
  for (const [id, n0] of Object.entries(scenario.initialAtoms)) {
    if (!ids.has(id)) fail(`初始原子数引用了不存在的核素 ${id}`, id);
    assertFiniteNonNeg(n0, `核素 ${id} 的初始原子数`, id);
  }
  for (const seg of scenario.injections) {
    if (!ids.has(seg.nuclide)) fail(`注入段引用不存在的核素 ${seg.nuclide}`, seg.nuclide);
    assertFiniteNonNeg(seg.rate, `核素 ${seg.nuclide} 注入率`, seg.nuclide);
    assertFiniteNonNeg(seg.tStart, `注入段起始时间`, seg.nuclide);
    if (!(seg.tEnd > seg.tStart)) {
      fail(`核素 ${seg.nuclide} 注入段 tEnd(${seg.tEnd}) 必须大于 tStart(${seg.tStart})`, seg.nuclide);
    }
  }
  assertFiniteNonNeg(scenario.tStart, "tStart");
  if (!(scenario.tEnd >= scenario.tStart)) fail("tEnd 不能早于 tStart");
  if (!Number.isInteger(scenario.nPoints) || scenario.nPoints < 1) {
    fail("nPoints 必须是 >= 1 的整数");
  }
  if (scenario.nPoints > MAX_GRID_POINTS) {
    fail(`采样点数量 ${scenario.nPoints} 超过上限 ${MAX_GRID_POINTS}`);
  }
}

/** 稳定核素检查工具 */
export function isStable(nuc: NuclideDef): boolean {
  return nuc.halfLife === null;
}

export type { InjectionSegment };
