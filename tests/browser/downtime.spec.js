// The Downtime tab: a GM starts a long rest, a short rest or days of downtime from a dialog,
// which labels the shifts it covers and can move the clock; each is its own card, with
// activities, players put on them, public notes and GM-only notes.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign, newContext, closeContexts, moreIn } = require("./helpers");
test.afterEach(closeContexts);

const activities = cid => sql(`SELECT abs_day, shift, activity FROM shifts WHERE campaign_id = ${cid} ORDER BY abs_day, shift`).trim().split("\n").filter(Boolean);
const clock = cid => Number(sql(`SELECT current_shift FROM campaigns WHERE id = ${cid}`).trim());

test("a long rest labels its shifts, moves the clock, and its card holds activities, players and notes", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Dana"), player = person("Eli");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Rest ${gm.id}`); // now: Dawn of day 2 (shift 8)
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const eli = (await api(page, "campaign", undefined, cid)).json.members.find(m => m.display_name === "Eli");
  expect((await api(page, "member_character", { user_id: eli.id, character_name: "Brother Eli" }, cid)).status).toBe(200);
  sql(`INSERT INTO shifts (campaign_id, abs_day, shift, activity) VALUES (${cid}, 2, 1, 'Make camp')`);

  await page.goto(`index.html#/c/${cid}/downtime`);
  await page.getByRole("button", { name: "+ New downtime" }).click();
  const dlg = page.locator("dialog.dt-dialog");
  await expect(dlg.getByLabel("Long Rest")).toBeChecked();
  const used = dlg.getByLabel("Shifts used up");
  await expect(used).toHaveValue("2");
  await expect(dlg).toContainText("At least 2 of the day's 4 shifts");
  // A long rest takes at least half the day.
  await used.fill("1");
  await dlg.getByRole("button", { name: "Create" }).click();
  await expect(dlg).toContainText("Enter 2 to 40 shifts");
  expect((await api(page, "downtime_save", { kind: "long_rest", slots: 1 }, cid)).status).toBe(400);
  await used.fill("2");
  await dlg.getByLabel("Title (optional)").fill("Under the old oak");
  await dlg.getByRole("button", { name: "Create" }).click();
  await expect(dlg).toHaveCount(0);

  // The two shifts after Dawn are the rest, added after what was there; the clock is on the last one.
  expect(activities(cid)).toEqual(["2\t1\tMake camp; Long Rest", "2\t2\tLong Rest"]);
  expect(clock(cid)).toBe(10);
  const card = page.locator(".downtime");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Long Rest · Under the old oak");
  await expect(card).toContainText("2 shifts");

  // Rest activities, with Work on Project for a long rest, a custom one, and a player on one.
  for (const a of ["Tend to Wounds", "Manage Stress", "Repair Gear", "Prepare", "Relax", "Work on Project"]) await expect(card.getByLabel(a, { exact: true })).toBeVisible();
  await expect(card.getByLabel("Crafting", { exact: true })).toHaveCount(0);
  await card.getByLabel("Tend to Wounds", { exact: true }).check();
  await card.getByRole("group", { name: "Who does Tend to Wounds" }).getByRole("button", { name: "Brother Eli" }).click();
  await card.getByLabel("Work on Project", { exact: true }).check();
  await card.getByLabel("Custom activity").fill("Sing old songs");
  await card.getByRole("button", { name: "+ Add" }).click();
  await expect(card.getByLabel("Sing old songs", { exact: true })).toBeChecked();
  await card.getByLabel("Notes", { exact: true }).fill("Wolves howled all night");
  await card.getByLabel("GM notes").fill("The oak is haunted");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Long Rest saved")).toBeVisible();

  const saved = (await api(page, "downtimes", undefined, cid)).json.downtimes[0];
  expect(saved.activities).toEqual([
    { name: "Tend to Wounds", members: [Number(eli.id)], characters: [] }, { name: "Work on Project", members: [], characters: [] },
    { name: "Sing old songs", members: [], characters: [] }]);
  expect(saved.gm_notes).toBe("The oak is haunted");

  // The player sees the activities and who does them, never the GM notes, and can edit the public notes only.
  const mine = (await api(pp, "downtimes", undefined, cid)).json.downtimes[0];
  expect(mine).not.toHaveProperty("gm_notes");
  await pp.goto(`index.html#/c/${cid}/downtime`);
  const pcard = pp.locator(".downtime");
  await expect(pcard).toContainText("Tend to Wounds · Brother Eli");
  await expect(pcard).toContainText("Sing old songs");
  await expect(pcard).not.toContainText("haunted");
  await expect(pp.getByRole("button", { name: "+ New downtime" })).toHaveCount(0);
  await pcard.getByLabel("Notes").fill("Wolves howled all night. Eli kept watch");
  await pcard.getByRole("button", { name: "Save notes" }).click();
  await expect(pp.getByText("Notes saved")).toBeVisible();
  expect((await api(pp, "downtime_save", { id: mine.id, notes: "x", activities: [], gm_notes: "y", title: "z" }, cid)).status).toBe(200);
  const after = (await api(page, "downtimes", undefined, cid)).json.downtimes[0];
  expect(after.notes).toBe("x");
  expect(after.gm_notes).toBe("The oak is haunted");
  expect(after.activities).toHaveLength(3);
  expect((await api(pp, "downtime_save", { kind: "short_rest", slots: 0 }, cid)).status).toBe(403);
  expect((await api(pp, "downtime_delete", { id: mine.id }, cid)).status).toBe(403);

  expectNoErrors(errors);
  expectNoErrors(perrors);
  await pctx.close();
});

test("a short rest costs no shift, and downtime covers whole days and comes off them when deleted", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Fen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Downtime ${gm.id}`); // now: Dawn of day 2 (shift 8)
  await page.goto(`index.html#/c/${cid}/downtime`);

  await page.getByRole("button", { name: "+ New downtime" }).click();
  const dlg = page.locator("dialog.dt-dialog");
  await dlg.getByLabel("Short Rest").check();
  await expect(dlg.getByLabel("Shifts used up")).toHaveValue("0");
  await dlg.getByRole("button", { name: "Create" }).click();
  await expect(dlg).toHaveCount(0);
  expect(activities(cid)).toEqual(["2\t0\tShort Rest"]);
  expect(clock(cid)).toBe(8);
  await expect(page.locator(".downtime")).toContainText("no shift lost");

  // Downtime from day 5 to day 7: every shift of those days, and the clock goes to the last.
  await page.getByRole("button", { name: "+ New downtime" }).click();
  await dlg.getByLabel("Downtime").check();
  await expect(dlg.getByLabel("Shifts used up")).toBeHidden();
  const [start, end] = [dlg.locator(".datepick").nth(0), dlg.locator(".datepick").nth(1)];
  await start.getByLabel("Day").fill("6");
  await end.getByLabel("Day").fill("4");
  await dlg.getByRole("button", { name: "Create" }).click();
  await expect(dlg).toContainText("The end date is before the start date");
  await end.getByLabel("Day").fill("8");
  await dlg.getByRole("button", { name: "Create" }).click();
  await expect(dlg).toHaveCount(0);
  const rows = activities(cid);
  expect(rows.filter(r => r.endsWith("\tDowntime"))).toHaveLength(12);
  expect(rows).toContain("5\t0\tDowntime");
  expect(rows).toContain("7\t3\tDowntime");
  expect(clock(cid)).toBe(31);

  const cards = page.locator(".downtime");
  await expect(cards).toHaveCount(2);
  const dt = cards.first(); // newest first
  await expect(dt).toContainText("3 days");
  for (const a of ["Work on Project", "Crafting", "Career Pursuits", "Research", "Recuperate", "Train", "Networking", "Acquire an Asset", "Indulge or Carouse"]) await expect(dt.getByLabel(a, { exact: true })).toBeVisible();
  await expect(dt.getByLabel("Tend to Wounds", { exact: true })).toHaveCount(0);

  await moreIn(dt, "Delete");
  await page.locator(".kit-dialog").getByRole("button", { name: "Delete" }).click();
  await expect(cards).toHaveCount(1);
  expect(activities(cid).filter(r => r.endsWith("Downtime"))).toEqual([]);
  expect(clock(cid)).toBe(31);
  expectNoErrors(errors);
});

test("a split party's downtime offers every player and every character with no player in the party, whatever their group", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen"), p1 = person("Ash"), p2 = person("Bryn");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Split ${gm.id}`);
  const ctx = await newContext(browser);
  const pp = await ctx.newPage();
  const ids = {};
  for (const [k, who] of [["p1", p1], ["p2", p2]]) {
    const p = k === "p1" ? pp : await (await newContext(browser)).newPage();
    await signIn(p, who);
    await approve(browser, who.email);
    expect((await api(page, "member_add", { email: who.email, role: "player" }, cid)).status).toBe(200);
    ids[k] = (await (await p.request.get("api/auth/me.php")).json()).id;
  }
  const tpl = Number(sql(`INSERT INTO sheet_templates (name, game, layout) VALUES ('Downtime ${gm.id}', 'Test', '{"sections":[]}'); SELECT LAST_INSERT_ID();`).trim().split("\n").pop());
  const make = async body => (await api(page, "character_create", { template_id: tpl, owner_id: 0, party: true, ...body }, cid)).json.character;
  const hireling = await make({ name: "Hireling", kind: "npc" });
  const absent = await make({ name: "Absent Friend" });
  const spy = await make({ name: "Spy", kind: "npc" });
  sql(`UPDATE encyclopedia_entries SET is_secret=1 WHERE id=${spy.entry_id}`);
  let groups = (await api(page, "groups", undefined, cid)).json.groups;
  const split = await api(page, "group_split", { from_id: groups[0].id, name: "Scouts", members: [ids.p2], characters: [hireling.id] }, cid);
  expect(split.status).toBe(200);
  groups = split.json.groups;
  // Time passes for everyone alike: the dialog asks for no group, and the card names none.
  await page.goto(`index.html#/c/${cid}/downtime`);
  await page.getByRole("button", { name: "+ New downtime" }).click();
  const dlg = page.locator("dialog.dt-dialog");
  await expect(dlg.getByLabel("Party", { exact: true })).toHaveCount(0);
  await dlg.getByLabel("Short Rest").check();
  await dlg.getByRole("button", { name: "Create" }).click();
  await expect(dlg).toHaveCount(0);
  const card = page.locator(".downtime");
  await expect(card).not.toContainText("👥");
  await expect(card.getByLabel("Party", { exact: true })).toHaveCount(0);

  // Everyone is offered, from both groups: the players, then the characters with no player, the GM-only spy among them.
  await card.getByLabel("Relax", { exact: true }).check();
  const who = card.getByRole("group", { name: "Who does Relax" });
  await expect(who.getByRole("button")).toHaveCount(5);
  expect((await who.getByRole("button").allTextContents()).sort()).toEqual(["Absent Friend", "Ash", "Bryn", "Hireling (NPC)", "Spy (NPC)"]);
  for (const name of ["Bryn", "Hireling (NPC)", "Absent Friend", "Spy (NPC)"]) await who.getByRole("button", { name }).click();
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Short Rest saved")).toBeVisible();
  let saved = (await api(page, "downtimes", undefined, cid)).json.downtimes[0];
  expect(saved.activities[0].members).toEqual([ids.p2]);
  expect(saved.activities[0].characters.sort()).toEqual([hireling.id, absent.id, spy.id].sort());
  expect(saved.group_id).toBeNull();

  // A player reads the names, but not the GM-only character's.
  const mine = await api(pp, "downtimes", undefined, cid);
  expect(mine.json.downtimes[0].activities[0].characters.sort()).toEqual([hireling.id, absent.id].sort());
  expect(JSON.stringify(mine.json)).not.toContain("Spy");
  await pp.goto(`index.html#/c/${cid}/downtime`);
  await expect(pp.locator(".downtime")).toContainText("Absent Friend");
  await expect(pp.locator(".downtime")).not.toContainText("Spy");

  // A character of another campaign is dropped.
  expect((await api(page, "downtime_save", { id: saved.id, activities: [{ name: "Relax", members: [], characters: [999999] }] }, cid)).status).toBe(200);
  expect((await api(page, "downtimes", undefined, cid)).json.downtimes[0].activities[0].characters).toEqual([]);

  // a copy of the campaign points at its own characters
  expect((await api(page, "downtime_save", { id: saved.id, activities: [{ name: "Relax", members: [], characters: [hireling.id] }] }, cid)).status).toBe(200);
  const copy = await api(page, "campaign_copy", { name: `Split copy ${gm.id}` }, cid);
  expect(copy.status).toBe(200);
  const cc = Number(sql(`SELECT id FROM campaigns WHERE name='Split copy ${gm.id}'`).trim());
  const cch = JSON.parse(sql(`SELECT activities_json FROM downtimes WHERE campaign_id=${cc}`).trim())[0].characters;
  expect(sql(`SELECT e.name FROM sheet_characters c JOIN encyclopedia_entries e ON e.id=c.entry_id WHERE c.id=${cch[0]} AND c.campaign_id=${cc}`).trim()).toBe("Hireling");
  await page.reload();
  await expect(card.getByLabel("Relax", { exact: true })).toBeChecked();
  await expect(card.getByRole("group", { name: "Who does Relax" }).locator("button.on")).toHaveText(["Hireling (NPC)"]);
  expectNoErrors(errors);
  await ctx.close();
});
