// The month grid and the week view preview each day's notes: day notes, shift
// notes and (for GMs only) GM notes, with the full text on hover.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign } = require("./helpers");

test("month and week views preview the notes each member may read", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rue"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Previews ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  expect((await api(page, "day_update", { abs_day: 2, region_id: null, notes: "Market day in Bree\nThe inn is full", gm_notes: "The innkeeper is a spy" }, cid)).status).toBe(200);
  expect((await api(pp, "shift_note_add", { abs_day: 3, shift: 1, body: "Pip pockets a ring" }, cid)).status).toBe(200);

  // The server sends GM notes to GMs only.
  const range = async (p) => (await (await p.request.get(`api/index.php?a=days&cid=${cid}&from=0&to=10`)).json()).notes;
  const gmNotes = await range(page), plNotes = await range(pp);
  expect(gmNotes.find(n => n.abs_day === 2).items.map(n => n.kind)).toEqual(["day", "gm"]);
  expect(plNotes.find(n => n.abs_day === 2).items.map(n => n.kind)).toEqual(["day"]);
  expect(JSON.stringify(plNotes)).not.toContain("spy");
  expect(plNotes.find(n => n.abs_day === 3).items[0]).toMatchObject({ kind: "shift", shift: 1, text: "Pip pockets a ring" });

  // Month grid: the first note shows in the cell, every note in its tooltip.
  await page.goto(`index.html#/c/${cid}/calendar`);
  const cell2 = page.locator(`a.daycell[href$="/day/2"]`);
  await expect(cell2.locator(".dc-notes")).toHaveAttribute("data-tip", /Market day in Bree[\s\S]*GM notes 🔒: The innkeeper is a spy/);
  await expect(cell2.locator(".dc-notes .np-icon")).toBeVisible();
  const narrow = (page.viewportSize()?.width || 1000) <= 720;
  if (narrow) await expect(cell2.locator(".np-text")).toBeHidden(); // phones show just the 📝
  else {
    await expect(cell2.locator(".np-text").first()).toContainText("Market day in Bree");
    await expect(cell2).toContainText("+1 more note");
  }

  await pp.goto(`index.html#/c/${cid}/calendar`);
  await expect(pp.locator(`a.daycell[href$="/day/2"] .dc-notes`)).not.toHaveAttribute("data-tip", /spy/);
  await expect(pp.locator(`a.daycell[href$="/day/3"] .dc-notes`)).toHaveAttribute("data-tip", /Midday · Pip: Pip pockets a ring/);

  // Week view: day notes beside the date, shift notes in their shift.
  await pp.getByRole("button", { name: "Week" }).click();
  const row3 = pp.locator(`a.weekrow[href$="/day/3"]`);
  await expect(row3.locator(".shiftbox").nth(1).locator(".wr-note")).toContainText("Pip pockets a ring");
  const row2 = pp.locator(`a.weekrow[href$="/day/2"]`);
  await expect(row2.locator(".wr-date .wr-note")).toContainText("Market day in Bree");
  await expect(row2).not.toContainText("spy");

  await pctx.close();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});
