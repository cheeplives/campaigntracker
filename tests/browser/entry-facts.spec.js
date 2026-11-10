// An Encyclopedia entry's facts: the short fields its Category gives it, shown in a box on its page; the Quest Category,
// whose Active ones are listed on At the Table; and Settings → Encyclopedia, where a GM sets each Category's fields
// (db/migrations/050_entry_facts.sql).
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, sql } = require("./helpers");
const LoreExport = require("../../static/lore-export.js");
test.afterEach(closeContexts);

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
const entries = async (page, cid) => (await api(page, "encyclopedia", undefined, cid)).json.entries;
const index = async (page, cid) => (await api(page, "campaign", undefined, cid)).json.encyclopedia;

test("facts are kept by Category, GM-only fields stay with the GMs, and a campaign sets its own fields", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Facts");
  // the built-in fields, with Quest among the Categories
  const fields = (await api(page, "campaign", undefined, cid)).json.entry_fields;
  expect(Object.keys(fields)).toEqual(["location", "person", "item", "group", "vehicle", "quest"]);
  expect(fields.quest.map(f => f.label)).toEqual(["Status", "Given by", "Reward", "Deadline"]);
  expect(fields.quest[0]).toEqual({ key: "status", label: "Status", options: ["Rumoured", "Active", "Done", "Failed", "Abandoned"], gm: false });
  expect(fields.quest[1].key).toBe("given_by");

  // only the Category's fields are kept and shown; blank ones are left out; long ones are cut
  const q = (await api(page, "entry_save", { name: "The Duke's poisoner", category: "quest", facts: { status: " Active ", given_by: "Gringle", reward: "", ruler: "nobody", x: "y" } }, cid)).json;
  expect((await entries(page, cid))[0].facts).toEqual({ status: "Active", given_by: "Gringle" });
  expect((await index(page, cid))[0]).toMatchObject({ category: "quest", facts: { status: "Active", given_by: "Gringle" } });
  expect((await api(page, "entry_save", { id: q.id, name: "The Duke's poisoner", facts: "Active" }, cid)).status).toBe(400);
  expect((await api(page, "entry_save", { id: q.id, name: "The Duke's poisoner", facts: { reward: "x".repeat(300) } }, cid)).status).toBe(200);
  expect((await entries(page, cid))[0].facts.reward).toHaveLength(200);
  // a save that says nothing of facts keeps them; another Category shows its own fields, and going back brings them back
  expect((await api(page, "entry_save", { id: q.id, name: "The Duke's poisoner", category: "location", facts: { ruler: "The Duke" } }, cid)).status).toBe(200);
  expect((await entries(page, cid))[0].facts).toEqual({ ruler: "The Duke" });
  expect((await api(page, "entry_save", { id: q.id, name: "The Duke's poisoner", category: "quest" }, cid)).status).toBe(200);
  expect((await entries(page, cid))[0].facts).toMatchObject({ status: "Active", given_by: "Gringle" });
  expect((await api(page, "entry_save", { name: "Bad", category: "saga" }, cid)).status).toBe(400);

  // the campaign's own fields for Person, one of them GM only; odd settings are read with care
  const settings = (await api(page, "campaign", undefined, cid)).json.campaign.settings;
  expect((await api(page, "campaign_update", { settings: { ...settings, entry_fields: { person: [{ label: "  True   name ", gm: true }, { label: "Role", options: ["Smith", "Smith", 7, ""] }, { label: "Role" }, "junk", { label: "!!" }], item: "junk", group: [] } } }, cid)).status).toBe(200);
  const mine = (await api(page, "campaign", undefined, cid)).json.entry_fields;
  expect(mine.person).toEqual([{ key: "true_name", label: "True name", options: [], gm: true }, { key: "role", label: "Role", options: ["Smith"], gm: false }]);
  expect(mine.group).toEqual([]);
  expect(mine.item.map(f => f.label)).toEqual(["Type", "Owner", "Value"]);   // not a list: the built-in ones
  const g = (await api(page, "entry_save", { name: "Gringle", category: "person", facts: { true_name: "Ragnaglar's own", role: "Pawnbroker" } }, cid)).json;
  const seen = async who => (await entries(who, cid)).find(e => e.id === g.id).facts;
  expect(await seen(page)).toEqual({ true_name: "Ragnaglar's own", role: "Pawnbroker" });
  expect(await seen(pp)).toEqual({ role: "Pawnbroker" });
  expect((await index(pp, cid)).find(e => e.id === g.id).facts).toEqual({ role: "Pawnbroker" });
  // a player changes what they can see, and can neither set nor clear the GM's field
  expect((await api(pp, "entry_save", { id: g.id, name: "Gringle", facts: { true_name: "guessed", role: "Fence" } }, cid)).status).toBe(200);
  expect(await seen(page)).toEqual({ true_name: "Ragnaglar's own", role: "Fence" });
  expect((await api(pp, "entry_save", { id: g.id, name: "Gringle", facts: { role: "" } }, cid)).status).toBe(200);
  expect(await seen(page)).toEqual({ true_name: "Ragnaglar's own" });

  // History keeps the facts and puts them back
  sql(`UPDATE content_versions SET saved_at = saved_at - INTERVAL 1 HOUR WHERE campaign_id=${cid}`);
  expect((await api(page, "entry_save", { id: g.id, name: "Gringle", facts: { true_name: "Someone else", role: "Mayor" } }, cid)).status).toBe(200);
  const versions = (await (await page.request.get(`api/index.php?a=history_list&cid=${cid}&kind=entry&ref=${g.id}`)).json()).versions;
  expect(versions.length).toBeGreaterThan(1);
  expect((await api(page, "history_restore", { id: versions[1].id }, cid)).status).toBe(200);
  expect(await seen(page)).toEqual({ true_name: "Ragnaglar's own" });
});

test("the Markdown export writes an entry's facts, GM-only ones only into the GM's copy", () => {
  const e = { id: 1, name: "Gringle", category: "person", notes: "<p>A pawnbroker</p>", links: [], files: [],
    fields: [{ label: "Role", value: "Pawnbroker" }, { label: "True name", value: "Ragnaglar's own", gm: true }] };
  const md = gmOnly => LoreExport.markdown(LoreExport.pick([e], { gmOnly }), [], { campaign: "C", gm: true, gmOnly, toMarkdown: h => h.replace(/<[^>]+>/g, ""), date: "2026-11-10" }).files[1].text;
  expect(md(true)).toContain("**Role:** Pawnbroker · **True name:** Ragnaglar's own");
  expect(md(false)).toContain("**Role:** Pawnbroker\n");
  expect(md(false)).not.toContain("Ragnaglar");
  expect(LoreExport.CATEGORIES.quest).toBe("Quest");
});

test("a GM writes a quest's facts on its entry; its page shows them and At the Table lists the Active ones", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Quests");
  expect((await api(page, "entry_save", { name: "Gringle", category: "person" }, cid)).status).toBe(200);
  // no Quest entry yet: At the Table has no quests box
  await page.goto(`index.html#/c/${cid}/table`);
  await expect(page.locator(".daybox[data-box=clocks]")).toBeVisible();
  await expect(page.locator(".daybox[data-box=quests]")).toHaveCount(0);

  await page.goto(`index.html#/c/${cid}/encyclopedia/new`);
  const form = page.locator(".enc-form");
  await form.getByLabel("Name", { exact: true }).fill("The Duke's poisoner");
  await expect(form.locator(".enc-facts-form")).toBeHidden();   // no Category, no fields
  await form.locator("select[name=category]").selectOption("person");
  await expect(form.locator(".enc-facts-form .lbl")).toHaveText(["Role", "Ancestry", "Affiliation", "Status", "Home"]);
  await form.getByLabel("Status", { exact: true }).fill("Missing");
  await form.locator("select[name=category]").selectOption("quest");
  await expect(form.locator(".enc-facts-form .lbl")).toHaveText(["Status", "Given by", "Reward", "Deadline"]);
  await expect(form.getByLabel("Status", { exact: true })).toHaveValue("Missing");   // what was typed stays
  await expect(form.locator("datalist option")).toHaveCount(5);
  await form.getByLabel("Status", { exact: true }).fill("Active");
  await form.getByLabel("Given by").fill("Gringle");
  await form.getByLabel("Reward").fill("500 Lunars");
  await form.getByRole("button", { name: "Add entry" }).click();

  // its page: Quest over the name, the facts under it, with Gringle's name a link
  const facts = page.locator(".enc-hero .enc-facts");
  await expect(facts.locator(".lbl")).toHaveText(["Status", "Given by", "Reward"]);
  await expect(facts).toContainText("Active");
  await expect(facts.getByRole("link", { name: "Gringle" })).toBeVisible();
  await expect(page.locator(".enc-kind")).toContainText("Quest");
  // the list finds it by a fact
  await page.getByLabel("Search the Encyclopedia").fill("500 lunars");
  await expect(page.locator(".enc-item")).toHaveCount(1);

  // At the Table, for the GM and the player
  for (const who of [page, pp]) {
    await who.goto(`index.html#/c/${cid}/table`);
    const box = who.locator(".daybox[data-box=quests]");
    await expect(box.locator(".daybox-sum")).toHaveText("1 active");
    await box.locator(".daybox-toggle").click();
    await expect(box.locator(".quest-row")).toHaveText(/The Duke's poisoner.*Given by: Gringle · Reward: 500 Lunars/);
    await expect(box.getByRole("link", { name: "All quests" })).toHaveAttribute("href", `#/c/${cid}/encyclopedia?cat=quest`);
  }
  // done: off the list, the box stays
  const q = (await entries(page, cid)).find(e => e.category === "quest");
  expect((await api(page, "entry_save", { id: q.id, name: q.name, facts: { status: "Done", given_by: "Gringle", reward: "500 Lunars" } }, cid)).status).toBe(200);
  await page.reload();
  const box = page.locator(".daybox[data-box=quests]");
  await expect(box.locator(".daybox-sum")).toHaveText("None active");
  // a GM-only quest is on the GM's list alone
  expect((await api(page, "entry_save", { name: "The cult below", category: "quest", is_secret: true, facts: { status: "active" } }, cid)).status).toBe(200);
  await page.reload();
  await expect(page.locator(".daybox[data-box=quests] .daybox-sum")).toHaveText("1 active");
  await pp.reload();
  await expect(pp.locator(".daybox[data-box=quests] .daybox-sum")).toHaveText("None active");
  expectNoErrors(errors);
});

test("Settings → Encyclopedia sets each Category's fields, a line each, and puts the built-in ones back", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Fields");
  await page.goto(`index.html#/c/${cid}/settings/encyclopedia`);
  const quest = page.getByLabel("Quest fields");
  await expect(quest).toHaveValue("Status: Rumoured, Active, Done, Failed, Abandoned\nGiven by\nReward\nDeadline");
  await quest.fill("Status: Open, Active, Closed\n\n  Patron (GM only)\nClue count");
  await page.getByRole("button", { name: "Save fields" }).click();
  await expect(page.locator("#toast")).toHaveText("Saved");
  const fields = (await api(page, "campaign", undefined, cid)).json.entry_fields;
  expect(fields.quest).toEqual([{ key: "status", label: "Status", options: ["Open", "Active", "Closed"], gm: false },
    { key: "patron", label: "Patron", options: [], gm: true }, { key: "clue_count", label: "Clue count", options: [], gm: false }]);
  expect(fields.person.map(f => f.label)).toEqual(["Role", "Ancestry", "Affiliation", "Status", "Home"]);   // saved as they stood
  await expect(page.getByLabel("Quest fields")).toHaveValue("Status: Open, Active, Closed\nPatron (GM only)\nClue count");

  // the entry form follows, and a player's form has no GM-only field
  await page.goto(`index.html#/c/${cid}/encyclopedia/new`);
  await page.locator(".enc-form").locator("select[name=category]").selectOption("quest");
  await expect(page.locator(".enc-facts-form .lbl")).toHaveText(["Status", "Patron 🔒", "Clue count"]);
  await pp.goto(`index.html#/c/${cid}/encyclopedia/new`);
  await pp.locator(".enc-form").locator("select[name=category]").selectOption("quest");
  await expect(pp.locator(".enc-facts-form .lbl")).toHaveText(["Status", "Clue count"]);

  // more than 12 is refused before it is sent
  await page.goto(`index.html#/c/${cid}/settings/encyclopedia`);
  await page.getByLabel("Item fields").fill(Array.from({ length: 13 }, (_, i) => `Field ${i + 1}`).join("\n"));
  await page.getByRole("button", { name: "Save fields" }).click();
  await expect(page.locator("#toast")).toContainText("Item has more than 12 fields");
  // back to the built-in ones
  await page.getByRole("button", { name: "Back to the built-in fields" }).click();
  await page.getByRole("button", { name: "Use the built-in fields" }).click();
  await expect(page.locator("#toast")).toHaveText("Saved");
  await expect(page.getByLabel("Quest fields")).toHaveValue("Status: Rumoured, Active, Done, Failed, Abandoned\nGiven by\nReward\nDeadline");
  expect((await api(page, "campaign", undefined, cid)).json.campaign.settings.entry_fields).toBeUndefined();
  // players have no Settings
  await pp.goto(`index.html#/c/${cid}/settings/encyclopedia`);
  await expect(pp.getByLabel("Quest fields")).toHaveCount(0);
  expectNoErrors(errors);
});
