import {
  NetworkInput,
  NetworkView,
  NuclideView,
  EdgeView,
  TIME_TO_SECONDS,
  TimeUnit,
} from './types.js';

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly location: string,
  ) {
    super(`[${location}] ${message}`);
    this.name = 'ValidationError';
  }
}

export interface BuiltNetwork {
  view: NetworkView;
  nuclideIndex: Map<string, number>;
  // 累计衰变计数器描述：每个分支边一个，加上每个有未跟踪比例的父核一个
  counters: { kind: 'edge'; parent: string; child: string; ratio: number }[];
  untrackedCounters: { parent: string; ratio: number }[];
}

export function validateAndBuild(
  input: NetworkInput,
  id: string,
  version: number,
): BuiltNetwork {
  const timeUnit: TimeUnit = input.timeUnit ?? 's';
  if (!(timeUnit in TIME_TO_SECONDS))
    throw new ValidationError(`未知时间单位 "${timeUnit}"`, 'network.timeUnit');

  if (!Array.isArray(input.nuclides) || input.nuclides.length === 0)
    throw new ValidationError('核素列表为空', 'network.nuclides');

  const nuclides = new Map<string, NuclideView>();
  for (const nuc of input.nuclides) {
    if (!nuc || typeof nuc.id !== 'string' || nuc.id.trim() === '')
      throw new ValidationError('核素 id 非法', 'network.nuclides[].id');
    if (nuclides.has(nuc.id))
      throw new ValidationError(`核素 "${nuc.id}" 重复定义`, `nuclide:${nuc.id}`);
    const stable = nuc.stable === true || nuc.halfLife == null;
    let lambda = 0;
    let halfLifeSeconds: number | null = null;
    if (!stable) {
      const h = nuc.halfLife!;
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0)
        throw new ValidationError(
          `半衰期必须为正的有限数值，收到 ${String(h)}`,
          `nuclide:${nuc.id}.halfLife`,
        );
      halfLifeSeconds = h * TIME_TO_SECONDS[timeUnit];
      lambda = Math.LN2 / halfLifeSeconds;
    }
    nuclides.set(nuc.id, { id: nuc.id, stable, lambda, halfLifeSeconds });
  }

  const edges: EdgeView[] = [];
  const outgoing = new Map<string, EdgeView[]>();
  for (const edge of input.edges ?? []) {
    if (!nuclides.has(edge.parent))
      throw new ValidationError(
        `父核素 "${edge.parent}" 不存在`,
        `edge:${edge.parent}->${edge.child}`,
      );
    if (!nuclides.has(edge.child))
      throw new ValidationError(
        `子核素 "${edge.child}" 不存在`,
        `edge:${edge.parent}->${edge.child}`,
      );
    if (edge.parent === edge.child)
      throw new ValidationError(
        '不允许自环衰变',
        `edge:${edge.parent}->${edge.child}`,
      );
    if (nuclides.get(edge.parent)!.stable)
      throw new ValidationError(
        `稳定核素 "${edge.parent}" 不能作为衰变父核`,
        `edge:${edge.parent}->${edge.child}`,
      );
    const b = edge.branchingRatio;
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 1)
      throw new ValidationError(
        `分支比例必须在 (0,1] 内，收到 ${String(b)}`,
        `edge:${edge.parent}->${edge.child}.branchingRatio`,
      );
    if (edges.some((e) => e.parent === edge.parent && e.child === edge.child))
      throw new ValidationError(
        '同一对父子核素出现重复边',
        `edge:${edge.parent}->${edge.child}`,
      );
    const view: EdgeView = { parent: edge.parent, child: edge.child, branchingRatio: b };
    edges.push(view);
    if (!outgoing.has(edge.parent)) outgoing.set(edge.parent, []);
    outgoing.get(edge.parent)!.push(view);
  }

  const untrackedFraction: Record<string, number> = {};
  for (const nuc of nuclides.values()) {
    if (nuc.stable) continue;
    const outs = outgoing.get(nuc.id) ?? [];
    const sum = outs.reduce((acc, e) => acc + e.branchingRatio, 0);
    if (sum > 1 + 1e-12)
      throw new ValidationError(
        `核素 "${nuc.id}" 的分支比例之和为 ${sum}，超过 1`,
        `nuclide:${nuc.id}.branchSum`,
      );
    const miss = 1 - sum;
    if (miss > 1e-12) untrackedFraction[nuc.id] = miss;
  }

  // DAG 拓扑排序（Kahn），检测循环。
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of nuclides.keys()) {
    indegree.set(id, 0);
    children.set(id, []);
  }
  for (const e of edges) {
    indegree.set(e.child, (indegree.get(e.child) ?? 0) + 1);
    children.get(e.parent)!.push(e.child);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([x]) => x);
  const order: string[] = [];
  while (queue.length) {
    const x = queue.shift()!;
    order.push(x);
    for (const c of children.get(x) ?? []) {
      const d = indegree.get(c)! - 1;
      indegree.set(c, d);
      if (d === 0) queue.push(c);
    }
  }
  if (order.length !== nuclides.size) {
    const cyclic = [...indegree.entries()].filter(([, d]) => d > 0).map(([x]) => x);
    throw new ValidationError(
      `衰变网络存在循环，涉及核素: ${cyclic.join(', ')}`,
      'network.cycle',
    );
  }

  const view: NetworkView = {
    id,
    version,
    name: input.name,
    timeUnit,
    nuclides: order.map((x) => nuclides.get(x)!),
    edges,
    untrackedFraction,
    topologicalOrder: order,
  };

  const counters = edges.map((e) => ({
    kind: 'edge' as const,
    parent: e.parent,
    child: e.child,
    ratio: e.branchingRatio,
  }));
  const untrackedCounters = Object.entries(untrackedFraction).map(([parent, ratio]) => ({
    parent,
    ratio,
  }));

  const nuclideIndex = new Map<string, number>();
  view.nuclides.forEach((n, i) => nuclideIndex.set(n.id, i));

  return { view, nuclideIndex, counters, untrackedCounters };
}
