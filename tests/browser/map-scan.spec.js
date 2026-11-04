// The map text scanner: Tesseract.js reads the words printed on a map's picture in the browser, and the GM approves or
// skips each name; an approved one is pinned where it was read, as its Encyclopedia entry (an existing one of that
// name, or a new Location).
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
const MapScan = require(path.join(__dirname, "..", "..", "static", "mapscan.js"));
test.afterEach(closeContexts);

const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
const blocks = (...lines) => [{ paragraphs: [{ lines: lines.map(words => ({ words })) }] }];

test("MapScan.candidates joins a line's words into names, splits labels side by side and drops noise", () => {
  const found = MapScan.candidates(blocks(
    [word("Raven", 100, 100, 160, 120), word("Hold,", 166, 100, 210, 120), word("Mirewood", 400, 102, 480, 120, 75)],
    [word("~~~", 10, 300, 40, 310), word("Ok", 60, 300, 80, 310), word("Bl0dg3r5", 100, 300, 180, 320)],
    [word("Mirewood", 600, 500, 680, 520, 60)],     // the same name again, less sure: the surer one is kept
    [word("Faintly", 10, 600, 60, 620, 30)],        // too unsure
  ), 2);
  expect(found.map(c => [c.name, c.conf])).toEqual([["Raven Hold", 90], ["Mirewood", 75]]);
  expect(found[0].box).toEqual({ x: 50, y: 50, w: 55, h: 10 });   // back in the map's own pixels (read at twice the size)
  expect([found[0].x, found[0].y]).toEqual([77.5, 55]);
  expect(MapScan.candidates([], 1)).toEqual([]);
});

/** A 900x600 map picture with two names printed on it, drawn in the page and returned as PNG bytes. */
async function printedMap(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 900; c.height = 600;
    const g = c.getContext("2d");
    g.fillStyle = "#f3ead2"; g.fillRect(0, 0, 900, 600);
    g.strokeStyle = "#6b8e5a"; g.lineWidth = 6; g.beginPath(); g.moveTo(0, 450); g.bezierCurveTo(300, 380, 600, 520, 900, 420); g.stroke();
    g.fillStyle = "#222"; g.font = "bold 44px sans-serif";
    g.fillText("Ravenhold", 80, 150);
    g.fillText("Mirewood", 520, 330);
    return c.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(b64, "base64");
}

test("Scan for names: the GM reviews what the scanner read and pins the approved names as entries", async ({ page, browser }) => {
  test.setTimeout(180_000);   // the scanner itself takes a while to load and read
  const errors = watchErrors(page);
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Scan ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await api(page, "entry_save", { name: "Mirewood" }, cid);   // one of the names is already an entry

  await page.goto("index.html#/");
  const png = await printedMap(page);
  const mapId = (await api(page, "map_save", { name: "Vale" }, cid)).json.map.id;
  const me = await (await page.request.get("api/auth/me.php")).json();
  const up = await page.request.post(`api/index.php?${new URLSearchParams({ a: "file_upload", cid })}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "map", parent_id: String(mapId), file: { name: "vale.png", mimeType: "image/png", buffer: png } },
  });
  expect(up.status()).toBe(200);
  await api(page, "map_save", { id: mapId, image_id: (await up.json()).file.id }, cid);

  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Scan for names…" }).click();
  const d = page.getByRole("dialog", { name: "Scan for place names" });
  await expect(d.getByRole("heading")).toContainText("Found", { timeout: 150_000 });
  const raven = d.locator(".map-scan-row").filter({ has: page.getByRole("checkbox", { name: "Add Ravenhold", exact: true }) });
  const mire = d.locator(".map-scan-row").filter({ has: page.getByRole("checkbox", { name: "Add Mirewood", exact: true }) });
  await expect(raven).toContainText("A new Location in the Encyclopedia");
  await expect(mire).toContainText("Pins the entry Mirewood");
  await raven.getByLabel("Place name").fill("Ravenhold Keep");   // a GM can fix a name before adding it
  // only these two, whatever else it read
  await d.getByRole("button", { name: "Select none" }).click();
  await raven.getByRole("checkbox").check();
  await mire.getByRole("checkbox").check();
  await expect(raven.getByRole("checkbox")).toBeChecked();
  await d.getByRole("button", { name: "Add 2 pins" }).click();
  await expect(page.locator("#toast")).toContainText("Added 2 pins, with 1 new Location in the Encyclopedia");
  await expect(page.locator(".map-pin")).toHaveCount(2);

  const map = await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json();
  const byName = Object.fromEntries(map.pins.map(p => [p.entry.name, p]));
  expect(Object.keys(byName).sort()).toEqual(["Mirewood", "Ravenhold Keep"]);
  // pinned where the words are printed (Ravenhold around 80–290, 110–150; Mirewood around 520–720, 290–330)
  expect(byName["Ravenhold Keep"].x).toBeGreaterThan(80); expect(byName["Ravenhold Keep"].x).toBeLessThan(300);
  expect(byName["Ravenhold Keep"].y).toBeGreaterThan(100); expect(byName["Ravenhold Keep"].y).toBeLessThan(160);
  expect(byName.Mirewood.x).toBeGreaterThan(510); expect(byName.Mirewood.y).toBeGreaterThan(280);
  const enc = (await api(page, "encyclopedia", undefined, cid)).json.entries.filter(e => ["Mirewood", "Ravenhold Keep"].includes(e.name));
  expect(enc).toHaveLength(2);   // Mirewood was reused, not made again
  await expect(pp.getByRole("button", { name: "Scan for names…" })).toHaveCount(0);
  await pp.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await expect(pp.locator(".map-pin")).toHaveCount(2);
  await expect(pp.getByRole("button", { name: "Scan for names…" })).toHaveCount(0);

  // scanning again finds them already pinned, and leaves them unticked
  await page.getByRole("button", { name: "Scan for names…" }).click();
  await expect(d.getByRole("heading")).toContainText("Found", { timeout: 150_000 });
  await expect(d.locator(".map-scan-row").filter({ has: page.getByRole("checkbox", { name: "Add Mirewood", exact: true }) })).toContainText("Already pinned on this map");
  await expect(d.locator(".map-scan-row").filter({ has: page.getByRole("checkbox", { name: "Add Mirewood", exact: true }) }).getByRole("checkbox")).not.toBeChecked();
  await d.getByRole("button", { name: "Cancel" }).click();
  expectNoErrors(errors);
});

test("Scan for names: every scanner file is served by Apache, not refused as a backup (.htaccess)", () => {
  // php -S, which the tests run on, never reads .htaccess, so the scanner can pass here and still be refused on the
  // real host: its model ends in .gz, which the backups-and-archives rule denies.
  const fs = require("fs");
  const ht = fs.readFileSync(path.join(__dirname, "..", "..", ".htaccess"), "utf8");
  const deny = [...ht.matchAll(/<FilesMatch "([^"]+)">\s*Require all denied/g)].map(m => new RegExp(m[1]));
  const allowed = new Set([...ht.matchAll(/<Files "([^"]+)">\s*Require all granted/g)].map(m => m[1]));
  const files = fs.readdirSync(path.join(__dirname, "..", "..", "static", "vendor", "tesseract"))
    .filter(f => /\.(js|wasm|gz)$/.test(f));
  expect(files).toContain("eng.traineddata.gz");
  const refused = files.filter(f => deny.some(re => re.test(f)) && !allowed.has(f));
  expect(refused).toEqual([]);
  // and the grant comes after the rule it overrides
  expect(ht.indexOf('<Files "eng.traineddata.gz">')).toBeGreaterThan(ht.search(/<FilesMatch "[^"]*\|gz\|/));
});

test("Scan for names: a scanner file the server refuses says so instead of loading for ever", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const gm = person("Gail");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Scan refused ${gm.id}`);
  await page.goto("index.html#/");
  const png = await printedMap(page);
  const mapId = (await api(page, "map_save", { name: "Fen" }, cid)).json.map.id;
  const me = await (await page.request.get("api/auth/me.php")).json();
  const up = await page.request.post(`api/index.php?${new URLSearchParams({ a: "file_upload", cid })}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "map", parent_id: String(mapId), file: { name: "fen.png", mimeType: "image/png", buffer: png } },
  });
  await api(page, "map_save", { id: mapId, image_id: (await up.json()).file.id }, cid);
  await page.context().route("**/eng.traineddata.gz", r => r.fulfill({ status: 403, contentType: "text/html", body: "Forbidden" }));
  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Scan for names…" }).click();
  const d = page.getByRole("dialog");
  await expect(d.getByRole("status")).toContainText("couldn't load its files", { timeout: 60_000 });
  await expect(d.getByRole("status")).toContainText("403");
  await d.getByRole("button", { name: "Cancel" }).click();
});
