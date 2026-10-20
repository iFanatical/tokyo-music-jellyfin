/* Install support: registers the service worker and keeps the browser's
   install prompt so the account menu can offer "Install app". */

let deferredPrompt = null;

export function initPwa() {
  // Service workers need a secure context (HTTPS or localhost).
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
  });
}

/** True when the browser has offered installation and it has not happened. */
export const canInstall = () => Boolean(deferredPrompt);

export async function promptInstall() {
  const prompt = deferredPrompt;
  if (!prompt) return false;
  deferredPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === "accepted";
}
