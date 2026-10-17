// A GM picks baseline actions into a shift's activity and can still type freely.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign } = require("./helpers");

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

  // The pass-time box suggests the same actions.
  await expect(page.locator("#pass-actions option")).toHaveCount(await page.evaluate(() => Engine.SHIFT_ACTIONS.length));
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
