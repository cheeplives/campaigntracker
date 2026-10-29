// Copy and Delete on the campaign list: a GM copies a campaign into a new one of their own (everything in it, or only
// its setup) and deletes one after typing DELETE (any case); players get neither.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign } = require("./helpers");

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Rows of $table belonging to campaign $cid (through $via for a table without campaign_id). */
const count = (table, cid, via) => Number(sql(via ? `SELECT COUNT(*) FROM ${table} WHERE ${via[0]} IN (SELECT id FROM ${via[1]} WHERE campaign_id=${cid})`
  : `SELECT COUNT(*) FROM ${table} WHERE campaign_id=${cid}`).trim());

/** One or more rows in nearly every table a campaign has, the ids between them pointing at each other. */
async function fill(page, cid, uid) {
  const one = q => Number(sql(`${q}; SELECT LAST_INSERT_ID();`).trim().split("\n").pop());
  const region = Number(sql(`SELECT id FROM regions WHERE campaign_id=${cid}`).trim());
  sql(`INSERT INTO holidays (campaign_id, name, rule_json) VALUES (${cid}, 'Midwinter', '{}');
    INSERT INTO days (campaign_id, abs_day, region_id, notes) VALUES (${cid}, 3, ${region}, 'Rain on the road');
    INSERT INTO shifts (campaign_id, abs_day, shift, activity) VALUES (${cid}, 3, 1, 'Travelling');
    INSERT INTO shift_notes (campaign_id, abs_day, shift, user_id, body) VALUES (${cid}, 3, 1, ${uid}, 'Sore feet');
    INSERT INTO downtimes (campaign_id, kind, start_shift, end_shift) VALUES (${cid}, 'long_rest', 12, 15);
    INSERT INTO party_gear (campaign_id, item) VALUES (${cid}, 'Rope');
    INSERT INTO party_funds (campaign_id, currency, amount) VALUES (${cid}, 'Gold', 120);
    INSERT INTO reminders (campaign_id, due_shift, title, created_by) VALUES (${cid}, 20, 'Rent due', ${uid});
    INSERT INTO encyclopedia_ignored (campaign_id, scope, term) VALUES (${cid}, 'gm', 'Tuesday');`);
  const ev = one(`INSERT INTO events (campaign_id, abs_day, title) VALUES (${cid}, 3, 'Ambush')`);
  const tag = one(`INSERT INTO tags (campaign_id, name) VALUES (${cid}, 'Battle')`);
  sql(`INSERT INTO event_tags VALUES (${ev}, ${tag}); INSERT INTO event_notes (event_id, user_id, body) VALUES (${ev}, ${uid}, 'Close call');`);
  const hold = one(`INSERT INTO holdings (campaign_id, name, kind) VALUES (${cid}, 'Wagon', 'vehicle')`);
  const htag = one(`INSERT INTO holding_tag_names (campaign_id, name) VALUES (${cid}, 'Slow')`);
  sql(`INSERT INTO holding_tags VALUES (${hold}, ${htag}); INSERT INTO holding_storage (holding_id, item) VALUES (${hold}, 'Barrel');`);
  const e1 = one(`INSERT INTO encyclopedia_entries (campaign_id, name) VALUES (${cid}, 'Hoffmann')`);
  const e2 = one(`INSERT INTO encyclopedia_entries (campaign_id, name) VALUES (${cid}, 'Altdorf')`);
  const etag = one(`INSERT INTO encyclopedia_tag_names (campaign_id, name) VALUES (${cid}, 'Innkeeper')`);
  const rtype = one(`INSERT INTO encyclopedia_relation_types (campaign_id, label) VALUES (${cid}, 'Lives in')`);
  sql(`INSERT INTO encyclopedia_tags VALUES (${e1}, ${etag});
    INSERT INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id) VALUES (${cid}, ${e1}, ${e2}, ${rtype});
    INSERT INTO library_tomes (campaign_id, title, body) VALUES (${cid}, 'Journal', '<p>Day one</p>');`);
  const ses = one(`INSERT INTO play_sessions (campaign_id, number, first_day) VALUES (${cid}, 1, 3)`);
  sql(`INSERT INTO session_notes (campaign_id, session_id, position, text, abs_shift) VALUES (${cid}, ${ses}, 1, 'Met Hoffmann', 13);`);
  // A picture on Hoffmann, through the API so it is on disk.
  const me = await (await page.request.get("api/auth/me.php")).json();
  const res = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, { headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "encyclopedia", parent_id: String(e1), file: { name: "hoffmann.png", mimeType: "image/png", buffer: PNG } } });
  expect(res.status(), await res.text()).toBe(200);
}

const TABLES = [["regions"], ["holidays"], ["days"], ["shifts"], ["shift_notes"], ["events"], ["tags"], ["event_tags", ["event_id", "events"]],
  ["event_notes", ["event_id", "events"]], ["downtimes"], ["party_gear"], ["holdings"], ["holding_tag_names"], ["holding_tags", ["holding_id", "holdings"]],
  ["holding_storage", ["holding_id", "holdings"]], ["reminders"], ["party_funds"], ["encyclopedia_entries"], ["encyclopedia_tag_names"],
  ["encyclopedia_tags", ["entry_id", "encyclopedia_entries"]], ["encyclopedia_ignored"], ["encyclopedia_relation_types"], ["encyclopedia_relations"],
  ["library_tomes"], ["play_sessions"], ["session_notes"], ["attachments"]];

test("a GM copies a campaign from the list, with everything in it, into a new one of their own", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Corin"), player = person("Tamsin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Enemy Within");
  const ctx = await browser.newContext();
  const pp = await ctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const uid = (await (await page.request.get("api/auth/me.php")).json()).id;
  await fill(page, cid, uid);
  for (const [t, via] of TABLES) expect(count(t, cid, via), t).toBeGreaterThan(0);

  await page.goto("index.html#/");
  const row = page.locator(".camp-row").filter({ hasText: "Enemy Within" });
  await row.getByRole("button", { name: "Copy" }).click();
  const dlg = page.locator("dialog.kit-dialog");
  await expect(dlg.getByLabel("Name of the copy")).toHaveValue("Enemy Within (copy)");
  await dlg.getByRole("button", { name: "Copy" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".camp-row").filter({ hasText: "Enemy Within (copy)" })).toBeVisible();

  const copy = Number(sql(`SELECT id FROM campaigns WHERE name='Enemy Within (copy)' AND created_by=${uid}`).trim());
  for (const [t, via] of TABLES) expect(count(t, copy, via), t).toBe(count(t, cid, via));
  // The ids inside it point at its own rows, never back at the original's.
  expect(sql(`SELECT COUNT(*) FROM days d JOIN regions r ON r.id=d.region_id WHERE d.campaign_id=${copy} AND r.campaign_id=${copy}`).trim()).toBe("1");
  expect(sql(`SELECT COUNT(*) FROM encyclopedia_relations x JOIN encyclopedia_entries a ON a.id=x.from_id JOIN encyclopedia_entries b ON b.id=x.to_id
    JOIN encyclopedia_relation_types t ON t.id=x.type_id WHERE x.campaign_id=${copy} AND a.campaign_id=${copy} AND b.campaign_id=${copy} AND t.campaign_id=${copy}`).trim()).toBe("1");
  expect(sql(`SELECT COUNT(*) FROM event_tags et JOIN tags t ON t.id=et.tag_id JOIN events e ON e.id=et.event_id WHERE e.campaign_id=${copy} AND t.campaign_id=${copy}`).trim()).toBe("1");
  expect(sql(`SELECT COUNT(*) FROM attachments a JOIN encyclopedia_entries e ON e.id=a.parent_id WHERE a.campaign_id=${copy} AND e.campaign_id=${copy}`).trim()).toBe("1");
  const settings = JSON.parse(sql(`SELECT settings_json FROM campaigns WHERE id=${copy}`).trim());
  expect(settings.current_region).toBe(Number(sql(`SELECT id FROM regions WHERE campaign_id=${copy}`).trim()));
  // The copier is its only member, as its GM.
  expect(sql(`SELECT user_id, role FROM campaign_members WHERE campaign_id=${copy}`).trim()).toBe(`${uid}\tgm`);

  // Its picture is a file of its own: it still opens once the original campaign, and its files, are deleted.
  expect((await api(page, "campaign_delete", { confirm: "DELETE" }, cid)).status).toBe(200);
  const fid = Number(sql(`SELECT id FROM attachments WHERE campaign_id=${copy}`).trim());
  const pic = await page.request.get(`api/index.php?a=file&cid=${copy}&id=${fid}`);
  expect(pic.status()).toBe(200);
  expect(Buffer.from(await pic.body()).equals(PNG)).toBeTruthy();
  expectNoErrors(errors);
  await ctx.close();
});

test("every table of a campaign is copied, so a new one can't be left behind", async ({ page, browser }) => {
  const gm = person("Hale");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Tables");
  const r = await api(page, "campaign_copy", { name: "Tables 2" }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const withCampaign = sql("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='campaign_id'")
    .trim().split("\n").filter(t => t !== "campaign_members");
  for (const t of withCampaign) expect(r.json.tables, `${t} is not in CAMPAIGN_COPY (api/index.php)`).toContain(t);
});

test("copying only the setup brings the calendar, regions, holidays and tag lists, and nothing that happened", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Ysolde");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Old World");
  const uid = (await (await page.request.get("api/auth/me.php")).json()).id;
  await fill(page, cid, uid);

  await page.goto("index.html#/");
  await page.locator(".camp-row").filter({ hasText: "Old World" }).getByRole("button", { name: "Copy" }).click();
  const dlg = page.locator("dialog.kit-dialog");
  await dlg.getByLabel("Name of the copy").fill("New World");
  await dlg.getByLabel("What to copy").selectOption("setup");
  await dlg.getByRole("button", { name: "Copy" }).click();
  await expect(page.locator(".camp-row").filter({ hasText: "New World" })).toBeVisible();

  const copy = Number(sql(`SELECT id FROM campaigns WHERE name='New World' AND created_by=${uid}`).trim());
  expect(sql(`SELECT calendar_json, current_shift FROM campaigns WHERE id=${copy}`)).toBe(sql(`SELECT calendar_json, current_shift FROM campaigns WHERE id=${cid}`));
  for (const t of ["regions", "holidays", "tags", "holding_tag_names", "encyclopedia_tag_names", "encyclopedia_relation_types"]) expect(count(t, copy), t).toBe(count(t, cid));
  for (const t of ["days", "events", "shift_notes", "holdings", "encyclopedia_entries", "library_tomes", "play_sessions", "attachments", "reminders"]) expect(count(t, copy), t).toBe(0);
  expectNoErrors(errors);
});

test("a GM deletes a campaign from the list after typing DELETE (any case); players see neither button", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Mara"), player = person("Odo");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Doomed Run");
  await makeCampaign(page, "Keeper");
  const ctx = await browser.newContext();
  const pp = await ctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  await pp.goto("index.html#/");
  const prow = pp.locator(".camp-row").filter({ hasText: "Doomed Run" });
  await expect(prow).toBeVisible();
  await expect(prow.getByRole("button")).toHaveCount(0);
  expect((await api(pp, "campaign_copy", { name: "Mine now" }, cid)).status).toBe(403);
  expect((await api(pp, "campaign_delete", { confirm: "DELETE" }, cid)).status).toBe(403);

  await page.goto("index.html#/");
  const row = page.locator(".camp-row").filter({ hasText: "Doomed Run" });
  // Anything but DELETE (in any case) keeps it.
  await row.getByRole("button", { name: "Delete" }).click();
  await page.locator("dialog.kit-dialog input").fill("delet");
  await page.locator("dialog.kit-dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Not deleted: type DELETE to confirm")).toBeVisible();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  await page.locator("dialog.kit-dialog input").fill("delete ");
  await page.locator("dialog.kit-dialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".camp-row").filter({ hasText: "Keeper" })).toBeVisible();
  expect(sql(`SELECT COUNT(*) FROM campaigns WHERE id=${cid}`).trim()).toBe("0");
  expectNoErrors(errors);
  await ctx.close();
});
