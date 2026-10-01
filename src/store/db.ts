import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CalculationSnapshot, DecayNetwork, Scenario } from "../types.js";

export interface StoreRow {
  id: string;
  network_version_id: string;
  label: string;
  payload: string;
  created_at: string;
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

export class Store {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  static async open(dbPath: string): Promise<Store> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const g = globalThis as { __DECAY_SQLITE__?: { DatabaseSync: new (location: string) => DatabaseSync } };
    const mod =
      g.__DECAY_SQLITE__ ??
      ((await import(["node", "sqlite"].join(":"))) as {
        DatabaseSync: new (location: string) => DatabaseSync;
      });
    const { DatabaseSync } = mod;
    return new Store(new DatabaseSync(dbPath));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS networks (
        version_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scenarios (
        scenario_id TEXT PRIMARY KEY,
        network_version_id TEXT NOT NULL,
        label TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calculations (
        calculation_id TEXT PRIMARY KEY,
        network_version_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calc_scenario ON calculations(scenario_id);
      CREATE INDEX IF NOT EXISTS idx_scn_network ON scenarios(network_version_id);
    `);
  }

  /** 不可变写入：版本已存在时，要求内容完全一致，否则报错要求新版本号。 */
  saveNetwork(network: DecayNetwork): void {
    const existing = this.getNetwork(network.versionId);
    const payload = JSON.stringify(network);
    if (existing) {
      if (JSON.stringify(existing) !== payload) {
        throw new Error(
          `网络版本 ${network.versionId} 已存在且内容不同；请使用新版本号（旧版本不可变）`,
        );
      }
      return;
    }
    this.db
      .prepare("INSERT INTO networks(version_id, payload, created_at) VALUES (?, ?, ?)")
      .run(network.versionId, payload, network.createdAt);
  }

  getNetwork(versionId: string): DecayNetwork | null {
    const row = this.db
      .prepare("SELECT payload FROM networks WHERE version_id = ?")
      .get(versionId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as DecayNetwork) : null;
  }

  listNetworks(): StoreRow[] {
    return this.db
      .prepare("SELECT version_id AS id, '' AS label, payload, created_at FROM networks ORDER BY created_at")
      .all() as unknown as StoreRow[];
  }

  saveScenario(scenario: Scenario): void {
    const existing = this.getScenario(scenario.scenarioId);
    const payload = JSON.stringify(scenario);
    if (existing) {
      if (JSON.stringify(existing) !== payload) {
        throw new Error(
          `工况 ${scenario.scenarioId} 已存在且内容不同；请使用新工况 id（旧工况不可变）`,
        );
      }
      return;
    }
    this.db
      .prepare(
        "INSERT INTO scenarios(scenario_id, network_version_id, label, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        scenario.scenarioId,
        scenario.networkVersionId,
        scenario.label ?? scenario.scenarioId,
        payload,
        scenario.createdAt,
      );
  }

  getScenario(scenarioId: string): Scenario | null {
    const row = this.db
      .prepare("SELECT payload FROM scenarios WHERE scenario_id = ?")
      .get(scenarioId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Scenario) : null;
  }

  listScenarios(networkVersionId?: string): StoreRow[] {
    if (networkVersionId) {
      return this.db
        .prepare(
          "SELECT scenario_id AS id, network_version_id, label, payload, created_at FROM scenarios WHERE network_version_id = ? ORDER BY created_at",
        )
        .all(networkVersionId) as unknown as StoreRow[];
    }
    return this.db
      .prepare(
        "SELECT scenario_id AS id, network_version_id, label, payload, created_at FROM scenarios ORDER BY created_at",
      )
      .all() as unknown as StoreRow[];
  }

  saveCalculation(snap: CalculationSnapshot): void {
    const payload = JSON.stringify(snap);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO calculations(calculation_id, network_version_id, scenario_id, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        snap.calculationId,
        snap.networkVersionId,
        snap.scenarioId,
        snap.status,
        payload,
        snap.createdAt,
      );
  }

  getCalculation(calculationId: string): CalculationSnapshot | null {
    const row = this.db
      .prepare("SELECT payload FROM calculations WHERE calculation_id = ?")
      .get(calculationId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as CalculationSnapshot) : null;
  }

  listCalculations(scenarioId?: string): StoreRow[] {
    if (scenarioId) {
      return this.db
        .prepare(
          "SELECT calculation_id AS id, scenario_id AS network_version_id, status AS label, payload, created_at FROM calculations WHERE scenario_id = ? ORDER BY created_at",
        )
        .all(scenarioId) as unknown as StoreRow[];
    }
    return this.db
      .prepare(
        "SELECT calculation_id AS id, scenario_id AS network_version_id, status AS label, payload, created_at FROM calculations ORDER BY created_at",
      )
      .all() as unknown as StoreRow[];
  }

  close(): void {
    this.db.close();
  }
}

