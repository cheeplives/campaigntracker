// Every campaign screen renders for a GM with no script errors, members are
// picked from the registered accounts or added by sign-in email, and players never receive secret events.
const { test, expect } = require("@playwright/test");
const { goTab, watchErrors, expectNoErrors, person, ADMIN, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("a GM creates a campaign and every tab renders", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Greta");
  await signIn(page, gm);
  await approve(browser, gm.email);
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("The Long Road");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "The Long Road" })).toBeVisible();
  await expect(page.locator(".tabs a.on")).toHaveText("At the Table");
  // goTab unfolds the Legend's Setup group (it starts folded) and opens the iPad's drawer when it has to
  for (const tab of ["Calendar", "Travel", "Party Holdings", "Regions", "Holidays", "Members", "Settings", "At the Table"]) {
    await goTab(page, tab);
    await expect(page.locator(".tabs a.on")).toHaveText(tab);
  }
  await page.goto(page.url().replace(/#.*/, "") + "#/account");
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
  expectNoErrors(errors);
});

for (const first of [true, false]) {
  test(`Cancel on the new campaign form goes back to the campaign list (${first ? "first campaign" : "with campaigns"})`, async ({ page, browser }) => {
    const errors = watchErrors(page);
    const gm = person("Cass");
    await signIn(page, gm);
    await approve(browser, gm.email);
    if (!first) await makeCampaign(page, "Already Running");
    await page.goto("index.html#/");
    await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
    await page.getByRole("button", { name: "+ New campaign" }).click();
    await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
    if (!first) await expect(page.getByRole("link", { name: /Already Running/ })).toBeVisible();
    // the browser's Back button leaves the form too
    await page.getByRole("button", { name: "+ New campaign" }).click();
    await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
    expectNoErrors(errors);
  });
}

test("a custom calendar gets its own number of months, each with its own length", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Kit");
  await signIn(page, gm);
  await approve(browser, gm.email);
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Odd Months");
  await page.getByLabel("Calendar preset").selectOption("custom");
  const count = page.getByRole("spinbutton", { name: /Number of months/ });
  await count.fill("3");
  await count.press("Tab");
  await page.getByLabel("Month 1 days").fill("10");
  await page.getByLabel("Month 2 name").fill("Longmonth");
  await page.getByLabel("Month 2 days").fill("40");
  await page.getByLabel("Month 3 days").fill("5");
  await page.getByLabel("Month 3 days").press("Tab");
  await expect(page.getByText("3 months, 55 days a year.")).toBeVisible();
  // and its own week: 5 days, one renamed
  const week = page.getByRole("spinbutton", { name: /Days in a week/ });
  await expect(week).toHaveValue("7");
  await week.fill("5");
  await week.press("Tab");
  await expect(page.getByLabel(/^Weekday \d+ name$/)).toHaveCount(5);
  await page.getByLabel("Weekday 5 name").fill("Restday");
  await page.getByLabel("Weekday 5 name").press("Tab");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Odd Months" })).toBeVisible();
  const cid = page.url().match(/#\/c\/(\d+)/)[1];
  const { json } = await api(page, "campaign", undefined, cid);
  expect(json.campaign.calendar.months.map(m => [m.name, m.days])).toEqual([["Month 1", 10], ["Longmonth", 40], ["Month 3", 5]]);
  for (const s of json.campaign.calendar.seasons) expect(s.day).toBeLessThanOrEqual([10, 40, 5][s.month]);
  expect(json.campaign.calendar.weekdays).toEqual(["Firstday", "Seconday", "Thirdday", "Fourthday", "Restday"]);
  await goTab(page, "Calendar");
  await expect(page.locator(".tabs a.on")).toHaveText("Calendar");
  expectNoErrors(errors);
});

test("a custom calendar gets leap days in the month and on the rule it is given", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Lea");
  await signIn(page, gm);
  await approve(browser, gm.email);
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Leaping");
  await page.getByLabel("Calendar preset").selectOption("custom");
  const count = page.getByRole("spinbutton", { name: /Number of months/ });
  await count.fill("3");
  await count.press("Tab");
  await page.getByLabel("Month 2 leap days").fill("2");
  await page.getByLabel("Month 2 leap days").press("Tab");
  await expect(page.getByText("Set how often leap years come below")).toBeVisible();
  await page.getByLabel("Leap year every N years").fill("5");
  await page.getByLabel("Except every N years").fill("50");
  await page.getByLabel("Except every N years").press("Tab");
  await expect(page.getByText("3 months, 90 days a year, 92 in a leap year (leap years: 5, 10, 15, 20…, but not 50).")).toBeVisible();
  // a 4-day week, so the weekday has to count the leap days to come out right
  const week = page.getByRole("spinbutton", { name: /Days in a week/ });
  await week.fill("4");
  await week.press("Tab");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Leaping" })).toBeVisible();
  const cid = page.url().match(/#\/c\/(\d+)/)[1];
  const { json } = await api(page, "campaign", undefined, cid);
  const cal = json.campaign.calendar;
  expect(cal.months.map(m => [m.days, m.leapDays || 0])).toEqual([[30, 0], [30, 2], [30, 0]]);
  expect(cal.leap).toEqual({ every: 5, skip: 50, unskip: 0 });
  const E = await page.evaluate(c => {
    const E = window.Engine; E.prep(c);
    return { y5: E.yearLength(c, 5), y4: E.yearLength(c, 4), y50: E.yearLength(c, 50), feb: E.monthLength(c, 5, 1),
      wd: E.weekday(c, E.toAbs(c, 6, 0, 1)) };
  }, cal);
  expect(E).toEqual({ y5: 92, y4: 90, y50: 90, feb: 32, wd: (5 * 90 + 2) % 4 });

  // Settings shows what the rule does, as it is typed
  await page.goto(`index.html#/c/${cid}/settings/calendar`);
  await expect(page.locator(".leap-note")).toContainText("A leap year has 92 days instead of 90 (Month 2 +2)");
  await page.locator("[name=leap_every]").fill("0");
  await expect(page.locator(".leap-note")).toContainText("no leap years are set");
  expectNoErrors(errors);
});

test("a GM adds a player by email; the player sees the campaign but not its secrets", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Hal"), player = person("Ivy");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Secrets ${gm.id}`);
  await api(page, "event_save", { abs_day: 2, title: "Public fair" }, cid);
  await api(page, "event_save", { abs_day: 2, title: "Hidden ambush", is_secret: true }, cid);

  // Not approved yet: they're refused the campaign, and the GM's add is recorded as an invitation
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).json).toEqual({ ok: true, invited: true });
  expect((await api(page, "member_add", { email: `nobody-${gm.id}@example.test`, role: "player" }, cid)).json).toEqual({ ok: true, invited: true });
  expect((await pp.request.get(`api/index.php?a=days&cid=${cid}&from=0&to=10`)).status()).toBe(403);
  await approve(browser, player.email);

  // the Members tab lists the invitations; one can be cancelled
  await page.goto(`index.html#/c/${cid}/members`);
  const invited = page.locator(".listrow.invite");
  await expect(invited).toHaveCount(2);
  await invited.filter({ hasText: "nobody-" }).getByRole("button", { name: "Cancel invitation" }).click();
  await expect(invited).toHaveCount(1);
  await expect(invited).toContainText(player.email);

  // their first request in the campaign takes the invitation up
  const r = await pp.request.get(`api/index.php?a=days&cid=${cid}&from=0&to=10`);
  expect(r.status()).toBe(200);
  const titles = (await r.json()).events.map(e => e.title);
  expect(titles).toContain("Public fair");
  expect(titles).not.toContain("Hidden ambush");
  // the invitation is gone from the Members tab, and they're listed as a member
  await page.reload();
  await expect(page.getByText(`(${player.email})`)).toBeVisible();
  await expect(invited).toHaveCount(0);
  // someone already approved, added by email, joins at once
  const late = person("Jem");
  const lctx = await newContext(browser);
  await signIn(await lctx.newPage(), late);
  await approve(browser, late.email);
  await page.getByPlaceholder("Search people, or type their sign-in email").fill(late.email);
  await page.getByRole("button", { name: "Add by email" }).click();
  await expect(page.getByText(`(${late.email})`)).toBeVisible();
  await pctx.close();
  expectNoErrors(errors);
});

test("a GM finds a player they already play with by searching; nobody is listed before a search, and only GMs can search", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Kit"), player = person("Lark"), waiting = person("Moss");
  // the picker shows a GM names only (just a site admin sees emails), so give each a name no other test uses
  for (const p of [gm, player, waiting]) p.name = `${p.name} ${p.id}`;
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Picker ${gm.id}`);

  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  const wctx = await newContext(browser);
  await signIn(await wctx.newPage(), waiting);
  /** member_candidates for search q, as whoever pg is signed in as */
  const find = async (pg, q) => {
    const res = await pg.request.get(`api/index.php?${new URLSearchParams({ a: "member_candidates", cid, ...(q === undefined ? {} : { q }) })}`);
    return { status: res.status(), json: await res.json() };
  };

  // Accounts are shared with Sinless, so a stranger's name isn't offered to a GM who isn't a site admin...
  expect((await find(page, player.id)).json.users.map(u => u.display_name)).not.toContain(player.name);
  // ...only someone they already play with, here in another of their campaigns
  const other = await makeCampaign(page, `Picker other ${gm.id}`);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, other)).status).toBe(200);
  const offered = (await find(page, player.id)).json.users;
  expect(offered.map(u => u.display_name)).toContain(player.name);
  expect((await find(page, waiting.id)).json.users).toEqual([]);   // not approved
  expect((await find(page, gm.id)).json.users).toEqual([]);        // already in the campaign
  // a GM who isn't a site admin gets no one's email, and can't find anyone by one
  expect(offered.filter(u => "email" in u)).toEqual([]);
  expect((await find(page, player.email)).json.users).toEqual([]);
  // nothing is listed without a search of at least two letters, for anyone, so no one can see who uses the site
  expect((await find(page)).json.users).toEqual([]);
  expect((await find(page, "")).json.users).toEqual([]);
  expect((await find(page, "L")).json.users).toEqual([]);
  // the site admin finds people by name or email, but also only by searching
  const actx = await newContext(browser);
  const ap = await actx.newPage();
  await signIn(ap, ADMIN);
  expect((await find(ap)).json.users).toEqual([]);
  expect((await find(ap, player.email)).json.users.map(u => u.email)).toContain(player.email);
  await actx.close();

  // the page lists no one until the GM types
  await page.goto(`index.html#/c/${cid}/members`);
  const picker = page.getByRole("list", { name: "People matching your search" });
  await expect(picker).toBeAttached();
  await expect(picker.getByRole("listitem")).toHaveCount(0);
  await page.getByPlaceholder("Search people, or type their sign-in email").fill(player.id);
  const row = page.getByRole("listitem").filter({ hasText: player.name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText(`(${player.email})`)).toBeVisible();

  // Players can't search the site's accounts, and someone already in the campaign isn't offered again.
  expect((await find(pp, player.id)).status).toBe(403);
  expect((await find(page, player.id)).json.users.map(u => u.display_name)).not.toContain(player.name);
  await pctx.close();
  await wctx.close();
  expectNoErrors(errors);
});
