#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Service } from './service.js';
import { ValidationError } from './network.js';
import { DEFAULT_MAX_POINTS } from './solver.js';
import { NetworkInput, ScenarioInput } from './types.js';
import { runToCSV, edgeDecaysToCSV, stableJSON } from './export.js';

const DATA_DIR = process.env.DECAY_DATA_DIR
  ? resolve(process.env.DECAY_DATA_DIR)
  : resolve(process.cwd(), 'data');

function readArg(arg?: string): unknown {
  if (!arg) return undefined;
  if (arg.startsWith('@')) return JSON.parse(readFileSync(resolve(arg.slice(1)), 'utf8'));
  return JSON.parse(arg);
}

function main(): void {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) return usage(0);
  const store = new Store(resolve(DATA_DIR, 'decay.sqlite'));
  const service = new Service(store, { maxPoints: DEFAULT_MAX_POINTS });
  try {
    switch (cmd) {
      case 'import': {
        const input = readArg(sub) as NetworkInput;
        const r = store.importNetwork(input);
        console.log(stableJSON(r).trim());
        break;
      }
      case 'inspect': {
        console.log(stableJSON(service.inspectNetwork(sub!)).trim());
        break;
      }
      case 'list': {
        if (sub === 'scenarios') console.log(stableJSON(store.listScenarios(rest[0])).trim());
        else if (sub === 'runs') console.log(stableJSON(store.listRuns()).trim());
        else console.log(stableJSON(store.listNetworks()).trim());
        break;
      }
      case 'submit': {
        const input = readArg(sub) as ScenarioInput;
        const r = service.submitScenario(input);
        console.log(stableJSON({ runId: r.runId, scenarioId: r.scenarioId, reused: r.reused }).trim());
        break;
      }
      case 'curve': {
        const [runId, nuclideId] = [sub!, rest[0]!];
        console.log(stableJSON(service.getCurve(runId, nuclideId)).trim());
        break;
      }
      case 'run': {
        console.log(stableJSON(store.getRun(sub!)).trim());
        break;
      }
      case 'compare': {
        const runIds = rest[0]!.split(',').map((s) => s.trim()).filter(Boolean);
        console.log(stableJSON(service.compareRuns([sub!, ...runIds])).trim());
        break;
      }
      case 'export': {
        const [runId, format, outFile] = [sub!, rest[0]!, rest[1]];
        const result = store.getRun(runId);
        let text: string;
        if (format === 'csv') text = runToCSV(result);
        else if (format === 'csv-edges') text = edgeDecaysToCSV(result);
        else text = stableJSON(result);
        if (outFile) {
          writeFileSync(resolve(outFile), text);
          console.log(`已写入 ${resolve(outFile)} (${text.length} 字节)`);
        } else process.stdout.write(text);
        break;
      }
      default:
        usage(1);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`校验失败 ${err.location}: ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function usage(code: number): void {
  const text = `衰变链计算后端 CLI（数据目录: ${DATA_DIR}）

用法:
  decay import '<网络JSON|@文件>'          导入/版本化衰变网络（幂等）
  decay inspect <networkId>              网络检查（拓扑、分支、未跟踪比例）
  decay list [networks|scenarios|runs]   列出对象（scenarios 可加 networkId）
  decay submit '<工况JSON|@文件>'         提交计算，输出 runId
  decay run <runId>                      查看完整计算快照 JSON
  decay curve <runId> <nuclideId>        按核素查询原子数/活度曲线
  decay compare <runIdA> <runIdB,...>    工况比较
  decay export <runId> <json|csv|csv-edges> [outFile]  导出

环境变量:
  DECAY_DATA_DIR   项目内数据目录（默认 ./data）
  PORT/DECAY_PORT  HTTP 服务端口（默认 8080）
`;
  (code === 0 ? console.log : console.error)(text);
  process.exitCode = code;
}

main();
