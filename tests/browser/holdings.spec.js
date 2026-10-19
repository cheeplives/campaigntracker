// The Party Holdings tab: Gear and Loot down the left (item, claimed by, location, amount),
// and a card per holding on the right, added from a dialog whose fields follow the type.
// GM and players alike can add, change and remove both.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign } = require("./helpers");

async function campaignWithPlayer(page, browser, tag) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${tag} ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp, pctx };
}

test("players and the GM keep the Gear and Loot list, with a ticker for how many", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp, pctx } = await campaignWithPlayer(page, browser, "Gear");
  const perrors = watchErrors(pp);

  // A player adds an item from the last row.
  await pp.goto(`index.html#/c/${cid}/holdings`);
  await expect(pp.locator(".tabs a.on")).toHaveText("Party Holdings");
  const gear = pp.locator(".gear");
  await expect(gear).toContainText("Nothing yet");
  await gear.getByLabel("New item", { exact: true }).fill("Rope (50 ft)");
  await gear.getByLabel("New item claimed by").fill("Pip");
  await gear.getByLabel("New item location").fill("Pack mule");
  await gear.getByRole("button", { name: "How many of the new item: one more" }).click();
  await gear.getByRole("button", { name: "+ Add" }).click();
  const row = gear.locator(".gear-rows .gear-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByLabel("Item", { exact: true })).toHaveValue("Rope (50 ft)");
  await expect(gear.getByLabel("New item", { exact: true })).toHaveValue("");

  // Ticks save straight away, never below 0; the boxes save when you leave them.
  const count = row.locator(".tick-n");
  await expect(count).toHaveValue("2");
  await row.getByRole("button", { name: /one more/ }).click();
  await expect(count).toHaveValue("3");
  await expect.poll(async () => (await api(pp, "holdings", undefined, cid)).json.gear[0].amount).toBe(3);
  await row.getByLabel("Location").fill("Wagon");
  await row.getByLabel("Location").press("Tab");
  await expect.poll(async () => (await api(pp, "holdings", undefined, cid)).json.gear[0].location).toBe("Wagon");
  expect((await api(pp, "gear_tick", { id: (await api(pp, "holdings", undefined, cid)).json.gear[0].id, delta: -10 }, cid)).json.amount).toBe(0);
  expect((await api(pp, "gear_save", { item: "" }, cid)).status).toBe(400);

  // The GM sees it and can remove it.
  await page.goto(`index.html#/c/${cid}/holdings`);
  const grow = page.locator(".gear .gear-rows .gear-row");
  await expect(grow.getByLabel("Claimed by")).toHaveValue("Pip");
  await expect(grow.locator(".tick-n")).toHaveValue("0");
  await expect(grow.getByRole("button", { name: /one fewer/ })).toBeDisabled();
  await grow.getByRole("button", { name: "Remove Rope (50 ft)" }).click();
  await page.locator(".kit-dialog").getByRole("button", { name: "Remove" }).click();
  await expect(grow).toHaveCount(0);
  expect((await api(page, "holdings", undefined, cid)).json.gear).toEqual([]);

  expectNoErrors(errors);
  expectNoErrors(perrors);
  await pctx.close();
});

test("a holding's dialog shows the fields of its type, takes custom choices and tags, and its card edits and deletes", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp, pctx } = await campaignWithPlayer(page, browser, "Holdings");
  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}/holdings`);

  await pp.getByRole("button", { name: "+ Add holding" }).click();
  const dlg = pp.locator("dialog.hold-dialog");
  const fieldsOf = () => dlg.locator(".hold-fields .lbl").allTextContents();
  await expect(dlg.getByLabel("Type", { exact: true })).toHaveValue("vehicle");
  expect(await fieldsOf()).toEqual(["Top Speed", "Fuel Capacity", "Fuel Type", "Fuel Consumption", "Reliability", "Armor", "Crew", "Cargo", "Value"]);
  await dlg.getByLabel("Type", { exact: true }).selectOption("animal");
  expect(await fieldsOf()).toEqual(["Top Speed", "Training", "Armor", "Crew", "Cargo", "Value"]);
  await dlg.getByLabel("Type", { exact: true }).selectOption("asset");
  expect(await fieldsOf()).toEqual(["Category", "Value"]);
  await dlg.getByLabel("Type", { exact: true }).selectOption("custom");
  expect(await fieldsOf()).toEqual(["Value"]);
  await expect(dlg.getByLabel("Custom type", { exact: true })).toBeVisible();

  // A building with a construction type of its own.
  await dlg.getByLabel("Type", { exact: true }).selectOption("building");
  expect(await fieldsOf()).toEqual(["Construction Type", "Armor", "Size", "Value"]);
  await expect(dlg.getByLabel("Custom type", { exact: true })).toBeHidden();
  await dlg.getByRole("button", { name: "Add holding" }).click();
  await expect(dlg).toContainText("Give the holding a name");
  await dlg.getByLabel("Holding Name", { exact: true }).fill("Old Watchtower");
  await dlg.getByLabel("Location", { exact: true }).fill("Northern ridge");
  await dlg.getByLabel("Description").fill("Three floors.\nThe roof leaks.");
  await dlg.getByLabel("Construction Type", { exact: true }).selectOption("__custom");
  await dlg.getByLabel("Custom construction type").fill("Bone and wattle");
  await dlg.getByLabel("Size", { exact: true }).fill("Small");
  await dlg.getByLabel("Value", { exact: true }).fill("400 gp");
  await dlg.getByRole("button", { name: "Amount: one more" }).click();
  await dlg.getByLabel("New tag name").fill("Base");
  await dlg.getByRole("button", { name: "+ Add tag" }).click();
  await dlg.getByRole("button", { name: "Add holding" }).click();
  await expect(dlg).toHaveCount(0);

  const card = pp.locator(".holding");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Old Watchtower");
  await expect(card).toContainText("Building · 📍 Northern ridge");
  await expect(card).toContainText("Bone and wattle");
  await expect(card).toContainText("The roof leaks.");
  await expect(card.locator(".chip.tag")).toHaveText("Base");
  await expect(card.locator(".tick-n")).toHaveValue("2");
  await card.getByRole("button", { name: /one fewer/ }).click();
  await expect.poll(async () => (await api(pp, "holdings", undefined, cid)).json.holdings[0].amount).toBe(1);
  const saved = (await api(pp, "holdings", undefined, cid)).json.holdings[0];
  expect(saved.stats).toEqual({ construction: "Bone and wattle", size: "Small", value: "400 gp" });
  expect(saved.tags.map(t => t.name)).toEqual(["Base"]);

  // The GM edits it into a custom type: only Value stays among its fields.
  await page.goto(`index.html#/c/${cid}/holdings`);
  await page.locator(".holding").getByRole("button", { name: "Edit" }).click();
  const gdlg = page.locator("dialog.hold-dialog");
  await expect(gdlg.getByLabel("Construction Type", { exact: true })).toHaveValue("__custom");
  await expect(gdlg.getByLabel("Custom construction type")).toHaveValue("Bone and wattle");
  await gdlg.getByLabel("Type", { exact: true }).selectOption("custom");
  await gdlg.getByRole("button", { name: "Save" }).click();
  await expect(gdlg).toContainText("Name the custom type");
  await gdlg.getByLabel("Custom type", { exact: true }).fill("Hideout");
  await gdlg.getByRole("button", { name: "Save" }).click();
  await expect(gdlg).toHaveCount(0);
  await expect(page.locator(".holding")).toContainText("Hideout · 📍 Northern ridge");
  await expect(page.locator(".holding")).not.toContainText("Bone and wattle");
  const edited = (await api(page, "holdings", undefined, cid)).json.holdings[0];
  expect(edited).toMatchObject({ kind: "custom", type_name: "Hideout", amount: 1, stats: { value: "400 gp" } });
  expect(edited.tags.map(t => t.name)).toEqual(["Base"]);
  expect((await api(page, "holding_save", { name: "X", kind: "spaceship" }, cid)).status).toBe(400);

  // The player deletes it.
  await pp.reload();
  await pp.locator(".holding").getByRole("button", { name: "Delete" }).click();
  await pp.locator(".kit-dialog").getByRole("button", { name: "Delete" }).click();
  await expect(pp.locator(".holding")).toHaveCount(0);
  await expect(pp.getByText("No holdings yet")).toBeVisible();

  expectNoErrors(errors);
  expectNoErrors(perrors);
  await pctx.close();
});
