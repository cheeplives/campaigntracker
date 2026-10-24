// GM-only paragraphs inside notes players can read, View as player, and the @ list of Encyclopedia names.
// A secret paragraph is stored as <aside> and the server takes it out of everything a player is sent; when a player
// saves an entry or a tome they could only see without it, the server keeps it where it was.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
const get = async (page, qs) => (await (await page.request.get(`api/index.php?${qs}`)).json());

test("the GM marks a paragraph of the day's Public notes GM only, and players never receive it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Secret paragraph");
  await page.goto(`index.html#/c/${cid}`);
  const pub = page.locator(".notepanel.public .ql-editor");
  await pub.click();
  await pub.pressSequentially("Market day in Bree");
  await pub.press("Enter");
  await page.locator(".notepanel.public button.ql-secret").click();
  await pub.pressSequentially("The innkeeper waters the ale");
  await expect(page.locator(".notepanel.public .ql-editor aside")).toHaveText("The innkeeper waters the ale");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByText("Notes saved")).toBeVisible();

  const day = (await get(page, `a=day&cid=${cid}&d=2`)).day;
  expect(day.notes).toBe("<p>Market day in Bree</p><aside>The innkeeper waters the ale</aside>");
  // the editor opens on it again after a reload
  await page.reload();
  await expect(page.locator(".notepanel.public .ql-editor aside")).toHaveText("The innkeeper waters the ale");
  // the GM's month grid previews it with the secret notes
  const gmRange = await get(page, `a=days&cid=${cid}&from=2&to=2`);
  expect(gmRange.notes[0].items.map(i => [i.kind, i.text])).toEqual([["day", "Market day in Bree"], ["gm", "The innkeeper waters the ale"]]);

  // A player gets the day, the previews, the search sources and the search page without it.
  const perrors = watchErrors(pp);
  const pday = (await get(pp, `a=day&cid=${cid}&d=2`)).day;
  expect(pday.notes).toBe("<p>Market day in Bree</p>");
  expect(JSON.stringify(await get(pp, `a=days&cid=${cid}&from=0&to=9`))).not.toContain("ale");
  expect(JSON.stringify(await get(pp, `a=encyclopedia_sources&cid=${cid}`))).not.toContain("ale");
  await pp.goto(`index.html#/c/${cid}/today`);
  await expect(pp.locator("[data-box=notes] .richtext")).toHaveText("Market day in Bree");
  await expect(pp.locator("aside")).toHaveCount(0);
  await pp.goto(`index.html#/c/${cid}/search?q=ale`);
  await expect(pp.getByText("Nothing in the campaign matches every word.")).toBeVisible();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("a player's save of an entry or a tome keeps the GM's secret paragraphs where they were", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Keep secrets");
  const notes = "<aside>Born in Marienburg</aside><p>Runs the Griffin inn.</p><aside>Smuggles wine.</aside><aside>Owes the Guild.</aside><p>Has a dog.</p>";
  const id = (await api(page, "entry_save", { name: "Gunther Hoffmann", notes }, cid)).json.id;
  const entry = async who => (await get(who, `a=encyclopedia&cid=${cid}`)).entries.find(e => e.id === id);
  expect((await entry(pp)).notes).toBe("<p>Runs the Griffin inn.</p><p>Has a dog.</p>");
  expect((await get(pp, `a=campaign&cid=${cid}`)).encyclopedia.find(e => e.id === id).preview).not.toMatch(/Smuggles|Marienburg/);

  // The player adds a paragraph, and tries to slip in a secret one of their own.
  expect((await api(pp, "entry_save", { id, name: "Gunther Hoffmann", notes: "<p>Runs the Griffin inn.</p><p>Plays dice.</p><p>Has a dog.</p><aside>mine</aside>" }, cid)).status).toBe(200);
  expect((await entry(page)).notes).toBe("<aside>Born in Marienburg</aside><p>Runs the Griffin inn.</p><aside>Smuggles wine.</aside><aside>Owes the Guild.</aside><p>Plays dice.</p><p>Has a dog.</p>");
  // A paragraph the player deleted takes its secret paragraphs to the end.
  expect((await api(pp, "entry_save", { id, name: "Gunther Hoffmann", notes: "<p>Has a dog.</p>" }, cid)).status).toBe(200);
  expect((await entry(page)).notes).toBe("<aside>Born in Marienburg</aside><p>Has a dog.</p><aside>Smuggles wine.</aside><aside>Owes the Guild.</aside>");

  // The same for a Library tome, which anyone can change.
  const t = (await api(page, "tome_save", { kind: "book", title: "Ledger", body: "<p>Ale, bread.</p><aside>Hidden debts.</aside>" }, cid)).json.tome;
  const ptome = (await get(pp, `a=tome&cid=${cid}&id=${t.id}`)).tome;
  expect(ptome.body).toBe("<p>Ale, bread.</p>");
  expect((await get(pp, `a=library&cid=${cid}`)).tomes.find(x => x.id === t.id).words).toBe(2);
  expect((await api(pp, "tome_save", { id: t.id, version: ptome.version, kind: "book", title: "Ledger", body: "<p>Ale, bread.</p><p>A room.</p>" }, cid)).status).toBe(200);
  expect((await get(page, `a=tome&cid=${cid}&id=${t.id}`)).tome.body).toBe("<p>Ale, bread.</p><aside>Hidden debts.</aside><p>A room.</p>");
  expect((await get(pp, `a=tome&cid=${cid}&id=${t.id}`)).tome.body).toBe("<p>Ale, bread.</p><p>A room.</p>");

  // Plain-text day notes are shown as typed: an "<aside>" typed into them is not a secret paragraph.
  expect((await api(page, "day_update", { abs_day: 2, notes: "see <aside>x</aside>" }, cid)).status).toBe(200);
  expect((await get(pp, `a=day&cid=${cid}&d=2`)).day.notes).toBe("see <aside>x</aside>");
});

test("View as player shows the GM the players' side, and changes nothing meanwhile", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "View as");
  await api(page, "event_save", { abs_day: 2, title: "Open fair" }, cid);
  await api(page, "event_save", { abs_day: 2, title: "Hidden plot", is_secret: 1 }, cid);
  await api(page, "day_update", { abs_day: 2, notes: "<p>Fair day</p><aside>The plot</aside>", notes_format: "html", gm_notes: "Only us" }, cid);

  await page.goto(`index.html#/c/${cid}/events`);
  await expect(page.locator(".evrow")).toHaveCount(2);
  await page.getByRole("button", { name: "👁 View as player" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Viewing as a player" })).toBeVisible();
  await expect(page.locator(".now-title .role")).toHaveText("Player view");
  await expect(page.locator(".evrow h4")).toHaveText(["Open fair"]);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.goto(`index.html#/c/${cid}/today`);
  await expect(page.locator("[data-box=notes] .richtext")).toHaveText("Fair day");
  await expect(page.locator(".notepanel.secret")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Pass time/i })).toHaveCount(0);

  // The server refuses changes while the GM is viewing as a player, and answers reads as it would a player.
  const me = await (await page.request.get("api/auth/me.php")).json();
  const asPlayer = { "X-View-As": "player", "X-CSRF-Token": me.csrf };
  const refused = await page.request.post(`api/index.php?a=event_save&cid=${cid}`, { data: { abs_day: 3, title: "Nope" }, headers: asPlayer });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toBe("viewing_as_player");
  const read = await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`, { headers: asPlayer })).json();
  expect(read.day.notes).toBe("<p>Fair day</p>");
  expect(read.day).not.toHaveProperty("gm_notes");

  await page.getByRole("button", { name: "Leave player view" }).click();
  await expect(page.locator(".now-title .role")).toHaveText("GM view");
  await expect(page.locator(".notepanel.secret")).toBeVisible();
  expectNoErrors(errors);
});

test("typing @ lists Encyclopedia names to write into a note, and can add a new one", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Mentions");
  await api(page, "entry_save", { name: "Gunther Hoffmann", aliases: ["the innkeeper"] }, cid);
  await api(page, "entry_save", { name: "Griselda" }, cid);
  await page.goto(`index.html#/c/${cid}`);
  const pub = page.locator(".notepanel.public .ql-editor");
  const list = page.locator(".notepanel.public .rt-mentions");
  await pub.click();
  await pub.pressSequentially("Met @g");
  await expect(list.locator("li")).toHaveText(["Griselda", "Gunther Hoffmann", 'Add "g" to the Encyclopedia']);
  await pub.pressSequentially("un");
  await expect(list.locator("li")).toHaveText(["Gunther Hoffmann", 'Add "gun" to the Encyclopedia']);
  await pub.press("Enter");
  await expect(list).toBeHidden();
  await expect(pub).toHaveText("Met Gunther Hoffmann ");
  // aliases match too, and the entry's own name is written
  await pub.pressSequentially("and @innk");
  await expect(list.locator("li").first()).toHaveText("Gunther Hoffmann (the innkeeper)");
  await pub.press("Tab");
  await expect(pub).toHaveText("Met Gunther Hoffmann and Gunther Hoffmann ");
  // Escape leaves the @ as typed
  await pub.pressSequentially("@gri");
  await pub.press("Escape");
  await expect(list).toBeHidden();
  await pub.pressSequentially("s");
  await expect(list).toBeHidden();
  await expect(pub).toContainText("@gris");
  // a name nobody has yet becomes a new entry
  await pub.press("Enter");
  await pub.pressSequentially("@Black Barrow");
  await list.getByText('Add "Black Barrow" to the Encyclopedia').click();
  await expect(pub).toContainText("Black Barrow ");
  const { entries } = await (await page.request.get(`api/index.php?a=encyclopedia&cid=${cid}`)).json();
  expect(entries.map(e => e.name)).toContain("Black Barrow");
  expectNoErrors(errors);
});

test("Reveal makes a run of GM-only paragraphs public in one click, and can log it on today's events", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Reveal");
  const id = (await api(page, "entry_save", { name: "Gunther Hoffmann", notes: "<p>Runs the inn.</p><aside>Smuggles wine.</aside><aside>Owes the <strong>Guild</strong>.</aside><p>Has a dog.</p><aside>Born in Marienburg.</aside>" }, cid)).json.id;
  await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
  const reveal = page.getByRole("button", { name: "🔓 Reveal" });
  await expect(reveal).toHaveCount(2);
  await reveal.first().click();
  await page.getByRole("button", { name: "Reveal and log it today" }).click();
  await expect(page.getByText("Revealed, and logged on today's events")).toBeVisible();
  await expect(reveal).toHaveCount(1);

  const entry = async who => (await (await who.request.get(`api/index.php?a=encyclopedia&cid=${cid}`)).json()).entries.find(e => e.id === id);
  expect((await entry(page)).notes).toBe("<p>Runs the inn.</p><p>Smuggles wine.</p><p>Owes the <strong>Guild</strong>.</p><p>Has a dog.</p><aside>Born in Marienburg.</aside>");
  expect((await entry(pp)).notes).toBe("<p>Runs the inn.</p><p>Smuggles wine.</p><p>Owes the <strong>Guild</strong>.</p><p>Has a dog.</p>");
  const { events } = await (await pp.request.get(`api/index.php?a=events&cid=${cid}`)).json();
  expect(events.map(e => [e.abs_day, e.title, e.body, e.tags.map(t => t.name)])).toEqual([[2, "Revealed: Gunther Hoffmann", "Smuggles wine.\nOwes the Guild.", ["Revealed"]]]);

  // Just reveal logs nothing; a stale page is refused; players can't reveal.
  expect((await api(page, "secret_reveal", { kind: "entry", id, which: [{ index: 0, text: "Something else" }] }, cid)).status).toBe(409);
  expect((await api(pp, "secret_reveal", { kind: "entry", id, which: [{ index: 0, text: "Born in Marienburg." }] }, cid)).status).toBe(403);
  await reveal.click();
  await page.getByRole("button", { name: "Just reveal" }).click();
  await expect(reveal).toHaveCount(0);
  expect((await entry(pp)).notes).toContain("<p>Born in Marienburg.</p>");
  expect((await (await pp.request.get(`api/index.php?a=events&cid=${cid}`)).json()).events).toHaveLength(1);

  // Tomes too.
  const t = (await api(page, "tome_save", { kind: "book", title: "Ledger", body: "<p>Ale.</p><aside>Hidden debts.</aside>" }, cid)).json.tome;
  await page.goto(`index.html#/c/${cid}/library/${t.id}`);
  await page.getByRole("button", { name: "🔓 Reveal" }).click();
  await page.getByRole("button", { name: "Just reveal" }).click();
  await expect(page.getByRole("button", { name: "🔓 Reveal" })).toHaveCount(0);
  expect((await (await pp.request.get(`api/index.php?a=tome&cid=${cid}&id=${t.id}`)).json()).tome.body).toBe("<p>Ale.</p><p>Hidden debts.</p>");
  expectNoErrors(errors);
});
