// The sheet template library and editor: building a template by hand, finding it in the library, forking someone
// else's (whose own Edit button isn't there), and reordering fields by dragging them, which works by touch too.
const { test, expect } = require("@playwright/test");
const { person, signIn, approve, api, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

async function ready(page, browser, name) {
  const who = person(name);
  await signIn(page, who);
  await approve(browser, who.email);
  return who;
}
/** The layout of template $id, from the server. */
const layoutOf = async (page, id) => (await (await page.request.get(`api/index.php?a=template&id=${id}`)).json()).template;
const field = (page, n) => page.locator(".sheet-ed-field").nth(n);

test("Templates: build one by hand, save it, and find it in the library", async ({ page, browser }) => {
  const who = await ready(page, browser, "Lark");
  await page.goto("index.html#/templates/new");
  await page.getByLabel("Template name").fill(`Hand Made ${who.id}`);
  await page.getByLabel("Game", { exact: true }).fill("Test RPG");
  const s1 = page.locator(".sheet-ed-section").nth(0);
  await s1.getByLabel("Section title").fill("Stats");
  await s1.getByRole("button", { name: "Add field" }).click();
  await field(page, 0).getByLabel("Field label").fill("HP");
  await field(page, 0).getByLabel("Field type").selectOption("counter");
  await field(page, 0).getByLabel("Play view").check();
  await s1.getByRole("button", { name: "Add field" }).click();
  await field(page, 1).getByLabel("Field label").fill("Luck");
  await field(page, 1).getByLabel("Field type").selectOption("pips");
  await field(page, 1).getByLabel("Pips").fill("5");
  await page.getByRole("button", { name: "Add section" }).click();
  const s2 = page.locator(".sheet-ed-section").nth(1);
  await s2.getByLabel("Section title").fill("Notes");
  await s2.getByRole("button", { name: "Add field" }).click();
  await field(page, 2).getByLabel("Field label").fill("Story");
  await field(page, 2).getByLabel("Field type").selectOption("longtext");

  const preview = page.locator(".sheet-preview");
  await expect(preview.getByText("HP", { exact: true })).toBeVisible();
  await expect(preview.locator(".sheet-pip")).toHaveCount(5);

  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page).toHaveURL(/#\/templates\/\d+$/);
  const id = Number(page.url().match(/templates\/(\d+)$/)[1]);
  expect((await layoutOf(page, id)).layout).toEqual({ sections: [
    { key: "stats", title: "Stats", fields: [{ key: "hp", label: "HP", type: "counter", play: true }, { key: "luck", label: "Luck", type: "pips", count: 5 }] },
    { key: "notes", title: "Notes", fields: [{ key: "story", label: "Story", type: "longtext" }] },
  ] });

  await page.goto("index.html#/templates");
  await page.getByLabel("Search templates").fill(`Hand Made ${who.id}`);
  const card = page.locator(".template-card", { hasText: `Hand Made ${who.id}` });
  await expect(card).toContainText("Test RPG");
  await expect(card).toContainText("Used by 0");
  await expect(card).toContainText("0 forks");
  await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();
});

test("Templates: fork someone else's and edit the fork; theirs has no Edit", async ({ page, browser }) => {
  const other = await (await newContext(browser)).newPage();
  const owner = await ready(other, browser, "Moth");
  const theirs = (await api(other, "template_save", { name: `Moth's Sheet ${owner.id}`, game: "Test RPG",
    layout: { sections: [{ key: "main", title: "Main", fields: [{ key: "name", label: "Name", type: "text" }] }] } })).json.template;
  await ready(page, browser, "Nell");

  await page.goto(`index.html#/templates/${theirs.id}`);
  await expect(page.getByRole("heading", { name: theirs.name })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await page.getByRole("button", { name: "Fork" }).click();
  await expect(page).toHaveURL(/#\/templates\/\d+\/edit$/);
  const forkId = Number(page.url().match(/templates\/(\d+)\/edit$/)[1]);
  expect(forkId).not.toBe(theirs.id);
  await page.getByLabel("Template name").fill(`Nell's fork ${owner.id}`);
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page).toHaveURL(new RegExp(`#/templates/${forkId}$`));
  await expect(page.getByText(`Forked from ${theirs.name}`)).toBeVisible();

  await page.goto(`index.html#/templates/${theirs.id}`);
  await expect(page.getByText("1 fork", { exact: true })).toBeVisible();
  await expect(page.locator(".template-forks")).toContainText(`Nell's fork ${owner.id}`);
});

test("Templates: dragging a field's handle moves it, by mouse or touch", async ({ page, browser }) => {
  await ready(page, browser, "Odo");
  const tpl = (await api(page, "template_save", { name: "Drag me", game: "Test RPG", layout: { sections: [{ key: "main", title: "Main", fields: [
    { key: "a", label: "Alpha", type: "text" }, { key: "b", label: "Bravo", type: "text" }, { key: "c", label: "Charlie", type: "text" }] }] } })).json.template;
  await page.goto(`index.html#/templates/${tpl.id}/edit`);
  const labels = () => page.locator(".sheet-ed-field input[aria-label='Field label']").evaluateAll(els => els.map(e => e.value));
  await expect.poll(labels).toEqual(["Alpha", "Bravo", "Charlie"]);
  await page.evaluate(() => document.querySelector(".sheet-ed-section").scrollIntoView());
  const handle = field(page, 2).locator(".drag-handle");
  const from = await handle.boundingBox(), to = await field(page, 0).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(labels).toEqual(["Charlie", "Alpha", "Bravo"]);
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page).toHaveURL(new RegExp(`#/templates/${tpl.id}$`));
  expect((await layoutOf(page, tpl.id)).layout.sections[0].fields.map(f => f.key)).toEqual(["c", "a", "b"]);
});

test("Templates: a finger on a field's handle drags it too", async ({ page, browser, browserName, isMobile }) => {
  test.skip(browserName !== "chromium" || !isMobile, "real touch events are sent through Chromium's DevTools protocol, on a phone");
  await ready(page, browser, "Pim");
  const tpl = (await api(page, "template_save", { name: "Touch me", game: "Test RPG", layout: { sections: [{ key: "main", title: "Main", fields: [
    { key: "a", label: "Alpha", type: "text" }, { key: "b", label: "Bravo", type: "text" }] }] } })).json.template;
  await page.goto(`index.html#/templates/${tpl.id}/edit`);
  await expect(field(page, 1)).toBeVisible();
  await page.evaluate(() => document.querySelector(".sheet-ed-section").scrollIntoView());
  const from = await field(page, 1).locator(".drag-handle").boundingBox(), to = await field(page, 0).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: from.x + from.width / 2, y }] });
  await touch("touchStart", from.y + from.height / 2);
  for (let i = 1; i <= 8; i++) await touch("touchMove", from.y + from.height / 2 + (to.y + 4 - from.y - from.height / 2) * i / 8);
  await touch("touchEnd");
  await expect.poll(() => page.locator(".sheet-ed-field input[aria-label='Field label']").evaluateAll(els => els.map(e => e.value))).toEqual(["Bravo", "Alpha"]);
});

test("Templates: a field can be small, medium or large on the sheet, and a bad size is refused", async ({ page, browser }) => {
  const who = await ready(page, browser, "Sizer");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("index.html#/templates/new");
  await page.getByLabel("Template name").fill(`Sized ${who.id}`);
  await page.getByLabel("Game", { exact: true }).fill("Test RPG");
  const s1 = page.locator(".sheet-ed-section").nth(0);
  for (const [i, label, size] of [[0, "Age", "small"], [1, "Name", null], [2, "Motto", "large"]]) {
    await s1.getByRole("button", { name: "Add field" }).click();
    await field(page, i).getByLabel("Field label").fill(label);
    expect(await field(page, i).getByLabel("Box size").inputValue()).toBe("medium");
    if (size) await field(page, i).getByLabel("Box size").selectOption(size);
  }
  // a long text has no size to pick: it runs the full width
  await s1.getByRole("button", { name: "Add field" }).click();
  await field(page, 3).getByLabel("Field type").selectOption("longtext");
  await expect(field(page, 3).getByLabel("Box size")).toHaveCount(0);

  // the preview is drawn again a moment after each change, so each look measures one drawing whole
  const measure = () => page.evaluate(() => {
    const box = k => document.querySelector(`.sheet-preview .sheet-field[data-key="${k}"]`)?.getBoundingClientRect();
    const [age, name, motto] = [box("age"), box("name"), box("motto")];
    const input = document.querySelector('.sheet-preview .sheet-field[data-key="age"] input')?.getBoundingClientRect();
    if (!age || !name || !motto || !input) return null;
    return { small: age.width, medium: name.width, large: motto.width, inside: input.right <= age.right + 1 };
  });
  await expect.poll(async () => {
    const m = await measure();
    return !!m && Math.abs(m.small * 2 - m.medium) < 16 && Math.abs(m.medium * 2 - m.large) < 16 && m.inside;  // a small box's input stays inside it
  }).toBe(true);

  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page).toHaveURL(/#\/templates\/\d+$/);
  const id = Number(page.url().match(/templates\/(\d+)$/)[1]);
  const fields = (await layoutOf(page, id)).layout.sections[0].fields;
  expect(fields.map(f => f.size ?? null)).toEqual(["small", null, "large", null]);

  const bad = { sections: [{ key: "a", title: "A", fields: [{ key: "n", label: "N", type: "text", size: "huge" }] }] };
  const r = await api(page, "template_save", { name: "Huge", game: "X", layout: bad });
  expect(r.status).toBe(400);
  expect(r.json.message).toMatch(/size/);
});

test("Templates: a large box fits a phone screen", async ({ page, browser }) => {
  await ready(page, browser, "Narrow");
  await page.setViewportSize({ width: 360, height: 740 });
  const layout = { sections: [{ key: "a", title: "A", fields: [{ key: "big", label: "Big", type: "text", size: "large" }, { key: "tiny", label: "Tiny", type: "number", size: "small" },
    { key: "rank", label: "Rank", type: "choice", options: ["Untrained", "Trained", "Expert", "Master", "Legendary"], size: "small" },
    { key: "intim", label: "Counterintelligence", type: "number", size: "small" },
    { key: "weapons", label: "Weapons", type: "list", columns: ["Weapon", "Damage", "Accuracy", "Range", "Rate", "Shots", "Bulk", "Recoil"].map(l => ({ key: l.toLowerCase(), label: l })) }] }] };
  const tpl = (await api(page, "template_save", { name: "Phone", game: "X", layout })).json.template;
  await page.goto(`index.html#/templates/${tpl.id}`);
  const big = page.locator('.sheet-field[data-key="big"]');
  await expect(big).toBeVisible();
  const box = await big.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  // a small box's dropdown is squeezed to fit inside it
  const [cell, pick] = [await page.locator('.sheet-field[data-key="rank"]').boundingBox(), await page.getByLabel("Rank", { exact: true }).boundingBox()];
  expect(pick.x + pick.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
  // a long label in a small box wraps inside it rather than running past it
  const [small, label] = [await page.locator('.sheet-field[data-key="intim"]').boundingBox(), await page.locator('.sheet-field[data-key="intim"] .sheet-label span').boundingBox()];
  expect(label.x + label.width).toBeLessThanOrEqual(small.x + small.width + 1);
  // a list with many columns scrolls sideways inside its box; the page doesn't
  await expect(page.locator('.sheet-field[data-key="weapons"] table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const list = await page.locator('.sheet-field[data-key="weapons"] .sheet-list').evaluate(e => ({ scroll: e.scrollWidth, width: e.clientWidth }));
  expect(list.scroll).toBeGreaterThan(list.width);
});

test("Templates: sections can sit on pages, shown as tabs on the sheet", async ({ page, browser }) => {
  const who = await ready(page, browser, "Pager");
  await page.goto("index.html#/templates/new");
  await page.getByLabel("Template name").fill(`Paged ${who.id}`);
  await page.getByLabel("Game", { exact: true }).fill("Test RPG");
  const sec = n => page.locator(".sheet-ed-section").nth(n);
  await sec(0).getByLabel("Section title").fill("Stats");
  await sec(0).getByRole("button", { name: "Add field" }).click();
  await page.getByRole("button", { name: "Add section" }).click();
  await sec(1).getByLabel("Section title").fill("Spells");
  await sec(1).getByLabel("Page").fill("Magic");
  await sec(1).getByRole("button", { name: "Add field" }).click();
  await field(page, 1).getByLabel("Field label").fill("Spell list");
  await page.getByRole("button", { name: "Add section" }).click();
  await sec(2).getByLabel("Section title").fill("Gear");
  await sec(2).getByRole("button", { name: "Add field" }).click();
  await field(page, 2).getByLabel("Field label").fill("Pack");

  // the preview shows the tabs: sections without a page are on the first, named Sheet
  const preview = page.locator(".sheet-preview");
  await expect(preview.getByRole("tab")).toHaveText(["Sheet", "Magic"]);
  await expect(preview.getByRole("heading", { name: "Stats" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Gear" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Spells" })).toBeHidden();
  await preview.getByRole("tab", { name: "Magic" }).click();
  await expect(preview.getByRole("heading", { name: "Spells" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Stats" })).toBeHidden();

  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page).toHaveURL(/#\/templates\/\d+$/);
  const id = Number(page.url().match(/templates\/(\d+)$/)[1]);
  const secs = (await layoutOf(page, id)).layout.sections;
  expect(secs.map(s => s.page ?? null)).toEqual([null, "Magic", null]);

  const bad = { sections: [{ key: "a", title: "A", page: "", fields: [] }] };
  const r = await api(page, "template_save", { name: "No page name", game: "X", layout: bad });
  expect(r.status).toBe(400);
  expect(r.json.message).toMatch(/[Pp]age/);
});

test("Templates: a template without pages has no tabs", async ({ page, browser }) => {
  await ready(page, browser, "Flat");
  const layout = { sections: [{ key: "a", title: "A", fields: [{ key: "n", label: "N", type: "text" }] }] };
  const tpl = (await api(page, "template_save", { name: "Flat", game: "X", layout })).json.template;
  await page.goto(`index.html#/templates/${tpl.id}`);
  await expect(page.getByRole("heading", { name: "A", exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("Templates: the library lists templates by name, A to Z, whatever is used most", async ({ page, browser }) => {
  const who = await ready(page, browser, "Sorter");
  const layout = { sections: [{ key: "a", title: "A", fields: [{ key: "n", label: "N", type: "text" }] }] };
  const tag = `Zq${who.id}`;
  for (const name of [`${tag} beta`, `${tag} Alpha`, `${tag} gamma`]) expect((await api(page, "template_save", { name, game: "X", layout })).status).toBe(200);
  // the last one is used, which used to put it first
  const used = (await (await page.request.get(`api/index.php?a=templates&q=${encodeURIComponent(`${tag} gamma`)}`)).json()).templates[0];
  const cid = await makeCampaign(page, `Sort ${who.id}`);
  expect((await api(page, "character_create", { template_id: used.id, name: "User" }, cid)).status).toBe(200);
  await page.goto("index.html#/templates");
  await page.getByLabel("Search templates").fill(tag);
  await expect(page.locator(".template-card .template-name")).toHaveText([`${tag} Alpha`, `${tag} beta`, `${tag} gamma`]);
});

test("Templates: editions of one game by one author share a card, with an Edition dropdown", async ({ page, browser }) => {
  const who = await ready(page, browser, "Editions");
  const layout = { sections: [{ key: "a", title: "A", fields: [{ key: "n", label: "N", type: "text" }] }] };
  const game = `Ed Game ${who.id}`;
  const made = {};
  for (const [name, edition] of [[`${game} Second`, "2nd Edition"], [`${game} First`, "1st Edition"], [`${game} Loose`, ""]])
    made[name] = (await api(page, "template_save", { name, game, edition, layout })).json.template;
  await page.goto("index.html#/templates");
  await page.getByLabel("Search templates").fill(game);
  // the two with editions share one card; the one with no edition keeps its own
  await expect(page.locator(".template-card")).toHaveCount(2);
  const card = page.locator(".template-editions");
  await expect(card.locator(".template-name")).toHaveText(game);
  await expect(card.getByText("2 editions")).toBeVisible();
  const pick = card.getByLabel(`${game} edition`);
  await expect(pick.locator("option")).toHaveText(["1st Edition", "2nd Edition"]);
  // nothing used yet, so it opens on the last edition
  await expect(card.getByText(`${game} Second`)).toBeVisible();
  await pick.selectOption({ label: "1st Edition" });
  await expect(card.getByText(`${game} First`)).toBeVisible();
  await expect(card.locator(".template-name")).toHaveAttribute("href", `#/templates/${made[`${game} First`].id}`);
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`#/templates/${made[`${game} First`].id}/edit$`));
});

test("Templates: sections sit side by side, a compact section puts labels beside their boxes, and a box can be any width", async ({ page, browser }) => {
  const who = await ready(page, browser, "Layout");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("index.html#/templates/new");
  await page.getByLabel("Template name").fill(`Laid out ${who.id}`);
  await page.getByLabel("Game", { exact: true }).fill("Test RPG");
  const sec = n => page.locator(".sheet-ed-section").nth(n);
  await sec(0).getByLabel("Section title").fill("Stats");
  await sec(0).getByLabel("Section width").selectOption("half");
  for (const [i, label] of [[0, "Name"], [1, "Motto"], [2, "Notes"]]) {
    await sec(0).getByRole("button", { name: "Add field" }).click();
    await field(page, i).getByLabel("Field label").fill(label);
  }
  await field(page, 1).getByLabel("Box size").selectOption("custom");
  await field(page, 1).getByLabel("Half-columns").fill("6");
  await field(page, 2).getByLabel("Box size").selectOption("full");
  await page.getByRole("button", { name: "Add section" }).click();
  await sec(1).getByLabel("Section title").fill("Skills");
  await sec(1).getByLabel("Section width").selectOption("half");
  await sec(1).getByLabel("Compact rows").check();
  await sec(1).getByRole("button", { name: "Add field" }).click();
  await field(page, 3).getByLabel("Field label").fill("Stealth");
  await field(page, 3).getByLabel("Field type").selectOption("number");

  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page).toHaveURL(/#\/templates\/\d+$/);
  const id = Number(page.url().match(/templates\/(\d+)$/)[1]);
  const secs = (await layoutOf(page, id)).layout.sections;
  expect(secs.map(s => [s.width ?? null, s.compact ?? null])).toEqual([["half", null], ["half", true]]);
  expect(secs[0].fields.map(f => [f.size ?? null, f.cols ?? null])).toEqual([[null, null], [null, 6], ["full", null]]);


  // the saved template's preview is wide enough to show the sections side by side
  await page.goto(`index.html#/templates/${id}`);
  const box = sel => page.evaluate(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; }, sel);
  // the two half sections share a row
  await expect.poll(async () => {
    const [a, b] = [await box('.sheet-preview .sheet-sec[data-key="stats"]'), await box('.sheet-preview .sheet-sec[data-key="skills"]')];
    return !!a && !!b && Math.abs(a.y - b.y) < 2 && b.x > a.right - 1 && Math.abs(a.w - b.w) < 4;
  }).toBe(true);
  // six half-columns are three times a medium box, and full runs the section's width
  await expect.poll(async () => {
    const [name, motto, notes, s] = [await box('.sheet-preview .sheet-field[data-key="name"]'), await box('.sheet-preview .sheet-field[data-key="motto"]'),
      await box('.sheet-preview .sheet-field[data-key="notes"]'), await box('.sheet-preview .sheet-sec[data-key="stats"] .sheet-fields')];
    return !!name && !!motto && !!notes && Math.abs(motto.w - (name.w * 3 + 24)) < 6 && Math.abs(notes.w - s.w) < 2;
  }).toBe(true);
  // and the text box inside a wide field fills it
  const [motto, mottoInput] = [await box('.sheet-preview .sheet-field[data-key="motto"]'), await box('.sheet-preview .sheet-field[data-key="motto"] input')];
  expect(Math.abs(mottoInput.w - motto.w)).toBeLessThan(2);
  // compact: the label sits on the same line as its box
  await expect.poll(async () => {
    const [label, input] = [await box('.sheet-preview .sheet-field[data-key="stealth"] .sheet-label'), await box('.sheet-preview .sheet-field[data-key="stealth"] input')];
    return !!label && !!input && input.x > label.x + 20 && Math.abs((label.y + label.h / 2) - (input.y + input.h / 2)) < 12;
  }).toBe(true);

  // an iPad in portrait still has room for them side by side
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect.poll(async () => {
    const [a, b] = [await box('.sheet-preview .sheet-sec[data-key="stats"]'), await box('.sheet-preview .sheet-sec[data-key="skills"]')];
    return !!a && !!b && Math.abs(a.y - b.y) < 2 && b.x > a.right - 1;
  }).toBe(true);

  // on a phone the sections stack and nothing runs off the screen
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`index.html#/templates/${id}`);
  await expect.poll(async () => {
    const [a, b] = [await box('.sheet-preview .sheet-sec[data-key="stats"]'), await box('.sheet-preview .sheet-sec[data-key="skills"]')];
    return !!a && !!b && b.y > a.y + a.h - 1;
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  for (const [what, layout] of [
    ["cols", { sections: [{ key: "a", title: "A", fields: [{ key: "n", label: "N", type: "text", cols: 20 }] }] }],
    ["width", { sections: [{ key: "a", title: "A", width: "quarter", fields: [] }] }],
    ["compact", { sections: [{ key: "a", title: "A", compact: 1, fields: [] }] }],
  ]) expect((await api(page, "template_save", { name: "Bad", game: "X", layout })).status, what).toBe(400);
});
