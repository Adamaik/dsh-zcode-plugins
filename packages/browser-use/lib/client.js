/**
 * dsh-zcode-browser-use — sidebar client.
 *
 * The agent's browser is Playwright-driven and headless. This half exists for
 * the OTHER browser: the plugin's own browser, mounted in DSH's right sidebar
 * as a real Chromium guest.
 *
 * It does not use DSH's built-in Browser tab type. That tab owns a browser with
 * a different cookie jar, so pointing it at a page behind a login only ever
 * shows the login screen. Instead this half registers its own tab type and
 * renders its own webview element, with its own persistent partition: a
 * separate process, its own cookies, no headless fingerprint, and
 * sendInputEvent for trusted input — so the agent can drive it and the user can
 * take over.
 *
 * The host half queues commands on /browser-use/own/command; this half runs
 * them against the guest and posts the outcome to /browser-use/own/result.
 *
 * The shell fetches this bundle from /plugins/dsh-zcode-browser-use/client.js
 * and runs it through window.__ModuleLoader__; it uses no other plugin.
 */
window.__ModuleLoader__.load({
  id: "dsh-zcode-browser-use",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * Services this client half needs.
     *
     * Cordis refuses to read a service property until the plugin declares it:
     * without this list the probe reported
     * `cannot get property "sidebarRightTabs" without inject`, ctx.get() returned
     * undefined, and the tab type was never registered.
     */
    const inject = ["sidebarRight", "sidebarRightTabs", "slots"];

    /** Tab type this half owns; unique across every registration. */
    const OWN_ID = "dsh-zcode-browser-use/own";

    /** Its kind, used with ctx.sidebarRight.openTab. */
    const OWN_KIND = "zcode-own-browser";

    /**
     * Workspace storage identity handed to the desktop bridge.
     *
     * The main process maps it to one session partition for the lifetime of the
     * application: the same string keeps the same cookies within a run. It does
     * NOT survive a restart — partitions are random per run, which is also true
     * of DSH's own sidebar browser.
     */
    const WORKSPACE_KEY = "zcode-browser-use";

    /** Fallback partition label, used only when no guest reservation exists yet. */
    const PARTITION = "persist:zcode-browser-use";

    const COMMAND_URL = "/browser-use/own/command";
    const RESULT_URL = "/browser-use/own/result";
    const STATUS_URL = "/browser-use/own/status";

    /** Delay before re-polling after a transport error. */
    const RETRY_MS = 1500;

    /** Delay between attempts to reach the sidebar services, and how many. */
    const REGISTER_RETRY_MS = 300;
    const REGISTER_ATTEMPTS = 120;

    /** Selector for the elements a snapshot exposes as addressable references. */
    const SNAPSHOT_SELECTOR =
      'a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],[onclick]';

    /** Upper bound on references returned by one snapshot. */
    const MAX_REFS = 300;

    /** The mounted guest, or null while no tab hosts it. */
    let guest = null;

    /** What activation managed to do; published with the status so a failure is inspectable. */
    const registration = { tabs: false, slots: false, error: null, probe: null, element: null, build: "probe-6" };

    /** Summarize one value for the diagnostics payload. */
    function describe(value) {
      if (value === undefined) return "undefined";
      if (value === null) return "null";
      return typeof value;
    }

    /**
     * Record what this client context actually offers.
     *
     * The sidebar services are provided under these names, but they are not
     * reachable as plain properties here, and reading them the wrong way yields
     * undefined, which silently skipped registration. Keep the evidence.
     */
    function probeServices(ctx) {
      const names = ["sidebarRightTabs", "sidebarRight", "slots", "layout"];
      const byName = {};
      const byProperty = {};
      for (const name of names) {
        try {
          byName[name] = describe(typeof ctx.get === "function" ? ctx.get(name) : "no-ctx-get");
        } catch (error) {
          byName[name] = "throw:" + String((error && error.message) || error);
        }
        try {
          byProperty[name] = describe(ctx[name]);
        } catch (error) {
          byProperty[name] = "throw:" + String((error && error.message) || error);
        }
      }
      let keys = [];
      try {
        keys = Object.keys(ctx).slice(0, 48);
      } catch (error) {
        keys = ["throw:" + String((error && error.message) || error)];
      }
      return { byName: byName, byProperty: byProperty, keys: keys };
    }

    /** Resolve one locator to the page script that finds the element. */
    function finderSource(locator) {
      var ref = JSON.stringify(locator.ref || "");
      var selector = JSON.stringify(locator.selector || "");
      var role = JSON.stringify(locator.role || "");
      var name = JSON.stringify(locator.name || "");
      return (
        "(function () {" +
        "  var ref = " + ref + ", selector = " + selector + ", role = " + role + ", name = " + name + ";" +
        "  if (ref) return document.querySelector('[data-dsh-ref=\"' + ref + '\"]');" +
        "  if (selector) return document.querySelector(selector);" +
        "  var wanted = name.toLowerCase(), wantedRole = role.toLowerCase();" +
        "  var nodes = document.querySelectorAll('a,button,input,select,textarea,summary,[role]');" +
        "  for (var i = 0; i < nodes.length; i += 1) {" +
        "    var el = nodes[i];" +
        "    var label = (el.getAttribute('aria-label') || el.placeholder || el.innerText || el.value || el.title || '').toString().trim();" +
        "    var elRole = (el.getAttribute('role') || el.tagName.toLowerCase());" +
        "    if (wanted && label.toLowerCase().indexOf(wanted) < 0) continue;" +
        "    if (wantedRole && elRole.toLowerCase() !== wantedRole) continue;" +
        "    return el;" +
        "  }" +
        "  return null;" +
        "})()"
      );
    }

    /** Turn a Playwright-style key name into an Electron sendInputEvent key. */
    function keyEvent(key) {
      var parts = String(key).split("+");
      var main = parts.pop();
      var modifiers = [];
      for (var i = 0; i < parts.length; i += 1) {
        var lower = parts[i].toLowerCase();
        modifiers.push(lower === "cmd" || lower === "command" ? "meta" : lower === "ctrl" ? "control" : lower);
      }
      var aliases = { Esc: "Escape", Return: "Enter", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
      var keyCode = aliases[main] || (main.length === 1 ? main : main.charAt(0).toUpperCase() + main.slice(1));
      return { keyCode: keyCode, modifiers: modifiers };
    }

    /** Run one script inside the guest and yield its JSON value. */
    function run(code) {
      return guest.element.executeJavaScript(code, true);
    }

    /** Wait until the guest stops loading, or the budget runs out. */
    function settle() {
      return new Promise((resolve) => {
        var timer = setTimeout(done, 4000);
        function done() {
          clearTimeout(timer);
          guest.element.removeEventListener("did-stop-loading", done);
          resolve();
        }
        guest.element.addEventListener("did-stop-loading", done);
        setTimeout(done, 60);
      });
    }

    /**
     * Wait until the guest is attached and has emitted its first dom-ready.
     *
     * Electron refuses loadURL/sendInputEvent/executeJavaScript before that:
     * "The WebView must be attached to the DOM and the dom-ready event emitted".
     */
    function whenReady() {
      return guest !== null && guest.ready !== undefined ? guest.ready : Promise.resolve();
    }

    /** Read the guest's identity, tolerating a guest that is not ready yet. */
    function identity() {
      try {
        identity.error = null;
        return { url: guest.element.getURL(), title: guest.element.getTitle() };
      } catch (error) {
        // Keep the raw message: swallowing it is how a real failure stayed
        // invisible for two rounds.
        identity.error = String((error && error.message) || error);
        if (registration.element !== null) registration.element.error = identity.error;
        return { url: null, title: null };
      }
    }

    /** Point the guest at a URL and wait for it. */
    async function load(url) {
      await whenReady();
      // loadURL is allowed once dom-ready fired, and unlike assigning src it
      // leaves the bootstrap lease marker in the URL untouched.
      guest.element.loadURL(url);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    /** Execute one command against the guest. */
    async function dispatch(command) {
      await whenReady();
      if (command.kind === "open") {
        if (typeof command.url === "string" && command.url) await load(command.url);
        return Object.assign({ open: true, partition: (guest && guest.partition) || PARTITION }, identity());
      }
      if (command.kind === "navigate") {
        await load(command.url);
        return Object.assign({ partition: (guest && guest.partition) || PARTITION }, identity());
      }
      if (command.kind === "snapshot") {
        return Object.assign({ partition: (guest && guest.partition) || PARTITION }, await run(
          "(function () {" +
          "  var selector = " + JSON.stringify(SNAPSHOT_SELECTOR) + ", maxRefs = " + MAX_REFS + ";" +
          "  var elements = [], index = 0;" +
          "  var nodes = document.querySelectorAll(selector);" +
          "  for (var i = 0; i < nodes.length; i += 1) {" +
          "    var el = nodes[i], rect = el.getBoundingClientRect(), style = window.getComputedStyle(el);" +
          "    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;" +
          "    if (rect.width < 1 && rect.height < 1) continue;" +
          "    index += 1;" +
          "    var ref = 'r' + index;" +
          "    el.setAttribute('data-dsh-ref', ref);" +
          "    var label = (el.getAttribute('aria-label') || el.placeholder || el.innerText || el.value || el.getAttribute('title') || '').toString().trim().replace(/\s+/g, ' ');" +
          "    var tag = el.tagName.toLowerCase();" +
          "    var entry = { ref: ref, tag: tag, role: el.getAttribute('role') || tag, name: label.slice(0, 160), disabled: el.disabled === true };" +
          "    if (el.getAttribute('type')) entry.type = el.getAttribute('type');" +
          "    if (tag === 'input' || tag === 'select' || tag === 'textarea') entry.value = typeof el.value === 'string' ? el.value.slice(0, 80) : '';" +
          "    elements.push(entry);" +
          "    if (elements.length >= maxRefs) break;" +
          "  }" +
          "  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 4000), elements: elements };" +
          "})()",
        ));
      }
      if (command.kind === "click") {
        const box = await run(
          "(function () { var el = " + finderSource(command) + ";" +
          " if (!el) return null;" +
          " el.scrollIntoView({ block: 'center', inline: 'center' });" +
          " var r = el.getBoundingClientRect();" +
          " return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
        );
        if (box === null || box === undefined) throw new Error("找不到要点击的元素");
        guest.element.focus();
        guest.element.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
        guest.element.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
        await settle();
        return Object.assign({ clicked: true, at: box, partition: (guest && guest.partition) || PARTITION }, identity());
      }
      if (command.kind === "type") {
        const focused = await run(
          "(function () { var el = " + finderSource(command) + ";" +
          " if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()",
        );
        if (focused !== true) throw new Error("找不到要输入的输入框");
        guest.element.focus();
        for (const char of String(command.text)) guest.element.sendInputEvent({ type: "char", keyCode: char });
        if (command.submit === true) {
          guest.element.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          guest.element.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        }
        await settle();
        return Object.assign({ typed: true, partition: (guest && guest.partition) || PARTITION }, identity());
      }
      if (command.kind === "press") {
        const key = keyEvent(command.key);
        guest.element.focus();
        guest.element.sendInputEvent({ type: "keyDown", keyCode: key.keyCode, modifiers: key.modifiers });
        guest.element.sendInputEvent({ type: "keyUp", keyCode: key.keyCode, modifiers: key.modifiers });
        await settle();
        return Object.assign({ pressed: true, partition: (guest && guest.partition) || PARTITION }, identity());
      }
      if (command.kind === "screenshot") {
        const image = await guest.element.capturePage();
        const dataUrl = image.toDataURL();
        return Object.assign({ base64: String(dataUrl).split(",")[1] || "" }, identity());
      }
      throw new Error("unknown own-browser command: " + String(command.kind));
    }

    /** Report the guest's state to the host half. */
    function report() {
      if (guest === null) {
        return fetch(STATUS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ open: false, registration: registration }),
          cache: "no-store",
        }).catch(() => undefined);
      }
      const id = identity();
      return fetch(STATUS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ open: true, partition: (guest && guest.partition) || PARTITION, url: id.url, title: id.title, registration: registration, identityError: identity.error || null }),
        cache: "no-store",
      }).catch(() => undefined);
    }

    /** The tab body: one guest, owned by this plugin. */
    function OwnBrowserBody(props) {
      const react = require("react");
      const host = react.useRef(null);
      react.useEffect(() => {
        let disposed = false;
        let mounted = null;
        const mount = async () => {
          const bridge = window.dshDesktop && window.dshDesktop.browser;
          if (bridge === undefined || typeof bridge.acquire !== "function") {
            registration.element = { error: "dshDesktop.browser bridge unavailable" };
            report();
            return;
          }
          let reservation;
          try {
            // The main process issues the lease and hardens the session. A guest
            // attaches only when its src carries that lease id — a plugin-made
            // webview without one is refused and never gets a guest at all.
            reservation = await bridge.acquire(WORKSPACE_KEY);
          } catch (error) {
            registration.element = { error: String((error && error.message) || error) };
            report();
            return;
          }
          if (disposed) {
            await bridge.release(reservation.lease).catch(() => undefined);
            return;
          }
          const element = document.createElement("webview");
          // Exactly the attributes the main process checks at will-attach-webview.
          element.dataset.sidebarBrowserFrame = "webview";
          element.setAttribute("name", reservation.lease);
          element.setAttribute("partition", reservation.partition);
          element.setAttribute("allowpopups", "");
          element.setAttribute("src", "about:blank#" + reservation.lease);
          element.style.width = "100%";
          element.style.height = "100%";
          element.style.display = "flex";
          host.current.appendChild(element);
          registration.element = {
            tag: element.tagName,
            isConnected: element.isConnected === true,
            hasLoadURL: typeof element.loadURL,
            hasGetURL: typeof element.getURL,
            hasSendInputEvent: typeof element.sendInputEvent,
            hasCapturePage: typeof element.capturePage,
            partition: reservation.partition,
            lease: reservation.lease,
            domReady: false,
            error: null,
          };
          mounted = {
            element: element,
            ready: null,
            lease: reservation.lease,
            bridge: bridge,
            partition: reservation.partition,
          };
          mounted.ready = new Promise((resolve) => {
            const done = () => {
              element.removeEventListener("dom-ready", done);
              if (registration.element !== null) registration.element.domReady = true;
              resolve();
            };
            element.addEventListener("dom-ready", done, { once: true });
            // Never leave the command queue waiting on an event that already fired.
            setTimeout(done, 5000);
          });
          guest = mounted;
          element.addEventListener("did-navigate", report);
          element.addEventListener("did-navigate-in-page", report);
          report();
        };
        mount().catch((error) => {
          registration.element = { error: String((error && error.message) || error) };
          report();
        });
        return () => {
          disposed = true;
          const current = mounted;
          if (guest === current) guest = null;
          if (current !== null) {
            current.element.remove();
            if (typeof current.bridge.release === "function") {
              current.bridge.release(current.lease).catch(() => undefined);
            }
          }
          report();
        };
      }, []);
      return react.createElement("div", {
        ref: host,
        style: { width: "100%", height: "100%", display: "flex", background: "#fff" },
      });
    }

    /**
     * Resolve one service by name.
     *
     * Plain property access yields undefined on the client context, and the
     * sidebar services may not be provided yet when this plugin activates, so
     * every lookup goes by name and callers retry.
     */
    function service(ctx, name) {
      if (typeof ctx.get === "function") {
        try {
          const found = ctx.get(name);
          if (found !== undefined) return found;
        } catch (error) {
          // fall through to the property form
        }
      }
      return ctx[name];
    }

    /** Register the tab type once the registry exists. Never throws. */
    function ensureTabType(ctx) {
      if (registration.tabs === true) return true;
      const tabs = service(ctx, "sidebarRightTabs");
      if (tabs === undefined) return false;
      try {
        ctx.effect(
          () => tabs.register({
            id: OWN_ID,
            kind: OWN_KIND,
            title: () => "自有浏览器",
            keepMounted: true,
          }),
          "dsh-zcode-browser-use: own browser tab type",
        );
        registration.tabs = true;
        return true;
      } catch (error) {
        registration.error = String((error && error.message) || error);
        console.error("[browser-use] tab type not registered:", error);
        return false;
      }
    }

    /** Contribute the tab body once the slot registry exists. Never throws. */
    function ensureTabBody(ctx) {
      if (registration.slots === true) return true;
      const slots = service(ctx, "slots");
      if (slots === undefined) return false;
      // The body has to be contributed from inside the slot's own scope. A bare
      // slots.register for a slot this scope does not own throws, and a throwing
      // client entry fails the whole web boot. Prefer inject, fall back to a
      // direct register.
      const contribute = () => slots.register(
        { name: "sidebar.right.pane.tab", key: OWN_ID },
        OwnBrowserBody,
      );
      try {
        ctx.effect(
          () => (typeof slots.inject === "function"
            ? slots.inject("sidebar.right.pane.tab", contribute)
            : contribute()),
          "dsh-zcode-browser-use: own browser body",
        );
        registration.slots = true;
        return true;
      } catch (error) {
        registration.error = String((error && error.message) || error);
        console.error("[browser-use] tab body not contributed:", error);
        return false;
      }
    }

    /**
     * Register the tab type and its body, retrying while the sidebar services
     * are still being provided.
     *
     * Activation order is not guaranteed — the sidebar package provides these
     * services itself, and this plugin may well activate first. One attempt and
     * a silent skip is what left the tab type missing.
     *
     * @param ctx - the client plugin context.
     * @param attempt - tries left before giving up and reporting.
     */
    function registerTab(ctx, attempt) {
      if (registration.tabs !== true || registration.slots !== true) registration.probe = probeServices(ctx);
      const typed = ensureTabType(ctx);
      const bodied = ensureTabBody(ctx);
      if (typed && bodied) {
        registration.error = null;
        report();
        return;
      }
      if (attempt <= 1) {
        report();
        return;
      }
      setTimeout(() => registerTab(ctx, attempt - 1), REGISTER_RETRY_MS);
    }

    /** Open (or focus) the plugin's own browser tab. */
    function openOwnTab(ctx, url) {
      const sidebar = ctx.get("sidebarRight");
      if (sidebar === undefined) throw new Error("右侧栏不可用，无法打开自有浏览器");
      sidebar.openTab(OWN_KIND, {
        params: url ? { url: url } : {},
        revealIfOpened: true,
      });
    }

    /** Poll for commands until the plugin unloads. */
    function startCommandLoop(ctx) {
      let stopped = false;
      const sendResult = async (id, payload) => {
        await fetch(RESULT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.assign({ id: id }, payload)),
          cache: "no-store",
        }).catch(() => undefined);
      };
      const loop = async () => {
        if (stopped) return;
        let command = null;
        try {
          const res = await fetch(COMMAND_URL, { method: "GET", cache: "no-store" });
          if (res.ok) {
            const body = await res.json();
            command = body ? body.command : null;
          }
        } catch (error) {
          command = null;
        }
        if (command) {
          if (command.kind === "open") {
            try {
              openOwnTab(ctx, typeof command.url === "string" ? command.url : undefined);
              await new Promise((resolve) => setTimeout(resolve, 600));
              if (guest === null) {
                await sendResult(command.id, { ok: false, error: "自有浏览器标签页没有挂载" });
              } else {
                const value = await dispatch(command);
                await sendResult(command.id, Object.assign({ ok: true }, value));
              }
            } catch (error) {
              await sendResult(command.id, { ok: false, error: String((error && error.message) || error) });
            }
          } else if (guest === null) {
            await sendResult(command.id, { ok: false, error: "自有浏览器还没打开，先调用 own_browser_open" });
          } else {
            try {
              const value = await dispatch(command);
              await sendResult(command.id, Object.assign({ ok: true }, value));
            } catch (error) {
              await sendResult(command.id, { ok: false, error: String((error && error.message) || error) });
            }
          }
          await report();
        } else {
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
        if (!stopped) loop().catch(() => undefined);
      };
      ctx.effect(
        () => {
          loop().catch((error) => {
            console.error("[browser-use] own browser command loop stopped:", error);
          });
          return () => {
            stopped = true;
          };
        },
        "dsh-zcode-browser-use: own browser commands",
      );
    }

    /**
     * Register the plugin's own sidebar browser and start serving commands.
     * @param ctx - the client plugin context providing sidebarRight and slots.
     */
    function apply(ctx) {
      // A client entry that throws fails the whole web boot. Nothing in here may
      // escape: worst case the sidebar tab is missing, never the application.
      try {
        registerTab(ctx, REGISTER_ATTEMPTS);
      } catch (error) {
        console.error("[browser-use] own browser tab type not registered:", error);
        report();
      }
      try {
        startCommandLoop(ctx);
      } catch (error) {
        console.error("[browser-use] own browser command loop not started:", error);
      }
      // Report at activation: otherwise a registration failure is only visible
      // after a guest mounts, which is exactly the case that never happens.
      report();
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
