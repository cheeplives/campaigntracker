// No action reaches into another campaign through an id. A GM of two campaigns calls every campaign action on the
// first, an empty one, with every id it sends pointing at a row of the second, which has one of nearly everything. The
// actions come from api/actions.php and the id parameters from the code, so a new action or parameter is swept too.
// Nothing of the second campaign may come back, and none of its rows may change.
const fs = require("fs"), path = require("path");
const { test, expect } = require("@playwright/test");
const { person, signIn, approve, api, sql, makeCampaign } = require("./helpers");

const root = path.join(__dirname, "..", "..");
const TABLE = Object.fromEntries([...fs.readFileSync(path.join(root, "api", "actions.php"), "utf8").matchAll(/^    '(\w+)' => \[(.*)\],$/gm)]
  .map(([, name, row]) => [name, { who: row.match(/'who' => '(\w+)'/)[1], get: row.includes("'get' => true") }]));
/** Every id a request can name, as the code reads it. Accounts and templates aren't a campaign's, so they're left out. */
const code = fs.readdirSync(path.join(root, "api")).filter(f => f.endsWith(".php")).map(f => fs.readFileSync(path.join(root, "api", f), "utf8")).join("\n");
const ID_KEYS = [...new Set([...code.matchAll(/(?:p\(|\$_GET\[|\$body\[|body\(\)\[)'(id|\w+_id|\w*ids)'/g)].map(m => m[1]))]
  .filter(k => !["user_id", "owner_id", "member_id", "template_id"].includes(k));
/** Left out: deleting or copying the campaign itself, and the actions that fetch from other sites. */
const SKIP = ["campaign_delete", "campaign_copy", "image_search", "image_import", "scabard_import", "scabard_picture", "sheet_import_fetch"];
const ACTIONS = Object.keys(TABLE).filter(a => ["gm", "member"].includes(TABLE[a].who) && !a.startsWith("fanwiki_") && !SKIP.includes(a));

const MARK = "Elsewhere";
/** One or more rows in nearly every table of campaign $cid, each with MARK in its text. */
function fill(cid, uid) {
  const one = q => Number(sql(`${q}; SELECT LAST_INSERT_ID();`).trim().split("\n").pop());
  const region = Number(sql(`SELECT id FROM regions WHERE campaign_id=${cid}`).trim());
  sql(`UPDATE regions SET name='${MARK} region' WHERE id=${region};
    INSERT INTO holidays (campaign_id, name, rule_json) VALUES (${cid}, '${MARK} day', '{}');
    INSERT INTO days (campaign_id, abs_day, region_id, notes) VALUES (${cid}, 3, ${region}, '${MARK} rain');
    INSERT INTO shifts (campaign_id, abs_day, shift, activity) VALUES (${cid}, 3, 1, '${MARK} travel');
    INSERT INTO shift_notes (campaign_id, abs_day, shift, user_id, body) VALUES (${cid}, 3, 1, ${uid}, '${MARK} feet');
    INSERT INTO downtimes (campaign_id, kind, start_shift, end_shift, notes) VALUES (${cid}, 'long_rest', 12, 15, '${MARK} rest');
    INSERT INTO party_gear (campaign_id, item) VALUES (${cid}, '${MARK} rope');
    INSERT INTO party_funds (campaign_id, currency, amount) VALUES (${cid}, '${MARK} gold', 120);
    INSERT INTO reminders (campaign_id, due_shift, title, created_by) VALUES (${cid}, 20, '${MARK} rent', ${uid});`);
  const ev = one(`INSERT INTO events (campaign_id, abs_day, title) VALUES (${cid}, 3, '${MARK} ambush')`);
  const tag = one(`INSERT INTO tags (campaign_id, name) VALUES (${cid}, '${MARK} battle')`);
  sql(`INSERT INTO event_tags VALUES (${ev}, ${tag}); INSERT INTO event_notes (event_id, user_id, body) VALUES (${ev}, ${uid}, '${MARK} call');`);
  const hold = one(`INSERT INTO holdings (campaign_id, name, kind) VALUES (${cid}, '${MARK} wagon', 'vehicle')`);
  sql(`INSERT INTO holding_storage (holding_id, item) VALUES (${hold}, '${MARK} barrel');`);
  const e1 = one(`INSERT INTO encyclopedia_entries (campaign_id, name) VALUES (${cid}, '${MARK} Hoffmann')`);
  const e2 = one(`INSERT INTO encyclopedia_entries (campaign_id, name) VALUES (${cid}, '${MARK} Altdorf')`);
  const rtype = one(`INSERT INTO encyclopedia_relation_types (campaign_id, label) VALUES (${cid}, '${MARK} lives in')`);
  sql(`INSERT INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id) VALUES (${cid}, ${e1}, ${e2}, ${rtype});
    INSERT INTO library_tomes (campaign_id, title, body) VALUES (${cid}, '${MARK} journal', '<p>Day one</p>');`);
  const ses = one(`INSERT INTO play_sessions (campaign_id, number, first_day, title) VALUES (${cid}, 1, 3, '${MARK} session')`);
  sql(`INSERT INTO session_notes (campaign_id, session_id, position, text, abs_shift) VALUES (${cid}, ${ses}, 1, '${MARK} met', 13);`);
  const map = one(`INSERT INTO maps (campaign_id, name) VALUES (${cid}, '${MARK} map')`);
  const token = one(`INSERT INTO tokens (campaign_id, name) VALUES (${cid}, '${MARK} token')`);
  sql(`INSERT INTO map_pins (campaign_id, map_id, kind, entry_id, x, y, label) VALUES (${cid}, ${map}, 'entry', ${e1}, 0.5, 0.5, '${MARK} pin');
    INSERT INTO map_routes (campaign_id, map_id, name, points_json) VALUES (${cid}, ${map}, '${MARK} road', '[]');
    INSERT INTO party_groups (campaign_id, name, members_json, region_id, map_id, token_id) VALUES (${cid}, '${MARK} party', '[]', ${region}, ${map}, ${token});
    INSERT INTO attachments (campaign_id, parent_type, parent_id, stored_name, original_name, mime, size_bytes, created_by)
      VALUES (${cid}, 'encyclopedia', ${e1}, MD5(RAND()), '${MARK}.png', 'image/png', 1, ${uid});`);
}

/** Every row of campaign $cid, as text, to compare before and after. */
function snapshot(cid) {
  const tables = sql("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='campaign_id' ORDER BY 1")
    .trim().split("\n");
  return tables.map(t => `${t}\n${sql(`SELECT * FROM \`${t}\` WHERE campaign_id=${cid} ORDER BY 1`)}`).join("\n")
    + sql(`SELECT * FROM event_notes WHERE event_id IN (SELECT id FROM events WHERE campaign_id=${cid}) ORDER BY 1`)
    + sql(`SELECT * FROM holding_storage WHERE holding_id IN (SELECT id FROM holdings WHERE campaign_id=${cid}) ORDER BY 1`)
    + sql(`SELECT id, name, description FROM campaigns WHERE id=${cid}`);
}

test("no action reaches another campaign's rows through an id", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "the server answers the same whatever the browser");
  test.setTimeout(300_000);
  const gm = person("Ilse");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const home = await makeCampaign(page, `Home ${gm.id}`);
  const away = await makeCampaign(page, `Away ${gm.id}`);
  const uid = Number(sql(`SELECT id FROM users WHERE email='${gm.email}'`).trim());
  fill(away, uid);
  const before = snapshot(away);
  expect(before).toContain(MARK);
  expect(ACTIONS.length).toBeGreaterThan(80);
  expect(ID_KEYS).toEqual(expect.arrayContaining(["id", "entry_id", "map_id", "token_id", "parent_id"]));

  // Every id the other campaign's rows have, whatever table: each is tried in every id parameter at once.
  const withIds = sql(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.columns i ON i.table_schema=c.table_schema
    AND i.table_name=c.table_name AND i.column_name='id' WHERE c.table_schema=DATABASE() AND c.column_name='campaign_id'`).trim().split("\n");
  const ids = [...new Set(withIds.flatMap(t => sql(`SELECT id FROM \`${t}\` WHERE campaign_id=${away}`).trim().split("\n").filter(Boolean).map(Number)))];
  expect(ids.length).toBeGreaterThan(0);

  const leaks = [];
  for (const id of ids) {
    sql(`DELETE FROM rate_limits WHERE id IN ('u${uid}', '${uid}')`);   // a thousand calls in a minute are this test, not a script
    const params = Object.fromEntries(ID_KEYS.map(k => [k, k.endsWith("ids") ? [id] : id]));
    params.parent_type = "encyclopedia";
    for (let i = 0; i < ACTIONS.length; i += 8) {
      await Promise.all(ACTIONS.slice(i, i + 8).map(async a => {
        const query = new URLSearchParams(Object.entries(params).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => [k, String(v)]));
        const r = TABLE[a].get
          ? await page.request.get(`api/index.php?a=${a}&cid=${home}&${query}`)
          : await api(page, a, params, home);
        const text = TABLE[a].get ? await r.text() : JSON.stringify(r.json);
        const status = TABLE[a].get ? r.status() : r.status;
        if (text.includes(MARK)) leaks.push(`${a} with id ${id} answered ${status} with the other campaign's data`);
        if (status >= 500) leaks.push(`${a} with id ${id} answered ${status}: ${text.slice(0, 200)}`);
      }));
    }
  }
  expect(leaks).toEqual([]);
  expect(snapshot(away)).toBe(before);
});
