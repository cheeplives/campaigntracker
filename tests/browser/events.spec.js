// Events run from a Shift Start to a Shift End (or all day), carry colour-coded
// tags that show in week view, and events saved before either still work.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

test("an event gets a shift range and tags, shown in day and week view", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Lux");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Events ${gm.id}`);
  // An event as saved before shift ranges and tags existed.
  await api(page, "event_save", { abs_day: 3, title: "Old watch", shift: 0 }, cid);

  await page.goto(`index.html#/c/${cid}/day/3`);
  await expect(page.locator(".event", { hasText: "Old watch" })).toContainText("Dawn");
  await page.getByRole("button", { name: "+ Add event" }).click();
  const form = page.locator("form.event");
  await expect(form.getByLabel("Starts", { exact: true })).toHaveCount(0);
  await expect(form.getByRole("combobox", { name: /^Shift Start/ })).toBeHidden();
  await form.getByLabel("Title", { exact: true }).fill("Skirmish at the ford");
  await form.getByRole("checkbox", { name: /^All day/ }).uncheck();
  await form.getByRole("combobox", { name: /^Shift Start/ }).selectOption({ label: "Dawn" });
  await expect(form.getByRole("combobox", { name: /^Shift End/ })).toHaveValue("0");   // follows Shift Start
  await form.getByRole("combobox", { name: /^Shift End/ }).selectOption({ label: "Midday" });
  await form.getByRole("button", { name: "Battle", exact: true }).click();
  await form.getByLabel("New tag name").fill("Siege");
  await form.getByRole("button", { name: "+ Add tag" }).click();
  await expect(form.getByRole("button", { name: "Siege", exact: true })).toHaveAttribute("aria-pressed", "true");
  await form.getByRole("button", { name: "Add event" }).click();
  await expect(page.getByText("Event saved")).toBeVisible();

  const ev = page.locator(".event", { hasText: "Skirmish at the ford" });
  await expect(ev).toContainText("Dawn → Midday");
  await expect(ev.locator(".chip.tag")).toHaveText(["Battle", "Siege"]);
  const { json } = await api(page, "campaign", undefined, cid);
  expect(json.tags.find(t => t.name === "Siege").id).not.toBeNull();
  const day = await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=3`)).json();
  const saved = day.events.find(e => e.title === "Skirmish at the ford");
  expect([Number(saved.shift), Number(saved.shift_end)]).toEqual([0, 1]);
  const old = day.events.find(e => e.title === "Old watch");
  expect([Number(old.shift), Number(old.shift_end), old.tags]).toEqual([0, 0, []]);

  // Shift End before Shift Start on a one-day event is refused.
  expect((await api(page, "event_save", { abs_day: 3, title: "Backwards", shift: 2, shift_end: 1 }, cid)).status).toBe(400);

  // Week view shows the day's tags in their colours.
  await page.getByRole("button", { name: "Back to calendar" }).click();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  const row = page.locator(".weekrow", { hasText: "Skirmish at the ford" });
  await expect(row.locator(".chip.tag", { hasText: "Battle" })).toHaveCSS("background-color", "rgb(185, 28, 28)");

  // Go to today, from another day.
  await page.goto(`index.html#/c/${cid}/day/7`);
  await page.getByRole("link", { name: "Go to today" }).click();
  await expect(page).toHaveURL(/#\/c\/\d+\/day\/2$/);
  expectNoErrors(errors);
});
