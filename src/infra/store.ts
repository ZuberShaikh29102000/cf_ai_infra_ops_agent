import type {
  Environment,
  Resource,
  ResourceStatus,
  ResourceType
} from "./types";

// The agent's `this.sql` tagged template (from the Agents SDK). It runs
// against the SQLite database built into this agent's Durable Object, which is
// what makes resources survive page refreshes, reconnects and DO eviction:
// every method below reads or writes SQLite directly and keeps NOTHING in
// memory, so there is no cache that an eviction could lose or leave stale.
// Each agent instance (one per chat "room") gets its own private database.
interface SqlHost {
  sql<T>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

interface Row {
  id: string;
  type: string;
  env: string;
  status: string;
  owner: string | null;
  created_at: string;
}

function toResource(row: Row): Resource {
  // Trusted cast: only this file writes to the table, and only with values
  // that already passed Zod validation in the tool layer.
  return {
    id: row.id,
    type: row.type as ResourceType,
    env: row.env as Environment,
    status: row.status as ResourceStatus,
    ...(row.owner ? { owner: row.owner } : {}),
    createdAt: row.created_at
  };
}

export class ResourceStore {
  // `onChange` fires after every write so the agent can tell connected
  // browsers to refresh their resource list.
  constructor(
    private host: SqlHost,
    private onChange: () => void = () => {}
  ) {}

  // Idempotent; called from the agent's onStart() on every wake-up.
  init() {
    this.host.sql`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        env TEXT NOT NULL,
        status TEXT NOT NULL,
        owner TEXT,
        created_at TEXT NOT NULL
      )`;
  }

  // `env` is optional: null means "all environments".
  list(env?: Environment): Resource[] {
    const filter = env ?? null;
    return this.host.sql<Row>`SELECT * FROM resources
                WHERE ${filter} IS NULL OR env = ${filter}
                ORDER BY created_at, id`.map(toResource);
  }

  get(id: string): Resource | undefined {
    const rows = this.host.sql<Row>`SELECT * FROM resources WHERE id = ${id}`;
    return rows[0] ? toResource(rows[0]) : undefined;
  }

  // Ids look like "redis-dev-01": one counter per (type, env). The provider is
  // stateless, so numbering has to live here. If the highest-numbered resource
  // is deleted, its number is reused; fine for a mock.
  nextId(type: ResourceType, env: Environment): string {
    const rows = this.host.sql<{ id: string }>`
      SELECT id FROM resources WHERE type = ${type} AND env = ${env}`;
    const highest = Math.max(
      0,
      ...rows.map((r) => Number(r.id.split("-").pop()) || 0)
    );
    return `${type}-${env}-${String(highest + 1).padStart(2, "0")}`;
  }

  insert(r: Resource) {
    this.host.sql`
      INSERT INTO resources (id, type, env, status, owner, created_at)
      VALUES (${r.id}, ${r.type}, ${r.env}, ${r.status}, ${r.owner ?? null},
              ${r.createdAt})`;
    this.onChange();
  }

  setStatus(id: string, status: ResourceStatus) {
    this.host.sql`UPDATE resources SET status = ${status} WHERE id = ${id}`;
    this.onChange();
  }

  // How many resources an environment already holds (used by the policy
  // check). `excludeId` is the resource being provisioned, which is already
  // reserved in the table and must not count against itself.
  countInEnv(env: Environment, excludeId: string): number {
    const rows = this.host.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM resources
      WHERE env = ${env} AND id != ${excludeId} AND status != 'failed'`;
    return rows[0]?.n ?? 0;
  }

  remove(id: string) {
    this.host.sql`DELETE FROM resources WHERE id = ${id}`;
    this.onChange();
  }
}
