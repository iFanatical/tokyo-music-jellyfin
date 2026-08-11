/* Sign-in: server address plus either a password or Quick Connect. */

import { api, JellyfinApi } from "./api.js";
import { icons } from "./icons.js";
import { el, $, clear } from "./util.js";

const LS_LAST_SERVER = "tokyomusic.lastServer";

/** Best guess at the Jellyfin address, given where this page is served from. */
function guessServer() {
  const saved = localStorage.getItem(LS_LAST_SERVER);
  if (saved) return saved;
  if (api.server) return api.server;
  const { protocol, hostname, port } = location;
  if (protocol === "file:") return "http://localhost:8096";
  // Served from Jellyfin itself? Then the origin already is the server.
  if (port === "8096") return location.origin;
  return `${protocol}//${hostname}:8096`;
}

export function loginScreen(onSuccess) {
  const root = el("div.login-screen");

  const err = el("div.login-error", { hidden: true });
  const showErr = (msg) => {
    err.textContent = msg;
    err.hidden = false;
  };
  const hideErr = () => {
    err.hidden = true;
  };

  const serverInput = el("input", {
    type: "text",
    placeholder: "http://your-server:8096",
    value: guessServer(),
    autocomplete: "url",
    spellcheck: "false",
  });
  const userInput = el("input", {
    type: "text",
    placeholder: "Username",
    autocomplete: "username",
  });
  const passInput = el("input", {
    type: "password",
    placeholder: "Password",
    autocomplete: "current-password",
  });

  const signInBtn = el("button.login-btn", { text: "Sign in" });
  const qcBtn = el("button.login-btn.secondary", {
    html: `${icons.sparkle}<span>Use Quick Connect</span>`,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
    },
  });

  const form = el("form", { autocomplete: "on" }, [
    el("div.field", {}, [el("label", { text: "Jellyfin server" }), serverInput]),
    el("div.field", {}, [el("label", { text: "Username" }), userInput]),
    el("div.field", {}, [el("label", { text: "Password" }), passInput]),
    signInBtn,
    el("div.login-sep", { text: "or" }),
    qcBtn,
  ]);

  const card = el("div.login-card", {}, [
    el("div.login-brand", {}, [
      el("div.brand-mark", { html: icons.wave }),
      el("h1", { text: "Tokyo Music" }),
    ]),
    el("p.login-tag", { text: "A pure music client for Jellyfin" }),
    err,
    form,
  ]);
  root.append(card);

  const busy = (on, btn, label) => {
    signInBtn.disabled = on;
    qcBtn.disabled = on;
    if (btn) btn.innerHTML = on ? '<span class="spinner sm"></span>' : label;
  };

  async function applyServer() {
    const raw = serverInput.value.trim();
    if (!raw) throw new Error("Enter your Jellyfin server address.");
    const info = await JellyfinApi.publicInfo(raw).catch(() => {
      throw new Error(
        `Could not reach ${raw}. Check the address, port and that the server is running.`
      );
    });
    api.setServer(raw);
    api.serverName = info.ServerName || "";
    localStorage.setItem(LS_LAST_SERVER, api.server);
    return info;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    if (!userInput.value.trim()) return showErr("Enter your username.");
    busy(true, signInBtn, "Sign in");
    try {
      await applyServer();
      await api.loginWithPassword(userInput.value.trim(), passInput.value);
      onSuccess();
    } catch (ex) {
      showErr(
        ex.status === 401
          ? "Incorrect username or password."
          : ex.message || "Sign-in failed."
      );
      busy(false, signInBtn, "Sign in");
    }
  });

  qcBtn.addEventListener("click", async () => {
    hideErr();
    busy(true, qcBtn, `${icons.sparkle}<span>Use Quick Connect</span>`);
    let poll;
    try {
      await applyServer();
      const req = await api.quickConnectInitiate();
      if (!req?.Code) throw new Error("Quick Connect is disabled on this server.");

      clear(card);
      card.append(
        el("div.login-brand", {}, [
          el("div.brand-mark", { html: icons.wave }),
          el("h1", { text: "Quick Connect" }),
        ]),
        el("div.qc-code", {}, [
          el("div.qc-digits", { text: req.Code }),
          el("p.qc-help", {
            html:
              "In Jellyfin, open your user menu and choose <strong>Quick Connect</strong>, then enter this code.<br>Waiting for approval…",
          }),
        ]),
        el("div", { style: { marginTop: "18px" } }, [
          el("button.login-btn.secondary", {
            text: "Cancel",
            onclick: () => {
              clearInterval(poll);
              location.reload();
            },
          }),
        ])
      );

      // Jellyfin expires unapproved requests, so give up rather than poll forever.
      const deadline = Date.now() + 5 * 60 * 1000;
      poll = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(poll);
          const help = $(".qc-help", card);
          if (help)
            help.innerHTML =
              "This code expired. <strong>Reload the page</strong> to get a new one.";
          return;
        }
        try {
          const state = await api.quickConnectPoll(req.Secret);
          if (state?.Authenticated) {
            clearInterval(poll);
            await api.loginWithQuickConnect(req.Secret);
            onSuccess();
          }
        } catch {
          /* keep polling; transient errors are common while waiting */
        }
      }, 2500);
    } catch (ex) {
      clearInterval(poll);
      showErr(ex.message || "Quick Connect failed.");
      busy(false, qcBtn, `${icons.sparkle}<span>Use Quick Connect</span>`);
    }
  });

  setTimeout(() => {
    (api.server ? userInput : serverInput).focus();
  }, 60);

  return root;
}
