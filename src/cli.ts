#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store } from "./store/db.js";
import {
  compare,
  comparisonToCvc,
  curvesToCsv,
  formatNumber,
  getCurve,
  inspectNetwork,
  submitCalculation,
} from "./core/service.js";
import { exampleNetwork, exampleScenario, equalHalfLifeNetwork, equalHalfLifeScenario } from "./core/examples.js";
import { ValidationError } from "./core/validate.js";

interface CliOptions {
  dataDir: string;
}

function parseArgs(argv: string[]): { command: string; args: string[]; opts: CliOptions } {
  const opts: CliOptions = {
    dataDir: process.env.DECAY_DATA_DIR ?? join(process.cwd(), "data"),
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir") opts.dataDir = resolve(argv[++i]);
    else rest.push(argv[i]);
  }
  return { command: rest[0] ?? "help", args: rest.slice(1), opts };
}

function readJsonFile(path: string): any {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

function printJson(x: unknown): void {
  process.stdout.write(JSON.stringify(x, null, 2) + "\n");
}

async function main(): Promise<void> {
  const { command, args, opts } = parseArgs(process.argv.slice(2));
  mkdirSync(opts.dataDir, { recursive: true });
  const store = await Store.open(join(opts.dataDir, "decay.sqlite"));

  try {
    switch (command) {
      case "import-network": {
        const network = readJsonFile(args[0]);
        store.saveNetwork(network);
        printJson({ ok: true, inspection: inspectNetwork(network) });
        break;
      }
      case "inspect": {
        const network = store.getNetwork(args[0]);
        if (!network) throw new Error(`网络不存在: ${args[0]}`);
        printJson(inspectNetwork(network));
        break;
      }
      case "import-scenario": {
        const scenario = readJsonFile(args[0]);
        if (!store.getNetwork(scenario.networkVersionId)) {
          throw new Error(`网络版本不存在: ${scenario.networkVersionId}`);
        }
        store.saveScenario(scenario);
        printJson({ ok: true, scenarioId: scenario.scenarioId });
        break;
      }
      case "run": {
        const snap = submitCalculation(store, args[0], args[1], {
          rtol: args[2] ? Number(args[2]) : undefined,
          atol: args[3] ? Number(args[3]) : undefined,
        });
        printJson({
          calculationId: snap.calculationId,
          status: snap.status,
          diagnostics: snap.diagnostics,
          conservation: snap.conservation,
          untracked: snap.untracked,
          warnings: snap.warnings,
        });
        console.error(`calculationId=${snap.calculationId}`);
        break;
      }
      case "curve": {
        const snap = store.getCalculation(args[0]);
        if (!snap) throw new Error(`计算不存在: ${args[0]}`);
        printJson(getCurve(snap, args[1]));
        break;
      }
      case "compare": {
        const [aId, bId, nuclide] = args;
        const a = store.getCalculation(aId);
        const b = store.getCalculation(bId);
        if (!a || !b) throw new Error("计算快照不存在");
        const cmp = compare(a, b, nuclide);
        printJson({
          nuclideId: cmp.nuclideId,
          maxAbsDeltaAtoms: cmp.maxAbsDeltaAtoms,
          maxRelDeltaAtoms: cmp.maxRelDeltaAtoms,
          rows: cmp.rows,
        });
        break;
      }
      case "export": {
        const [calcId, outPath] = args;
        const snap = store.getCalculation(calcId);
        if (!snap) throw new Error(`计算不存在: ${calcId}`);
        if (outPath.endsWith(".csv")) {
          mkdirSync(dirname(resolve(outPath)), { recursive: true });
          writeFileSync(resolve(outPath), curvesToCsv(snap), "utf-8");
        } else if (outPath.endsWith(".compare.csv")) {
          throw new Error("比较导出请使用 export-compare");
        } else {
          mkdirSync(dirname(resolve(outPath)), { recursive: true });
          writeFileSync(resolve(outPath), JSON.stringify(snap, null, 2), "utf-8");
        }
        printJson({ ok: true, out: resolve(outPath) });
        break;
      }
      case "export-compare": {
        const [aId, bId, nuclide, outPath] = args;
        const a = store.getCalculation(aId);
        const b = store.getCalculation(bId);
        if (!a || !b) throw new Error("计算快照不存在");
        mkdirSync(dirname(resolve(outPath)), { recursive: true });
        writeFileSync(resolve(outPath), comparisonToCvc(compare(a, b, nuclide)), "utf-8");
        printJson({ ok: true, out: resolve(outPath) });
        break;
      }
      case "list": {
        printJson({
          networks: store.listNetworks().map((r) => r.id),
          scenarios: store.listScenarios().map((r) => ({
            scenarioId: r.id,
            networkVersionId: r.network_version_id,
            label: r.label,
          })),
          calculations: store.listCalculations().map((r) => ({
            calculationId: r.id,
            scenarioId: r.network_version_id,
            status: r.label,
          })),
        });
        break;
      }
      case "seed-examples": {
        const net = exampleNetwork();
        const scn = exampleScenario();
        const net2 = equalHalfLifeNetwork();
        const scn2 = equalHalfLifeScenario();
        store.saveNetwork(net);
        store.saveScenario(scn);
        store.saveNetwork(net2);
        store.saveScenario(scn2);
        printJson({ ok: true, networks: [net.versionId, net2.versionId], scenarios: [scn.scenarioId, scn2.scenarioId] });
        break;
      }
      default:
        process.stdout.write(
          [
            "decay-cli <command> [--data-dir DIR]",
            "  import-network <network.json>",
            "  inspect <networkVersionId>",
            "  import-scenario <scenario.json>",
            "  run <networkVersionId> <scenarioId> [rtol] [atol]   # 输出诊断，calculationId 打到 stderr",
            "  curve <calculationId> <nuclideId>",
            "  compare <calcA> <calcB> <nuclideId>",
            "  export <calculationId> <out.json|out.csv>",
            "  export-compare <calcA> <calcB> <nuclideId> <out.csv>",
            "  list",
            "  seed-examples",
          ].join("\n") + "\n",
        );
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(JSON.stringify({ error: err.message, locator: err.locator }, null, 2));
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

void formatNumber;
void main();
