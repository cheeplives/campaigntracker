// The visual lexicon (AGENTS.md, Buttons): buttons and boxes side by side in one row are the same height, and every
// button is set in Spectral. This walks the main pages and fails on any row of controls that mixes sizes or fonts.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, makeCampaign } = require("./helpers");

test("every row of buttons and boxes on the main pages is one height, its buttons all in Spectral", async ({ page, browser }) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const gm = person("Lexi");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Button sizes");
  const pages = ["#/templates", "#/", "#/account", ...["", "calendar", "events", "events/reminders", "sessions", "clocks", "economy", "economy/setup", "party", "groups",
    "characters", "holdings", "travel", "downtime", "encyclopedia", "library", "generators", "maps", "members", "settings",
    "settings/calendar", "settings/dice", "settings/encyclopedia", "settings/assistant", "settings/weather", "settings/tools"].map(p => `#/c/${cid}/${p}`)];
  const mixed = [];
  for (const p of pages) {
    await page.goto(`index.html${p}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(200);   // the page drawn after its data arrives
    mixed.push(...(await page.evaluate(where => {
      const ctl = e => e.matches("button, a.button, label.button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden])")
        && !e.matches(".tab-search-kbd");   // the Ctrl K hint in the Legend's search box is a key, not a button
      const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
      const out = [];
      for (const row of new Set([...document.querySelectorAll("button, a.button, select, input")].map(e => e.parentElement))) {
        const kids = [...row.children].filter(e => ctl(e) && shown(e));
        if (kids.length < 2) continue;
        const tops = kids.map(k => Math.round(k.getBoundingClientRect().top));
        if (Math.max(...tops) - Math.min(...tops) >= 30) continue;   // not one line
        const heights = kids.map(k => Math.round(k.getBoundingClientRect().height));
        const fonts = kids.filter(k => k.matches("button, a.button")).map(k => getComputedStyle(k).fontFamily.split(",")[0].replace(/"/g, ""));
        if (new Set(heights).size > 1 || fonts.some(f => f !== fonts[0]))
          out.push(`${where}: ${kids.map((k, i) => `"${(k.textContent || k.placeholder || k.tagName).trim().slice(0, 24)}" ${heights[i]}px`).join(", ")}`);
      }
      return out;
    }, p)));
  }
  expect(mixed, mixed.join("\n")).toEqual([]);
  expectNoErrors(errors);
});
