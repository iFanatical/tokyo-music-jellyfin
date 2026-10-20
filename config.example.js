/* Optional deployment settings. Copy to config.js (gitignored) and edit.
   Loaded as a plain script before the app, so it may contain logic. */

window.TOKYO_MUSIC_CONFIG = {
  // Pre-filled Jellyfin address on the sign-in screen when nothing is saved.
  // "{hostname}" expands to the hostname this page was loaded from.
  // Example: a public copy on :444 whose Jellyfin is on standard HTTPS.
  defaultServer: location.port === "444" ? "https://{hostname}" : null,
};
