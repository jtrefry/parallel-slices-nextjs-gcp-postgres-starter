#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

export type Migration = {
  name: string;
  path: string;
  checksum: string;
  sql: string;
};

type AppliedMigration = {
  name: string;
  checksum: string;
  applied_at: Date;
};

const migrationNamePattern = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const advisoryLockName = "app-schema-migrations";

function fail(message: string): never {
  throw new Error(message);
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function discoverMigrations(root = process.cwd()): Migration[] {
  const directory = resolve(root, "apps/backend/migrations");
  if (!existsSync(directory)) {
    fail("apps/backend/migrations is missing");
  }
  if (lstatSync(directory).isSymbolicLink()) {
    fail("apps/backend/migrations must not be a symbolic link");
  }

  const entries = readdirSync(directory, { withFileTypes: true });
  const symlink = entries.find((entry) => entry.isSymbolicLink());
  if (symlink)
    fail(`migration entry must not be a symbolic link: ${symlink.name}`);

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .filter((entry) => !entry.name.startsWith("_"))
    .map((entry) => {
      if (!migrationNamePattern.test(entry.name)) {
        fail(
          `invalid migration filename: ${entry.name}; use YYYYMMDDHHMMSS_description.sql`,
        );
      }
      const path = resolve(directory, entry.name);
      const sql = readFileSync(path, "utf8");
      if (!sql.trim()) fail(`migration is empty: ${entry.name}`);
      if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;\s*(?:--.*)?$/im.test(sql)) {
        fail(`migration contains transaction control: ${entry.name}`);
      }
      return { name: entry.name, path, checksum: checksum(sql), sql };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function validateMigrationHistory(
  migrations: Migration[],
  applied: AppliedMigration[],
): Migration[] {
  const available = new Map(
    migrations.map((migration) => [migration.name, migration]),
  );
  const appliedNames = new Set(applied.map((migration) => migration.name));

  for (const record of applied) {
    const migration = available.get(record.name);
    if (!migration) {
      fail(`applied migration file is missing: ${record.name}`);
    }
    if (migration.checksum !== record.checksum) {
      fail(`applied migration was modified: ${record.name}`);
    }
  }
  const pending = migrations.filter(
    (migration) => !appliedNames.has(migration.name),
  );
  const latestApplied = applied
    .map((migration) => migration.name)
    .sort((left, right) => right.localeCompare(left))[0];
  const outOfOrder = latestApplied
    ? pending.find((migration) => migration.name < latestApplied)
    : undefined;
  if (outOfOrder) {
    fail(
      `pending migration sorts before applied history: ${outOfOrder.name}; create a new later migration`,
    );
  }
  return pending;
}

function assertDatabaseConfiguration(): void {
  const hasUrl = Boolean(process.env.DATABASE_URL);
  const hasPgEnvironment = Boolean(
    process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER,
  );
  if (!hasUrl && !hasPgEnvironment) {
    fail(
      "set DATABASE_URL or PGHOST, PGDATABASE, and PGUSER before running migrations",
    );
  }
}

async function ensureMigrationTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
      name text PRIMARY KEY,
      checksum character(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readAppliedMigrations(
  client: Client,
): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(`
    SELECT name, checksum, applied_at
    FROM public.app_schema_migrations
    ORDER BY name
  `);
  return result.rows;
}

async function applyMigration(
  client: Client,
  migration: Migration,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '5min'");
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO public.app_schema_migrations (name, checksum)
       VALUES ($1, $2)`,
      [migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function runMigrations(
  command: "status" | "up",
  root = process.cwd(),
): Promise<void> {
  assertDatabaseConfiguration();
  const migrations = discoverMigrations(root);
  const client = new Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : undefined,
  );
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      advisoryLockName,
    ]);
    try {
      await ensureMigrationTable(client);
      const applied = await readAppliedMigrations(client);
      const pending = validateMigrationHistory(migrations, applied);
      console.log(
        `database migrations: ${applied.length} applied, ${pending.length} pending`,
      );
      if (command === "status") {
        for (const migration of pending)
          console.log(`pending: ${migration.name}`);
        return;
      }
      for (const migration of pending) {
        console.log(`applying: ${migration.name}`);
        await applyMigration(client, migration);
      }
      console.log(`database migrations complete: ${pending.length} applied`);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [advisoryLockName])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

function parseCommand(value: string | undefined): "status" | "up" {
  if (value === "status" || value === "up") return value;
  fail("usage: postgres-migration-runner.ts <status|up>");
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  runMigrations(parseCommand(process.argv[2])).catch((error: Error) => {
    console.error(`DATABASE MIGRATION FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
