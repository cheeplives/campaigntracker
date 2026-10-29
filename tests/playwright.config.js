// Cross-browser test run for Campaign Chronicle. See tests/README.md.
//
// Same five engines/form factors as Sinless's suite, plus an iPad (Safari's
// engine, touch, no hover) because the app is meant to work fully on one. The app needs PHP and
// MySQL, so the config starts `php -S` on the repo root with
// CHRONICLE_CONFIG pointing at support/config.test.php, and support/reset-db.js
// rebuilds the test database before each run.
const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

const PORT = process.env.PORT || "8755";
// Lets offline mode and request routing reach the service worker's own fetches in Chromium, so install.spec.js can
// check the "you're offline" page. The worker only passes page loads through, so nothing else sees a difference.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

module.exports = defineConfig({
  testDir: "./browser",
  globalSetup: require.resolve("./support/reset-db.js"),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,                       // a failure is a finding, not a flake to paper over
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 13"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    { name: "ipad", use: { ...devices["iPad (gen 7)"] } },
  ],
  webServer: {
    // With PHP_ERROR_LOG set (CI does), PHP's own warnings go to that file, which the workflow checks for deprecations.
    command: `php ${process.env.PHP_ERROR_LOG ? `-d log_errors=1 -d error_log=${process.env.PHP_ERROR_LOG} ` : ""}-S 127.0.0.1:${PORT} -t ..`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    env: { ...process.env, PORT, CHRONICLE_CONFIG: path.join(__dirname, "support", "config.test.php") },
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "ignore",            // php -S logs every request there
  },
});
