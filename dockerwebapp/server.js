// server.js
// Express Web Server: Web UI & API for full-state manual sync across:
// 1. Container (Docker Postgres)
// 2. VM (Hyper-V Ubuntu Postgres)
// 3. SQL Server (Host Windows Instance)

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
const port = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ALLOWED_FIELDS = ["id", "name", "phone_number", "address", "salary"];

// ============================================================================
// NETWORK ARCHITECTURE & CONNECTION PATHWAYS (IP ROUTING EXPLAINED)
// ============================================================================
//
// 1. APP CONTAINER -> DOCKER POSTGRES (LOCAL CONTAINER DB)
//    - IP / Hostname: 'postgres-db' (or internal container bridge IP e.g. 172.20.0.10)
//    - Port: 5432
//    - How it works: Both the Node.js container and Postgres container share the
//      'employee-net' Docker network, allowing direct container-to-container connection.
//
// 2. APP CONTAINER -> HYPER-V VM (POSTGRESQL)
//    - IP: '192.168.56.10' (Host-Only Virtual Adapter Network)
//    - Port: 5432
//    - How it works: The Hyper-V VM sits on a Host-Only virtual switch. The Docker
//      container routes out to the Windows Host network stack to reach the VM at 192.168.56.10.
//
// 3. APP CONTAINER -> SQL SERVER (WINDOWS HOST)
//    - IP: '192.168.56.1'
//    - Port: 1433
//    - How it works: 192.168.56.1 is the Windows host's own address on the same
//      Host-Only virtual switch the VM lives on (the VM is 192.168.56.10, the host
//      is 192.168.56.1 on that same subnet). The container reaches out over that
//      switch to the native SQL Server instance running on the host.
//
// 4. VM <-> SQL SERVER: THERE IS NO DIRECT CONNECTION.
//    The VM's PostgreSQL and the host's SQL Server never talk to each other
//    directly — nothing on the VM has a SQL Server client, and nothing on the
//    Windows host initiates a Postgres connection to the VM. This app (and the
//    standalone sync-service.js) is the ONLY thing that holds both a Postgres
//    connection to the VM (192.168.56.10:5432) and an mssql connection to SQL
//    Server (192.168.56.1:1433) at the same time. It reads rows out of one and
//    writes them into the other — it IS the bridge between the two systems.
//    Per the sync design, the VM is always the intermediate hop: Container and
//    SQL Server data is only ever exchanged by way of the VM, never directly
//    between Container and SQL Server (see /api/sync below).
// ============================================================================

// SQL Server Connection Configuration
const sqlServerConfig = {
  user: process.env.SQL_DB_USER,
  password: process.env.SQL_DB_PASSWORD,
  // Container -> Windows Host, over the same Host-Only virtual switch the VM uses
  // (192.168.56.1 is the host's address on that switch
  // as the IP the host/SQL Server side uses to reach the VM's 192.168.56.10).
  server: process.env.SQL_DB_HOST,
  database: process.env.SQL_DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};
let sqlServerPoolPromise = sql.connect(sqlServerConfig);

// Node Definitions & Database Pool Mappings
const nodes = {
  container: {
    label: "Container",
    prefix: "",
    displayHost: process.env.CONTAINER_DB_HOST,
    pool: new Pool({
      user: process.env.CONTAINER_DB_USER,
      host: process.env.CONTAINER_DB_HOST, // Container -> Postgres Container
      database: process.env.CONTAINER_DB_NAME,
      password: process.env.CONTAINER_DB_PASSWORD,
      port: 5432,
    }),
  },
  vm: {
    label: "VM",
    prefix: "/vm",
    displayHost: process.env.VM_DB_HOST,
    pool: new Pool({
      user: process.env.VM_DB_USER,
      host: process.env.VM_DB_HOST, // Container -> Hyper-V Ubuntu VM IP
      database: process.env.VM_DB_NAME,
      password: process.env.VM_DB_PASSWORD,
      port: 5432,
    }),
  },
  sql: {
    label: "SQL Server",
    prefix: "/sql",
    displayHost: sqlServerConfig.server,
  },
};

// Database pool error handlers
nodes.container.pool.on("error", (err) =>
  console.error("Container Pool Error:", err),
);
nodes.vm.pool.on("error", (err) => console.error("VM Pool Error:", err));

// ==========================================
// HELPER & UI RENDER FUNCTIONS
// ==========================================

function renderTable(rows) {
  if (!rows || rows.length === 0) {
    return '<p class="empty">No matching records found.</p>';
  }
  const headers = Object.keys(rows[0]);
  const headRow =
    headers.map((h) => `<th>${h.replace("_", " ")}</th>`).join("") +
    "<th>Actions</th>";

  const bodyRows = rows
    .map((r, i) => {
      const cells = headers.map((h) => `<td>${r[h]}</td>`).join("");
      const rowId = `row-${prefixSafe(r.id)}-${i}`;
      return `<tr>
      ${cells}
      <td class="row-actions">
        <button type="button" class="btn-secondary" onclick="document.getElementById('${rowId}').classList.toggle('open')">Edit</button>
        <form action="ACTIONPREFIX/delete" method="POST" onsubmit="return confirm('Delete ${r.name}?');" style="display:inline;">
          <input type="hidden" name="id" value="${r.id}">
          <button class="btn-danger" type="submit">Delete</button>
        </form>
      </td>
    </tr>
    <tr class="edit-row" id="${rowId}">
      <td colspan="${headers.length + 1}">
        <form action="ACTIONPREFIX/update" method="POST" class="inline-form">
          <input type="hidden" name="id" value="${r.id}">
          <input type="text" name="name" value="${r.name}" placeholder="Name">
          <input type="text" name="phone_number" value="${r.phone_number}" placeholder="Phone">
          <input type="text" name="address" value="${r.address}" placeholder="Address">
          <input type="number" step="0.01" name="salary" value="${r.salary}" placeholder="Salary">
          <button class="btn-secondary" type="submit">Save</button>
        </form>
      </td>
    </tr>`;
    })
    .join("");
  return `<table>
    <thead><tr>${headRow}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

function friendlyError(err) {
  const msg = err.message || String(err);
  if (msg.includes("numeric field overflow")) {
    return "Error: Salary value is out of bounds. Must be under 99,999,999.99.";
  }
  if (
    msg.includes("duplicate key value") ||
    msg.includes("PRIMARY KEY constraint")
  ) {
    return "Error: Duplicate Primary Key encountered.";
  }
  return `Error: ${msg}`;
}

function prefixSafe(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "");
}

function pageShell({
  nodeLabel,
  dbHost,
  prefix,
  content,
  message = "",
  isError = false,
}) {
  const tableHtml = content.replaceAll("ACTIONPREFIX", prefix);
  const nav = Object.values(nodes)
    .map(
      (n) =>
        `<a href="${n.prefix || "/"}" class="node-link ${n.prefix === prefix ? "active" : ""}">${n.label}</a>`,
    )
    .join("");

  const currentNodeKey =
    prefix === "" ? "container" : prefix === "/vm" ? "vm" : "sql";

  return `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Employee Directory — ${nodeLabel}</title>
    <style>
      :root {
        --ink: #1b1f23; --slate: #5b6470; --line: #dfe3e8;
        --surface: #ffffff; --bg: #f3f5f7;
        --accent: #2d5c8a; --accent-dark: #1e3f5f;
        --danger: #b3423e; --danger-bg: #fbeceb;
        --ok: #2f7a4f; --ok-bg: #eaf6ee;
        --mono: 'JetBrains Mono', 'Consolas', monospace;
      }
      * { box-sizing: border-box; }
      body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; padding: 32px 24px 80px; }
      .wrap { max-width: 880px; margin: 0 auto; }
      header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px 16px; border-bottom: 2px solid var(--ink); padding-bottom: 14px; margin-bottom: 20px; }
      h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; }
      .meta { font-family: var(--mono); font-size: 12.5px; color: var(--slate); display: flex; gap: 14px; align-items: center; }
      .tag { background: var(--accent); color: white; padding: 3px 9px; border-radius: 3px; font-weight: 600; }
      .node-nav { display: flex; gap: 8px; margin-bottom: 24px; align-items: center; }
      .node-link { padding: 8px 16px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); color: var(--slate); text-decoration: none; font-size: 13.5px; font-weight: 600; }
      .node-link.active { background: var(--ink); color: white; border-color: var(--ink); }
      .btn-sync { margin-left: auto; background: #d97706; color: white; border: none; border-radius: 6px; padding: 8px 16px; font-weight: 600; cursor: pointer; font-size: 13.5px; }
      .btn-sync:hover { background: #b45309; }
      .btn-sync:disabled { opacity: 0.6; cursor: not-allowed; }
      .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 22px 24px; margin-bottom: 20px; }
      .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--slate); margin: 0 0 14px; font-weight: 700; }
      form.row { display: flex; flex-wrap: wrap; gap: 10px; }
      input, select { border: 1px solid var(--line); border-radius: 6px; padding: 9px 12px; font-size: 14px; background: var(--bg); min-width: 140px; flex: 1; }
      button { border: none; border-radius: 6px; padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
      .btn-primary { background: var(--accent); color: white; }
      .btn-secondary { background: #eef1f4; color: var(--ink); }
      .btn-danger { background: var(--danger-bg); color: var(--danger); }
      .btn-ghost { background: transparent; border: 1px solid var(--line); color: var(--slate); }
      table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 14px; }
      th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--slate); padding: 8px 10px; border-bottom: 1px solid var(--line); }
      td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
      tr.edit-row { display: none; }
      tr.edit-row.open { display: table-row; }
      .inline-form { display: flex; gap: 6px; flex-wrap: wrap; }
      .row-actions { text-align: right; }
      .empty { color: var(--slate); font-style: italic; padding: 10px 0; }
      .msg { padding: 10px 14px; border-radius: 6px; font-size: 13.5px; font-weight: 600; margin-bottom: 16px; }
      .msg.ok { background: var(--ok-bg); color: var(--ok); }
      .msg.error { background: var(--danger-bg); color: var(--danger); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>Employee Directory</h1>
        <div class="meta"><span class="tag">${nodeLabel}</span> host: ${dbHost}</div>
      </header>

      <div class="node-nav">
        ${nav}
        <!-- Simplified Sync Button: Silent trigger, no popups -->
        <button id="syncBtn" class="btn-sync" onclick="triggerManualSync('${currentNodeKey}')">🔄 Sync</button>
      </div>

      ${message ? `<div class="msg ${isError ? "error" : "ok"}">${message}</div>` : ""}

      <div class="card">
        <h2>Search</h2>
        <form class="row" action="${prefix}/search" method="GET">
          <select name="field" required>
            <option value="" disabled selected>Search by field...</option>
            <option value="name">Name</option>
            <option value="phone_number">Phone Number</option>
            <option value="address">Address</option>
            <option value="salary">Salary</option>
            <option value="id">ID</option>
          </select>
          <input type="text" name="value" placeholder="value to search" required>
          <button class="btn-primary" type="submit">Search</button>
          <a href="${prefix || "/"}"><button class="btn-ghost" type="button">Show All</button></a>
        </form>
      </div>

      <div class="card">
        <h2>Add Employee</h2>
        <form class="row" action="${prefix}/insert" method="POST">
          <input type="text" name="name" placeholder="Name" required>
          <input type="text" name="phone_number" placeholder="Phone Number" required>
          <input type="text" name="address" placeholder="Address" required>
          <input type="number" step="0.01" name="salary" placeholder="Salary" required>
          <button class="btn-primary" type="submit">Add</button>
        </form>
      </div>

      <div class="card">
        <h2>Records</h2>
        ${tableHtml}
      </div>
    </div>

    <script>
      // Silent sync function: posts active source node and reloads page on success
      async function triggerManualSync(sourceNode) {
        const btn = document.getElementById('syncBtn');
        btn.disabled = true;
        btn.innerText = 'Syncing...';
        try {
          const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: sourceNode })
          });
          const data = await res.json();
          if (data.success) {
            window.location.reload();
          } else {
            alert('Sync failed: ' + data.message);
          }
        } catch (err) {
          alert('Sync error: ' + err.message);
        } finally {
          btn.disabled = false;
          btn.innerText = '🔄 Sync';
        }
      }
    </script>
  </body>
  </html>`;
}

// ==========================================
// POSTGRES ROUTE REGISTRATION (Container & VM)
// ==========================================

[nodes.container, nodes.vm].forEach((node) => {
  const { pool, label, prefix, displayHost } = node;
  const base = prefix;

  app.get(base || "/", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM employees ORDER BY id");
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable(result.rows),
        }),
      );
    } catch (err) {
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: `Connection error: ${err.message}`,
          isError: true,
        }),
      );
    }
  });

  app.get(`${base}/search`, async (req, res) => {
    const { field, value } = req.query;
    if (!ALLOWED_FIELDS.includes(field)) {
      return res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: `Invalid field search.`,
          isError: true,
        }),
      );
    }
    try {
      const query = `SELECT * FROM employees WHERE CAST(${field} AS TEXT) ILIKE $1 ORDER BY id`;
      const result = await pool.query(query, [`%${value}%`]);
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable(result.rows),
        }),
      );
    } catch (err) {
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: `Error: ${err.message}`,
          isError: true,
        }),
      );
    }
  });

  app.post(`${base}/insert`, async (req, res) => {
    const { name, phone_number, address, salary } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Calculate next ID manually to ensure gapless sequence
      const maxRes = await client.query(
        "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM employees",
      );
      const nextId = maxRes.rows[0].next_id;

      await client.query(
        "INSERT INTO employees (id, name, phone_number, address, salary) VALUES ($1, $2, $3, $4, $5)",
        [nextId, name, phone_number, address, salary],
      );

      await client.query("SELECT setval('employees_id_seq', $1, true)", [
        nextId,
      ]);
      await client.query("COMMIT");

      res.redirect(base || "/");
    } catch (err) {
      await client.query("ROLLBACK");
      const result = await pool
        .query("SELECT * FROM employees ORDER BY id")
        .catch(() => ({ rows: [] }));
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable(result.rows),
          message: friendlyError(err),
          isError: true,
        }),
      );
    } finally {
      client.release();
    }
  });

  app.post(`${base}/update`, async (req, res) => {
    const { id, name, phone_number, address, salary } = req.body;
    try {
      await pool.query(
        "UPDATE employees SET name=$1, phone_number=$2, address=$3, salary=$4 WHERE id=$5",
        [name, phone_number, address, salary, id],
      );
      res.redirect(base || "/");
    } catch (err) {
      const result = await pool
        .query("SELECT * FROM employees ORDER BY id")
        .catch(() => ({ rows: [] }));
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable(result.rows),
          message: friendlyError(err),
          isError: true,
        }),
      );
    }
  });

  app.post(`${base}/delete`, async (req, res) => {
    const { id } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Delete target record
      await client.query("DELETE FROM employees WHERE id = $1", [id]);

      // 2. Compact remaining IDs sequentially starting from 1
      await client.query(`
        WITH renumbered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS new_id
          FROM employees
        )
        UPDATE employees
        SET id = renumbered.new_id
        FROM renumbered
        WHERE employees.id = renumbered.id;
      `);

      // 3. Reseed sequence cleanly
      await client.query(`
        SELECT CASE 
          WHEN COUNT(*) = 0 THEN setval('employees_id_seq', 1, false)
          ELSE setval('employees_id_seq', MAX(id), true)
        END
        FROM employees;
      `);

      await client.query("COMMIT");
      res.redirect(base || "/");
    } catch (err) {
      await client.query("ROLLBACK");
      const result = await pool
        .query("SELECT * FROM employees ORDER BY id")
        .catch(() => ({ rows: [] }));
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable(result.rows),
          message: friendlyError(err),
          isError: true,
        }),
      );
    } finally {
      client.release();
    }
  });
});

// ==========================================
// SQL SERVER ROUTE REGISTRATION (FULL CRUD)
// ==========================================

{
  const { label, prefix, displayHost } = nodes.sql;

  app.get(prefix, async (req, res) => {
    try {
      const sqlPool = await sqlServerPoolPromise;
      const result = await sqlPool
        .request()
        .query(
          "SELECT id, name, phone_number, address, salary FROM employees ORDER BY id",
        );
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable(result.recordset),
        }),
      );
    } catch (err) {
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: `Connection error: ${err.message}`,
          isError: true,
        }),
      );
    }
  });

  app.get(`${prefix}/search`, async (req, res) => {
    const { field, value } = req.query;
    if (!ALLOWED_FIELDS.includes(field)) {
      return res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: `Invalid search field.`,
          isError: true,
        }),
      );
    }
    try {
      const sqlPool = await sqlServerPoolPromise;
      const request = sqlPool.request();
      request.input("value", sql.VarChar, `%${value}%`);
      const result = await request.query(
        `SELECT id, name, phone_number, address, salary FROM employees WHERE CAST(${field} AS VARCHAR) LIKE @value ORDER BY id`,
      );
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable(result.recordset),
        }),
      );
    } catch (err) {
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: `Error: ${err.message}`,
          isError: true,
        }),
      );
    }
  });

  app.post(`${prefix}/insert`, async (req, res) => {
    const { name, phone_number, address, salary } = req.body;
    try {
      const sqlPool = await sqlServerPoolPromise;
      const transaction = new sql.Transaction(sqlPool);
      await transaction.begin();

      const request = new sql.Request(transaction);
      request.input("name", sql.VarChar, name);
      request.input("phone_number", sql.VarChar, phone_number);
      request.input("address", sql.VarChar, address);
      request.input("salary", sql.Decimal(10, 2), salary);

      // Force explicit identity assignment (MAX + 1) to eliminate seed offsets
      await request.query(`
        DECLARE @nextId INT = ISNULL((SELECT MAX(id) FROM employees), 0) + 1;

        SET IDENTITY_INSERT employees ON;

        INSERT INTO employees (id, name, phone_number, address, salary)
        VALUES (@nextId, @name, @phone_number, @address, @salary);

        SET IDENTITY_INSERT employees OFF;

        DBCC CHECKIDENT ('employees', RESEED, @nextId);
      `);

      await transaction.commit();
      res.redirect(prefix);
    } catch (err) {
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: friendlyError(err),
          isError: true,
        }),
      );
    }
  });

  app.post(`${prefix}/update`, async (req, res) => {
    const { id, name, phone_number, address, salary } = req.body;
    try {
      const sqlPool = await sqlServerPoolPromise;
      const request = sqlPool.request();
      request.input("id", sql.Int, id);
      request.input("name", sql.VarChar, name);
      request.input("phone_number", sql.VarChar, phone_number);
      request.input("address", sql.VarChar, address);
      request.input("salary", sql.Decimal(10, 2), salary);
      await request.query(
        "UPDATE employees SET name=@name, phone_number=@phone_number, address=@address, salary=@salary WHERE id=@id",
      );
      res.redirect(prefix);
    } catch (err) {
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: friendlyError(err),
          isError: true,
        }),
      );
    }
  });

  app.post(`${prefix}/delete`, async (req, res) => {
    const { id } = req.body;
    let transaction;
    try {
      const sqlPool = await sqlServerPoolPromise;
      transaction = new sql.Transaction(sqlPool);
      await transaction.begin();

      const dbRequest = new sql.Request(transaction);
      dbRequest.input("id", sql.Int, id);

      await dbRequest.query(`
        DELETE FROM employees WHERE id = @id;

        SELECT 
          ROW_NUMBER() OVER (ORDER BY id) AS new_id,
          name, phone_number, address, salary
        INTO #TempRenumbered
        FROM employees;

        DELETE FROM employees;

        SET IDENTITY_INSERT employees ON;

        INSERT INTO employees (id, name, phone_number, address, salary)
        SELECT new_id, name, phone_number, address, salary
        FROM #TempRenumbered;

        SET IDENTITY_INSERT employees OFF;
        DROP TABLE #TempRenumbered;

        DECLARE @maxId INT = ISNULL((SELECT MAX(id) FROM employees), 0);
        DBCC CHECKIDENT ('employees', RESEED, @maxId);
      `);

      await transaction.commit();
      res.redirect(prefix);
    } catch (err) {
      if (transaction) {
        try {
          await transaction.rollback();
        } catch (rollbackErr) {
          console.error("Rollback failed:", rollbackErr);
        }
      }
      res.send(
        pageShell({
          nodeLabel: label,
          dbHost: displayHost,
          prefix,
          content: renderTable([]),
          message: friendlyError(err),
          isError: true,
        }),
      );
    }
  });
}

// ==========================================
// UNIVERSAL CLEAR & SYNC API IMPLEMENTATION
// ==========================================

// Helper: Overwrite target PostgreSQL DB dataset and reseed auto-increment sequence
async function writeToPostgres(targetPool, data) {
  const client = await targetPool.connect();
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
        "SELECT setval('employees_id_seq', (SELECT MAX(id) FROM employees), true)",
      );
    } else {
      await client.query("SELECT setval('employees_id_seq', 1, false)");
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Helper: Overwrite SQL Server dataset using unified query batch
async function writeToSqlServer(data) {
  const sqlPool = await sqlServerPoolPromise;
  const transaction = new sql.Transaction(sqlPool);

  try {
    await transaction.begin();
    const req = new sql.Request(transaction);

    await req.query("DELETE FROM employees");

    if (data.length > 0) {
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
      await req.query("DBCC CHECKIDENT ('employees', RESEED, 0);");
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// Universal Manual Sync API
// Prevents two syncs from running concurrently (double-click, two users,
// overlapping requests), which would otherwise let two TRUNCATE/INSERT
// cycles interleave against the same tables.
let syncInProgress = false;

async function fetchFrom(nodeKey) {
  if (nodeKey === "container") {
    const result = await nodes.container.pool.query(
      "SELECT id, name, phone_number, address, salary FROM employees ORDER BY id",
    );
    return result.rows;
  }
  if (nodeKey === "vm") {
    const result = await nodes.vm.pool.query(
      "SELECT id, name, phone_number, address, salary FROM employees ORDER BY id",
    );
    return result.rows;
  }
  if (nodeKey === "sql") {
    const sqlPool = await sqlServerPoolPromise;
    const result = await sqlPool
      .request()
      .query(
        "SELECT id, name, phone_number, address, salary FROM employees ORDER BY id",
      );
    return result.recordset;
  }
  throw new Error(`Unknown node: ${nodeKey}`);
}

// Universal Manual Sync API — VM is always the central hop.
// Container and SQL Server never exchange data directly; every sync
// either originates at the VM or passes through it.
app.post("/api/sync", async (req, res) => {
  const { source } = req.body;

  if (!["container", "vm", "sql"].includes(source)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid sync source node specified." });
  }

  if (syncInProgress) {
    return res
      .status(409)
      .json({ success: false, message: "A sync is already in progress. Try again shortly." });
  }
  syncInProgress = true;

  try {
    let recordCount = 0;

    if (source === "container") {
      // Container -> VM -> SQL Server
      const containerData = await fetchFrom("container");
      await writeToPostgres(nodes.vm.pool, containerData);
      const vmData = await fetchFrom("vm"); // re-read VM as the canonical hop
      await writeToSqlServer(vmData);
      recordCount = vmData.length;
    } else if (source === "vm") {
      // VM -> Container, VM -> SQL Server
      const vmData = await fetchFrom("vm");
      await writeToPostgres(nodes.container.pool, vmData);
      await writeToSqlServer(vmData);
      recordCount = vmData.length;
    } else if (source === "sql") {
      // SQL Server -> VM -> Container
      const sqlData = await fetchFrom("sql");
      await writeToPostgres(nodes.vm.pool, sqlData);
      const vmData = await fetchFrom("vm"); // re-read VM as the canonical hop
      await writeToPostgres(nodes.container.pool, vmData);
      recordCount = vmData.length;
    }

    return res.json({
      success: true,
      message: `Sync successful. ${recordCount} records processed.`,
    });
  } catch (err) {
    console.error("Manual sync failure:", err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    syncInProgress = false;
  }
});

app.listen(port, () => {
  console.log(
    `Web application active on port ${port} — Available paths: /, /vm, /sql`,
  );
});
