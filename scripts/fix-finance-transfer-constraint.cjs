const { DatabaseSync } = require("node:sqlite");

(async () => {
const { dbPath } = await import("../server/storage-paths.mjs");
const db = new DatabaseSync(dbPath);
const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_transactions'").get();

if (!table?.sql) {
  console.log("Tabela financial_transactions nao encontrada.");
  process.exit(0);
}

if (table.sql.includes("'transferencia'")) {
  console.log("Tabela ja aceita transferencia.");
  process.exit(0);
}

const columns = db.prepare("PRAGMA table_info(financial_transactions)").all().map((column) => column.name);
const wantedColumns = [
  "id",
  "account_id",
  "destination_account_id",
  "pocket_id",
  "type",
  "category",
  "description",
  "amount",
  "date",
  "payment_method",
  "notes",
  "created_at",
  "updated_at"
];
const copyColumns = wantedColumns.filter((column) => columns.includes(column));
const selectColumns = copyColumns.join(", ");

db.exec(`
  PRAGMA foreign_keys = OFF;
  BEGIN TRANSACTION;
  CREATE TABLE financial_transactions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    destination_account_id INTEGER,
    pocket_id INTEGER,
    type TEXT NOT NULL CHECK(type IN ('entrada','saida','transferencia')),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    payment_method TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO financial_transactions_new (${selectColumns})
  SELECT ${selectColumns}
  FROM financial_transactions;
  DROP TABLE financial_transactions;
  ALTER TABLE financial_transactions_new RENAME TO financial_transactions;
  COMMIT;
  PRAGMA foreign_keys = ON;
`);

console.log("Tabela financial_transactions atualizada para aceitar transferencia.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
