// A small D1Database stand-in on node:sqlite, loaded with the real migration, for tests.
// D1's ?1, ?2 placeholders are rewritten to named parameters because node:sqlite treats ?NNN as named.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

// From the repo root rather than import.meta.url, which is not a file URL under the happy-dom environment.
const migrationsDir = join(process.cwd(), "migrations");

function rewrite(sql: string): string {
  return sql.replace(/\?(\d+)/g, (_m, n) => `$p${n}`);
}

function params(args: unknown[]): Record<string, null | number | string> {
  const out: Record<string, null | number | string> = {};
  args.forEach((v, i) => {
    out[`p${i + 1}`] = v === undefined ? null : (v as null | number | string);
  });
  return out;
}

export interface TestD1 {
  db: D1Database;
  raw: DatabaseSync;
}

export function createTestD1(): TestD1 {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }

  const statement = (sql: string, args: unknown[] = []) => {
    const run = () => raw.prepare(rewrite(sql)).run(params(args));
    const stmt = {
      bind: (...a: unknown[]) => statement(sql, a),
      first: async <T = Row>(): Promise<T | null> => {
        const row = raw.prepare(rewrite(sql)).get(params(args)) as Row | undefined;
        return row ? ({ ...row } as T) : null;
      },
      all: async <T = Row>() => ({
        results: (raw.prepare(rewrite(sql)).all(params(args)) as Row[]).map((r) => ({ ...r }) as T),
        success: true,
        meta: {},
      }),
      run: async () => ({ success: true, meta: { changes: Number(run().changes) } }),
      __run: run,
    };
    return stmt;
  };

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: Array<{ __run: () => unknown }>) => {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          s.__run();
          return { success: true, meta: {} };
        });
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { db: db as unknown as D1Database, raw };
}
