// 自适应 Cash-Karp RK45 积分器。
// 设计要点：
// 1) 直接积分 ODE 方程组 dN/dt = -λN + Σ b·λN_parent + s(t)，
//    不使用 Bateman 解析式中 (λ_j - λ_i) 相近时相减相除的形式，
//    因此相同（或极接近）半衰期不会产生数值爆炸。
// 2) 每个核素的累计衰变 C_i 以 dC_i/dt = λ_i N_i 作为附加状态同步积分，
//    未跟踪流失 U_i 同理（dU_i/dt = u_i λ_i N_i）。
//    累计量由内部自适应步长精确积分，而非对输出采样点求和。

export interface OdeSystem {
  /** 维度 */
  n: number;
  /** 计算导数：f(t, y, out) */
  f(t: number, y: Float64Array, out: Float64Array): void;
}

export interface IntegrateOptions {
  rtol?: number;
  atol?: number;
  maxSteps?: number;
  /** 最小允许步长（相对区间尺度），低于则报警 */
  minStep?: number;
}

export interface IntegrateResult {
  acceptedSteps: number;
  rejectedSteps: number;
  totalTries: number;
  tinyStepEncountered: boolean;
  /** 每次接受步的误差估计累计（归一化） */
  errorAccum: number;
}

// Cash-Karp 系数
const A2 = 1 / 5;
const A3 = 3 / 10;
const A4 = 3 / 5;
const A5 = 1;
const A6 = 7 / 8;

const B21 = 1 / 5;
const B31 = 3 / 40;
const B32 = 9 / 40;
const B41 = 3 / 10;
const B42 = -9 / 10;
const B43 = 6 / 5;
const B51 = -11 / 54;
const B52 = 5 / 2;
const B53 = -70 / 27;
const B54 = 35 / 27;
const B61 = 1631 / 55296;
const B62 = 175 / 512;
const B63 = 575 / 13824;
const B64 = 44275 / 110592;
const B65 = 253 / 4096;

// 五阶解系数
const C1 = 37 / 378;
const C3 = 250 / 621;
const C4 = 125 / 594;
const C6 = 512 / 1771;

// 四阶解系数（误差 = 五阶 - 四阶）
const DC1 = C1 - 2825 / 27648;
const DC3 = C3 - 18575 / 48384;
const DC4 = C4 - 13525 / 55296;
const DC5 = -277 / 14336;
const DC6 = C6 - 1 / 4;

const SAFETY = 0.9;
const MIN_FACTOR = 0.2;
const MAX_FACTOR = 5.0;

/**
 * 从 t0 积分到 tEnd，y 原地更新。步长不跨越断点 breakpoints。
 */
export function integrateAdaptive(
  sys: OdeSystem,
  t0: number,
  tEnd: number,
  y: Float64Array,
  breakpoints: number[],
  opts: IntegrateOptions = {},
): IntegrateResult {
  const rtol = opts.rtol ?? 1e-9;
  const atol = opts.atol ?? 1e-12;
  const maxSteps = opts.maxSteps ?? 200000;
  const n = sys.n;

  const k1 = new Float64Array(n);
  const k2 = new Float64Array(n);
  const k3 = new Float64Array(n);
  const k4 = new Float64Array(n);
  const k5 = new Float64Array(n);
  const k6 = new Float64Array(n);
  const yTmp = new Float64Array(n);
  const yNext = new Float64Array(n);
  const errVec = new Float64Array(n);

  const cuts = [t0, ...breakpoints.filter((b) => b > t0 && b < tEnd), tEnd].sort(
    (a, b) => a - b,
  );

  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let totalTries = 0;
  let errorAccum = 0;
  let tinyStepEncountered = false;

  let t = t0;
  sys.f(t, y, k1);
  let h = suggestInitialStep(tEnd - t0);

  for (let ci = 0; ci < cuts.length - 1; ci++) {
    const segEnd = cuts[ci + 1];
    h = Math.min(h, segEnd - t);

    while (t < segEnd) {
      if (totalTries++ > maxSteps) {
        throw new Error(`积分器超过最大步数 ${maxSteps}（体系可能过度刚性）`);
      }
      if (t + h > segEnd) h = segEnd - t;
      if (h < (opts.minStep ?? 1e-14) * Math.max(1, segEnd - cuts[ci])) {
        tinyStepEncountered = true;
      }

      for (let i = 0; i < n; i++) yTmp[i] = y[i] + h * (B21 * k1[i]);
      sys.f(t + A2 * h, yTmp, k2);
      for (let i = 0; i < n; i++) yTmp[i] = y[i] + h * (B31 * k1[i] + B32 * k2[i]);
      sys.f(t + A3 * h, yTmp, k3);
      for (let i = 0; i < n; i++)
        yTmp[i] = y[i] + h * (B41 * k1[i] + B42 * k2[i] + B43 * k3[i]);
      sys.f(t + A4 * h, yTmp, k4);
      for (let i = 0; i < n; i++)
        yTmp[i] = y[i] + h * (B51 * k1[i] + B52 * k2[i] + B53 * k3[i] + B54 * k4[i]);
      sys.f(t + A5 * h, yTmp, k5);
      for (let i = 0; i < n; i++)
        yTmp[i] =
          y[i] + h * (B61 * k1[i] + B62 * k2[i] + B63 * k3[i] + B64 * k4[i] + B65 * k5[i]);
      sys.f(t + A6 * h, yTmp, k6);

      let errNorm = 0;
      for (let i = 0; i < n; i++) {
        const fifth = y[i] + h * (C1 * k1[i] + C3 * k3[i] + C4 * k4[i] + C6 * k6[i]);
        yNext[i] = fifth;
        const err = h * (DC1 * k1[i] + DC3 * k3[i] + DC4 * k4[i] + DC5 * k5[i] + DC6 * k6[i]);
        errVec[i] = err;
        const sc = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(fifth));
        const r = err / sc;
        errNorm += r * r;
      }
      errNorm = Math.sqrt(errNorm / n);

      if (errNorm <= 1 || h <= (opts.minStep ?? 1e-14) * Math.max(1, tEnd - t0)) {
        t += h;
        y.set(yNext);
        acceptedSteps++;
        errorAccum += errNorm * errNorm;
        sys.f(t, y, k1);
        const factor =
          errNorm === 0
            ? MAX_FACTOR
            : Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, SAFETY * errNorm ** -0.2));
        h = Math.min(segEnd - t, h * factor);
        if (segEnd - t === 0) break;
      } else {
        rejectedSteps++;
        const factor = Math.max(MIN_FACTOR, SAFETY * errNorm ** -0.25);
        h *= factor;
      }
    }
  }

  return {
    acceptedSteps,
    rejectedSteps,
    totalTries,
    tinyStepEncountered,
    errorAccum: Math.sqrt(errorAccum / Math.max(1, acceptedSteps)),
  };
}

function suggestInitialStep(span: number): number {
  return Math.max(span * 1e-4, 1e-12);
}
