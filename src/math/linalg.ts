// 小型稠密线性代数与矩阵指数实现。
// 矩阵采用行优先一维数组：a[i * n + j]。

export interface ExpmResult {
  e: Float64Array;
  squarings: number;
  norm1: number;
  padeOrder: number;
  commutatorResidual: number; // ||E*M - M*E||_1 相对量，精度诊断
}

// 对角 Pade [m/m] 系数 c_k = (2m-k)! m! / ((2m)! k! (m-k)!)，
// 用递推 c_0=1、c_{k+1}/c_k = (m-k)/((2m-k)(k+1)) 在运行时精确生成，
// 避免手算/查表误差。
function padeCoefficients(m: number): number[] {
  const c = [1];
  for (let k = 0; k < m; k++)
    c.push((c[k]! * (m - k)) / ((2 * m - k) * (k + 1)));
  return c;
}

export function norm1(a: Float64Array, n: number): number {
  let m = 0;
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(a[i * n + j]!);
    if (s > m) m = s;
  }
  return m;
}

function identity(n: number): Float64Array {
  const a = new Float64Array(n * n);
  for (let i = 0; i < n; i++) a[i * n + i] = 1;
  return a;
}

function mul(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const c = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const aik = a[i * n + k]!;
      if (aik === 0) continue;
      const rowBase = i * n;
      const bBase = k * n;
      for (let j = 0; j < n; j++)
        c[rowBase + j] = c[rowBase + j]! + aik * b[bBase + j]!;
    }
  }
  return c;
}

function addScale(
  a: Float64Array,
  b: Float64Array,
  s: number,
  n: number,
): Float64Array {
  const c = new Float64Array(n * n);
  for (let i = 0; i < c.length; i++) c[i] = a[i]! + s * b[i]!;
  return c;
}

function luSolve(a: Float64Array, b: Float64Array, n: number): Float64Array {
  // 部分选主元 LU 分解解 A x = b。
  const lu = new Float64Array(a);
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(lu[col * n + col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(lu[r * n + col]!);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best === 0) throw new Error('矩阵奇异，无法求解线性方程组');
    if (pivot !== col) {
      for (let j = 0; j < n; j++) {
        const t = lu[col * n + j]!;
        lu[col * n + j] = lu[pivot * n + j]!;
        lu[pivot * n + j] = t;
      }
      const t = piv[col]!;
      piv[col] = piv[pivot]!;
      piv[pivot] = t;
    }
    const d = lu[col * n + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = lu[r * n + col]! / d;
      lu[r * n + col] = f;
      for (let j = col + 1; j < n; j++)
        lu[r * n + j] = lu[r * n + j]! - f * lu[col * n + j]!;
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = b[piv[i]!]!;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) x[i]! -= lu[i * n + j]! * x[j]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) x[i]! -= lu[i * n + j]! * x[j]!;
    x[i] = x[i]! / lu[i * n + i]!;
  }
  return x;
}

// 缩放-平方 + 13 阶 Pade：对任意衰减常数（包括完全相等）均稳定，
// 不使用 (lambda_i - lambda_j) 相除，因此不存在相同半衰期导致的数值爆炸。
export function expm(m: Float64Array, n: number): ExpmResult {
  const PADE_ORDER = 13;
  const padeCoeffs = padeCoefficients(PADE_ORDER);
  const nm1 = norm1(m, n);
  const maxSquarings = 60;
  let s = 0;
  const theta = 5; // theta_13 ≈ 5.37，取 5.0 更保守
  let scale = 1;
  while (nm1 / scale > theta && s < maxSquarings) {
    scale *= 2;
    s++;
  }
  const a = new Float64Array(m.length);
  for (let i = 0; i < m.length; i++) a[i] = m[i]! / scale;

  const a2 = mul(a, a, n);
  const a4 = mul(a2, a2, n);
  const a6 = mul(a4, a2, n);
  void a6;

  // U = A * [b13 A12 + b11 A10 + b9 A8 + b7 A6 + b5 A4 + b3 A2 + b1 I]
  // V = b12 A12 + b10 A10 + b8 A8 + b6 A6 + b4 A4 + b2 A2 + b0 I
  let u = new Float64Array(n * n);
  let v = new Float64Array(n * n);
  // 逐项累加 A^0..A^13
  let power = identity(n); // A^0
  for (let p = 0; p <= PADE_ORDER; p++) {
    const coeff = padeCoeffs[p]!;
    const target = p % 2 === 0 ? v : u;
    for (let i = 0; i < target.length; i++) target[i]! += coeff * power[i]!;
    if (p < PADE_ORDER) power = mul(power, a, n);
  }

  // R = (V - U)^-1 (V + U)，逐列 LU 求解。
  const vu = addScale(v, u, -1, n);
  const vp = addScale(v, u, 1, n);
  const r = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = vp[i * n + j]!;
    const sol = luSolve(vu, col, n);
    for (let i = 0; i < n; i++) r[i * n + j] = sol[i]!;
  }

  const e0: Float64Array = r;
  let e = e0;
  for (let q = 0; q < s; q++) e = mul(e, e, n);

  const em = mul(e, m, n);
  const me = mul(m, e, n);
  let diff = 0;
  for (let i = 0; i < em.length; i++) diff += Math.abs(em[i]! - me[i]!);
  const residual = nm1 > 0 ? diff / (n * nm1) : 0;

  return {
    e,
    squarings: s,
    norm1: nm1,
    padeOrder: PADE_ORDER,
    commutatorResidual: residual,
  };
}

// 增广矩阵
//  | M  v |
//  | 0  0 |  的指数，返回 E=expm(Mh) 与 w=∫_0^h expm(M s) v ds。
// 常数注入段 z1 = E z0 + w；M 奇异（含稳定核素）时同样适用。
export function expmWithInput(
  m: Float64Array,
  v: Float64Array,
  n: number,
  h: number,
): { e: Float64Array; w: Float64Array; diag: ExpmResult } {
  const k = n + 1;
  const aug = new Float64Array(k * k);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i * k + j] = m[i * n + j]! * h;
    aug[i * k + n] = v[i]! * h;
  }
  const r = expm(aug, k);
  const e = new Float64Array(n * n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) e[i * n + j] = r.e[i * k + j]!;
    w[i] = r.e[i * k + n]!;
  }
  return { e, w, diag: r };
}
