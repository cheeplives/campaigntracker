// At the Table opens first (the campaign's current day, since Current Day merged into it), and players only get
// today's weather up to the current shift: the server holds back later shifts and the day's forecast.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign , notNow, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const shift = (type, temp) => ({ type, temp, wind: 1 });
const STORMY = { type: "storm", temp: 20, wind: 2, shift_order: "dawn", shifts: [shift("overcast", 12), shift("rain", 15), shift("storm", 20), shift("rain", 16)] };

test("a campaign opens on At the Table: the clock's shift in a big box, End shift, a look at the shift before, today's boxes folded under it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Dana");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Today ${gm.id}`);
  await page.goto(`index.html#/c/${cid}`);
  await expect(page.locator(".tabs a.on")).toHaveText("At the Table");
  await expect(page.locator(".tabs a", { hasText: "Current Day" })).toHaveCount(0);
  const now = page.locator(".tv-now");
  await expect(now.locator("h4")).toContainText("Dawn");
  await expect(now.locator(".nowtag")).toBeVisible();
  await expect(page.locator(".dh-step")).toHaveCount(4);
  // the shift before and after sit either side of it
  await expect(page.locator(".tv-side.prev")).toContainText("Overnight");
  await expect(page.locator(".tv-side.next")).toContainText("Midday");
  const today = async () => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day?.weather;
  await expect.poll(async () => (await today())?.shifts?.length).toBe(4);
  expect((await today()).shift_order).toBe("dawn");
  // The Clocks box, then today's boxes, come folded under it: Weather, Shifts, Events, Reminders. The day's notes are on its calendar page.
  expect(await page.locator(".daybox").evaluateAll(b => b.map(x => x.dataset.box))).toEqual(["clocks", "table-weather", "table-shifts", "table-events", "table-reminders"]);
  await expect(page.locator(".daybox.folded")).toHaveCount(5);
  // Locations visited sits under the Region for this day, saves with the day and survives a weather re-roll.
  await page.locator("[data-box=table-weather] .daybox-toggle").click();
  const regionTop = (await page.locator(".dayedit [name=region_id]").boundingBox()).y;
  expect((await page.getByLabel("Locations visited").boundingBox()).y).toBeGreaterThan(regionTop);
  await page.getByLabel("Locations visited").fill("Altdorf; the Grey Lady inn");
  await page.getByRole("button", { name: "Save day" }).click();
  await expect(page.getByText("Day saved")).toBeVisible();
  await notNow(page); // the detector offers Altdorf and the Grey Lady inn for the Encyclopedia
  await expect.poll(async () => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day.locations).toBe("Altdorf; the Grey Lady inn");
  // The re-roll saves, then redraws the page: wait for the redraw, so the next click doesn't land on a link it replaces.
  await page.getByLabel("Locations visited").evaluate(e => { e.dataset.beforeReroll = "1"; });
  await page.getByRole("button", { name: "🎲 Re-roll weather" }).click();
  await expect(page.locator("[data-before-reroll]")).toHaveCount(0);
  await expect(page.getByLabel("Locations visited")).toHaveValue("Altdorf; the Grey Lady inn");
  // the box stays unfolded in this browser
  await page.reload();
  await expect(page.locator("[data-box=table-weather]")).not.toHaveClass(/folded/);

  // what the party does saves as it is typed in the big box
  await now.getByLabel("What the party does this Dawn").fill("Breakfast at the inn");
  await now.getByLabel("GM-only notes for Dawn").click();
  await expect(now.locator(".shift-status")).toHaveText("Saved ✓");
  // End shift moves the clock on one, and the box follows
  await page.getByRole("button", { name: /^End Dawn ▶ on to Midday/ }).click();
  // with no session open, it offers to start one on the shift the clock moved to
  await expect(page.locator("dialog.kit-dialog")).toContainText("No session is open");
  await page.getByRole("button", { name: "Start a session" }).click();
  await expect(now.locator("h4")).toContainText("Midday");
  expect((await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(9);
  expect((await api(page, "campaign", undefined, cid)).json.open_session).toMatchObject({ number: 1, first_shift: 9 });
  // a look at the shift before, with its activity, and back
  await expect(page.locator(".tv-side.prev")).toContainText("Breakfast at the inn");
  await page.locator(".tv-side.prev").click();
  await expect(page.locator(".tv-peek")).toContainText("Looking at");
  await expect(now.locator("h4")).toContainText("Dawn");
  await expect(now.getByLabel("What the party does this Dawn")).toHaveValue("Breakfast at the inn");
  await expect(page.getByRole("button", { name: /^End / })).toHaveCount(0);   // only the clock's shift can be ended
  await page.getByRole("button", { name: "Back to now" }).click();
  await expect(now.locator("h4")).toContainText("Midday");
  await expect(page.locator(".tv-peek")).toHaveCount(0);

  // An old Current Day link to another day opens that day's calendar page; Go to today comes back here.
  await page.goto(`index.html#/c/${cid}/today/3`);
  await expect(page.locator(".tabs a.on")).toHaveText("Calendar");
  await expect(page.locator("[data-box=notes]")).toHaveCount(1);
  await page.getByRole("link", { name: "Go to today" }).click();
  await expect(page.locator(".tabs a.on")).toHaveText("At the Table");
  expectNoErrors(errors);
});

test("Locations visited suggests the Encyclopedia's places named on the day's shifts, and a tap adds one", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Lou");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Places ${gm.id}`);
  for (const [name, category, aliases] of [["Altdorf", "location", []], ["The Grey Lady", "location", ["Grey Lady inn"]], ["Hera", "person", []], ["Ford", "location", []]])
    expect((await api(page, "entry_save", { name, category, aliases, notes: "<p>Here.</p>" }, cid)).status).toBe(200);
  await api(page, "shift_save", { abs_day: 2, shift: 0, activity: "Rode to Altdorf with Hera", gm_notes: "Spies wait at the grey lady inn" }, cid);
  await api(page, "shift_note_add", { abs_day: 2, shift: 1, body: "Crossed at the Fordham bridge" }, cid);   // Ford only as part of a word
  await page.goto(`index.html#/c/${cid}/day/2`);
  const sugg = page.locator(".loc-suggest");
  await expect(sugg.getByRole("button")).toHaveText(["+ Altdorf", "+ The Grey Lady"]);
  await sugg.getByRole("button", { name: "+ Altdorf" }).click();
  await expect(page.getByLabel("Locations visited")).toHaveValue("Altdorf");
  await expect(sugg.getByRole("button")).toHaveText(["+ The Grey Lady"]);
  await sugg.getByRole("button", { name: "+ The Grey Lady" }).click();
  await expect(page.getByLabel("Locations visited")).toHaveValue("Altdorf, The Grey Lady");
  await expect(sugg).toBeHidden();
  await page.getByRole("button", { name: "Save day" }).click();
  await expect(page.getByText("Day saved")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day.locations).toBe("Altdorf, The Grey Lady");
  expectNoErrors(errors);
});

test("players see today's weather only up to the current shift", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Eli"), player = person("Fay");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Shift weather ${gm.id}`); // now = day 2, Dawn
  expect((await api(page, "days_save", { days: [1, 2, 3].map(d => ({ abs_day: d, weather: STORMY })) }, cid)).status).toBe(200);

  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  const day = async d => (await (await pp.request.get(`api/index.php?a=day&cid=${cid}&d=${d}`)).json()).day.weather;
  expect(await day(1)).toEqual(STORMY);                       // past days: everything
  expect(await day(3)).toBeNull();                            // future days: nothing
  expect(await day(2)).toEqual({ ...shift("overcast", 12), season: null, shifts: [shift("overcast", 12)], partial: true });
  const range = (await (await pp.request.get(`api/index.php?a=days&cid=${cid}&from=1&to=3`)).json()).days;
  expect(range.find(x => x.abs_day === 2).weather.shifts).toHaveLength(1);
  expect(JSON.stringify(range.filter(x => x.abs_day >= 2))).not.toContain("storm");

  // A copy saved in the old Overnight-first order (or with no order) is never handed out.
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: { ...STORMY, shift_order: "overnight" } }] }, cid)).status).toBe(200);
  expect(await day(2)).toBeNull();
  const { shift_order, ...unmarked } = STORMY;
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: unmarked }] }, cid)).status).toBe(200);
  expect(await day(2)).toBeNull();
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: STORMY }] }, cid)).status).toBe(200);

  expect((await api(page, "day_update", { abs_day: 2, notes: "", locations: "Ubersreik market" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator(".tabs a.on")).toHaveText("At the Table");
  await expect(pp.locator("[data-box=table-weather] .notes-locs")).toContainText("Ubersreik market"); // players read the day's locations, by the Region
  await expect(pp.locator("[data-box=notes], [data-box=table-notes]")).toHaveCount(0);             // and no Notes box under At the Table
  // Days run Dawn first, so at Dawn the player has Dawn's weather and nothing after it.
  await expect(pp.locator(".tv-now h4")).toHaveText(/^Dawn/);
  await expect(pp.locator(".tv-now")).not.toContainText("Weather not known yet");
  await expect(pp.locator(".tv-side.next")).toContainText("Weather not known yet");
  await expect(pp.locator("div.tv-side.next")).toHaveCount(1);       // a player can look back, not ahead
  await expect(pp.locator("button.tv-side.prev")).toHaveCount(1);
  await expect(pp.getByRole("button", { name: /^End / })).toHaveCount(0);
  await pp.locator("[data-box=table-shifts] .daybox-toggle").click();
  await expect(pp.locator("[data-box=table-shifts] .shiftcard").first()).not.toContainText("Weather not known yet");
  await expect(pp.locator("[data-box=table-shifts] .shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(3);

  // Two shifts later the player has three shifts' weather, still not the forecast.
  expect((await api(page, "set_time", { current_shift: 10 }, cid)).status).toBe(200);
  const w = await day(2);
  expect(w.shifts).toEqual(STORMY.shifts.slice(0, 3));
  expect(w.type).toBe("storm");
  await pp.reload();
  await expect(pp.locator(".tv-now h4")).toContainText("Dusk");
  await expect(pp.locator("[data-box=table-shifts] .shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(1);
  await expect(pp.locator("[data-box=table-shifts] .shiftcard").last()).toContainText("Overnight");
  await expect(pp.locator("[data-box=table-shifts] .shiftcard").last()).toContainText("Weather not known yet");

  // The days' calendar pages keep the same rule: nothing for tomorrow, everything for yesterday.
  await pp.goto(`index.html#/c/${cid}/day/3`);
  await expect(pp.locator(".dh-step-icon")).toHaveCount(0);
  await expect(pp.locator(".shiftcard")).toHaveCount(4);
  await expect(pp.locator(".shiftcard .wx")).toHaveCount(0);
  await pp.getByRole("link", { name: "◀ Previous day" }).click();
  // wait for day 2 to draw, or the second click lands on day 3's link again
  await expect(pp.getByRole("link", { name: "◀ Previous day" })).toHaveAttribute("href", new RegExp(`/day/1$`));
  await pp.getByRole("link", { name: "◀ Previous day" }).click();
  await expect(pp).toHaveURL(new RegExp(`#/c/${cid}/day/1$`));
  await expect(pp.locator(".shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(0);
  await expect(pp.locator("[data-box=weather]")).toContainText("Thunderstorm");     // a past day shows its forecast

  // The GM still gets the whole day, and so do players once the GM allows future weather.
  expect((await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day.weather).toEqual(STORMY);
  expect((await api(page, "campaign_update", { settings: { players_see_future_weather: true } }, cid)).status).toBe(200);
  expect(await day(2)).toEqual(STORMY);
  await pctx.close();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});
