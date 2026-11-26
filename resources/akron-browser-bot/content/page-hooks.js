// Runs in the PAGE'S main world (declared with "world": "MAIN" in the manifest).
// Hooks console + fetch/XHR so Akron can read what the page actually logged
// and requested. Communicates with content/agent-overlay.js via window.postMessage.

(() => {
  if (window.__autobotHooks) return;
  window.__autobotHooks = true;

  const MAX = 400;
  const logs = [];
  const net = [];

  const push = (arr, item) => {
    arr.push(item);
    if (arr.length > MAX) arr.shift();
  };

  const now = () => Date.now();

  const fmt = (args) =>
    args
      .map((a) => {
        try {
          if (typeof a === "string") return a;
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === "object" && a !== null) return JSON.stringify(a);
          return String(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level];
    if (typeof orig !== "function") continue;
    console[level] = function (...args) {
      try {
        push(logs, { level, text: fmt(args).slice(0, 2000), ts: now() });
      } catch {}
      return orig.apply(this, args);
    };
  }

  window.addEventListener("error", (e) => {
    push(logs, {
      level: "error",
      text: `${e.message || "Error"} (${e.filename || ""}:${e.lineno || 0})`,
      ts: now(),
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    push(logs, {
      level: "error",
      text: "Unhandled rejection: " + String(e.reason),
      ts: now(),
    });
  });

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : (input && input.url) || String(input);
      const method =
        (init && init.method) || (input && input.method) || "GET";
      const start = now();
      return origFetch
        .call(this, input, init)
        .then((res) => {
          push(net, {
            url: String(url),
            method: String(method).toUpperCase(),
            status: res.status,
            ms: now() - start,
            ts: start,
          });
          return res;
        })
        .catch((err) => {
          push(net, {
            url: String(url),
            method: String(method).toUpperCase(),
            status: 0,
            error: String(err),
            ms: now() - start,
            ts: start,
          });
          throw err;
        });
    };
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__autobotReq = {
      method: String(method || "GET").toUpperCase(),
      url: String(url || ""),
    };
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const start = now();
    this.addEventListener("loadend", () => {
      const r = this.__autobotReq || {};
      push(net, {
        url: r.url,
        method: r.method,
        status: this.status,
        ms: now() - start,
        ts: start,
      });
    });
    return XS.apply(this, args);
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__autobot_request) return;
    let payload = null;
    if (d.__autobot_request === "console") payload = logs.slice(-150);
    else if (d.__autobot_request === "network") payload = net.slice(-150);
    try {
      window.postMessage({ __autobot_reply: d.__autobot_reqid, payload }, "*");
    } catch {}
  });
})();
