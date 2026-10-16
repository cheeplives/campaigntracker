// Playwright global setup: give every run an empty test database built from
// db/schema.sql. Uses the mysql command-line client; DB_* env vars as in
// support/config.test.php.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

module.exports = async () => {
  const name = process.env.DB_NAME || "chronicle_test";
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("DB_NAME must be letters, digits and _");
  const args = ["-h", process.env.DB_HOST || "127.0.0.1", "-P", process.env.DB_PORT || "3306", "-u", process.env.DB_USER || "root"];
  if (process.env.DB_PASSWORD) args.push(`-p${process.env.DB_PASSWORD}`);
  const run = (sql, db) => execFileSync("mysql", db ? [...args, db] : args, { input: sql });
  run(`DROP DATABASE IF EXISTS ${name}; CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  run(fs.readFileSync(path.join(__dirname, "..", "..", "db", "schema.sql")), name);
};
