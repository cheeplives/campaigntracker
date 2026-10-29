// The Tokens tab: a library of token pictures, assigned to party groups, characters and entries.
const { test, expect } = require("@playwright/test");
const zlib = require("zlib");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

// A w x h PNG, all one colour (the same encoder as maps.spec.js).
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = makePng(64, 64);

/** A GM with a campaign and one player, Pip, who has a page of their own. */
async function setup(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const pip = (await api(page, "campaign", undefined, cid)).json.members.find(m => m.email === player.email);
  return { cid, pp, pipId: pip.id };
}
/** Upload one token picture as whoever `page` is. */
async function tokenUpload(page, cid, name, file = "token.png") {
  const me = await (await page.request.get("api/auth/me.php")).json();
  const res = await page.request.post(`api/index.php?${new URLSearchParams({ a: "token_upload", cid })}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { ...(name ? { name } : {}), file: { name: file, mimeType: "image/png", buffer: PNG } },
  });
  return { status: res.status(), json: await res.json() };
}
const tokens = async (page, cid) => (await api(page, "tokens", undefined, cid)).json.tokens;
const get = async (page, url) => (await page.request.get(url)).status();

test("Tokens: a GM uploads several at once, named after their files", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Tokens upload");
  await page.goto(`#/c/${cid}/tokens`);
  await page.locator('input[type=file]').setInputFiles([
    { name: "Goblin_archer.png", mimeType: "image/png", buffer: PNG },
    { name: "pip-the-bold.png", mimeType: "image/png", buffer: PNG },
  ]);
  const cards = page.locator(".token-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "Goblin archer" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "Pip the bold" })).toHaveCount(1);
  await expect(cards.first().locator(".token-face img")).toBeVisible();
  const list = await tokens(page, cid);
  expect(list.map(t => [t.name, t.kind, t.size_squares]).sort()).toEqual([["Goblin archer", "creature", 1], ["Pip the bold", "creature", 1]]);
  expect(list.every(t => t.image_url && t.is_secret === false && t.groups.length === 0)).toBe(true);
  expectNoErrors(errors);
});

test("Tokens: assigning one to a character, an entry and the party", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pipId } = await setup(page, browser, "Tokens assign");
  const entry = (await api(page, "entry_save", { name: "Old Mill", notes: "<p>A mill.</p>" }, cid)).json.id;
  const a = (await tokenUpload(page, cid, "Pip the bold")).json.token;
  const b = (await tokenUpload(page, cid, "Mill wheel")).json.token;
  await page.goto(`#/c/${cid}/tokens`);

  const card = name => page.locator(".token-card").filter({ hasText: name });
  await card("Pip the bold").getByRole("button", { name: "Edit" }).click();
  const dlg = page.locator("dialog.kit-dialog");
  await dlg.getByLabel("Character", { exact: true }).selectOption(String(pipId));
  await dlg.getByLabel("The party").check();
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);

  await card("Mill wheel").getByRole("button", { name: "Edit" }).click();
  await dlg.getByLabel("Entry", { exact: true }).selectOption(String(entry));
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);

  const groups = (await api(page, "groups", undefined, cid)).json.groups;
  expect(groups[0].token_id).toBe(a.id);
  expect(groups[0].token_url).toBeTruthy();
  const pip = (await api(page, "campaign", undefined, cid)).json.members.find(m => m.id === pipId);
  expect(pip.token_url).toBeTruthy();

  await page.goto(`#/c/${cid}/members`);
  await expect(page.locator(".listrow.member").filter({ hasText: "Pip" }).locator(".token-face img")).toBeVisible();
  await page.goto(`#/c/${cid}/encyclopedia/${entry}`);
  await expect(page.locator(".enc-detail .token-face img")).toBeVisible();

  // a second token for Pip takes the character from the first
  const c = (await tokenUpload(page, cid, "Pip again")).json.token;
  expect((await api(page, "token_save", { id: c.id, member_id: pipId }, cid)).status).toBe(200);
  const now = await tokens(page, cid);
  expect(now.find(t => t.id === a.id).member_id).toBeNull();
  expect(now.find(t => t.id === c.id).member_id).toBe(pipId);
  expect(now.find(t => t.id === a.id).groups).toHaveLength(1);
  expect(now.find(t => t.id === b.id).entry_id).toBe(entry);
  expectNoErrors(errors);
});

test("Tokens: deleting a token clears what used it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Tokens delete");
  const t = (await tokenUpload(page, cid, "Banner")).json.token;
  const gid = (await api(page, "groups", undefined, cid)).json.groups[0].id;
  expect((await api(page, "token_save", { id: t.id, group_ids: [gid] }, cid)).status).toBe(200);
  expect((await api(page, "groups", undefined, cid)).json.groups[0].token_id).toBe(t.id);
  expect(sql(`SELECT COUNT(*) FROM attachments WHERE parent_type='token' AND parent_id=${t.id}`).trim()).toBe("1");

  await page.goto(`#/c/${cid}/tokens`);
  await page.locator(".token-card").filter({ hasText: "Banner" }).getByRole("button", { name: "Edit" }).click();
  await page.locator("dialog.kit-dialog").getByRole("button", { name: "Delete" }).click();
  await page.locator("dialog.kit-dialog").getByRole("button", { name: "Delete" }).last().click();
  await expect(page.locator(".token-card")).toHaveCount(0);

  expect((await api(page, "groups", undefined, cid)).json.groups[0].token_id).toBeNull();
  expect(sql(`SELECT COUNT(*) FROM attachments WHERE parent_type='token' AND parent_id=${t.id}`).trim()).toBe("0");
  expect(sql(`SELECT COUNT(*) FROM tokens WHERE id=${t.id}`).trim()).toBe("0");
  expectNoErrors(errors);
});

test("Tokens: only GMs", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp, pipId } = await setup(page, browser, "Tokens gm");
  const t = (await tokenUpload(page, cid, "Secret pip")).json.token;
  expect((await api(page, "token_save", { id: t.id, member_id: pipId, is_secret: true }, cid)).status).toBe(200);

  await pp.goto(`#/c/${cid}/today`);
  await expect(pp.locator("nav.tabs")).toBeVisible();
  await expect(pp.locator("nav.tabs a", { hasText: "Members" })).toHaveCount(1);   // Setup starts folded, so look for it, not at it
  await expect(pp.locator("nav.tabs a", { hasText: "Tokens" })).toHaveCount(0);
  expect((await api(pp, "tokens", undefined, cid)).status).toBe(403);
  expect((await tokenUpload(pp, cid, "Mine")).status).toBe(403);
  expect((await api(pp, "token_save", { id: t.id, name: "Mine" }, cid)).status).toBe(403);
  expect((await api(pp, "token_delete", { id: t.id }, cid)).status).toBe(403);

  const pip = (await api(pp, "campaign", undefined, cid)).json.members.find(m => m.id === pipId);
  expect(pip.token_url ?? null).toBeNull();
  expect(await get(pp, t.image_url)).toBe(404);
  expect(await get(page, t.image_url)).toBe(200);
  expectNoErrors(errors);
});

test("Tokens: a player sees the picture of a token that isn't GM only", async ({ page, browser }) => {
  const { cid, pp, pipId } = await setup(page, browser, "Tokens player");
  const t = (await tokenUpload(page, cid, "Pip")).json.token;
  expect((await api(page, "token_save", { id: t.id, member_id: pipId }, cid)).status).toBe(200);
  const pip = (await api(pp, "campaign", undefined, cid)).json.members.find(m => m.id === pipId);
  expect(pip.token_url).toBe(t.image_url);
  expect(await get(pp, pip.token_url)).toBe(200);
  // on a GM-only entry it is hidden again
  const e = (await api(page, "entry_save", { name: "Hidden", notes: "<p>x</p>", is_secret: true }, cid)).json.id;
  expect((await api(page, "token_save", { id: t.id, entry_id: e }, cid)).status).toBe(200);
  expect(((await api(pp, "campaign", undefined, cid)).json.members.find(m => m.id === pipId)).token_url ?? null).toBeNull();
  expect(await get(pp, t.image_url)).toBe(404);
});

test("Tokens: kind and name filter", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pipId } = await setup(page, browser, "Tokens filter");
  const pip = (await tokenUpload(page, cid, "Pip the bold")).json.token;
  await tokenUpload(page, cid, "Goblin archer");
  expect((await api(page, "token_save", { id: pip.id, kind: "character", member_id: pipId }, cid)).status).toBe(200);
  await page.goto(`#/c/${cid}/tokens`);
  await expect(page.locator(".token-card")).toHaveCount(2);
  await page.getByLabel("Kind", { exact: true }).selectOption("character");
  await expect(page.locator(".token-card")).toHaveCount(1);
  await expect(page.locator(".token-card")).toContainText("Pip the bold");
  await page.getByLabel("Kind", { exact: true }).selectOption("");
  await page.getByLabel("Find a token").fill("gob");
  await expect(page.locator(".token-card")).toHaveCount(1);
  await expect(page.locator(".token-card")).toContainText("Goblin archer");
  expectNoErrors(errors);
});

test("Tokens: the fields are checked", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Tokens checks");
  const t = (await tokenUpload(page, cid, null, "ogre-chief_2.png")).json.token;
  expect(t.name).toBe("Ogre chief 2");
  expect((await api(page, "token_save", { id: t.id, size_squares: 5 }, cid)).status).toBe(400);
  expect((await api(page, "token_save", { id: t.id, kind: "dragon" }, cid)).status).toBe(400);
  expect((await api(page, "token_save", { id: t.id, member_id: 999999 }, cid)).status).toBe(400);
  expect((await api(page, "token_save", { id: t.id, group_ids: [999999] }, cid)).status).toBe(400);
  expect((await api(page, "token_save", { id: t.id, name: " " }, cid)).status).toBe(400);
  const r = await api(page, "token_save", { id: t.id, kind: "object", size_squares: 3 }, cid);
  expect(r.json.token).toMatchObject({ kind: "object", size_squares: 3, name: "Ogre chief 2" });
  expect((await api(page, "token_save", { name: "Barrel" }, cid)).json.token).toMatchObject({ name: "Barrel", image_url: null, kind: "creature" });
});
