import { exampleNetwork, exampleScenario } from "../src/core/examples.js";

const base = process.argv[2] ?? "http://localhost:8811";

async function j(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return parsed;
}

const net = exampleNetwork();
const scn = exampleScenario();
await j("POST", "/api/networks", net);
await j("POST", "/api/scenarios", scn);
await j("POST", "/api/scenarios", {
  ...scn,
  scenarioId: "scn-example-2x",
  initialAtoms: { A: 5000, B: 0, C: 0, D: 0, E: 0, F: 0 },
});

const r1 = await j("POST", "/api/calculations", {
  networkVersionId: net.versionId,
  scenarioId: scn.scenarioId,
});
const r2 = await j("POST", "/api/calculations", {
  networkVersionId: net.versionId,
  scenarioId: "scn-example-2x",
});
const id1 = r1.snapshot.calculationId;
const id2 = r2.snapshot.calculationId;

const curve = await j("GET", `/api/calculations/${id1}/curves/E`);
const cmp = await j("GET", `/api/compare?a=${id1}&b=${id2}&nuclide=E`);
const csv = await (await fetch(`${base}/api/calculations/${id1}/export?format=csv`)).text();
const inspect = await j("GET", `/api/networks/${net.versionId}`);

const bad = await fetch(`${base}/api/networks`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...net,
    versionId: net.versionId + "-bad",
    nuclides: [...net.nuclides, { id: "X", halfLife: -1 }],
  }),
});

console.log(JSON.stringify({
  inspection: {
    stable: inspect.inspection.stableNuclides,
    order: inspect.inspection.topologicalOrder,
  },
  calc1: {
    id: id1,
    status: r1.snapshot.status,
    relResidual: r1.snapshot.conservation.relativeResidual,
  },
  curveE_end: curve.curve.points.at(-1),
  compareE: {
    maxAbs: cmp.comparison.maxAbsDeltaAtoms,
    maxRel: cmp.comparison.maxRelDeltaAtoms,
  },
  csvFirstLine: csv.split("\n")[0].slice(0, 80) + "...",
  badBranchStatus: bad.status,
}, null, 2));
