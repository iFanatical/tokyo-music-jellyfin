import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.localStorage = { getItem: () => null };
const { api } = await import("../js/api.js");

test("artist search includes albums with unrelated titles and deduplicates results", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const fake = {
    artists: async () => ({ items: [{ Id: "skillet", Name: "Skillet" }] }),
    songs: async (params, passedSignal) => {
      assert.equal(passedSignal, signal);
      calls.push(params);
      return { items: params.ArtistIds ? [{ Id: "monster", Name: "Monster" }] : [] };
    },
    albums: async (params, passedSignal) => {
      assert.equal(passedSignal, signal);
      calls.push(params);
      return { items: params.AlbumArtistIds
        ? [{ Id: "debut", Name: "Skillet" }, { Id: "comatose", Name: "Comatose" }]
        : [{ Id: "debut", Name: "Skillet" }] };
    },
  };
  const result = await api.search.call(fake, "Skillet", 24, signal);
  assert.deepEqual(result.albums.map(x => x.Name), ["Skillet", "Comatose"]);
  assert.deepEqual(result.songs.map(x => x.Name), ["Monster"]);
  assert(calls.filter(x => x.ArtistIds || x.AlbumArtistIds).every(x => !x.searchTerm));
});

test("title-only searches retain direct results without extra queries", async () => {
  let count = 0;
  const fake = {
    artists: async () => ({ items: [] }),
    songs: async () => { count++; return { items: [{ Id: "song" }] }; },
    albums: async () => { count++; return { items: [{ Id: "album" }] }; },
  };
  const result = await api.search.call(fake, "Comatose");
  assert.equal(count, 2);
  assert.deepEqual(result, { songs: [{ Id: "song" }], albums: [{ Id: "album" }], artists: [] });
});

test("merged artist results respect the search limit", async () => {
  const fake = {
    artists: async () => ({ items: [{ Id: "a" }, { Id: "b" }] }),
    songs: async () => ({ items: [] }),
    albums: async (params) => {
      if (params.AlbumArtistIds) assert.equal(params.AlbumArtistIds, "a,b");
      return { items: params.AlbumArtistIds ? [{ Id: "2" }, { Id: "3" }] : [{ Id: "1" }] };
    },
  };
  assert.deepEqual((await api.search.call(fake, "artist", 2)).albums, [{ Id: "1" }, { Id: "2" }]);
});
