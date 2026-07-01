import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/drsosystem.sqlite");
const user = db.prepare("SELECT id FROM users WHERE lower(username) = 'drs' LIMIT 1").get();
if (!user) throw new Error("Usuario drs nao encontrado.");

const userId = user.id;
const entries = [
  ["2025-12-03", "99", 2, 19.37, 9.4, "22:19", "22:41"],
  ["2025-12-05", "99", 7, 65.63, 33, "20:51", "23:36"],
  ["2025-12-06", "99", 1, 9.64, 5, "00:00", "00:00"],
  ["2025-12-07", "99", 6, 99.53, 47.8, "19:40", "22:07"],
  ["2025-12-09", "99", 6, 84.19, 39.2, "20:26", "22:37"],
  ["2025-12-10", "99", 1, 15.30, 7.1, "20:28", "20:28"],
  ["2025-12-12", "99", 4, 49.26, 22.9, "21:48", "23:15"],
  ["2025-12-17", "99", 4, 59.53, 25.9, "20:29", "22:08"],
  ["2025-12-18", "99", 3, 42.81, 22.3, "21:04", "22:33"],
  ["2025-12-20", "99", 4, 54.4, 23, "21:30", "23:07"],
  ["2025-12-21", "99", 5, 79.97, 42, "21:09", "23:22"],
  ["2026-01-14", "99", 2, 20.3, 10.4, "20:55", "21:21"],
  ["2026-01-15", "99", 3, 31.75, 19.2, "20:49", "22:23"],
  ["2026-01-17", "99", 4, 44.81, 28.2, "20:56", "23:57"],
  ["2026-01-18", "99", 2, 22.23, 14.3, "00:18", "00:52"],
  ["2026-01-23", "99", 4, 43.3, 24.6, "21:05", "23:35"],
  ["2026-01-25", "99", 4, 47.84, 27, "20:34", "22:03"],
  ["2026-01-27", "99", 6, 54.01, 39.5, "21:36", "23:29"],
  ["2026-02-01", "99", 11, 86.48, 64.9, "20:18", "23:45"],
  ["2026-02-02", "99", 1, 6.9, 5.6, "00:09", "00:09"],
  ["2026-02-04", "99", 8, 103.86, 65.5, "20:54", "23:33"],
  ["2026-02-16", "99", 7, 56.35, 41.9, "20:12", "22:58"],
  ["2026-02-19", "99", 5, 47.84, 38.6, "20:50", "22:32"],
  ["2026-02-23", "99", 5, 34.77, 23.4, "21:44", "23:15"],
  ["2026-03-03", "99", 6, 43.8, 31.9, "20:54", "22:56"],
  ["2026-03-07", "99", 13, 92.3, 57.9, "20:55", "00:27"],
  ["2026-03-09", "99", 5, 42.17, 32.4, "21:57", "23:13"],
  ["2026-03-12", "99", 2, 20.37, 16.3, "21:19", "21:58"],
  ["2025-12-12", "iFood", 1, 9.16, 0, "20:13", "20:34"],
  ["2026-01-15", "iFood", 3, 34.87, 0, "21:39", "22:46"]
];

const withdrawals = [
  ["2025-12-08", "99", 194],
  ["2025-12-10", "99", 84.36],
  ["2025-12-14", "99", 64.56],
  ["2025-12-22", "99", 236.71],
  ["2026-01-21", "99", 119.09],
  ["2026-01-29", "99", 145.15],
  ["2026-02-05", "99", 197.24],
  ["2026-02-18", "99", 56.35],
  ["2026-02-20", "99", 47.84],
  ["2026-02-25", "99", 34.77],
  ["2026-03-04", "99", 43.8],
  ["2026-03-09", "99", 92.3],
  ["2026-03-12", "99", 42.17],
  ["2025-12-17", "iFood", 9.16],
  ["2025-12-17", "iFood", 34.87]
];

function workedHours(startTime, endTime) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
  let start = sh * 60 + sm;
  let end = eh * 60 + em;
  if (end < start) end += 1440;
  return Math.round(((end - start) / 60) * 100) / 100;
}

const existingEntry = db.prepare(`
  SELECT id FROM delivery_entries
  WHERE user_id = ? AND date = ? AND platform = ? AND trips = ?
    AND abs(earned_amount - ?) < 0.001 AND abs(kilometers - ?) < 0.001
  LIMIT 1
`);
const insertEntry = db.prepare(`
  INSERT INTO delivery_entries
    (user_id, date, platform, trips, earned_amount, kilometers, start_time, end_time, hours_worked, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const existingWithdrawal = db.prepare(`
  SELECT id FROM delivery_withdrawals
  WHERE user_id = ? AND date = ? AND platform = ? AND abs(amount - ?) < 0.001
  LIMIT 1
`);
const insertWithdrawal = db.prepare(`
  INSERT INTO delivery_withdrawals (user_id, date, platform, amount, notes)
  VALUES (?, ?, ?, ?, ?)
`);

let insertedEntries = 0;
let skippedEntries = 0;
let insertedWithdrawals = 0;
let skippedWithdrawals = 0;

db.exec("BEGIN");
try {
  for (const [day, platform, trips, earned, km, start, end] of entries) {
    const date = `${day} ${start}:00`;
    if (existingEntry.get(userId, date, platform, trips, earned, km)) {
      skippedEntries += 1;
      continue;
    }
    insertEntry.run(userId, date, platform, trips, earned, km, start, end, workedHours(start, end), "Importado da planilha antiga de entregador.");
    insertedEntries += 1;
  }
  for (const [day, platform, amount] of withdrawals) {
    const date = `${day} 12:00:00`;
    if (existingWithdrawal.get(userId, date, platform, amount)) {
      skippedWithdrawals += 1;
      continue;
    }
    insertWithdrawal.run(userId, date, platform, amount, "Importado da planilha antiga de saques.");
    insertedWithdrawals += 1;
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const totals = {
  insertedEntries,
  skippedEntries,
  insertedWithdrawals,
  skippedWithdrawals,
  entries: db.prepare("SELECT count(*) total, round(sum(earned_amount), 2) earned, sum(trips) trips, round(sum(kilometers), 1) km FROM delivery_entries WHERE user_id = ?").get(userId),
  withdrawals: db.prepare("SELECT count(*) total, round(sum(amount), 2) amount FROM delivery_withdrawals WHERE user_id = ?").get(userId)
};

console.log(JSON.stringify(totals, null, 2));
db.close();
