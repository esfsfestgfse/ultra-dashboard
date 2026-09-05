const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const storage = new Map();
const context = {
  window: {
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
  },
  globalThis: {},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync("sports-model.js", "utf8"), context);
const model = context.window.DashSports;

const edge = {
  generatedAt: new Date().toISOString(),
  sources: [
    { id: "espn", ok: true },
    { id: "mlb", ok: true },
    { id: "nhl", ok: true },
    { id: "afl", ok: true },
    { id: "thesportsdb", ok: true },
  ],
  live: [{
    source: "espn", kind: "team", sport: "baseball", key: "mlb", league: "MLB",
    away: "Detroit Tigers", home: "Cleveland Guardians", aScore: "6", hScore: "7",
    status: "LIVE", eventId: "espn-1",
  }],
  finals: [{
    source: "mlb", kind: "team", sport: "baseball", key: "mlb", league: "MLB",
    away: "Texas Rangers", home: "Houston Astros", aScore: "4", hScore: "2",
    status: "Final", eventId: "mlb-1",
  }],
  upcoming: [{
    source: "espn", kind: "team", sport: "football", key: "nfl", league: "NFL",
    away: "Dallas Cowboys", home: "New York Giants", status: "Scheduled",
    eventId: "espn-2", startTime: new Date(Date.now() + 3600000).toISOString(),
  }],
};

(async () => {
  const state = await model.run({
    edge,
    favorites: "Cowboys",
    fetcher: async () => { throw new Error("fixture should not fetch"); },
    proxy: (url) => url,
  });
  assert.strictEqual(state.live.length, 1);
  assert.strictEqual(state.finals.length, 1);
  assert.strictEqual(state.upcoming.length, 1);
  assert.strictEqual(state.live[0].source, "espn");
  assert.strictEqual(state.live[0].aScore, "6");
  assert.ok(state.sources.length >= 1);

  const oldEdge = model.normalizeEdge({
    live: [{ kind: "match", sport: "baseball", key: "mlb", league: "MLB", away: "Detroit Tigers", home: "Cleveland Guardians", aScore: "6", hScore: "7", status: "LIVE" }],
  }, Date.now())[0];
  const authority = model.normalizeEdge({
    live: [{ source: "mlb", kind: "team", sport: "baseball", key: "mlb", league: "MLB", away: "Detroit Tigers", home: "Cleveland Guardians", aScore: "6", hScore: "7", status: "LIVE", eventId: "mlb-2" }],
  }, Date.now())[0];
  const merged = model.merge([oldEdge, authority]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].source, "mlb");
  console.log("sports model fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
