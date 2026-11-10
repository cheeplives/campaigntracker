// theme-init.js — applied before first paint so there's no flash of the wrong
// theme. Same pattern as Sinless: an external script (so the page can keep a
// strict CSP with no inline scripts), loaded synchronously in <head>, that sets
// data-theme (light/dark mode) from the saved choice, else the OS setting, and
// data-scheme (the colour theme picked from the top bar) from the saved choice.
(function () {
  try {
    var t = localStorage.getItem("chronicle:theme");
    if (!t) t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.setAttribute("data-scheme", localStorage.getItem("chronicle:scheme") || "parchment");
  } catch (e) { /* localStorage unavailable — default dark parchment styling still applies */ }
})();
