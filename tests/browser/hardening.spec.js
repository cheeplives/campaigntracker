// Checks from the code review's "fix soon" list: an error that isn't a database one still answers JSON, an outbound
// reply larger than its cap is refused instead of filling PHP's memory, and X-Forwarded-For is believed only from a
// trusted proxy. The last two run PHP's own functions (api/lib.php) from the command line, against a local server.
const { test, expect } = require("@playwright/test");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { person, signIn, api, approve, makeCampaign } = require("./helpers");

const ROOT = path.join(__dirname, "..", "..");
/** Run $code after api/lib.php has loaded with the test config, and return what it prints, parsed as JSON. Async, so
 * a server in this same process can answer PHP meanwhile; with no proxy, as the requests are to this machine. */
function php(code) {
  const env = { ...process.env, CHRONICLE_CONFIG: path.join(ROOT, "tests", "support", "config.test.php") };
  for (const k of Object.keys(env)) if (/_proxy$/i.test(k)) delete env[k];
  return new Promise((resolve, reject) => execFile("php", ["-r", `require 'api/lib.php'; ${code}`], { cwd: ROOT, env },
    (err, out) => err ? reject(err) : resolve(JSON.parse(out.toString()))));
}

test("an exception that isn't a database one answers JSON, not PHP's HTML error page", async ({ page, browser }) => {
  const gm = person("Tess");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Throw ${gm.id}`);
  // support/config.test.php turns on a header that throws a RuntimeException just before an action runs
  const res = await page.request.get(`api/index.php?a=campaign&cid=${cid}`, { headers: { "X-Test-Throw": "1" } });
  expect(res.status()).toBe(500);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(await res.json()).toEqual({ error: "server_error", message: "Server error" });
  // and the same request without it is fine
  expect((await api(page, "campaign", undefined, cid)).status).toBe(200);
});

test("an outbound reply larger than its cap is refused, and a small one is read", async () => {
  const big = Buffer.alloc(3_000_000, "a");
  const server = http.createServer((req, res) => {
    if (req.url === "/big") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(big); }
    else if (req.url === "/chunked") {   // no Content-Length, so only the write callback can stop it
      res.writeHead(200, { "Content-Type": "text/plain" });
      for (let i = 0; i < 30; i++) res.write(Buffer.alloc(100_000, "b"));
      res.end();
    } else { res.writeHead(200); res.end("small"); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const call = (p, max) => php(`$r = http_request('GET', '${base}${p}', ['max_bytes' => ${max}]); echo json_encode([$r['status'], strlen($r['body']), $r['error']]);`);
    expect(await call("/big", 1_000_000)).toEqual([0, 0, "Response too large"]);
    expect(await call("/chunked", 1_000_000)).toEqual([0, 0, "Response too large"]);
    expect(await call("/small", 1_000_000)).toEqual([200, 5, ""]);
    expect(await call("/big", 4_000_000)).toEqual([200, 3_000_000, ""]);
  } finally {
    server.close();
  }
});

test("X-Forwarded-For is believed only from a trusted proxy, and only its nearest untrusted hop", async () => {
  const ip = (remote, xff, trusted) => php(
    `$GLOBALS['__CFG']['trusted_proxies'] = ${JSON.stringify(trusted)};` +
    `$_SERVER['REMOTE_ADDR'] = '${remote}'; $_SERVER['HTTP_X_FORWARDED_FOR'] = '${xff}'; echo json_encode(client_ip());`);
  // direct hosting: the header is anyone's to send, so it's ignored
  expect(await ip("203.0.113.9", "198.51.100.1", [])).toBe("203.0.113.9");
  expect(await ip("203.0.113.9", "198.51.100.1", ["10.0.0.0/8"])).toBe("203.0.113.9");
  // behind a trusted proxy: the hop it appended, never an earlier one the visitor wrote themselves
  expect(await ip("10.1.2.3", "6.6.6.6, 198.51.100.1", ["10.0.0.0/8"])).toBe("198.51.100.1");
  // two trusted proxies in a row, IPv6 included
  expect(await ip("2001:db8::1", "198.51.100.7, 10.0.0.5", ["10.0.0.0/8", "2001:db8::/32"])).toBe("198.51.100.7");
  // a proxy that passes nothing usable leaves its own address
  expect(await ip("10.1.2.3", "not-an-ip", ["10.0.0.0/8"])).toBe("10.1.2.3");
  expect(await ip("10.1.2.3", "", ["10.1.2.3"])).toBe("10.1.2.3");
});
