// Starring Encyclopedia entries and Library tomes: each person stars their own (kept in their preferences), from the
// ☆ on a card in the list or by the name on its page, and the starred ones are listed under Starred on the tab's first
// page, below Newest (Encyclopedia) or Last changed (Library), newest star first.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
const starred = page => page.locator(".lp-starred .enc-name");

test("Encyclopedia: entries are starred from the list or their page, listed under Starred, each person their own", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Stars");
  const ids = {};
  for (const n of ["Altdorf", "Marienburg", "Nuln"]) ids[n] = (await api(page, "entry_save", { name: n, notes: `<p>${n} is a city.</p>` }, cid)).json.id;
  await api(page, "entry_save", { name: "Middenheim" }, cid);   // blank

  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await expect(page.locator(".lp-start h3").first()).toHaveText("Newest");
  await expect(page.locator(".lp-starred")).toHaveCount(0);
  // the blank one waits in a folded Blank Entries, with a red count
  await expect(page.locator(".enc-blank .count-badge")).toHaveText("1");
  await expect(page.locator(".enc-blank button.enc-fold")).toHaveAttribute("aria-expanded", "false");

  // star from the list's cards: pressing the star doesn't open the entry
  await page.getByRole("button", { name: "Star Nuln", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unstar Nuln", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/encyclopedia$`));
  await page.getByRole("button", { name: "Star Altdorf", exact: true }).click();
  await expect(starred(page)).toHaveText(["Altdorf", "Nuln"]);   // newest star first
  await expect(page.locator(".lp-start h3")).toHaveText(["Newest", "★ Starred"]);

  // and from the entry's page, next to its name
  await page.goto(`index.html#/c/${cid}/encyclopedia/${ids.Marienburg}`);
  await expect(page.getByRole("heading", { name: "Marienburg", exact: true })).toBeVisible();   // the star isn't part of its name
  await page.locator(".enc-detail .title-star").getByRole("button", { name: "Star Marienburg", exact: true }).click();
  await expect(page.locator(".enc-detail .title-star").getByRole("button", { name: "Unstar Marienburg", exact: true })).toBeVisible();
  await page.locator(".enc-detail .title-star").getByRole("button", { name: "Unstar Marienburg", exact: true }).click();
  await expect(page.locator(".enc-detail .title-star").getByRole("button", { name: "Star Marienburg", exact: true })).toBeVisible();
  // the keyboard stars a card too
  await page.getByRole("button", { name: "Star Marienburg", exact: true }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Unstar Marienburg", exact: true }).first()).toBeVisible();

  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await expect(starred(page)).toHaveText(["Marienburg", "Altdorf", "Nuln"]);
  await page.reload();
  await expect(starred(page)).toHaveText(["Marienburg", "Altdorf", "Nuln"]);

  // a player's stars are their own
  await pp.goto(`index.html#/c/${cid}/encyclopedia`);
  await expect(pp.locator(".lp-start h3").first()).toHaveText("Newest");
  await expect(pp.locator(".lp-starred")).toHaveCount(0);
  await pp.getByRole("button", { name: "Star Altdorf", exact: true }).click();
  await expect(starred(pp)).toHaveText(["Altdorf"]);
  await page.reload();
  await expect(starred(page)).toHaveText(["Marienburg", "Altdorf", "Nuln"]);

  // a deleted entry drops off the list
  expect((await api(page, "entry_delete", { id: ids.Nuln }, cid)).status).toBe(200);
  await page.reload();
  await expect(starred(page)).toHaveText(["Marienburg", "Altdorf"]);
  expectNoErrors(errors);
});

test("Library: tomes are starred from the list or their page and listed under Starred", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Tome stars");
  const ids = {};
  for (const t of ["The Codex", "Ship's Log"]) ids[t] = (await api(page, "tome_save", { kind: "book", title: t, description: "", body: "<p>Words.</p>" }, cid)).json.tome.id;

  await page.goto(`index.html#/c/${cid}/library`);
  await expect(page.locator(".lp-starred")).toHaveCount(0);
  await page.getByRole("button", { name: "Star Ship's Log", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/library$`));
  await expect(page.locator(".lp-start h3")).toHaveText(["Last changed", "★ Starred"]);
  await expect(starred(page)).toHaveText([/Ship's Log/]);

  await page.goto(`index.html#/c/${cid}/library/${ids["The Codex"]}`);
  await expect(page.locator(".lib-detail h2")).toHaveText("The Codex");
  await page.locator(".lib-detail .title-star").getByRole("button", { name: "Star The Codex", exact: true }).click();
  await expect(page.locator(".lib-detail .title-star").getByRole("button", { name: "Unstar The Codex", exact: true })).toBeVisible();
  await page.goto(`index.html#/c/${cid}/library`);
  await expect(starred(page)).toHaveText([/The Codex/, /Ship's Log/]);
  expectNoErrors(errors);
});

test("a star is kept only in a campaign you belong to, and only on an entry or a tome", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Star rules");
  const ctx = await newContext(browser);
  const other = await ctx.newPage();
  const b = person("Bram");
  await signIn(other, b);
  await approve(browser, b.email);
  const theirs = await makeCampaign(other, "Theirs");
  expect((await api(page, "prefs_save", { star: { cid: theirs, kind: "entry", id: 5, on: true } })).status).toBe(404);
  expect((await api(page, "prefs_save", { star: { cid, kind: "map", id: 5, on: true } })).status).toBe(400);
  const r = await api(page, "prefs_save", { star: { cid, kind: "entry", id: 5, on: true } });
  expect(r.status).toBe(200);
  expect(r.json.prefs.stars).toEqual({ [cid]: { entry: [5] } });
  const off = await api(page, "prefs_save", { star: { cid, kind: "entry", id: 5, on: false } });
  expect(off.json.prefs.stars).toBeUndefined();
});
