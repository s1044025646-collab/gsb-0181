// 解析参考解：仅用于教学对照与自动化校核。
// 刻意保持简单；通用计算走 engine.ts 的 ODE 积分。

/** 单核素 N(t)=N0 exp(-λt) */
export function singleNuclide(n0: number, halfLife: number, t: number): number {
  const lambda = Math.LN2 / halfLife;
  return n0 * Math.exp(-lambda * t);
}

export interface ChainParams {
  n10: number;
  n20: number;
  lambda1: number;
  lambda2: number;
}

/**
 * 母子链 N1 -> N2（分支比 1）。
 * 使用稳定的实现：
 *  - |λ1-λ2| 较大时采用经典 Bateman 差分式；
 *  - 二者相同（或接近，相对差 < 1e-6）时改用简并极限公式
 *    N2(t)=N20 e^-λt + N10 λ t e^-λt，避免相减相除导致的数值爆炸。
 */
export function motherDaughter(p: ChainParams, t: number): [number, number] {
  const { n10, n20, lambda1, lambda2 } = p;
  const n1 = n10 * Math.exp(-lambda1 * t);
  let n2: number;
  const scale = Math.max(lambda1, lambda2, 1e-300);
  if (Math.abs(lambda1 - lambda2) < 1e-6 * scale) {
    const lambda = lambda1;
    n2 = n20 * Math.exp(-lambda * t) + n10 * lambda * t * Math.exp(-lambda * t);
  } else {
    n2 =
      n20 * Math.exp(-lambda2 * t) +
      (n10 * lambda1 * (Math.exp(-lambda1 * t) - Math.exp(-lambda2 * t))) /
        (lambda2 - lambda1);
  }
  return [n1, n2];
}

/** 对稳定终点核素以恒定速率注入：N(t)=N0 + r t（λ=0） */
export function stableInjection(n0: number, rate: number, t: number): number {
  return n0 + rate * t;
}

/** 单核素恒速注入（0 时刻起）：N(t)=N0 e^-λt + r(1-e^-λt)/λ */
export function singleNuclideInjection(
  n0: number,
  halfLife: number,
  rate: number,
  t: number,
): number {
  const lambda = Math.LN2 / halfLife;
  if (lambda === 0) return stableInjection(n0, rate, t);
  return n0 * Math.exp(-lambda * t) + (rate * (1 - Math.exp(-lambda * t))) / lambda;
}
