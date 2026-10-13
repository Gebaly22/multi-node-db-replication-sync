// sync-service.js
// Dedicated standalone reconciliation service engine.
// Continuous background polling is disabled—synchronization is executed strictly on demand via HTTP trigger.

const requiredDbEnv = [
  "CONTAINER_DB_HOST", "CONTAINER_DB_USER", "CONTAINER_DB_PASSWORD", "CONTAINER_DB_NAME",
  "VM_DB_HOST", "VM_DB_USER", "VM_DB_PASSWORD", "VM_DB_NAME",
  "SQL_DB_HOST", "SQL_DB_USER", "SQL_DB_PASSWORD", "SQL_DB_NAME",
];
const missingDbEnv = requiredDbEnv.filter((name) => !process.env[name]?.trim());
if (missingDbEnv.length > 0) {
  console.error(`Missing required database environment variables: ${missingDbEnv.join(", ")}. Configure them before starting.`);
  process.exit(1);
}

const express = require("express");
const { Pool } = require("pg");
const sql = require("mssql");

const app = express();
app.use(express.json());

// ==========================================
// 1. CONNECTION MECHANICS & EXPLANATIONS
// ==========================================

/*
 * VM CONNECTION MECHANICS:
 * - Driver: PostgreSQL Client Pool ('pg')
 * - Routing: Direct TCP Connection to '192.168.56.10:5432'
 * - Hyper-V Setup: Uses Hyper-V Internal Virtual Switch adapter.
 *   The Windows Host acts as gateway '192.168.56.1' while the VM receives IP '192.168.56.10'.
 */
const vmPgPool = new Pool({
  user: process.env.VM_DB_USER,
  host: process.env.VM_DB_HOST,
  database: process.env.VM_DB_NAME,
  password: process.env.VM_DB_PASSWORD,
  port: 5432,
});
vmPgPool.on("error", (err) =>
  console.error("[Sync Service] VM Pool Error:", err),
);

/*
 * CONTAINER CONNECTION MECHANICS:
 * - Driver: PostgreSQL Client Pool ('pg')
 * - Routing: Connected to user-defined Docker Network 'employee-net' on static IP '172.20.0.10:5432'.
 */
const containerPgPool = new Pool({
  user: process.env.CONTAINER_DB_USER,
  host: process.env.CONTAINER_DB_HOST,
  database: process.env.CONTAINER_DB_NAME,
  password: process.env.CONTAINER_DB_PASSWORD,
  port: 5432,
});
containerPgPool.on("error", (err) =>
  console.error("[Sync Service] Container Pool Error:", err),
);

/*
 * SQL SERVER CONNECTION MECHANICS:
 * - Driver: Microsoft SQL Server Client ('mssql')
 * - Routing: Direct host IP '192.168.56.1:1433' — the Windows host's own address
 *   on the same Host-Only virtual switch the VM sits on (VM = 192.168.56.10).
 * - Mechanics: This service never lets the VM and SQL Server talk directly — it
 *   holds both connections itself and copies rows between them on request.
 */
const sqlConfig = {
  user: process.env.SQL_DB_USER,
  password: process.env.SQL_DB_PASSWORD,
  server: process.env.SQL_DB_HOST,
  database: process.env.SQL_DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

function log(msg) {
  console.log(`[sync-service ${new Date().toISOString()}] ${msg}`);
}

// ==========================================
// 2. ATOMIC CLEAR & REWRITE HELPER FUNCTIONS
// ==========================================

async function clearAndRewritePostgres(pool, data) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE employees RESTART IDENTITY");

    for (const row of data) {
      await client.query(
        "INSERT INTO employees (id, name, phone_number, address, salary) VALUES ($1, $2, $3, $4, $5)",
        [row.id, row.name, row.phone_number, row.address, row.salary],
      );
    }

    if (data.length > 0) {
      await client.query(
        "SELECT setval('employees_id_seq', (SELECT MAX(id) FROM employees))",
      );
    } else {
      await client.query("ALTER SEQUENCE employees_id_seq RESTART WITH 1");
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function clearAndRewriteSqlServer(sqlPool, data) {
  const transaction = new sql.Transaction(sqlPool);

  try {
    await transaction.begin();
    const req = new sql.Request(transaction);

    // 1. Wipe existing records
    await req.query("DELETE FROM employees");

    if (data.length > 0) {
      // 2. Execute toggle and inserts in one single SQL script block
      let batchSql = "SET IDENTITY_INSERT employees ON;\n";

      data.forEach((row, i) => {
        req.input(`id_${i}`, sql.Int, row.id);
        req.input(`name_${i}`, sql.VarChar, row.name);
        req.input(`phone_${i}`, sql.VarChar, row.phone_number);
        req.input(`addr_${i}`, sql.VarChar, row.address);
        req.input(`sal_${i}`, sql.Decimal(10, 2), row.salary);

        batchSql += `INSERT INTO employees (id, name, phone_number, address, salary) VALUES (@id_${i}, @name_${i}, @phone_${i}, @addr_${i}, @sal_${i});\n`;
      });

      batchSql += "SET IDENTITY_INSERT employees OFF;\n";

      const maxId = Math.max(...data.map((r) => r.id));
      batchSql += `DBCC CHECKIDENT ('employees', RESEED, ${maxId});`;

      await req.query(batchSql);
    } else {
      await req.query("DBCC CHECKIDENT ('employees', RESEED, 0)");
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ==========================================
// 3. STANDALONE SYNC API ENDPOINT
// ==========================================

app.post("/sync", async (req, res) => {
  const { source } = req.body; // Expected payload: { "source": "container" | "vm" | "sql" }
  log(`Manual sync request received. Source node: ${source}`);

  let sqlPool;
  try {
    sqlPool = await sql.connect(sqlConfig);
    let sourceData = [];

    // Extract data from requested source
    if (source === "container") {
      const res = await containerPgPool.query(
        "SELECT id, name, phone_number, address, salary FROM employees ORDER BY id",
      );
      sourceData = res.rows;
    } else if (source === "vm") {
      const res = await vmPgPool.query(
        "SELECT id, name, phone_number, address, salary FROM employees ORDER BY id",
      );
      sourceData = res.rows;
    } else if (source === "sql") {
      const res = await sqlPool
        .request()
        .query(
          "SELECT id, name, phone_number, address, salary FROM employees ORDER BY id",
        );
      sourceData = res.recordset;
    } else {
      return res
        .status(400)
        .json({ success: false, error: "Invalid source node." });
    }

    // Replicate across target nodes
    if (source === "container") {
      await clearAndRewritePostgres(vmPgPool, sourceData);
      await clearAndRewriteSqlServer(sqlPool, sourceData);
    } else if (source === "vm") {
      await clearAndRewritePostgres(containerPgPool, sourceData);
      await clearAndRewriteSqlServer(sqlPool, sourceData);
    } else if (source === "sql") {
      await clearAndRewritePostgres(containerPgPool, sourceData);
      await clearAndRewritePostgres(vmPgPool, sourceData);
    }

    log(
      `Manual synchronization complete from ${source}. ${sourceData.length} records processed.`,
    );
    return res.json({
      success: true,
      count: sourceData.length,
      message: `Replicated from ${source} to all other nodes.`,
    });
  } catch (err) {
    log(`Sync execution error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const SYNC_SERVICE_PORT = 4000;
app.listen(SYNC_SERVICE_PORT, () => {
  log(
    `Sync engine online on port ${SYNC_SERVICE_PORT}. Manual polling endpoint active at POST /sync.`,
  );
});
