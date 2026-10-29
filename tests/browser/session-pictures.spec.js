// Pictures on a session: a map, a handout or a sketch of the scene, kept with the game night. GMs add them; players see
// them once the session is published (never a GM-only one), and every picture opens in the viewer, which zooms so a big
// map can be read.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

// A 2×1 PNG, and a 1200×800 one for zooming, made in the browser so the test needs no image files.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAD0lEQVQImWNgYGBgYGAAAAAHAAHV3tbYAAAAAElFTkSuQmCC", "base64");
async function bigPng(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200; c.height = 800;
    const g = c.getContext("2d");
    g.fillStyle = "#c96"; g.fillRect(0, 0, 1200, 800);
    g.fillStyle = "#246"; g.fillRect(100, 100, 300, 200);
    return c.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(b64, "base64");
}

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
async function upload(page, cid, sid, name, buffer, extra = {}) {
  const me = await (await page.request.get("api/auth/me.php")).json();
  const res = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "session", parent_id: String(sid), file: { name, mimeType: "image/png", buffer }, ...extra },
  });
  return { status: res.status(), json: await res.json() };
}
const session = async (page, cid, id) => (await (await page.request.get(`api/index.php?a=session&cid=${cid}&id=${id}`)).json());

test("a GM adds a map to a session; players see it once published, never a GM-only one, and can't add their own", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Session maps");
  const sid = (await api(page, "session_save", { title: "The Sunken Keep" }, cid)).json.session.id;

  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  const box = page.locator(".sess-detail .enc-files");
  await expect(box.getByText("Add a map, a handout or a sketch of the scene")).toBeVisible();
  await box.locator("input[type=file]").setInputFiles({ name: "keep map.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("File added")).toBeVisible();
  await expect.poll(() => box.locator(".file-pic img").evaluate(img => img.complete && img.naturalWidth)).toBe(2);
  // the caption is changed in the viewer
  await box.locator(".file-thumb").click();
  const viewer = page.locator("dialog.file-viewer");
  await viewer.getByRole("button", { name: "✎ Caption" }).click();
  await page.getByRole("textbox", { name: "Caption" }).fill("The keep, ground floor");
  await page.getByRole("dialog", { name: "Change keep map.png" }).getByRole("button", { name: "Save" }).click();
  await expect(box.locator(".file-pic .tip")).toHaveAttribute("data-tip", "The keep, ground floor");
  expect((await upload(page, cid, sid, "trap.png", PNG, { is_secret: "1" })).status).toBe(200);

  // Unpublished, the session and its pictures are the GM's alone.
  const map = (await session(page, cid, sid)).session.files.find(f => f.name === "keep map.png");
  expect((await pp.request.get(map.url)).status()).toBe(404);
  expect((await upload(pp, cid, sid, "mine.png", PNG)).status).toBe(404);

  await api(page, "session_save", { id: sid, is_published: true }, cid);
  const pj = await session(pp, cid, sid);
  expect(pj.session.files.map(f => f.name)).toEqual(["keep map.png"]);
  expect((await pp.request.get(map.url)).status()).toBe(200);
  const trap = (await session(page, cid, sid)).session.files.find(f => f.name === "trap.png");
  expect((await pp.request.get(trap.url)).status()).toBe(404);
  // a player reads the session's pictures but adds none of their own, nor changes the GM's
  const added = await upload(pp, cid, sid, "mine.png", PNG);
  expect(added.status, JSON.stringify(added.json)).toBe(403);
  expect((await api(pp, "file_update", { id: map.id, caption: "Mine now" }, cid)).status).toBe(403);
  expect((await api(pp, "file_delete", { id: map.id }, cid)).status).toBe(403);

  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}/sessions/${sid}`);
  const pbox = pp.locator(".sess-detail .enc-files");
  await expect(pbox.locator(".file-pic")).toHaveCount(1);
  await expect.poll(() => pbox.locator(".file-pic img").evaluate(img => img.complete && img.naturalWidth)).toBe(2);
  await expect(pbox.locator("input[type=file]")).toHaveCount(0);
  await pbox.locator(".file-thumb").click();
  const pview = pp.locator("dialog.file-viewer");
  await expect(pview.locator(".file-cap")).toContainText("The keep, ground floor");
  await expect(pview.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await pview.getByRole("button", { name: "Close" }).click();

  // Deleting the session takes its pictures with it.
  expect((await api(page, "session_delete", { id: sid }, cid)).status).toBe(200);
  expect((await page.request.get(map.url)).status()).toBe(404);
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("a session with no pictures shows players no Pictures box", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Session no maps");
  const sid = (await api(page, "session_save", { title: "Quiet night" }, cid)).json.session.id;
  await api(page, "session_save", { id: sid, is_published: true }, cid);
  await pp.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await expect(pp.locator(".sess-detail h2")).toContainText("Quiet night");
  await expect(pp.locator(".sess-detail .enc-files")).toHaveCount(0);
  await expect(pp.locator(".sess-detail")).not.toContainText("null");
});

test("the picture viewer zooms a big map in and out, and moves around it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Session zoom");
  const sid = (await api(page, "session_save", { title: "Map night" }, cid)).json.session.id;
  expect((await upload(page, cid, sid, "region.png", await bigPng(page))).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await page.locator(".sess-detail .file-thumb").click();
  const viewer = page.locator("dialog.file-viewer");
  const img = viewer.locator("img.file-full");
  await expect.poll(() => img.evaluate(i => i.complete && i.naturalWidth)).toBe(1200);
  const fitted = await img.evaluate(i => i.getBoundingClientRect().width);
  const stage = viewer.locator(".file-stage");
  await expect(stage).not.toHaveClass(/zoomed/);
  await expect(viewer).not.toContainText("null");

  await viewer.getByRole("button", { name: "+", exact: true }).click();
  await expect(stage).toHaveClass(/zoomed/);
  expect(await img.evaluate(i => i.getBoundingClientRect().width)).toBeGreaterThan(fitted * 1.4);
  await viewer.getByRole("button", { name: "1:1" }).click();
  await expect(viewer.locator(".file-zoom-pct")).toHaveText("100%");
  expect(Math.round(await img.evaluate(i => i.getBoundingClientRect().width))).toBe(1200);
  // zoomed, the picture stays inside the viewer, which stays inside the window
  const sb = await stage.boundingBox(), vb = await viewer.boundingBox();
  expect(sb.x + sb.width).toBeLessThanOrEqual(vb.x + vb.width + 1);
  expect(vb.x + vb.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  // the zoomed picture scrolls inside the viewer, so all of it can be reached
  await expect.poll(() => stage.evaluate(s => s.scrollWidth > s.clientWidth || s.scrollHeight > s.clientHeight)).toBe(true);
  await viewer.getByRole("button", { name: "Fit" }).click();
  await expect(stage).not.toHaveClass(/zoomed/);
  expect(Math.round(await img.evaluate(i => i.getBoundingClientRect().width))).toBe(Math.round(fitted));
  // a click on the picture zooms in, another back out
  await img.click();
  await expect(stage).toHaveClass(/zoomed/);
  await img.click();
  await expect(stage).not.toHaveClass(/zoomed/);
  expectNoErrors(errors);
});
