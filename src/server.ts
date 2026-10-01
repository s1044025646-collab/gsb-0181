import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Service } from './service.js';
import { ValidationError } from './network.js';
import { DEFAULT_MAX_POINTS } from './solver.js';
import { runToCSV, edgeDecaysToCSV } from './export.js';
import { NetworkInput, ScenarioInput } from './types.js';

const PORT = Number(process.env.PORT ?? process.env.DECAY_PORT ?? 8080);
const DATA_DIR = process.env.DECAY_DATA_DIR
  ? resolve(process.env.DECAY_DATA_DIR)
  : resolve(process.cwd(), 'data');
const DB_PATH = resolve(DATA_DIR, 'decay.sqlite');

const store = new Store(DB_PATH);
const service = new Service(store, { maxPoints: DEFAULT_MAX_POINTS });

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 8 * 1024 * 1024) throw new ValidationError('请求体超过 8 MiB', 'request.body');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && path === '/health')
      return send(res, 200, { ok: true, dbPath: DB_PATH });
    if (req.method === 'GET' && path === '/api/networks')
      return send(res, 200, store.listNetworks());
    if (req.method === 'POST' && path === '/api/networks') {
      const body = (await readBody(req)) as NetworkInput;
      const result = store.importNetwork(body);
      return send(res, 200, result);
    }
    const netMatch = path.match(/^\/api\/networks\/([^/]+)$/);
    if (req.method === 'GET' && netMatch)
      return send(res, 200, service.inspectNetwork(decodeURIComponent(netMatch[1]!)));

    if (req.method === 'GET' && path === '/api/scenarios')
      return send(res, 200, store.listScenarios(url.searchParams.get('networkId') ?? undefined));
    if (req.method === 'POST' && path === '/api/scenarios') {
      const body = (await readBody(req)) as ScenarioInput;
      const created = store.createScenario(body);
      return send(res, 200, created);
    }
    if (req.method === 'POST' && path === '/api/runs') {
      // 允许 {scenarioId} 直接提交，或内联完整工况。
      const body = (await readBody(req)) as (ScenarioInput & { networkId: string }) | { scenarioId: string };
      if ('scenarioId' in body && typeof (body as { scenarioId?: unknown }).scenarioId === 'string') {
        const out = service.submitRun((body as { scenarioId: string }).scenarioId);
        return send(res, 200, { runId: out.runId, reused: out.reused, result: out.result });
      }
      const out = service.submitScenario(body as ScenarioInput);
      return send(res, 200, out);
    }
    if (req.method === 'GET' && path === '/api/runs')
      return send(res, 200, store.listRuns());
    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === 'GET' && runMatch)
      return send(res, 200, store.getRun(decodeURIComponent(runMatch[1]!)));
    const curveMatch = path.match(/^\/api\/runs\/([^/]+)\/curves\/([^/]+)$/);
    if (req.method === 'GET' && curveMatch)
      return send(
        res,
        200,
        service.getCurve(decodeURIComponent(curveMatch[1]!), decodeURIComponent(curveMatch[2]!)),
      );
    if (req.method === 'POST' && path === '/api/compare') {
      const body = (await readBody(req)) as { runIds: string[] };
      if (!Array.isArray(body.runIds) || body.runIds.length < 1)
        throw new ValidationError('runIds 必须为非空数组', 'request.runIds');
      return send(res, 200, service.compareRuns(body.runIds));
    }
    const exportMatch = path.match(/^\/api\/runs\/([^/]+)\/export$/);
    if (req.method === 'GET' && exportMatch) {
      const result = store.getRun(decodeURIComponent(exportMatch[1]!));
      const format = url.searchParams.get('format') ?? 'json';
      const nuc = url.searchParams.get('nuclide') ?? undefined;
      if (format === 'csv') {
        const which = url.searchParams.get('kind') ?? 'atoms';
        const text =
          which === 'edges' ? edgeDecaysToCSV(result) : runToCSV(result, nuc);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${exportMatch[1]}-${which}.csv"`,
        });
        return res.end(text);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result, null, 2));
    }
    return send(res, 404, { error: 'not found', path });
  } catch (err) {
    if (err instanceof ValidationError)
      return send(res, 400, { error: err.message, location: err.location });
    if (err instanceof SyntaxError)
      return send(res, 400, { error: `JSON 解析失败: ${err.message}`, location: 'request.body' });
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('不存在')) return send(res, 404, { error: message });
    return send(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`[decay-chain] 数据目录: ${DATA_DIR}`);
  console.log(`[decay-chain] SQLite:   ${DB_PATH}`);
  console.log(`[decay-chain] 监听端口: http://localhost:${PORT}`);
});
