/**
 * dsh-zcode-browser-use — sidebar mirror (browser half).
 *
 * The agent's browser is Playwright-driven and headless. To let the user watch
 * the run, this half mirrors the page the agent is on into DSH's own right
 * sidebar: it polls `/browser-use/state` from the host half and drives the
 * built-in Browser tab type
 * (`@deepseek-ai/dsh-client-ui-sidebar-browser`) through the sidebar
 * controller, `ctx.sidebarRight.openTab('browser', { params: { url } })`.
 *
 * The tab is opened once per browser session and replaced in place on every
 * page change, so the sidebar keeps exactly one tab that follows the agent.
 * A profile without the sidebar browser keeps the tools and mirrors nothing.
 *
 * The shell fetches this bundle from /plugins/dsh-zcode-browser-use/client.js
 * and runs it through window.__ModuleLoader__; it uses no other plugin.
 */
window.__ModuleLoader__.load({
  id: "dsh-zcode-browser-use",
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const STATE_URL = "/browser-use/state";
    const POLL_MS = 900;
    const WEB_URL = /^https?:\/\//;

    /** Read the host half's page state; null when the host is unreachable. */
    async function readState() {
      try {
        const res = await fetch(STATE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          cache: "no-store",
        });
        if (!res.ok) return null;
        return await res.json();
      } catch (error) {
        return null;
      }
    }

    /** The page the agent is on, or null while no browser session is live. */
    function pageUrl(state) {
      if (!state || state.active !== true || typeof state.url !== "string") return null;
      return WEB_URL.test(state.url) ? state.url : null;
    }

    /**
     * Follow the agent's page in the right sidebar's built-in Browser tab.
     * @param ctx - the client plugin context providing the sidebarRight service.
     */
    function apply(ctx) {
      // The tab this plugin opened; null until the first mirror and whenever
      // the active tab is not a Browser tab.
      let tabId = null;
      let lastUrl = null;
      let stop = false;
      let timer = null;

      const follow = async () => {
        const sidebar = ctx.get("sidebarRight");
        const url = pageUrl(await readState());
        if (sidebar !== undefined && url !== null && url !== lastUrl) {
          try {
            const options = tabId === null ? { params: { url } } : { params: { url }, replaceTab: tabId };
            sidebar.openTab("browser", options);
            const active = sidebar.active();
            tabId = active && active.kind === "browser" && typeof active.id === "string" ? active.id : null;
            lastUrl = url;
          } catch (error) {
            // A refused address must not wedge the mirror on this URL.
            lastUrl = null;
          }
        }
        if (!stop) timer = setTimeout(follow, POLL_MS);
      };

      ctx.effect(
        () => {
          follow();
          return () => {
            stop = true;
            if (timer) clearTimeout(timer);
          };
        },
        "dsh-zcode-browser-use: sidebar browser"
      );
    }

    exports.apply = apply;
    return module.exports;
  },
});
