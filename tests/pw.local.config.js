const base = require("./playwright.config.js");
for (const p of base.projects) p.use = { ...p.use, launchOptions: { executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome" } };
module.exports = base;
