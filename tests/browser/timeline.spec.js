// The Events tab's Timeline: the events along the campaign's own calendar, in lanes by tag, zoomable from an era down
// to a day, with sessions, seasons and holidays as bands, a line for now, and a picture to download. The arithmetic
// (static/timeline.js) runs under Node; the page is checked in every browser, touch ones included.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
const E = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const T = require(path.join(__dirname, "..", "..", "static", "timeline.js"));

/** The helpers' test calendar: two 30-day months, a five-day week, year 1 first. */
function calendar(extra = {}) {
  const c = { months: [{ name: "Firstmonth", days: 30 }, { name: "Secondmonth", days: 30 }], weekdays: ["One", "Two", "Three", "Four", "Five"], epochYear: 1, ...extra };
  E.prep(c);
  return c;
}

test("an event runs over its days, or from its first shift to the end of its last", () => {
  expect(T.span({ abs_day: 5 }, 4)).toEqual({ start: 5, end: 6, days: 1 });
  expect(T.span({ abs_day: 5, end_day: 7 }, 4)).toEqual({ start: 5, end: 8, days: 3 });
  expect(T.span({ abs_day: 5, shift: 1 }, 4)).toEqual({ start: 5.25, end: 5.5, days: 1 });
  expect(T.span({ abs_day: 5, shift: 1, shift_end: 2 }, 4)).toEqual({ start: 5.25, end: 5.75, days: 1 });
  expect(T.span({ abs_day: 5, end_day: 6, shift: 3, shift_end: 0 }, 4)).toEqual({ start: 5.75, end: 6.25, days: 2 });
  expect(T.span({ abs_day: "2", end_day: null, shift: null }, 24)).toEqual({ start: 2, end: 3, days: 1 });
});

test("lanes go by tag with an Untagged lane, by the entries named, or all in one", () => {
  const battle = { name: "Battle", color: "#c00" }, fair = { name: "Festival", color: "#0c0" };
  const a = { id: 1, title: "Ambush", tags: [battle] }, b = { id: 2, title: "Fair", tags: [fair] }, d = { id: 3, title: "Duel", tags: [battle, fair] }, n = { id: 4, title: "Rain", tags: [] };
  const by = T.lanes([a, b, d, n], "tags", { tags: [battle, fair] });
  expect(by.map(l => [l.name, l.color, l.events.map(e => e.id)])).toEqual([["Battle", "#c00", [1, 3]], ["Festival", "#0c0", [2, 3]], ["Untagged", null, [4]]]);
  expect(T.lanes([a], "tags", { tags: [battle, fair] }).map(l => l.name)).toEqual(["Battle"]); // an empty lane isn't drawn
  expect(T.lanes([a, b], "one").map(l => [l.name, l.events.length])).toEqual([["All events", 2]]);
  expect(T.lanes([], "one")).toEqual([]);
  const keep = { id: 9, name: "Keep" }, arden = { id: 8, name: "Arden" };
  const mentions = e => ({ 1: [keep], 2: [keep, arden] }[e.id] || []);
  expect(T.lanes([a, b, n], "entries", { mentions }).map(l => [l.name, l.events.map(e => e.id)])).toEqual([["Arden", [2]], ["Keep", [1, 2]], ["No entry named", [4]]]);
});

test("pack puts overlapping marks on new rows and reuses a row once it's clear", () => {
  const { rows, count } = T.pack([{ x0: 0, x1: 50 }, { x0: 20, x1: 60 }, { x0: 57, x1: 90 }, { x0: 70, x1: 80 }], 6);
  expect(rows).toEqual([0, 1, 0, 1]);
  expect(count).toBe(2);
  expect(T.pack([{ x0: 0, x1: 10 }, { x0: 0, x1: 10 }, { x0: 0, x1: 10 }], 6, 2)).toEqual({ rows: [0, 1, 1], count: 2 });
});

test("the axis labels days, weeks, months and years from the campaign's calendar", () => {
  const c = calendar({ eras: [{ name: "Age of Kings", abbr: "AK", start: 1 }] });
  // close up: every day numbered under the month and year
  let a = T.axis(c, 0, 10, 80);
  expect(a.minorKind).toBe("day");
  expect(a.minor.slice(0, 3).map(t => t.label)).toEqual(["1", "2", "3"]);
  expect(a.lead).toBe("Firstmonth 1 AK");
  a = T.axis(c, 25, 40, 50);
  expect(a.major.map(t => [t.day, t.label])).toEqual([[30, "Secondmonth 1 AK"]]);
  // weeks start on the first weekday: day 0 is One, so every fifth day
  a = T.axis(c, 0, 30, 8);
  expect(a.minorKind).toBe("week");
  expect(a.minor.map(t => t.day)).toEqual([0, 5, 10, 15, 20, 25, 30]);
  // months, then years under them
  a = T.axis(c, 0, 180, 2);
  expect(a.minorKind).toBe("month");
  expect(a.minor.map(t => t.label)).toEqual(["Firstmonth", "Secondmonth", "Firstmonth", "Secondmonth", "Firstmonth", "Secondmonth", "Firstmonth"]);
  expect(a.major.map(t => t.label)).toEqual(["1 AK", "2 AK", "3 AK", "4 AK"]);
  // far out: years, and then counts of years
  expect(T.axis(c, 0, 600, 1.5).minorKind).toBe("year");
  a = T.axis(c, 0, 60 * 1000, 0.01);
  expect(typeof a.minorKind).toBe("number");
  expect(a.minor.every(t => (t.year % a.minorKind) === 0)).toBe(true);
  // a zoom button is about the span it names
  const long = calendar({ months: Array.from({ length: 12 }, (_, i) => ({ name: `M${i + 1}`, days: 30 })) });
  expect(T.zoomOf(long, T.zoomPx(long, "month", 900), 900)).toBe("month");
  expect(T.zoomOf(long, T.zoomPx(long, "day", 900) * 1.2, 900)).toBe("day");
  expect(T.zoomOf(long, T.zoomPx(long, "era", 900) / 3, 900)).toBe("era");
});

test("season and holiday bands cover their days, cut at the view's edges", () => {
  const c = calendar({ seasons: [{ name: "Warm", type: "summer", month: 0, day: 1 }, { name: "Cold", type: "winter", month: 1, day: 1 }] });
  expect(T.seasonBands(c, 10, 70).map(b => [b.from, b.to, b.name])).toEqual([[10, 30, "Warm"], [30, 60, "Cold"], [60, 70, "Warm"]]);
  expect(T.seasonBands(calendar(), 0, 60)).toEqual([]);
  const fest = { name: "Fair Days", color: "#fc0", rule: { type: "fixed", month: 0, day: 3, span: 2 } };
  expect(T.holidayBands(c, [fest], 0, 70).map(h => [h.from, h.to, h.name])).toEqual([[2, 4, "Fair Days"], [62, 64, "Fair Days"]]);
  expect(T.holidayBands(c, [fest], 0, 100000)).toBeNull(); // too wide to work out day by day
});

test("the Events tab switches to a timeline of the same events, remembered, and players never get the secret one", async ({ page, browser, hasTouch }) => {
  const errors = watchErrors(page);
  const gm = person("Mara"), player = person("Tobin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Timeline ${gm.id}`); // today is day 2
  const save = async ev => (await api(page, "event_save", ev, cid)).json.id;
  await save({ abs_day: 0, title: "Ambush on the road", tags: [{ name: "Battle", color: "#b91c1c" }] });
  await save({ abs_day: 2, end_day: 4, title: "Harvest fair", body: "Stalls and a juggler", tags: [{ name: "Festival", color: "#15803d" }] });
  await save({ abs_day: 9, shift: 1, title: "Duel at noon", tags: [{ name: "Battle" }] });
  await save({ abs_day: 6, title: "Quiet day" });
  await save({ abs_day: 12, title: "The baron's plot", is_secret: 1 });
  const ses = await api(page, "session_save", { first_day: 0, title: "The Road North" }, cid);
  expect(ses.status, JSON.stringify(ses.json)).toBe(200);

  await page.goto(`index.html#/c/${cid}/events`);
  await expect(page.locator(".evrow")).toHaveCount(5);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.locator(".evrow")).toHaveCount(0);
  const tl = page.locator("svg.tl");
  await expect(tl).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Order" })).toBeHidden();
  await page.getByRole("combobox", { name: "Lanes" }).selectOption("tags"); // a phone starts with one lane
  await page.getByRole("button", { name: "Month", exact: true }).click();

  // lanes by tag, by name, with an Untagged lane; the duel is in Battle, the plot is Untagged and secret
  const lanes = tl.locator(".tl-lane-name");
  await expect(lanes).toHaveText([/^Sessions$/, /Battle \(2\)/, /Festival \(1\)/, /Untagged \(2\)/]);
  const marks = tl.locator(".tl-ev");
  await expect(marks).toHaveCount(5);
  await expect(tl.locator(".tl-ev.secret")).toHaveCount(1);
  await expect(tl.locator(".tl-ev.secret .tl-label")).toHaveText(/🔒 The baron's plot/);
  await expect(tl.locator(".tl-ev", { hasText: "Harvest fair" }).locator("rect.tl-bar")).toHaveCount(1); // three days: a bar
  await expect(tl.locator(".tl-ev", { hasText: "Quiet day" }).locator("circle.tl-dot")).toHaveCount(1);  // one day: a dot
  await expect(tl.locator(".tl-now")).toHaveCount(1);
  await expect(tl.locator(".tl-session")).toHaveCount(1);

  // the filters apply to it: a search, then a tag
  const search = page.getByRole("searchbox", { name: "Search events" });
  await search.fill("juggler");
  await expect(marks).toHaveCount(1);
  await expect(page.getByText("1 of 5 events")).toBeVisible();
  await search.fill("");
  await page.locator(".tagpick").getByRole("button", { name: "Battle", exact: true }).click();
  await expect(marks).toHaveCount(2);
  await page.getByRole("button", { name: "Clear tags" }).click();
  await expect(marks).toHaveCount(5);

  // one lane, then zoom to a day around the duel: with a shift set it's a bar over just its shift
  await page.getByRole("combobox", { name: "Lanes" }).selectOption("one");
  await expect(lanes).toHaveText([/^Sessions$/, /All events \(5\)/]);
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
  await tl.focus();
  const duel = tl.locator(".tl-ev", { hasText: "Duel at noon" });
  // the right arrow moves along a sixth of the width at a time, so a phone takes more steps to reach day 9
  for (let i = 0; i < 40 && !(await duel.count()); i++) await page.keyboard.press("ArrowRight");
  await expect(duel.locator("rect.tl-bar")).toHaveCount(1);
  await expect(duel).toHaveAttribute("data-tip", /Midday/);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(marks).toHaveCount(5);

  // the choice is remembered, and so is the lane setting while you move around the campaign
  await page.reload();
  await expect(tl).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Lanes" })).toHaveValue(/one|tags/);
  await expect(marks).toHaveCount(5);

  // a picture of it
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "⬇ PNG" }).click()]);
  expect(download.suggestedFilename()).toMatch(/timeline\.png$/);

  // clicking an event (tapping it twice on a touch screen) opens its day
  const fair = tl.locator(".tl-ev", { hasText: "Harvest fair" });
  // headless Firefox reports no hover, so go by whether the page has touch, not by the media query
  if (hasTouch) { await fair.tap(); await fair.tap(); } else await fair.click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/day/2$`));
  expectNoErrors(errors);

  // a player sees the timeline without the secret event or the unpublished session
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}/events`);
  await pp.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(pp.locator("svg.tl .tl-ev")).toHaveCount(4);
  await expect(pp.locator("svg.tl .tl-ev.secret")).toHaveCount(0);
  await expect(pp.locator("svg.tl")).not.toContainText("baron");
  await expect(pp.locator("svg.tl .tl-session")).toHaveCount(0);
  await pctx.close();
});

test("the timeline zooms with the wheel and moves when dragged", async ({ page, browser, isMobile }) => {
  test.skip(isMobile, "a phone has no wheel or mouse; the buttons and keys are checked above");
  const gm = person("Quill");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Timeline wheel ${gm.id}`);
  await api(page, "event_save", { abs_day: 2, title: "Market day" }, cid);
  await page.goto(`index.html#/c/${cid}/events`);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  const tl = page.locator("svg.tl"), mark = tl.locator(".tl-ev .tl-dot, .tl-ev .tl-bar").first();
  // each move redraws the timeline, so the mark can be replaced between finding it and measuring it
  const markX = async () => (await mark.boundingBox().catch(() => null))?.x ?? -Infinity;
  await expect(mark).toBeVisible();
  const box = await tl.boundingBox();
  await expect.poll(markX).toBeGreaterThan(-Infinity);
  const x0 = await markX();
  // drag right: the event moves right with it
  await page.mouse.move(box.x + 300, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect.poll(markX).toBeGreaterThan(x0 + 40);
  // the wheel zooms out: the zoom button lit moves from Week toward Era
  const lit = () => page.locator(".tl-tools .seg button.on").textContent();
  const before = await lit();
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 300);
  await expect.poll(lit).not.toBe(before);
});
