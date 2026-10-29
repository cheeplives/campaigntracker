// A GM picks baseline actions into a shift's activity and can still type freely;
// players and GMs add notes to a shift, signed with their character name.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("shift actions are picked into the activity alongside free text", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Kit");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Actions ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/day/2`);

  const card = page.locator(".shiftcard").first();
  const activity = card.locator("textarea").first();
  await activity.fill("Ana and Bo");
  await card.getByLabel("Add an action").selectOption("Scout ahead");
  await expect(activity).toHaveValue("Ana and Bo; Scout ahead");
  await expect(card).toContainText("Scout ahead: Range ahead");
  await card.getByLabel("Add an action").selectOption("Keep watch");
  await expect(activity).toHaveValue("Ana and Bo; Scout ahead; Keep watch");
  await expect(card.getByLabel("Add an action")).toHaveValue("");
  await card.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Dawn saved")).toBeVisible();
  const r = await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`);
  const s = (await r.json()).shifts.find(x => Number(x.shift) === 0);
  expect(s.activity).toBe("Ana and Bo; Scout ahead; Keep watch");

  expectNoErrors(errors);
});

// Not a <datalist>: Android Chrome shows those as a sideways strip above the keyboard.
test("the pass-time activity box drops down a list of actions that works by tap, mouse and keyboard", async ({ page, browser, hasTouch }) => {
  const errors = watchErrors(page);
  const gm = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Pass actions ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/today`);

  const box = page.getByRole("combobox", { name: "Activity" });
  const list = page.locator(".passtime .combo-list");
  await expect(page.locator(".passtime datalist")).toHaveCount(0);
  await expect(list).toBeHidden();

  // The ▾ opens every action, grouped, and a pick fills the box and closes the list.
  const arrow = page.locator(".passtime .combo-btn");
  hasTouch ? await arrow.tap() : await arrow.click();
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(await page.evaluate(() => Engine.SHIFT_ACTIONS.length));
  await expect(list.locator(".combo-group").first()).toHaveText("On the move");
  const nav = list.getByRole("option", { name: /Navigate/ });
  hasTouch ? await nav.tap() : await nav.click();
  await expect(box).toHaveValue("Navigate");
  await expect(list).toBeHidden();

  // Typing filters it; arrow keys and Enter pick; anything else stays free text.
  await box.fill("");
  await box.pressSequentially("watch");
  await expect(list.getByRole("option")).toHaveCount(1);
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("Keep watch");
  await expect(list).toBeHidden();
  await box.fill("Marching to Altdorf");
  await expect(list).toBeHidden();

  // A tap or click elsewhere closes it.
  hasTouch ? await arrow.tap() : await arrow.click();
  await expect(list).toBeVisible();
  const label = page.locator(".passtime .lbl");
  hasTouch ? await label.tap({ position: { x: 4, y: 4 } }) : await label.click({ position: { x: 4, y: 4 } });
  await expect(list).toBeHidden();
  expectNoErrors(errors);
});

test("a campaign from before Dawn came first keeps every shift at the same moment", async ({ page, browser }) => {
  const gm = person("Mara");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Old order ${gm.id}`);
  // Put it back the way it was stored before: Overnight (0), Dawn, Midday, Dusk; "now" is Dawn of day 5.
  sql(`UPDATE campaigns SET current_shift = 21,
         calendar_json = '{"months":[{"name":"M","days":30}],"weekdays":["A"],"shiftNames":["Night","Morn","Noonish","Eve"],"lightLevels":[2,4,5,4]}' WHERE id = ${cid};
       UPDATE regions SET settings_json = '{"climate":"temperate","lighting":"artificial","light_levels":[1,2,3,4]}' WHERE campaign_id = ${cid};
       INSERT INTO shifts (campaign_id, abs_day, shift, activity) VALUES
         (${cid}, 5, 0, 'night before'), (${cid}, 5, 1, 'morning'), (${cid}, 5, 2, 'noon'), (${cid}, 5, 3, 'evening'), (${cid}, 6, 0, 'night after');
       INSERT INTO events (campaign_id, abs_day, end_day, shift, title) VALUES
         (${cid}, 5, NULL, 0, 'Owl'), (${cid}, 5, 5, 0, 'Fox'), (${cid}, 5, 7, 0, 'Trek'), (${cid}, 5, NULL, 3, 'Supper'), (${cid}, 5, NULL, NULL, 'Fair');`);

  const { json } = await api(page, "campaign", undefined, cid);
  expect(json.campaign.current_shift).toBe(20); // Dawn of day 5 is now shift 0 of day 5
  expect(json.campaign.calendar.shiftNames).toEqual(["Morn", "Noonish", "Eve", "Night"]);
  expect(json.campaign.calendar.lightLevels).toEqual([4, 5, 4, 2]);
  expect(json.regions[0].settings.light_levels).toEqual([2, 3, 4, 1]);

  const rows = sql(`SELECT abs_day, shift, activity FROM shifts WHERE campaign_id = ${cid} ORDER BY abs_day, shift`).trim().split("\n");
  expect(rows).toEqual(["4\t3\tnight before", "5\t0\tmorning", "5\t1\tnoon", "5\t2\tevening", "5\t3\tnight after"]);
  const evs = sql(`SELECT title, abs_day, IFNULL(end_day, '-'), IFNULL(shift, '-') FROM events WHERE campaign_id = ${cid} ORDER BY id`).trim().split("\n");
  expect(evs).toEqual(["Owl\t4\t-\t3", "Fox\t4\t4\t3", "Trek\t4\t7\t3", "Supper\t5\t-\t2", "Fair\t5\t-\t-"]);

  // It only happens once.
  await api(page, "campaign", undefined, cid);
  expect(sql(`SELECT current_shift FROM campaigns WHERE id = ${cid}`).trim()).toBe("20");
});

test("players and GMs add shift notes, signed with their character name", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Lou"), player = person("Max");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Notes ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  // The player names their character on the Members tab.
  await pp.goto(`index.html#/c/${cid}/members`);
  const row = pp.locator(".listrow", { hasText: "Max" });
  await row.getByRole("button", { name: "Set character" }).click();
  await pp.locator(".kit-dialog-input").fill("Sir Maximus");
  await pp.getByRole("button", { name: "Save" }).click();
  await expect(row.locator(".member-char .charname")).toHaveText("Sir Maximus");
  // Players can't rename someone else's character.
  const lou = (await api(page, "campaign", undefined, cid)).json.members.find(m => m.display_name === "Lou");
  expect((await api(pp, "member_character", { user_id: lou.id, character_name: "Nope" }, cid)).status).toBe(403);

  // The player adds a note to the first shift; it is signed with the character name.
  await pp.goto(`index.html#/c/${cid}/day/2`);
  const card = pp.locator(".shiftcard").first();
  await card.locator(".shiftnotes textarea").fill("Heard wolves to the north");
  await card.getByRole("button", { name: "Add note" }).click();
  await expect(pp.locator(".shiftcard").first().locator(".shiftnotes")).toContainText("Heard wolves to the north");
  await expect(pp.locator(".shiftcard").first().locator(".shiftnotes")).toContainText("Sir Maximus");

  // The GM sees it and adds their own, signed with their account name.
  await page.goto(`index.html#/c/${cid}/day/2`);
  const gcard = page.locator(".shiftcard").first();
  await expect(gcard.locator(".shiftnotes")).toContainText("Sir Maximus");
  await gcard.locator(".shiftnotes textarea").fill("The wolves are a warg pack");
  await gcard.getByRole("button", { name: "Add note" }).click();
  await expect(page.locator(".shiftcard").first().locator(".shiftnotes")).toContainText("— Lou");

  // Events the player adds carry the character name too.
  await api(page, "campaign_update", { settings: { players_can_add_events: true } }, cid);
  await api(pp, "event_save", { abs_day: 2, title: "Found a ford" }, cid);
  const r = await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`);
  const body = await r.json();
  expect(body.events.find(e => e.title === "Found a ford").author).toBe("Sir Maximus");
  expect(body.shift_notes.map(n => n.author)).toEqual(["Sir Maximus", "Lou"]);
  await pctx.close();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("the GM moves the NOW flag from shift title to shift title; players only see it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rue"), player = person("Sam");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Now flag ${gm.id}`); // now is Dawn of day 2
  await page.goto(`index.html#/c/${cid}`);
  const nowCard = page.locator(".shiftcard.now");
  await expect(nowCard.locator("h4")).toContainText("Dawn");
  await expect(nowCard.locator(".nowtag")).toHaveText("NOW");
  // No separate button on each card any more: the other titles take the flag.
  await expect(page.getByRole("button", { name: "Set as now" })).toHaveCount(0);
  await expect(page.locator(".shiftcard .nowpick")).toHaveCount(3);

  await page.locator(".shifts").getByRole("button", { name: "Move Now to Dusk" }).click();
  await expect(page.locator(".shiftcard.now h4")).toContainText("Dusk");
  await expect.poll(async () => (await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(10);
  // And back again, to an earlier shift.
  await page.locator(".shifts").getByRole("button", { name: "Move Now to Dawn" }).click();
  await expect(page.locator(".shiftcard.now h4")).toContainText("Dawn");
  await expect.poll(async () => (await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(8);
  // The Weather box's strip of shift forecasts carries the flag too, and moves it the same way.
  await expect(page.locator(".dh-step.now .nowtag")).toHaveText("NOW");
  await expect(page.locator(".dh-step.now")).toContainText("Dawn");
  await page.locator(".dh-strip").getByRole("button", { name: "Move Now to Midday" }).click();
  await expect(page.locator(".dh-step.now")).toContainText("Midday");
  await expect(page.locator(".shiftcard.now h4")).toContainText("Midday");
  await expect.poll(async () => (await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(9);

  // A player sees the flag but can't move it.
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator(".shiftcard.now .nowtag")).toHaveText("NOW");
  await expect(pp.locator(".nowpick")).toHaveCount(0);
  await pctx.close();
  expectNoErrors(errors);
});
