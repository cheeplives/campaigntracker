// Calendar reminders: set on a day and shift from the day page, they pop up once the campaign
// clock reaches them, for whoever they are meant for, until each person dismisses them.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign } = require("./helpers");

test("a GM's reminder pops up for the GM and an open player page when time passes to it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rhea"), player = person("Sol");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Reminders ${gm.id}`); // now: Dawn of day 2 (shift 8)
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await pp.clock.install();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  // Added from today's page, it starts on the next shift, since the clock is already on this one.
  await page.goto(`index.html#/c/${cid}`);
  await page.getByRole("button", { name: "+ Add reminder" }).click();
  const form = page.locator("form.reminder");
  await expect(form.getByLabel("Shift", { exact: true })).toHaveValue("1");
  await form.getByLabel("Title").fill("The ransom is due");
  await form.getByLabel("Details").fill("Meet the Black Hand at the bridge");
  await form.getByLabel("Who sees it").selectOption("all");
  await form.getByRole("button", { name: "Add reminder" }).click();
  await expect(page.getByText("Reminder saved")).toBeVisible();
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
  await page.getByRole("button", { name: "Pass time ▶" }).click();
  const dlg = page.locator("dialog.reminder-dialog");
  await expect(dlg).toContainText("🔔 Reminder");
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
  await pp.locator(".tabs a", { hasText: "Current Day" }).click();
  await expect(pp.locator(".tabs a.on")).toHaveText("Current Day");
  await expect(pp.locator(".event.reminder")).toContainText("Midday · Due");
  await expect(pdlg).toHaveCount(0);
  // A new page load asks again; this time the player dismisses it, and only for themselves.
  await pp.reload();
  await expect(pdlg).toContainText("The ransom is due");
  await pdlg.getByRole("button", { name: "Dismiss" }).click();
  await expect(pp.locator(".event.reminder")).toContainText("Midday · Due"); // until the page redraws
  const mine = (await api(pp, "reminders", undefined, cid)).json.reminders;
  expect(mine.map(x => [x.title, x.due, x.dismissed])).toEqual([["The ransom is due", true, true]]);
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
  const pctx = await browser.newContext();
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
  await pp.getByRole("button", { name: "+ Add reminder" }).click();
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
