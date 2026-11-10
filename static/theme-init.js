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

  // The Encyclopedia portrait's fade behind an entry's head (--portrait-fade, --portrait-blur, --portrait-sat in
  // style.css) can be tried live from the browser console while a look is being settled:
  //   portraitFade({ fade: .45, blur: '1.5px', sat: .75 })   applies them now and keeps them in this browser
  //   portraitFade()                                          puts the theme's own values back
  // Only the keys given change; a number for blur is taken as pixels. Nothing here reaches other people or the server.
  var KEYS = { fade: "--portrait-fade", blur: "--portrait-blur", sat: "--portrait-sat" };
  function applyPortrait(o) {
    var root = document.documentElement.style;
    for (var k in KEYS) {
      var v = o && o[k];
      if (v === undefined || v === null || v === "") root.removeProperty(KEYS[k]);
      else root.setProperty(KEYS[k], k === "blur" && typeof v === "number" ? v + "px" : String(v));
    }
  }
  window.portraitFade = function (o) {
    try { if (o && typeof o === "object") localStorage.setItem("chronicle:portrait", JSON.stringify(o)); else localStorage.removeItem("chronicle:portrait"); } catch (e) { /* private mode: this page only */ }
    applyPortrait(o && typeof o === "object" ? o : null);
    return o && typeof o === "object" ? o : "theme values";
  };
  try { var saved = localStorage.getItem("chronicle:portrait"); if (saved) applyPortrait(JSON.parse(saved)); } catch (e) { /* a bad value: the theme's own apply */ }
})();
