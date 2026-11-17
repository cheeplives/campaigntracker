// Calendar reminders: set on a day and shift from the day page, they pop up once the campaign
// clock reaches them, for whoever they are meant for, until each person dismisses them.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign, openPassTime, notNow, newContext, closeContexts, goTab, moreIn } = require("./helpers");
test.afterEach(closeContexts);

test("a GM's reminder pops up for the GM and an open player page when time passes to it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rhea"), player = person("Sol");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Reminders ${gm.id}`); // now: Dawn of day 2 (shift 8)
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await pp.clock.install();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  // Added from today's page, it starts on the next shift, since the clock is already on this one.
  await page.goto(`index.html#/c/${cid}`);
  await page.getByRole("button", { name: "+ New reminder" }).click();
  const form = page.locator("form.reminder");
  await expect(form.getByLabel("Shift", { exact: true })).toHaveValue("1");
  await form.getByLabel("Title").fill("The ransom is due");
  await form.getByLabel("Details").fill("Meet the Black Hand at the bridge");
  await form.getByLabel("Who sees it").selectOption("all");
  await form.getByRole("button", { name: "Add reminder" }).click();
  await expect(page.getByText("Reminder saved")).toBeVisible();
  await notNow(page); // the detector offers the Black Hand for the Encyclopedia
  const card = page.locator(".event.reminder");
  await expect(card).toContainText("The ransom is due");
  await expect(card).toContainText("Midday · Waiting");
  await expect(card).toContainText("Everyone");
  expect(sql(`SELECT due_shift, audience FROM reminders WHERE campaign_id = ${cid}`).trim()).toBe("9\tall");
  // Not due yet, so nothing pops up.
  await expect(page.locator("dialog.reminder-dialog")).toHaveCount(0);

  // The calendar marks the day with a bell.
  await page.goto(`index.html#/c/${cid}/calendar`);
  await expect(page.locator(".daycell.today .dc-bell")).toBeVisible();

  // The player has the calendar open. The GM passes one shift and the reminder pops up for the GM.
  await pp.goto(`index.html#/c/${cid}/calendar`);
  await expect(pp.locator(".tabs a.on")).toHaveText("Calendar");
  await pp.waitForTimeout(1100); // so the change stamp moves
  await openPassTime(page);
  await page.getByRole("button", { name: "Pass time ▶" }).click();
  const dlg = page.locator("dialog.reminder-dialog");
  await expect(dlg).toContainText("Reminder");
  await expect(dlg).toContainText("The ransom is due");
  await expect(dlg).toContainText("Meet the Black Hand at the bridge");
  await dlg.getByRole("button", { name: "Dismiss" }).click();
  await expect(dlg).toHaveCount(0);
  // Dismissed: it doesn't come back for the GM.
  await page.reload();
  await expect(page.locator(".tabs a.on")).toHaveText("Calendar");
  await page.waitForTimeout(500);
  await expect(page.locator("dialog.reminder-dialog")).toHaveCount(0);

  // The player's open page notices the change on its next check and pops it up without a refresh.
  await pp.clock.runFor(31_000);
  const pdlg = pp.locator("dialog.reminder-dialog");
  await expect(pdlg).toContainText("The ransom is due");
  // Remind me later: gone until the clock moves again.
  await pdlg.getByRole("button", { name: "Remind me later" }).click();
  await expect(pdlg).toHaveCount(0);
  await goTab(pp, "At the Table");
  await expect(pp.locator(".tabs a.on")).toHaveText("At the Table");
  await expect(pp.locator("[data-box=table-reminders] .event.reminder")).toContainText("Midday · Due");   // in today's Reminders box
  await expect(pdlg).toHaveCount(0);
  // A new page load asks again; this time the player dismisses it, and only for themselves.
  await pp.reload();
  await expect(pdlg).toContainText("The ransom is due");
  await pdlg.getByRole("button", { name: "Dismiss" }).click();
  await expect(pp.locator("[data-box=table-reminders] .event.reminder")).toContainText("Midday · Due"); // until the page redraws
  // Dismiss saves in the background, so wait for the server to have it.
  await expect.poll(async () => (await api(pp, "reminders", undefined, cid)).json.reminders.map(x => [x.title, x.due, x.dismissed]))
    .toEqual([["The ransom is due", true, true]]);
  const mine = (await api(pp, "reminders", undefined, cid)).json.reminders;
  // The player can't change the GM's reminder.
  await expect(pp.locator(".event.reminder").getByRole("button", { name: "Edit" })).toHaveCount(0);
  expect((await api(pp, "reminder_delete", { id: mine[0].id }, cid)).status).toBe(404);

  // Moving it to a later time sets it off again, for everyone.
  expect((await api(page, "reminder_save", { id: mine[0].id, title: "The ransom is due", due_shift: 12, audience: "all" }, cid)).status).toBe(200);
  const again = (await api(pp, "reminders", undefined, cid)).json.reminders[0];
  expect([again.due, again.dismissed]).toEqual([false, false]);
  expectNoErrors(errors);
  expectNoErrors(perrors);
  await pctx.close();
});

test("players keep their own reminders, GMs can share theirs, and only future times are taken", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Tara"), player = person("Uri");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Reminder access ${gm.id}`); // now: shift 8
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  // The clock has passed shift 8's start, so a reminder there (or before) is refused.
  expect((await api(page, "reminder_save", { title: "Too late", due_shift: 8, audience: "me" }, cid)).status).toBe(400);
  expect((await api(page, "reminder_save", { title: "GMs: the spy reports", due_shift: 10, audience: "gm" }, cid)).status).toBe(200);
  expect((await api(page, "reminder_save", { title: "My own note", due_shift: 10, audience: "me" }, cid)).status).toBe(200);
  expect((await api(page, "reminder_save", { title: "Market day", due_shift: 11, audience: "all" }, cid)).status).toBe(200);
  // A player can only keep reminders for themselves.
  expect((await api(pp, "reminder_save", { title: "Tell everyone", due_shift: 10, audience: "all" }, cid)).status).toBe(403);
  expect((await api(pp, "reminder_save", { title: "Buy rope", due_shift: 9, audience: "me" }, cid)).status).toBe(200);

  const titles = async p => (await api(p, "reminders", undefined, cid)).json.reminders.map(x => x.title);
  expect(await titles(page)).toEqual(["GMs: the spy reports", "My own note", "Market day"]);
  expect(await titles(pp)).toEqual(["Buy rope", "Market day"]);

  // On the day page a player sees no audience picker, only their own reminders and shared ones.
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator(".event.reminder")).toHaveCount(2);
  await pp.getByRole("button", { name: "+ New reminder" }).click();
  await expect(pp.locator("form.reminder")).toContainText("Only you see your reminders.");
  await expect(pp.locator("form.reminder").getByLabel("Who sees it")).toHaveCount(0);

  // Switching the campaign to hours moves each reminder to the same time of day, like the clock.
  const c = (await api(page, "campaign", undefined, cid)).json.campaign;
  expect((await api(page, "campaign_update", { calendar: { ...c.calendar, timeMode: "hours" } }, cid)).status).toBe(200);
  const after = (await api(page, "reminders", undefined, cid)).json.reminders;
  // Dawn of day 2 is 06:00 (hour 54), Dusk 18:00 and Overnight the midnight after.
  expect((await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(54);
  expect(after.map(r => [r.title, r.due_shift])).toEqual([["GMs: the spy reports", 66], ["My own note", 66], ["Market day", 72]]);
  expectNoErrors(errors);
  await pctx.close();
});

test("the Events tab's Reminders half lists every reminder, filters it, and adds, edits and deletes them", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Vela"), player = person("Wim");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Reminder list ${gm.id}`); // now: shift 8 (Dawn of day 2)
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const save = async (p, r) => expect((await api(p, "reminder_save", r, cid)).status).toBe(200);
  await save(page, { title: "The spy reports", body: "At the old mill", due_shift: 9, audience: "gm" });
  await save(page, { title: "Market day", due_shift: 13, audience: "all" });
  await save(page, { title: "Check the wards", due_shift: 20, audience: "me" });
  await save(pp, { title: "Buy rope", due_shift: 10, audience: "me" });
  sql(`UPDATE campaigns SET current_shift = 9 WHERE id = ${cid}`); // the spy's report is due now

  // The Events tab has Events and Reminders along the top; Reminders has its own address.
  await page.goto(`index.html#/c/${cid}/events`);
  await page.locator("dialog.reminder-dialog").getByRole("button", { name: "Remind me later" }).click();
  const sub = page.getByRole("navigation", { name: "Events and reminders" });
  await expect(sub.getByRole("link", { name: "Events" })).toHaveAttribute("aria-current", "page");
  await sub.getByRole("link", { name: "Reminders" }).click();
  await expect(page).toHaveURL(/#\/c\/\d+\/events\/reminders$/);
  await expect(page.locator(".tabs a.on")).toHaveText("Events");
  const rows = page.locator(".remrow");
  await expect(rows.locator("h4")).toHaveText(["The spy reports", "Market day", "Check the wards"]);
  await expect(page.getByText("3 reminders")).toBeVisible();
  await expect(rows.first()).toContainText("Due");
  await expect(rows.first()).toContainText("GMs only");
  await expect(rows.nth(1)).toContainText("Waiting");

  // Search, which-reminders, who-sees-it and order narrow and turn the list.
  const search = page.getByRole("searchbox", { name: "Search reminders" });
  await search.fill("mill");
  await expect(rows.locator("h4")).toHaveText(["The spy reports"]);
  await expect(page.getByText("1 of 3 reminders")).toBeVisible();
  await search.fill("");
  await page.getByLabel("Which reminders").selectOption("waiting");
  await expect(rows.locator("h4")).toHaveText(["Market day", "Check the wards"]);
  await page.getByLabel("Who sees it").selectOption("all");
  await expect(rows.locator("h4")).toHaveText(["Market day"]);
  await page.getByLabel("Which reminders").selectOption("all");
  await page.getByLabel("Who sees it").selectOption({ label: "For anyone" });
  await page.getByLabel("Order").selectOption("desc");
  await expect(rows.locator("h4")).toHaveText(["Check the wards", "Market day", "The spy reports"]);
  await page.getByLabel("Order").selectOption("asc");

  // Edit one where it is: the filters stay as they were.
  await rows.filter({ hasText: "Market day" }).getByRole("button", { name: "Edit" }).click();
  const form = page.locator("form.reminder");
  await form.getByLabel("Title").fill("Market day at Thornbury");
  await form.getByRole("button", { name: "Save reminder" }).click();
  await expect(page.getByText("Reminder saved")).toBeVisible();
  await notNow(page); // the detector offers Thornbury for the Encyclopedia
  await expect(rows.locator("h4")).toHaveText(["The spy reports", "Market day at Thornbury", "Check the wards"]);

  // + New reminder adds one on any day.
  await page.getByRole("button", { name: "+ New reminder" }).click();
  await form.getByLabel("Title").fill("Harvest moon");
  await form.getByRole("button", { name: "Add reminder" }).click();
  await expect(page.getByText("Reminder saved")).toBeVisible();
  await expect(page.getByText("4 reminders")).toBeVisible();

  // Delete goes at once, with Undo in the toast for a few seconds.
  await moreIn(rows.filter({ hasText: "Check the wards" }), "Delete");
  await expect(rows.filter({ hasText: "Check the wards" })).toBeHidden();

  // A player sees their own reminders and everyone's, with no who-sees-it filter, and can't edit the GM's.
  await pp.goto(`index.html#/c/${cid}/events/reminders`);
  const prow = pp.locator(".remrow");
  await expect(prow.locator("h4")).toHaveText(["Buy rope", "Market day at Thornbury"]);
  await expect(pp.getByLabel("Who sees it")).toHaveCount(0);
  await expect(prow.filter({ hasText: "Buy rope" }).getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(prow.filter({ hasText: "Market day" }).getByRole("button", { name: "Edit" })).toHaveCount(0);
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("a reminder set to every shift pops up At the Table on each shift until dismissed, and can be marked done", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Tamsin"), player = person("Ulf");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Repeating reminders ${gm.id}`); // now: Dawn of day 2 (shift 8)
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const mine = async p => (await api(p, "reminders", undefined, cid)).json.reminders;

  // Set from At the Table's Reminders box, starting on the next shift, every shift until dismissed.
  await page.goto(`index.html#/c/${cid}`);
  await expect(page.locator(".tabs a.on")).toHaveText("At the Table");
  await page.locator("[data-box=table-reminders]").getByText("Reminders", { exact: true }).first().click();
  await page.locator("[data-box=table-reminders]").getByRole("button", { name: "+ New reminder" }).click();
  const form = page.locator("form.reminder");
  await form.getByLabel("Title").fill("Torches burn down");
  await form.getByLabel("How often").selectOption("shift");
  await form.getByRole("button", { name: "Add reminder" }).click();
  await expect(page.getByText("Reminder saved")).toBeVisible();
  expect(sql(`SELECT due_shift, repeat_every FROM reminders WHERE campaign_id = ${cid}`).trim()).toBe("9\tshift");
  await expect(page.locator(".event.reminder")).toContainText("Midday · every shift · Waiting");

  // End shift: it pops up At the Table. Got it puts it away for this shift only, even across a reload.
  const dlg = page.locator("dialog.reminder-dialog");
  const endShift = name => page.locator(".tv-bar").getByRole("button", { name }).click();
  await endShift(/^End Dawn/);
  await page.getByRole("button", { name: "Not now" }).click();   // no session open: asked once in this browser
  await expect(dlg).toContainText("Torches burn down");
  await expect(dlg).toContainText("Every shift from");
  await dlg.getByRole("button", { name: "Got it" }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await mine(page))[0].seen_shift).toBe(9);
  await page.reload();
  await expect(page.locator(".tabs a.on")).toHaveText("At the Table");
  await page.waitForTimeout(500);
  await expect(dlg).toHaveCount(0);
  // the badge up top still lists it while it is going
  await expect(page.locator(".tv-rem-chip")).toContainText("1 reminder");

  // The next shift it is back; its own Dismiss stops it for good (for this GM).
  await endShift(/^End Midday/);
  await expect(dlg).toContainText("Torches burn down");
  await dlg.locator(".reminder").getByRole("button", { name: "Dismiss" }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await mine(page))[0].dismissed).toBe(true);
  await endShift(/^End Dusk/);
  await expect(page.locator(".tv-rem-chip")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(dlg).toHaveCount(0);

  // A shared one: a player dismisses it for themselves from the list; the GM marks it done for everyone.
  expect((await api(page, "reminder_save", { title: "Wandering monsters", due_shift: 12, repeat_every: "shift", audience: "all" }, cid)).status).toBe(200);
  expect((await api(page, "reminder_save", { title: "Rations", due_shift: 12, repeat_every: "shift", audience: "all" }, cid)).status).toBe(200);
  expect((await api(pp, "reminder_done", { id: (await mine(pp))[0].id }, cid)).status).toBe(404); // a player can't mark the GM's done
  await endShift(/^End Overnight/);
  await expect(dlg).toContainText("2 reminders");
  await dlg.locator(".reminder", { hasText: "Rations" }).getByRole("button", { name: "✓ Mark done" }).click();
  await expect(dlg).toContainText("Reminder");
  await expect(dlg).not.toContainText("Rations");
  await dlg.getByRole("button", { name: "Remind me later" }).click();
  const rations = (await mine(pp)).find(x => x.title === "Rations");
  expect([rations.done, rations.due]).toEqual([true, false]);

  await pp.goto(`index.html#/c/${cid}/events/reminders`);
  const pdlg = pp.locator("dialog.reminder-dialog");
  await expect(pdlg).toContainText("Wandering monsters");
  await expect(pdlg).not.toContainText("Rations");
  await pdlg.getByRole("button", { name: "Remind me later" }).click();
  const row = pp.locator(".remrow", { hasText: "Wandering monsters" });
  await expect(row).toContainText("every shift · Due");
  await expect(row.getByRole("button", { name: "✓ Mark done" })).toHaveCount(0);
  await row.getByRole("button", { name: "Dismiss" }).click();
  await expect(pp.getByText("Reminder dismissed")).toBeVisible();
  await expect(pp.locator(".remrow", { hasText: "Wandering monsters" })).toContainText("Dismissed");
  await expect(pp.locator(".remrow", { hasText: "Rations" })).toContainText("Done");
  await pp.getByLabel("Which reminders").selectOption("done");
  await expect(pp.locator(".remrow")).toHaveCount(1);

  // The GM reopens Rations from the list: it pops up again.
  await page.goto(`index.html#/c/${cid}/events/reminders`);   // Remind me later still holds on this page load
  await expect(page.locator(".remrow", { hasText: "Rations" })).toContainText("Done");
  await page.locator(".remrow", { hasText: "Rations" }).getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("Reminder reopened")).toBeVisible();
  await expect(page.locator(".remrow", { hasText: "Rations" })).toContainText("Due");
  await page.reload();
  await expect(dlg).toContainText("Rations");
  await expect(dlg).toContainText("Wandering monsters");
  expectNoErrors(errors);
  await pctx.close();
});
