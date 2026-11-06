/*
 * The theme, chosen before the first paint.
 *
 * `useTheme` (src/commons/lib/theme.ts) decides it in React, and React runs only once the bundle has
 * downloaded and parsed: seconds on a cold load from a Pi. Until then the page wore whatever
 * `index.html` said, so somebody on the light theme watched it flash dark on every load. This runs
 * first, from <head>, and gives the same answer theme.ts does: the theme the person chose, else the
 * system's, else dark. It saves nothing; only the toggle does.
 *
 * A file, not an inline script, because the dashboard's CSP is `script-src 'self'`. Plain ES5 that
 * the bundler never sees, so it stays this size; tests/theme.test.ts holds it to theme.ts's answer.
 */
(function () {
  var theme = "dark";
  var chosen = null;
  try {
    chosen = localStorage.getItem("nouride-theme-choice");
  } catch (e) {
    // Storage can throw in a locked-down browser. Then there is no choice to read, and the system decides.
  }
  if (chosen === "light" || chosen === "dark") theme = chosen;
  else {
    try {
      if (matchMedia("(prefers-color-scheme: light)").matches) theme = "light";
    } catch (e) {
      // No way to ask the system: dark, as in theme.ts.
    }
  }
  document.documentElement.setAttribute("data-theme", theme === "light" ? "nouride-light" : "nouride");
})();
