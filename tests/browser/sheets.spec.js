// Character sheets through the API: the tables and their upgrade step, the site-wide template library (forks, only
// the author edits), and characters in a campaign (each with an Encyclopedia entry, PC or NPC, hidden fields, the
// active character's name, who else is on a sheet, and the GM's Edit button).
const { test, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");
const path = require("path");
const { person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const ROOT = path.join(__dirname, "..", "..");

test("Sheets: a fresh database has the tables, and the upgrade finds nothing left to do", async ({ page, browser }) => {
  const tables = sql("SHOW TABLES LIKE 'sheet\\_%'; SHOW TABLES LIKE 'characters';").trim().split("\n");
  for (const t of ["sheet_templates", "sheet_presence", "characters"]) expect(tables).toContain(t);
  expect(sql("SHOW COLUMNS FROM campaign_members LIKE 'active_character_id'").trim()).not.toBe("");
  const gm = person("Hob");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Sheets ready");
  expect((await api(page, "campaign", undefined, cid)).json.sheets_ready).toBe(true);
  // The step is listed for older installs, and the test database needs nothing more.
  const env = { ...process.env, CHRONICLE_CONFIG: path.join(ROOT, "tests", "support", "config.test.php") };
  const steps = execFileSync("php", ["-r", `require '${ROOT}/api/upgrade.php'; echo implode("\\n", array_column(upgrade_steps(), 0));`], { env }).toString();
  expect(steps).toContain("023_character_sheets.sql");
  execFileSync("php", [path.join(ROOT, "tools", "migrate.php"), "--check"], { env });
});
