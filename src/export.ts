import { RunResult } from './types.js';

export function runToCSV(result: RunResult, nuclideId?: string): string {
  const rows: string[] = [];
  const header = [
    't_seconds',
    ...result.nuclideIds.flatMap((id) =>
      nuclideId && id !== nuclideId
        ? []
        : [`${id}_atoms`, `${id}_activity_Bq`],
    ),
  ];
  rows.push(header.join(','));
  for (let p = 0; p < result.times.length; p++) {
    const cols: string[] = [num(result.times[p]!)];
    result.nuclideIds.forEach((id, i) => {
      if (nuclideId && id !== nuclideId) return;
      cols.push(num(result.atoms[i]![p]!), num(result.activity[i]![p]!));
    });
    rows.push(cols.join(','));
  }
  return rows.join('\n') + '\n';
}

export function edgeDecaysToCSV(result: RunResult): string {
  const keys = Object.keys(result.edgeDecays).sort();
  const rows: string[] = [
    ['t_seconds', ...keys.map((k) => `${k}_cumulative_decays`)].join(','),
  ];
  for (let p = 0; p < result.times.length; p++) {
    const line = [result.times[p]!.toString(), ...keys.map((k) => num(result.edgeDecays[k]![p]!))];
    rows.push(line.join(','));
  }
  return rows.join('\n') + '\n';
}

function num(v: number): string {
  // 稳定、可比较的数字格式：15 位有效数字，指数表示。
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e15) return Number(v.toPrecision(12)).toString();
  return v.toExponential(12);
}

export function stableJSON(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
