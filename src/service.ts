import { RunResult, ScenarioInput } from './types.js';
import { Store } from './store.js';
import { solve, SolveOptions } from './solver.js';
import { ValidationError } from './network.js';

export class Service {
  constructor(
    readonly store: Store,
    readonly solveOptions: SolveOptions = {},
  ) {}

 inspectNetwork(id: string) {
    return this.store.buildNetwork(id).view;
  }

  submitRun(scenarioId: string): { runId: string; reused: boolean; result: RunResult } {
    const { input, networkId } = this.store.getScenario(scenarioId);
    const built = this.store.buildNetwork(networkId);
    const tempId = 'pending';
    const result = solve(
      built,
      input,
      tempId,
      networkId,
      scenarioId,
      this.solveOptions,
    );
    const saved = this.store.saveRun(
      networkId,
      built.view.version,
      scenarioId,
      result,
    );
    result.runId = saved.id;
    return { runId: saved.id, reused: saved.reused, result };
  }

  // 便捷：直接用工况对象计算（不落库工况，结果落库需先存工况）。
  submitScenario(
    input: ScenarioInput,
  ): { scenarioId: string; runId: string; reused: boolean; result: RunResult } {
    const sc = this.store.createScenario(input);
    const run = this.submitRun(sc.id);
    return { scenarioId: sc.id, runId: run.runId, reused: run.reused, result: run.result };
  }

  getCurve(runId: string, nuclideId: string) {
    const result = this.store.getRun(runId);
    const idx = result.nuclideIds.indexOf(nuclideId);
    if (idx < 0)
      throw new ValidationError(
        `结果中不存在核素 "${nuclideId}"`,
        `run:${runId}.nuclide:${nuclideId}`,
      );
    return {
      runId,
      nuclideId,
      points: result.times.map((t, p) => ({
        t,
        atoms: result.atoms[idx]![p],
        activity: result.activity[idx]![p],
      })),
    };
  }

  compareRuns(runIds: string[]) {
    const results = runIds.map((id) => this.store.getRun(id));
    const commonNuclides = results.reduce<string[]>(
      (acc, r) => acc.filter((id) => r.nuclideIds.includes(id)),
      results[0]?.nuclideIds ?? [],
    );
    const summary = results.map((r) => ({
      runId: r.runId,
      networkVersion: r.networkVersion,
      scenarioId: r.scenarioId,
      pointCount: r.diagnostics.pointCount,
      finalAtoms: Object.fromEntries(
        r.nuclideIds.map((id, i) => [id, r.atoms[i]![r.times.length - 1]]),
      ),
      finalActivity: Object.fromEntries(
        r.nuclideIds.map((id, i) => [id, r.activity[i]![r.times.length - 1]]),
      ),
      totalEdgeDecays: Object.fromEntries(
        Object.entries(r.edgeDecays).map(([k, arr]) => [k, arr[arr.length - 1]]),
      ),
      injectedTotal: r.diagnostics.injectedTotal,
      untrackedLoss: r.diagnostics.untrackedLoss,
      conservationError: r.diagnostics.conservationError,
      warnings: r.diagnostics.warnings,
    }));
    // 公共网格 + 公共核素上的最大差值（网格不同则只给摘要）。
    let maxAtomDifference: unknown = null;
    if (results.length >= 2 && results.every((r) => arrayEq(r.times, results[0]!.times))) {
      maxAtomDifference = Object.fromEntries(
        commonNuclides.map((id) => {
          const is = results.map((r) => r.nuclideIds.indexOf(id));
          let d = 0;
          for (let p = 0; p < results[0]!.times.length; p++)
            for (let k = 1; k < results.length; k++)
              d = Math.max(d, Math.abs(results[k]!.atoms[is[k]!]![p]! - results[0]!.atoms[is[0]!]![p]!));
          return [id, d];
        }),
      );
    }
    return { runs: summary, commonNuclides, maxAtomDifference };
  }
}

function arrayEq(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
