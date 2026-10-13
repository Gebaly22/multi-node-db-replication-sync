# Known issues and limitations

## Data consistency

- Sync replaces entire target tables. Target-only edits are discarded; an empty source clears both targets. No continuous replication, merge, conflict resolution, or preview exists.
- Targets commit independently. A second-hop failure leaves the first target changed; no distributed transaction or automatic recovery exists.
- The web app re-reads the VM between container/SQL hops. Concurrent CRUD can alter this dataset. Its process-local sync flag covers neither CRUD, other instances, nor standalone sync.
- Manual MAX(id) + 1 permits concurrent primary-key collisions. Deletes renumber surviving IDs, making IDs unsuitable as stable external references. Foreign keys can obstruct truncation/renumbering; PostgreSQL in-place renumbering may encounter uniqueness conflicts.
- PostgreSQL sequence updates have different rollback semantics from row updates; inspect counters after failures.
- Rows are held in memory, PostgreSQL inserts are sequential, and SQL inserts use one batch with five parameters per row. Large datasets can hit memory, parameter-count, or proxy timeout limits. No chunking or pagination exists.

## Security and error handling

- Database passwords are required and have no built-in defaults. Use .env secrets; Docker inspection privileges permit inspecting container environment values.
- Endpoints have no authentication, authorization, or CSRF protection. Published ports are reachable on host interfaces permitted by firewall rules; restrict access to the demo.
- Stored values and errors enter HTML without escaping, creating an XSS risk.
- SQL encryption is disabled and server certificates are trusted. Nginx uses HTTP without TLS.
- SQL insert catch handlers do not explicitly roll back. The web startup SQL promise has no immediate rejection handler or reconnect strategy. PostgreSQL insert/delete acquire clients outside route try blocks.
- Standalone sync connects to SQL before validating the source. SQL failure can turn invalid-source requests into HTTP 500 and prevent the first PostgreSQL copy. Sync rollback errors may obscure original failures.

## Deployment and schema

- Provision external databases, accounts, grants, listeners, routing, and firewall rules separately. Compose waits only for local PostgreSQL, with no external database or HTTP readiness checks.
- A Hyper-V internal switch alone does not establish Docker-to-VM routing.
- Fixed employee-net, postgres-db container name, 172.20.0.0/24 subnet, and published ports can conflict with other deployments.
- PostgreSQL initialization and credentials apply only to an empty volume. Changing .env does not change existing database credentials. Compose down retains the volume; removing it destroys data.
- DDL creates missing objects but does not migrate schemas or reconcile sequence values. Apply PostgreSQL DDL as database owner; use dbo as the SQL application's default schema.
- String encoding/collation differs between PostgreSQL and SQL Server. SQL bindings use VarChar, not Unicode NVarChar.
- npm install, dependency ranges, and moving base-image tags prevent fully reproducible builds.
- TAR archives remain on disk and are excluded from Git/build contexts; Compose does not use them. Archived backend may differ. Ignore rules do not untrack previously committed archives.

The active standalone service also retains direct copies without a concurrency guard. Avoid reconciling concurrently with web sync or CRUD.

## Design history

The project began with PostgreSQL streaming replication, then moved to bidirectional logical replication. Race conditions and ID collisions led to odd/even sequence partitioning before the project settled on on-demand manual sync. These are historical stages; the current implementation uses manual sync and increment-one sequences, not the earlier replication setup.
