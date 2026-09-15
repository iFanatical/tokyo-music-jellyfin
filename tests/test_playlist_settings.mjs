import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.localStorage = { getItem: () => null };
const { api } = await import("../js/api.js");

test("rename uses playlist endpoint and sends no tracks or sharing fields", async () => {
  const calls = [];
  const client = { updatePlaylistSettings: api.updatePlaylistSettings,
    post: async (...args) => calls.push(args) };
  await api.renamePlaylist.call(client, "p", "  New name  ");
  assert.deepEqual(calls, [["/Playlists/p", undefined, { Name: "New name" }]]);
});

test("visibility-only updates preserve the name, tracks, and explicit invitations", async () => {
  for (const isPublic of [true, false]) {
    let call;
    await api.updatePlaylistSettings.call({ post: async (...args) => { call = args; } },
      "p", { isPublic, Ids: [], Users: [] });
    assert.deepEqual(call, ["/Playlists/p", undefined, { IsPublic: isPublic }]);
  }
});

test("combined edit sends only the requested fields", async () => {
  let body;
  await api.updatePlaylistSettings.call({ post: async (p, q, b) => { body = b; } },
    "p", { name: "Evening", isPublic: false });
  assert.deepEqual(body, { Name: "Evening", IsPublic: false });
});

test("invalid names/visibility and no-op edits never send writes", async () => {
  const client = { post: () => { throw new Error("Unexpected write"); } };
  for (const fields of [{ name: " " }, { name: null }, { isPublic: "false" }, { isPublic: null }]) {
    await assert.rejects(api.updatePlaylistSettings.call(client, "p", fields), /Enter|Choose/);
  }
  await api.updatePlaylistSettings.call(client, "p", {});
});

test("server permission errors propagate to the UI", async () => {
  const denied = Object.assign(new Error("forbidden"), { status: 403 });
  await assert.rejects(api.updatePlaylistSettings.call({ post: async () => { throw denied; } },
    "p", { isPublic: true }), e => e === denied);
});

test("owner/shared-editor access uses the current user's permission endpoint", async () => {
  const signal = new AbortController().signal;
  for (const CanEdit of [true, false]) {
    const calls = [];
    const result = await api.playlistAccess.call({ userId: "u", get: async (...args) => {
      calls.push(args);
      return args[0].endsWith("/Users/u") ? { CanEdit } : { OpenAccess: true };
    } }, "p", signal);
    assert.deepEqual(result, { isPublic: true, canEdit: CanEdit });
    assert.deepEqual(calls, [["/Playlists/p", undefined, signal], ["/Playlists/p/Users/u", undefined, signal]]);
  }
});

test("public viewers without an invitation are read-only", async () => {
  for (const status of [403, 404]) {
    const result = await api.playlistAccess.call({ userId: "u", get: async path => {
      if (path.endsWith("/Users/u")) throw Object.assign(new Error("no share"), { status });
      return { OpenAccess: true };
    } }, "p");
    assert.deepEqual(result, { isPublic: true, canEdit: false });
  }
});

test("missing visibility is not silently treated as private", async () => {
  await assert.rejects(api.playlistAccess.call({ userId: "u", get: async () => ({}) }, "p"), /visibility/);
});

test("network/auth errors loading permissions are not disguised as read-only access", async () => {
  for (const status of [0, 401, 500]) {
    await assert.rejects(api.playlistAccess.call({ userId: "u", get: async path => {
      if (path.endsWith("/Users/u")) throw Object.assign(new Error("load failure"), { status });
      return { OpenAccess: false };
    } }, "p"), /load failure/);
  }
});
