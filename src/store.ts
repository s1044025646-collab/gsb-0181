import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NetworkInput, RunResult, ScenarioInput } from './types.js';
import { validateAndBuild, BuiltNetwork } from './network.js';

function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS networks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        network_id TEXT NOT NULL REFERENCES networks(id),
        content_hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        network_id TEXT NOT NULL,
        network_version INTEGER NOT NULL,
        scenario_id TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  importNetwork(input: NetworkInput): { id: string; version: number; reused: boolean } {
    const hash = sha256(canonical(input));
    const existing = this.db
      .prepare('SELECT id, version FROM networks WHERE content_hash = ?')
      .get(hash) as { id: string; version: number } | undefined;
    if (existing) return { ...existing, reused: true };

    const row = this.db
      .prepare(
        "SELECT id, version FROM networks WHERE name = ? ORDER BY version DESC LIMIT 1",
      )
      .get(input.name) as { id: string; version: number } | undefined;
    const version = row ? row.version + 1 : 1;
    // id 由名字决定，便于同名网络定位版本
    const baseId = row?.id ?? `${slug(input.name)}-${hash.slice(0, 8)}`;
    const id = version === 1 ? baseId : `${baseId}-v${version}`;
    validateAndBuild(input, id, version); // 导入即校验
    this.db
      .prepare(
        'INSERT INTO networks (id, name, version, content_hash, payload) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name, version, hash, canonical(input));
    return { id, version, reused: false };
  }

  getNetwork(id: string): { input: NetworkInput; version: number } {
    const row = this.db
      .prepare('SELECT payload, version FROM networks WHERE id = ?')
      .get(id) as { payload: string; version: number } | undefined;
    if (!row) throw new Error(`网络 "${id}" 不存在`);
    return { input: JSON.parse(row.payload) as NetworkInput, version: row.version };
  }

  buildNetwork(id: string): BuiltNetwork {
    const { input, version } = this.getNetwork(id);
    return validateAndBuild(input, id, version);
  }

  listNetworks(): unknown[] {
    return this.db
      .prepare('SELECT id, name, version, created_at FROM networks ORDER BY rowid')
      .all();
  }

  createScenario(input: ScenarioInput): { id: string; reused: boolean } {
    const networkId = input.networkId;
    if (!networkId) throw new Error('scenario.networkId 不能为空');
    this.getNetwork(networkId); // 确保存在
    const hash = sha256(canonical({ ...input, networkId }));
    const existing = this.db
      .prepare('SELECT id FROM scenarios WHERE content_hash = ?')
      .get(hash) as { id: string } | undefined;
    if (existing) return { id: existing.id, reused: true };
    const id = `${slug(input.name)}-${hash.slice(0, 8)}`;
    this.db
      .prepare(
        'INSERT INTO scenarios (id, name, network_id, content_hash, payload) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name, networkId, hash, canonical({ ...input, networkId }));
    return { id, reused: false };
  }

  getScenario(id: string): { input: ScenarioInput; networkId: string } {
    const row = this.db
      .prepare('SELECT payload FROM scenarios WHERE id = ?')
      .get(id) as { payload: string } | undefined;
    if (!row) throw new Error(`工况 "${id}" 不存在`);
    const parsed = JSON.parse(row.payload) as ScenarioInput & { networkId: string };
    const { networkId, ...input } = parsed;
    return { input: input as ScenarioInput, networkId };
  }

  listScenarios(networkId?: string): unknown[] {
    if (networkId)
      return this.db
        .prepare(
          'SELECT id, name, network_id, created_at FROM scenarios WHERE network_id = ? ORDER BY rowid',
        )
        .all(networkId);
    return this.db
      .prepare('SELECT id, name, network_id, created_at FROM scenarios ORDER BY rowid')
      .all();
  }

  saveRun(
    networkId: string,
    networkVersion: number,
    scenarioId: string,
    result: RunResult,
  ): { id: string; reused: boolean } {
    const hash = sha256(canonical({ networkId, networkVersion, scenarioId, result }));
    const existing = this.db
      .prepare('SELECT id FROM runs WHERE content_hash = ?')
      .get(hash) as { id: string } | undefined;
    if (existing) return { id: existing.id, reused: true };
    const id = `run-${hash.slice(0, 12)}`;
    this.db
      .prepare(
        `INSERT INTO runs (id, network_id, network_version, scenario_id, content_hash, result)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        networkId,
        networkVersion,
        scenarioId,
        hash,
        JSON.stringify(stripUndefined(result)),
      );
    return { id, reused: false };
  }

  getRun(id: string): RunResult {
    const row = this.db
      .prepare('SELECT result FROM runs WHERE id = ?')
      .get(id) as { result: string } | undefined;
    if (!row) throw new Error(`计算结果 "${id}" 不存在`);
    return JSON.parse(row.result) as RunResult;
  }

  listRuns(): unknown[] {
    return this.db
      .prepare(
        'SELECT id, network_id, network_version, scenario_id, created_at FROM runs ORDER BY rowid',
      )
      .all();
  }
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

function slug(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return ascii || 'net';
}
