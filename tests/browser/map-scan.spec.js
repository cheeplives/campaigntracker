// The map text scanner: Claude (through Anthropic's API, with the GM's own key, kept in their browser) or Tesseract.js
// (on the GM's device) reads the place names printed on a map's picture, and the GM approves or skips each name; an
// approved one is pinned where it was read, as its Encyclopedia entry (an existing one of that name, or a new
// Location). Quick label pins names by hand: click a spot, type its name.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, settledBox } = require("./helpers");
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
  await d.getByRole("button", { name: "Read here" }).click();
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
  await d.getByRole("button", { name: "Read here" }).click();
  await expect(d.getByRole("heading")).toContainText("Found", { timeout: 150_000 });
  await expect(d.locator(".map-scan-row").filter({ has: page.getByRole("checkbox", { name: "Add Mirewood", exact: true }) })).toContainText("Already pinned on this map");
  await expect(d.locator(".map-scan-row").filter({ has: page.getByRole("checkbox", { name: "Add Mirewood", exact: true }) }).getByRole("checkbox")).not.toBeChecked();
  await d.getByRole("button", { name: "Cancel" }).click();
  expectNoErrors(errors);
});

test("Scan for names: every scanner file is served by Apache, not refused as a backup (.htaccess)", () => {
  // php -S, which the tests run on, never reads .htaccess, so the scanner can pass here and still be refused on the
  // real host (its model once ended in .gz, which the backups-and-archives rule denies).
  const fs = require("fs");
  const ht = fs.readFileSync(path.join(__dirname, "..", "..", ".htaccess"), "utf8");
  const deny = [...ht.matchAll(/<FilesMatch "([^"]+)">\s*Require all denied/g)].map(m => new RegExp(m[1]));
  const allowed = new Set([...ht.matchAll(/<Files "([^"]+)">\s*Require all granted/g)].map(m => m[1]));
  const files = fs.readdirSync(path.join(__dirname, "..", "..", "static", "vendor", "tesseract"))
    .filter(f => !/^(LICENSE|README)/.test(f));
  expect(files).toContain("eng.traineddata");
  expect(files.filter(f => f.endsWith(".gz"))).toEqual([]);   // hosts refuse or mangle .gz files: one answered 404
  const refused = files.filter(f => deny.some(re => re.test(f)) && !allowed.has(f));
  expect(refused).toEqual([]);
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
  await page.context().route("**/eng.traineddata", r => r.fulfill({ status: 403, contentType: "text/html", body: "Forbidden" }));
  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Scan for names…" }).click();
  const d = page.getByRole("dialog");
  await d.getByRole("button", { name: "Read here" }).click();
  await expect(d.getByRole("status")).toContainText("couldn't load its files", { timeout: 60_000 });
  await expect(d.getByRole("status")).toContainText("403");
  await d.getByRole("button", { name: "Cancel" }).click();
});

test("Scan for names: deploy.sh's security check doesn't call any file the repo ships a leftover to delete", () => {
  // It once flagged the scanner's eng.traineddata.gz as a stray backup, and deleting it as told broke the scanner.
  const { spawnSync } = require("child_process");
  const r = spawnSync("php", [path.join(__dirname, "..", "..", "tools", "security-check.php")], { encoding: "utf8" });
  const out = r.stdout + r.stderr;
  expect(out).toContain("Security check");
  // tests/ itself holds generated reports locally; only what the repo ships counts
  expect(out.split("\n").filter(l => l.includes("Leftover file") && !l.includes("tests/"))).toEqual([]);
});


test("MapScan.fromClaude turns Claude's boxes into names in the map's own pixels, in reading order, dropping junk", () => {
  const found = MapScan.fromClaude({ labels: [
    { name: "  Mirewood ", x0: 400, y0: 200, x1: 500, y1: 230 },
    { name: "World's Edge  Mountains", x0: 100, y0: 20, x1: 700, y1: 60 },
    { name: "42", x0: 1, y0: 1, x1: 9, y1: 9 },                      // no letters
    { name: "Off the edge", x0: 2000, y0: 10, x1: 2100, y1: 30 },    // outside the picture
    { name: "Backwards", x0: 300, y0: 330, x1: 200, y1: 300 },       // corners swapped: still a box
  ] }, 2, 1000, 800);
  expect(found.map(c => c.name)).toEqual(["World's Edge Mountains", "Mirewood", "Backwards"]);
  expect(found[1]).toEqual({ name: "Mirewood", conf: null, x: 225, y: 107.5, box: { x: 200, y: 100, w: 50, h: 15 } });
  expect(MapScan.fromClaude(null)).toEqual([]);
});

/** A GM's campaign with a map whose picture is printedMap(): { cid, mapId }. */
async function mapReady(page, browser, label) {
  const gm = person(label);
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  await api(page, "entry_save", { name: "Mirewood" }, cid);
  await page.goto("index.html#/");
  const png = await printedMap(page);
  const mapId = (await api(page, "map_save", { name: "Vale" }, cid)).json.map.id;
  const me = await (await page.request.get("api/auth/me.php")).json();
  const up = await page.request.post(`api/index.php?${new URLSearchParams({ a: "file_upload", cid })}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "map", parent_id: String(mapId), file: { name: "vale.png", mimeType: "image/png", buffer: png } },
  });
  await api(page, "map_save", { id: mapId, image_id: (await up.json()).file.id }, cid);
  return { cid, mapId };
}
const KEY = "sk-ant-api03-" + "x".repeat(40);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

test("Scan for names: Read with Claude sends the picture to Anthropic with the GM's own key, and pins the names it read", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, mapId } = await mapReady(page, browser, "Cleo");
  await page.evaluate(k => localStorage.setItem("chronicle.anthropicKey", k), KEY);
  const sent = [];
  await page.context().route("https://api.anthropic.com/**", async r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    sent.push({ headers: r.request().headers(), body: r.request().postDataJSON() });
    // the picture is 900x600, sent as it is (under Claude's 2576px), so these are the map's own pixels
    const answer = { labels: [{ name: "Ravenhold", x0: 80, y0: 110, x1: 290, y1: 152 }, { name: "Mirewood", x0: 520, y0: 290, x1: 720, y1: 332 }] };
    return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify({ id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] }) });
  });
  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Scan for names…" }).click();
  const d = page.getByRole("dialog", { name: "Scan for place names" });
  await d.getByRole("button", { name: "Read with Claude" }).click();
  await expect(d.getByRole("heading")).toContainText("Found 2 names");
  expect(sent).toHaveLength(1);
  const { headers, body } = sent[0];
  expect(headers["x-api-key"]).toBe(KEY);
  expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(headers["anthropic-version"]).toBeTruthy();
  expect(body.model).toBe(MapScan.MODEL);
  expect(body.output_config.format.type).toBe("json_schema");
  const img = body.messages[0].content.find(c => c.type === "image");
  expect(img.source.media_type).toBe("image/jpeg");
  expect(img.source.data.length).toBeGreaterThan(1000);
  expect(body.messages[0].content.find(c => c.type === "text").text).toContain("900 by 600 pixels");
  const mire = d.locator(".map-scan-row").filter({ has: page.getByRole("checkbox", { name: "Add Mirewood", exact: true }) });
  await expect(mire).toContainText("Pins the entry Mirewood");
  await expect(mire).not.toContainText("% sure");   // Claude gives no confidence
  await expect(mire.getByRole("checkbox")).toBeChecked();
  await d.getByRole("button", { name: "Add 2 pins" }).click();
  await expect(page.locator("#toast")).toContainText("Added 2 pins, with 1 new Location in the Encyclopedia");
  const map = await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json();
  const raven = map.pins.find(p => p.entry.name === "Ravenhold");
  expect([Math.round(raven.x), Math.round(raven.y)]).toEqual([185, 131]);
  expectNoErrors(errors);
});

test("Scan for names: an API key Anthropic refuses says so", async ({ page, browser }) => {
  const { cid, mapId } = await mapReady(page, browser, "Cato");
  await page.evaluate(k => localStorage.setItem("chronicle.anthropicKey", k), KEY);
  await page.context().route("https://api.anthropic.com/**", r => r.request().method() === "OPTIONS" ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) }));
  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Scan for names…" }).click();
  const d = page.getByRole("dialog", { name: "Scan for place names" });
  await d.getByRole("button", { name: "Read with Claude" }).click();
  await expect(d.getByRole("status")).toContainText("didn't accept your API key");
});

test("Scan for names: with no key, Read with Claude points to the account page, which keeps the key in the browser only", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, mapId } = await mapReady(page, browser, "Kit");
  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Scan for names…" }).click();
  const d = page.getByRole("dialog", { name: "Scan for place names" });
  await expect(d.getByRole("button", { name: "Read with Claude" })).toHaveCount(0);
  await d.getByRole("link", { name: "Add your key" }).click();
  await expect(page).toHaveURL(/#\/account$/);
  const card = page.locator("form.card", { has: page.getByRole("heading", { name: "Map scanner" }) });
  await expect(card.getByRole("status")).toHaveText("No key saved in this browser.");
  await expect(card.getByRole("button", { name: "Remove key" })).toBeHidden();
  await card.getByLabel("Anthropic API key").fill("not a key");
  await card.getByRole("button", { name: "Save key" }).click();
  await expect(page.locator("#toast")).toContainText("doesn't look like an Anthropic API key");
  const toServer = [];
  page.on("request", r => { if (r.url().includes("127.0.0.1") && (r.postData() || "").includes("sk-ant-")) toServer.push(r.url()); });
  await card.getByLabel("Anthropic API key").fill(KEY);
  await card.getByRole("button", { name: "Save key" }).click();
  await expect(card.getByRole("status")).toHaveText("A key is saved in this browser.");
  await expect(card.getByLabel("Anthropic API key")).toHaveValue("");   // not shown again
  expect(await page.evaluate(() => localStorage.getItem("chronicle.anthropicKey"))).toBe(KEY);
  expect(toServer).toEqual([]);
  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Scan for names…" }).click();
  await expect(d.getByRole("button", { name: "Read with Claude" })).toBeVisible();
  await d.getByRole("button", { name: "Cancel" }).click();
  await page.goto("index.html#/account");
  await card.getByRole("button", { name: "Remove key" }).click();
  await expect(card.getByRole("status")).toHaveText("No key saved in this browser.");
  expect(await page.evaluate(() => localStorage.getItem("chronicle.anthropicKey"))).toBe(null);
  expectNoErrors(errors);
});

test("Quick label: each click on the map asks for a name and pins it as an entry, until the GM is done", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, mapId } = await mapReady(page, browser, "Lark");
  await page.goto(`index.html#/c/${cid}/maps/${mapId}`);
  const click = async (fx, fy) => {
    await page.locator(".map-view .leaflet-container").scrollIntoViewIfNeeded();
    const box = await settledBox(page.locator(".map-view .leaflet-image-layer"));
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  };
  const quick = page.getByRole("button", { name: "Quick label" });
  await quick.click();
  await expect(quick).toHaveAttribute("aria-pressed", "true");
  await click(0.2, 0.2);
  const name = page.getByLabel("Name of this place");
  await expect(name).toBeFocused();
  await name.fill("Ravenhold");
  await expect(page.locator(".map-label-form")).toContainText("A new Location in the Encyclopedia");
  await name.press("Enter");
  await expect(page.locator(".map-pin", { hasText: "Ravenhold" })).toBeVisible();
  await expect(quick).toHaveAttribute("aria-pressed", "true");   // still labelling
  await click(0.7, 0.5);
  await name.fill("mirewood");
  await expect(page.locator(".map-label-form")).toContainText("Pins the entry Mirewood");
  await page.getByRole("button", { name: "Pin it" }).click();
  await expect(page.locator(".map-pin", { hasText: "Mirewood" })).toBeVisible();
  await click(0.5, 0.8);
  await name.press("Escape");   // skips this spot
  await expect(name).toHaveCount(0);
  await quick.click();
  await expect(quick).toHaveAttribute("aria-pressed", "false");
  const map = await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json();
  expect(map.pins.map(p => p.entry.name).sort()).toEqual(["Mirewood", "Ravenhold"]);
  const enc = (await api(page, "encyclopedia", undefined, cid)).json.entries.filter(e => ["Mirewood", "Ravenhold"].includes(e.name));
  expect(enc).toHaveLength(2);   // Mirewood was reused
  expectNoErrors(errors);
});
