// theme-init.js — applied before first paint so there's no flash of the wrong
// theme. Same pattern as Sinless: an external script (so the page can keep a
// strict CSP with no inline scripts), loaded synchronously in <head>, that sets
// data-theme on <html> from the saved choice, else the OS setting.
(function () {
  try {
    var t = localStorage.getItem("chronicle:theme");
    if (!t) t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* localStorage unavailable — default dark styling still applies */ }
})();
