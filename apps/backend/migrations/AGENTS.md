# PostgreSQL migration instructions

These rules govern every file in `apps/backend/migrations/`.

- Create forward-only migrations named
  `YYYYMMDDHHMMSS_short_snake_case_description.sql`, using a UTC timestamp.
- Never edit or delete a migration after it has been applied. Create a new
  forward migration to correct it. The runner rejects checksum drift and
  missing applied files.
- Keep each migration focused on one schema change. Prefer expand-and-contract
  changes that remain compatible with the currently deployed application.
- Do not add `BEGIN`, `COMMIT`, or `ROLLBACK`. The migration runner applies each
  file in its own transaction and records it atomically.
- Prefer static SQL. Parameterize runtime SQL in application code. When
  PostgreSQL dynamic SQL is unavoidable, use `EXECUTE ... USING` for values and
  `format('%I', identifier)` only for reviewed identifiers.
- Give every `SECURITY DEFINER` function an explicit trusted `search_path` and
  schema-qualify referenced objects.
- Make ownership, runtime grants, constraints, indexes, and row-level security
  decisions explicit. Use least privilege.
- Assess lock duration, table rewrites, backfill size, and rollback strategy in
  the pull request. Split high-risk data backfills from schema expansion.
- Never put credentials, production data, customer data, or environment-specific
  resource names in a migration.
- Do not run migrations from application startup. Production migrations run as
  a separately approved Cloud Run Job before the compatible service release.

Copy `_MIGRATION_TEMPLATE.sql` when starting a migration. Run the SQL security
scanner and migration status command before requesting review.
