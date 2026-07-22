# PostgreSQL migrations

This directory is the ordered, immutable history of the application's
PostgreSQL schema. PostgreSQL is the default database, with Cloud SQL
as the production service.

## Create a migration

1. Copy `_MIGRATION_TEMPLATE.sql` to a name such as
   `20260715143000_add_account_status.sql`. Use the current UTC timestamp.
2. Replace the commented checklist with one focused, forward-compatible change.
3. Run `npm run security:sql` and `npm run db:migrate:status` from the repository
   root. Substitute the repository's selected package manager when needed.
4. Test the migration against a disposable local PostgreSQL database before the
   full integration gate.

Files beginning with `_` are documentation or templates and are not executed.
Applied migration files are immutable: changing their bytes changes the SHA-256
checksum and the runner will stop. A newly added file must sort after all
applied files; use a new current timestamp instead of inserting history.

## Runner behavior

`scripts/database/postgres-migration-runner.ts` supports two explicit commands:

- `db:migrate:status` validates history and lists pending migrations.
- `db:migrate` acquires a database advisory lock, applies each pending file in
  its own transaction, and records its checksum in
  `public.app_schema_migrations`.

The runner accepts `DATABASE_URL`, or PostgreSQL's standard `PGHOST`,
`PGDATABASE`, and `PGUSER` variables. Authentication can use the remaining
standard `PG*` variables. It never runs automatically during app startup,
installation, a quality gate, or local development.

Production execution belongs in a separately approved Cloud Run Job. A failed
migration is corrected with a new forward migration, not by editing history.
