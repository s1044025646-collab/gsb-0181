import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Store } from "./store/db.js";
import {
  compare,
  comparisonToCvc,
  curvesToCsv,
  getCurve,
  inspectNetwork,
  submitCalculation,
} from "./core/service.js";
import { ValidationError } from "./core/validate.js";

const PORT = Number(process.env.PORT ?? process.env.DECAY_PORT ?? 8787);
const DATA_DIR = process.env.DECAY_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "decay.sqlite");

const store = await Store.open(DB_PATH);

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("请求体不是合法 JSON") as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, dataDir: DATA_DIR, dbPath: DB_PATH });
    }

    if (req.method === "POST" && path === "/api/networks") {
      const body = await readJson(req);
      store.saveNetwork(body);
      return send(res, 200, { ok: true, inspection: inspectNetwork(body) });
    }
    if (req.method === "GET" && path === "/api/networks") {
      return send(res, 200, {
        networks: store.listNetworks().map((r) => ({
          versionId: r.id,
          createdAt: r.created_at,
        })),
      });
    }
    const netMatch = path.match(/^\/api\/networks\/([^/]+)$/);
    if (req.method === "GET" && netMatch) {
      const network = store.getNetwork(decodeURIComponent(netMatch[1]));
      if (!network) return send(res, 404, { error: "网络不存在" });
      return send(res, 200, { network, inspection: inspectNetwork(network) });
    }

    if (req.method === "POST" && path === "/api/scenarios") {
      const body = await readJson(req);
      const network = store.getNetwork(body.networkVersionId);
      if (!network) return send(res, 404, { error: `网络版本不存在: ${body.networkVersionId}` });
      store.saveScenario(body);
      return send(res, 200, { ok: true, scenarioId: body.scenarioId });
    }
    if (req.method === "GET" && path === "/api/scenarios") {
      const v = url.searchParams.get("networkVersionId") ?? undefined;
      return send(res, 200, {
        scenarios: store.listScenarios(v).map((r) => ({
          scenarioId: r.id,
          networkVersionId: r.network_version_id,
          label: r.label,
          createdAt: r.created_at,
        })),
      });
    }
    const scnMatch = path.match(/^\/api\/scenarios\/([^/]+)$/);
    if (req.method === "GET" && scnMatch) {
      const scenario = store.getScenario(decodeURIComponent(scnMatch[1]));
      if (!scenario) return send(res, 404, { error: "工况不存在" });
      return send(res, 200, { scenario });
    }

    if (req.method === "POST" && path === "/api/calculations") {
      const body = await readJson(req);
      const snap = submitCalculation(store, body.networkVersionId, body.scenarioId, {
        rtol: body.rtol,
        atol: body.atol,
      });
      return send(res, 200, { snapshot: summary(snap) });
    }
    if (req.method === "GET" && path === "/api/calculations") {
      const scn = url.searchParams.get("scenarioId") ?? undefined;
      return send(res, 200, {
        calculations: store.listCalculations(scn).map((r) => ({
          calculationId: r.id,
          scenarioId: r.network_version_id,
          status: r.label,
          createdAt: r.created_at,
        })),
      });
    }

    const calcMatch = path.match(/^\/api\/calculations\/([^/]+)$/);
    if (req.method === "GET" && calcMatch) {
      const snap = store.getCalculation(decodeURIComponent(calcMatch[1]));
      if (!snap) return send(res, 404, { error: "计算快照不存在" });
      return send(res, 200, { snapshot: snap });
    }
    const curveMatch = path.match(/^\/api\/calculations\/([^/]+)\/curves\/([^/]+)$/);
    if (req.method === "GET" && curveMatch) {
      const snap = store.getCalculation(decodeURIComponent(curveMatch[1]));
      if (!snap) return send(res, 404, { error: "计算快照不存在" });
      const curve = getCurve(snap, decodeURIComponent(curveMatch[2]));
      return send(res, 200, { calculationId: snap.calculationId, curve });
    }

    if (req.method === "GET" && path === "/api/compare") {
      const aId = url.searchParams.get("a");
      const bId = url.searchParams.get("b");
      const nuclide = url.searchParams.get("nuclide");
      if (!aId || !bId || !nuclide) {
        return send(res, 400, { error: "需要查询参数 a, b, nuclide" });
      }
      const a = store.getCalculation(aId);
      const b = store.getCalculation(bId);
      if (!a || !b) return send(res, 404, { error: "计算快照不存在" });
      const cmp = compare(a, b, nuclide);
      if (url.searchParams.get("format") === "csv") {
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
        return res.end(comparisonToCvc(cmp));
      }
      return send(res, 200, { comparison: cmp });
    }

    const exportMatch = path.match(/^\/api\/calculations\/([^/]+)\/export$/);
    if (req.method === "GET" && exportMatch) {
      const snap = store.getCalculation(decodeURIComponent(exportMatch[1]));
      if (!snap) return send(res, 404, { error: "计算快照不存在" });
      const format = url.searchParams.get("format") ?? "json";
      if (format === "csv") {
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${snap.calculationId}.csv"`,
        });
        return res.end(curvesToCsv(snap));
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(snap, null, 2));
    }

    return send(res, 404, { error: `未知路由: ${req.method} ${path}` });
  } catch (err) {
    const e = err as { name?: string; message?: string; locator?: unknown };
    if (err instanceof ValidationError || e?.name === "ValidationError") {
      return send(res, 400, {
        error: (err as Error).message,
        locator: (err as { locator?: unknown }).locator,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { statusCode?: number })?.statusCode ?? 500;
    return send(res, status, { error: message });
  }
});

function summary(snap: Awaited<ReturnType<typeof submitCalculation>>) {
  return {
    calculationId: snap.calculationId,
    networkVersionId: snap.networkVersionId,
    scenarioId: snap.scenarioId,
    status: snap.status,
    method: snap.method,
    diagnostics: snap.diagnostics,
    conservation: snap.conservation,
    untracked: snap.untracked,
    warnings: snap.warnings,
    curveCount: snap.curves.length,
    pointCount: snap.curves[0]?.points.length ?? 0,
  };
}

server.listen(PORT, () => {
  console.log(`[decay-chain] 数据目录: ${DATA_DIR}`);
  console.log(`[decay-chain] API 已启动: http://localhost:${PORT}`);
});
