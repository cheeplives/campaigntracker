// Edit history: every save of an entry, tome, session or day's notes keeps the text it was saved as, a GM can read an
// earlier version, see what changed and restore it, and nobody else can. The diff (static/diff.js) runs under Node;
// the dialog is checked in every browser, touch ones included.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
const Diff = require(path.join(__dirname, "..", "..", "static", "diff.js"));
/** A read with parameters, as whoever the page is signed in as. */
async function get(page, action, params, cid) {
  const res = await page.request.get(`api/index.php?${new URLSearchParams({ a: action, cid, ...params })}`);
  return { status: res.status(), json: await res.json() };
}

test("a diff goes paragraph by paragraph, and word by word inside a reworded one", () => {
  const d = Diff.lines("The inn\nGunther runs it\nIt is old", "The inn\nGunther runs it well\nIt is old\nA new line");
  expect(d.map(x => x.type)).toEqual(["same", "change", "same", "add"]);
  expect(d[1].parts).toEqual([{ t: "=", s: "Gunther runs it" }, { t: "+", s: " well" }]);
  expect(Diff.counts(d)).toEqual({ add: 1, del: 0, change: 1 });
  expect(Diff.changed(Diff.lines("same", "same"))).toBe(false);
  expect(Diff.lines("a\nb", "a").map(x => x.type)).toEqual(["same", "del"]);
  expect(Diff.words("the quick brown fox", "the slow brown dog").map(p => `${p.t}${p.s}`)).toEqual(["=the ", "-quick", "+slow", "= brown ", "-fox", "+dog"]);
  expect(Diff.htmlText("<p>Hi &amp; bye</p><p><strong>Two</strong> <em>lines</em></p><ul><li>a</li><li>b</li></ul>")).toBe("Hi & bye\nTwo lines\na\nb");
  expect(Diff.htmlText(null)).toBe("");
  // two enormous texts are not compared cell by cell: the whole of each side is marked instead
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  expect(Diff.lines(big, big + "!").length).toBeGreaterThan(0);
});

test("saves are kept, joined when close together, restorable, GM-only and forgotten with the item", async ({ page, browser }) => {
  const gm = person("Hale"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `History ${gm.id}`);
  const ok = async (action, body) => { const r = await api(page, action, body, cid); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
  const ageAll = () => sql(`UPDATE content_versions SET saved_at = saved_at - INTERVAL 1 HOUR WHERE campaign_id=${cid}`);
  const read = async (action, params) => { const r = await get(page, action, params, cid); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
  const list = async (kind, ref) => (await read("history_list", { kind, ref })).versions;
  const got = id => read("history_get", { id });

  // an entry: made, edited later, edited again at once (joined to the last)
  const id = (await ok("entry_save", { name: "Gunther", notes: "<p>One</p>" })).id;
  expect(await list("entry", id)).toHaveLength(1);
  ageAll();
  await ok("entry_save", { id, name: "Gunther", notes: "<p>Two</p>", gm_notes: "<p>Smuggler</p>" });
  await ok("entry_save", { id, name: "Gunther", notes: "<p>Three</p>", gm_notes: "<p>Smuggler</p>" });
  let versions = await list("entry", id);
  expect(versions).toHaveLength(2);                                           // the second and third saves are one version
  expect(versions[0].by).toBe(gm.name);
  const latest = await got(versions[0].id);
  expect(latest.version.data.notes).toBe("<p>Three</p>");
  expect(latest.version.data.gm_notes).toBe("<p>Smuggler</p>");
  expect(latest.previous.notes).toBe("<p>One</p>");
  expect(latest.current.notes).toBe("<p>Three</p>");

  // restore the first: the entry reads as it did, and the restore is a version of its own
  await ok("history_restore", { id: versions[1].id });
  const entries = (await read("encyclopedia", {})).entries;
  expect(entries.find(e => e.id === id).notes).toBe("<p>One</p>");
  expect(entries.find(e => e.id === id).gm_notes ?? null).toBeNull();
  versions = await list("entry", id);
  expect(versions).toHaveLength(3);

  // an entry written before history began gets a "before history" version on its first change
  const old = Number(sql(`INSERT INTO encyclopedia_entries (campaign_id, name, notes) VALUES (${cid}, 'Ilse', '<p>Old words</p>'); SELECT LAST_INSERT_ID();`).trim().split("\n").pop());
  expect(await list("entry", old)).toHaveLength(0);
  await ok("entry_save", { id: old, name: "Ilse", notes: "<p>New words</p>" });
  versions = await list("entry", old);
  expect(versions.map(v => v.baseline)).toEqual([false, true]);
  expect((await got(versions[1].id)).version.data.notes).toBe("<p>Old words</p>");

  // the newest 50 are kept
  const rows = Array.from({ length: 55 }, () => `(${cid}, 'entry', ${old}, '{"name":"Ilse","notes":"x"}', NULL, 0)`).join(",");
  sql(`INSERT INTO content_versions (campaign_id, kind, ref_id, data, saved_by, baseline) VALUES ${rows}`);
  ageAll();
  await ok("entry_save", { id: old, name: "Ilse", notes: "<p>Newest</p>" });
  versions = await list("entry", old);
  expect(versions).toHaveLength(50);
  expect((await got(versions[0].id)).version.data.notes).toBe("<p>Newest</p>");

  // revealing a secret paragraph is a version too
  const sec = (await ok("entry_save", { name: "Vault", notes: "<p>Open</p>" })).id;
  ageAll();
  await ok("entry_save", { id: sec, name: "Vault", notes: "<p>Open</p><aside>Hidden door</aside>" });
  ageAll();
  await ok("secret_reveal", { kind: "entry", id: sec, which: [{ index: 0, text: "Hidden door" }] });
  versions = await list("entry", sec);
  expect(versions).toHaveLength(3);
  expect((await got(versions[0].id)).version.data.notes).toBe("<p>Open</p><p>Hidden door</p>");

  // a tome, a session and a day each keep theirs
  const tome = (await ok("tome_save", { kind: "journal", title: "Ledger", body: "<p>Ale</p>" })).tome.id;
  ageAll();
  await ok("tome_save", { id: tome, version: 1, kind: "journal", title: "Ledger", body: "<p>Ale and bread</p>" });
  versions = await list("tome", tome);
  expect(versions).toHaveLength(2);
  await ok("history_restore", { id: versions[1].id });
  expect((await read("tome", { id: tome })).tome.body).toBe("<p>Ale</p>");

  const ses = (await ok("session_save", {})).session.id;
  await ok("session_notes_save", { id: ses, notes_text: "met the baron", base: null });
  ageAll();
  await ok("session_notes_save", { id: ses, notes_text: "met the baron\nhe lied", base: "met the baron" });
  versions = await list("session", ses);
  expect(versions.length).toBeGreaterThanOrEqual(2);
  expect((await got(versions[0].id)).version.data.notes_text).toBe("met the baron\nhe lied");
  await ok("history_restore", { id: versions[1].id });
  expect((await read("session", { id: ses })).session.notes_text).toBe("met the baron");

  await ok("day_update", { abs_day: 4, notes: "<p>Rain</p>", notes_format: "html" });
  ageAll();
  await ok("day_update", { abs_day: 4, notes: "<p>Sun</p>", notes_format: "html", gm_notes: "<p>Plot</p>", gm_notes_format: "html" });
  versions = await list("day", 4);
  expect(versions).toHaveLength(2);
  await ok("history_restore", { id: versions[1].id });
  expect(sql(`SELECT notes FROM days WHERE campaign_id=${cid} AND abs_day=4`).trim()).toBe("<p>Rain</p>");

  // a name taken since refuses the restore, with a reason
  const a = (await ok("entry_save", { name: "Mira", notes: "<p>x</p>" })).id;
  ageAll();
  await ok("entry_save", { id: a, name: "Mirabel", notes: "<p>x</p>" });
  await ok("entry_save", { name: "Mira", notes: "<p>taken</p>" });
  const mv = await list("entry", a);
  const r = await api(page, "history_restore", { id: mv[1].id }, cid);
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("name_taken");

  // only GMs; a player is never sent a version
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  await ok("member_add", { email: player.email, role: "player" });
  expect((await get(pp, "history_list", { kind: "entry", ref: id }, cid)).status).toBe(403);
  expect((await get(pp, "history_get", { id: versions[0].id }, cid)).status).toBe(403);
  expect((await api(pp, "history_restore", { id: versions[0].id }, cid)).status).toBe(403);

  // deleting the item forgets its versions
  await ok("entry_delete", { id });
  expect(sql(`SELECT COUNT(*) FROM content_versions WHERE campaign_id=${cid} AND kind='entry' AND ref_id=${id}`).trim()).toBe("0");
});

test("the History dialog lists the versions, shows what changed, and restores one", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `HistoryUI ${gm.id}`);
  const ok = async (action, body) => { const r = await api(page, action, body, cid); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
  const id = (await ok("entry_save", { name: "Gunther", notes: "<p>Runs the inn</p><p>Likes ale</p>" })).id;
  sql(`UPDATE content_versions SET saved_at = saved_at - INTERVAL 1 HOUR WHERE campaign_id=${cid}`);
  await ok("entry_save", { id, name: "Gunther", notes: "<p>Runs the inn in Bree</p><p>Likes ale</p><p>Owes money</p>" });

  await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
  await page.locator(".enc-detail").getByLabel(/^More for /).click();   // History waits in the entry's ⋯ menu
  await page.getByRole("button", { name: "History" }).click();
  const dlg = page.locator("dialog.history-dialog");
  await expect(dlg.locator(".hist-ver")).toHaveCount(2);
  await expect(dlg.locator(".hist-head")).toContainText("changed");
  await expect(dlg.locator(".hist-line ins")).toContainText(["in Bree"]);        // the reworded paragraph, word by word
  await expect(dlg.locator(".hist-line.add")).toContainText("Owes money");
  // the first version is what was first written; against now, restoring it would remove the new words
  await dlg.locator(".hist-ver").nth(1).click();
  await expect(dlg.locator(".hist-head")).toContainText("wrote");
  await dlg.getByRole("button", { name: "Compared with now" }).click();
  await expect(dlg.locator(".hist-line del").first()).toBeVisible();
  await dlg.getByRole("button", { name: "Restore this version" }).click();
  await page.getByRole("dialog").filter({ hasText: "Put the entry back" }).getByRole("button", { name: "Restore" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByText("Runs the inn", { exact: true })).toBeVisible();
  await expect(page.getByText("Owes money")).toHaveCount(0);
  expectNoErrors(errors);

  // a player has no History button
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  await ok("member_add", { email: player.email, role: "player" });
  await pp.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
  await expect(pp.getByRole("heading", { name: "Gunther" }).first()).toBeVisible();
  await pp.locator(".enc-detail").getByLabel(/^More for /).click();   // a player's ⋯ menu has no History
  await expect(pp.getByRole("button", { name: "History" })).toHaveCount(0);
});
