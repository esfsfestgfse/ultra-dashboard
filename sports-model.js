/*
 * DASH sports data model.
 *
 * The page still owns the ticker markup and motion. This file owns the data
 * contract between providers so a provider can fail without changing the
 * visual surface.
 */
(function (root) {
  "use strict";

  const VERSION = "6.0.0";
  const CENTRAL_TZ = "America/Chicago";
  const MAX_STALE_MS = 12 * 60 * 1000;
  const MAX_STALE_LIVE_MS = 4 * 60 * 1000;
  const SOURCE_PRIORITY = {
    mlb: 100,
    nhl: 100,
    afl: 100,
    nascar: 100,
    openf1: 90,
    espn: 80,
    edge: 75,
    thesportsdb: 35,
  };

  // This is the deliberately bounded scoreboard set. The edge worker uses
  // the same family; the browser only uses it when the edge aggregate is down.
  const ESPN_BOARDS = [
    { key: "mlb", path: "baseball/mlb", label: "MLB", sport: "baseball", kind: "team", ico: "⚾" },
    { key: "nba", path: "basketball/nba", label: "NBA", sport: "basketball", kind: "team", ico: "🏀" },
    { key: "nhl", path: "hockey/nhl", label: "NHL", sport: "hockey", kind: "team", ico: "🏒" },
    { key: "nfl", path: "football/nfl", label: "NFL", sport: "football", kind: "team", ico: "🏈" },
    { key: "wnba", path: "basketball/wnba", label: "WNBA", sport: "basketball", kind: "team", ico: "🏀" },
    { key: "ncaaf", path: "football/college-football", label: "CFB", sport: "football", kind: "team", ico: "🏈" },
    { key: "ncaam", path: "basketball/mens-college-basketball", label: "CBB", sport: "basketball", kind: "team", ico: "🏀" },
    { key: "mls", path: "soccer/usa.1", label: "MLS", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "nwsl", path: "soccer/usa.w.1", label: "NWSL", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "epl", path: "soccer/eng.1", label: "EPL", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "laliga", path: "soccer/esp.1", label: "La Liga", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "seriea", path: "soccer/ita.1", label: "Serie A", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "bundesliga", path: "soccer/ger.1", label: "Bundesliga", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "ucl", path: "soccer/uefa.champions", label: "UCL", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "mex", path: "soccer/mex.1", label: "Liga MX", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "atp", path: "tennis/atp", label: "ATP", sport: "tennis", kind: "tennis", ico: "🎾" },
    { key: "wta", path: "tennis/wta", label: "WTA", sport: "tennis", kind: "tennis", ico: "🎾" },
    { key: "ufc", path: "mma/ufc", label: "UFC", sport: "combat", kind: "combat", ico: "🥊" },
    { key: "pga", path: "golf/pga", label: "PGA", sport: "golf", kind: "golf", ico: "⛳" },
  ];

  const TSDB_SPORTS = [
    { key: "soccer", sportName: "Soccer", sport: "soccer", kind: "team", ico: "⚽" },
    { key: "tennis", sportName: "Tennis", sport: "tennis", kind: "tennis", ico: "🎾" },
    { key: "cricket", sportName: "Cricket", sport: "cricket", kind: "team", ico: "🏏" },
    { key: "rugby", sportName: "Rugby", sport: "rugby", kind: "team", ico: "🏉" },
  ];

  const REGISTRY = [
    {
      id: "edge",
      label: "DASH edge aggregate",
      role: "primary aggregate",
      priority: SOURCE_PRIORITY.edge,
      endpoint: "/sports or /bundle.sports",
      freshness: "90s",
    },
    {
      id: "espn",
      label: "ESPN scoreboards",
      role: "broad primary",
      priority: SOURCE_PRIORITY.espn,
      endpoint: "site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard",
      freshness: "90s",
    },
    {
      id: "mlb",
      label: "MLB StatsAPI",
      role: "league authority",
      priority: SOURCE_PRIORITY.mlb,
      endpoint: "statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=linescore,team",
      freshness: "90s",
    },
    {
      id: "nhl",
      label: "NHL web API",
      role: "league authority",
      priority: SOURCE_PRIORITY.nhl,
      endpoint: "api-web.nhle.com/v1/score/{central-date}",
      freshness: "90s",
    },
    {
      id: "afl",
      label: "Squiggle AFL",
      role: "league authority",
      priority: SOURCE_PRIORITY.afl,
      endpoint: "api.squiggle.com.au/?q=games;year={year};live=1",
      freshness: "90s",
    },
    {
      id: "thesportsdb",
      label: "TheSportsDB livescore",
      role: "secondary international gap filler",
      priority: SOURCE_PRIORITY.thesportsdb,
      endpoint: "www.thesportsdb.com/api/v1/json/123/livescore.php?s={sport}",
      freshness: "3m",
    },
    {
      id: "nascar",
      label: "NASCAR live feed",
      role: "strict racing source",
      priority: SOURCE_PRIORITY.nascar,
      endpoint: "cf.nascar.com/live/feeds/live-feed.json",
      freshness: "12s",
    },
    {
      id: "openf1",
      label: "OpenF1",
      role: "F1 supplemental source",
      priority: SOURCE_PRIORITY.openf1,
      endpoint: "api.openf1.org/v1/{session endpoint}",
      freshness: "12s",
    },
  ];

  function asText(value, fallback) {
    const text = String(value === undefined || value === null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
    return text || (fallback || "");
  }

  function hasScore(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function numberOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function dateKey(value) {
    const date = new Date(value || "");
    if (!Number.isFinite(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: CENTRAL_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    } catch (error) {
      return date.toISOString().slice(0, 10);
    }
  }

  function cleanName(value) {
    return asText(value)
      .replace(/\s+\(.*?\)$/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function nameKey(value) {
    return cleanName(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\b(football club|football|basketball club|hockey club|fc|cf|sc|club)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function genericName(value) {
    return !cleanName(value) || /^(away|home|tbd|team\s*[12]?|unknown|participant\s*[12]?)$/i.test(cleanName(value));
  }

  function safeUrl(value, fallback) {
    try {
      const url = new URL(String(value || fallback || ""));
      if (url.protocol !== "http:" && url.protocol !== "https:") return fallback || "";
      return url.href;
    } catch (error) {
      return fallback || "";
    }
  }

  function competitorName(value) {
    if (!value) return "";
    if (value.team) return cleanName(value.team.shortDisplayName || value.team.displayName || value.team.name || value.team.abbreviation);
    if (value.athlete) return cleanName(value.athlete.displayName || value.athlete.fullName || value.athlete.shortName);
    return cleanName(value.name || value.displayName || value.abbreviation || value.strParticipant || value.strPlayer);
  }

  function competitorId(value, name) {
    if (!value) return nameKey(name);
    return asText(value.id || (value.team && value.team.id) || (value.athlete && value.athlete.id), nameKey(name));
  }

  function makeCompetitor(value, index) {
    const name = typeof value === "string" ? cleanName(value) : competitorName(value);
    const score = typeof value === "object" && value
      ? (hasScore(value.score) ? value.score : (value.linescores && value.linescores[0] && value.linescores[0].value))
      : null;
    const rank = typeof value === "object" && value
      ? (value.rank || value.order || value.position || null)
      : null;
    return {
      id: competitorId(value, name),
      name: name,
      shortName: typeof value === "object" && value
        ? cleanName((value.team && (value.team.shortDisplayName || value.team.abbreviation)) || (value.athlete && value.athlete.shortName) || name)
        : name,
      score: hasScore(score) ? String(score) : "",
      scoreValue: numberOrNull(score),
      rank: rank == null ? null : String(rank),
      participantType: typeof value === "object" && value && value.athlete ? "player" : "team",
      index: index,
    };
  }

  function statusInfo(status, fallback) {
    const type = status && status.type ? status.type : status || {};
    const state = asText(type.state || type.name || type.status || fallback).toLowerCase();
    const blob = asText(type.detail || type.shortDetail || type.description || type.displayValue || type.name || state);
    if (/postponed|cancelled|canceled|abandoned|suspended|forfeit|walkover/.test((state + " " + blob).toLowerCase())) {
      return { state: "unknown", text: blob };
    }
    if (state === "in" || state === "halftime" || /\blive\b|in progress|in-play|in play|critical/.test((state + " " + blob).toLowerCase())) {
      return { state: "live", text: blob };
    }
    if (state === "post" || /final|complete|ended|full time|finished/.test((state + " " + blob).toLowerCase())) {
      return { state: "final", text: blob };
    }
    if (state === "pre" || /scheduled|not started|upcoming/.test((state + " " + blob).toLowerCase())) {
      return { state: "scheduled", text: blob };
    }
    return { state: "unknown", text: blob };
  }

  function boardLink(board, event) {
    const links = event && Array.isArray(event.links) ? event.links : [];
    return safeUrl(links[0] && links[0].href, "https://www.espn.com/scoreboard");
  }

  function baseRecord(source, board, state, competitors, eventId, competitionId, status, event, extras) {
    const list = (competitors || []).filter(function (item) { return item && !genericName(item.name); });
    if (list.length < 2) return null;
    const meta = extras || {};
    const now = Date.now();
    const record = {
      id: source + ":" + asText(eventId || competitionId || nameKey(list.map(function (c) { return c.name; }).join("|"))),
      source: source,
      sourcePriority: SOURCE_PRIORITY[source] || SOURCE_PRIORITY.edge,
      sport: meta.sport || board.sport || "other",
      league: meta.league || board.label || "Sports",
      key: meta.key || board.key || "sports",
      ico: meta.ico || board.ico || "🎯",
      kind: meta.kind || board.kind || "team",
      state: state,
      status: asText(status || "LIVE", state === "final" ? "FINAL" : "LIVE"),
      startTime: meta.startTime || (event && (event.date || event.startDate || event.startTime)) || "",
      updatedAt: meta.updatedAt || new Date(now).toISOString(),
      eventId: asText(eventId || competitionId),
      competitionId: asText(competitionId),
      sourcePath: meta.sourcePath || (board.path ? board.path + "/scoreboard" : ""),
      link: safeUrl(meta.link || boardLink(board, event), "https://www.espn.com/scoreboard"),
      confidence: meta.confidence || (source === "thesportsdb" ? "secondary" : "authoritative"),
      competitors: list,
      metadata: Object.assign({}, meta.metadata || {}),
      stale: Boolean(meta.stale),
      staleAgeMs: Number(meta.staleAgeMs || 0),
    };
    record.away = list[0].name;
    record.home = list[1].name;
    record.aScore = list[0].score;
    record.hScore = list[1].score;
    if (record.kind === "golf") {
      record.away = asText(meta.eventName || record.league);
      record.home = list.slice(0, 5).map(function (item) {
        return (item.rank ? "T" + item.rank + " " : "") + item.name + (item.score ? " (" + item.score + ")" : "");
      }).join(" · ");
      record.aScore = "";
      record.hScore = "";
    }
    return record;
  }

  function parseESPNCompetition(event, board, competition, source, now) {
    if (!competition) return [];
    const status = statusInfo(competition.status || event.status, "");
    if (status.state === "unknown") return [];
    const rawCompetitors = Array.isArray(competition.competitors) ? competition.competitors : [];
    let ordered = rawCompetitors.slice();
    if (board.kind === "team" || board.kind === "combat" || board.kind === "tennis") {
      const home = rawCompetitors.find(function (item) { return item.homeAway === "home"; });
      const away = rawCompetitors.find(function (item) { return item.homeAway === "away"; });
      if (home && away) ordered = [away, home];
    } else {
      ordered.sort(function (a, b) {
        return Number(a.order || a.rank || a.position || 999) - Number(b.order || b.rank || b.position || 999);
      });
    }
    const competitors = ordered.map(makeCompetitor).filter(function (item) { return !genericName(item.name); });
    if (competitors.length < 2) return [];
    const live = status.state === "live";
    const final = status.state === "final";
    const scoresReady = competitors.slice(0, 2).every(function (item) { return hasScore(item.score); });
    const progressText = asText(status.text).toLowerCase();
    if ((board.kind === "team" || board.kind === "tennis") && (live || final) && !scoresReady) return [];
    if (board.kind === "golf" && (live || final)) {
      const ranked = competitors.filter(function (item) { return hasScore(item.score) || item.rank; });
      if (ranked.length < 2) return [];
    }
    if (board.kind === "combat" && live && !(/round|\b\d+[:']\d+\b|live|in progress/.test(progressText))) return [];
    if (status.state === "scheduled" && !event.date && !event.startDate) return [];
    if (status.state === "scheduled" && new Date(event.date || event.startDate).getTime() > now + 48 * 60 * 60 * 1000) return [];
    const record = baseRecord(source, board, status.state, competitors, event.id, competition.id, status.text || (live ? "LIVE" : final ? "FINAL" : "UPCOMING"), event, {
      kind: board.kind,
      sport: board.sport,
      key: board.key,
      ico: board.ico,
      league: board.label,
      startTime: competition.date || competition.startDate || event.date || event.startDate || "",
      sourcePath: board.path + "/scoreboard",
      link: boardLink(board, event),
      eventName: event.shortName || event.name || board.label,
      metadata: {
        clock: competition.status && competition.status.clock,
        period: competition.status && competition.status.period,
        venue: competition.venue && (competition.venue.fullName || competition.venue.name),
        broadcast: competition.broadcasts && competition.broadcasts[0] && competition.broadcasts[0].names,
        progress: status.text,
      },
    });
    return record ? [record] : [];
  }

  function parseESPN(data, board, source, now) {
    const records = [];
    const events = data && Array.isArray(data.events) ? data.events : [];
    events.forEach(function (event) {
      if (board.kind === "tennis" && Array.isArray(event.groupings)) {
        event.groupings.forEach(function (group) {
          (group.competitions || []).forEach(function (competition) {
            records.push.apply(records, parseESPNCompetition(event, board, competition, source, now));
          });
        });
        return;
      }
      const competition = event.competitions && event.competitions[0];
      records.push.apply(records, parseESPNCompetition(event, board, competition, source, now));
    });
    return records;
  }

  function normalizeRow(row, source, state, fallback) {
    if (!row) return null;
    const kindRaw = asText(row.kind || fallback.kind || "team").toLowerCase();
    const kind = kindRaw === "match"
      ? (String(row.sport || fallback.sport || "").toLowerCase() === "tennis" ? "tennis" : "team")
      : kindRaw;
    const names = Array.isArray(row.competitors) && row.competitors.length
      ? row.competitors.map(makeCompetitor)
      : [
        { name: cleanName(row.away), score: hasScore(row.aScore) ? String(row.aScore) : "", rank: null },
        { name: cleanName(row.home), score: hasScore(row.hScore) ? String(row.hScore) : "", rank: null },
      ].map(makeCompetitor);
    const filtered = names.filter(function (item) { return !genericName(item.name); });
    if (filtered.length < 2) return null;
    const actualState = state || asText(row.state || row.status).toLowerCase();
    const record = baseRecord(source, {
      key: row.key || fallback.key || "sports",
      path: row.espnPath || row.sourcePath || "",
      label: row.league || fallback.league || "Sports",
      sport: row.sport || fallback.sport || "other",
      kind: kind,
      ico: row.ico || fallback.ico || "🎯",
    }, actualState === "post" ? "final" : actualState, filtered, row.eventId || row.id, row.competitionId, row.status || (actualState === "final" ? "FINAL" : "LIVE"), null, {
      kind: kind,
      sport: row.sport || fallback.sport || "other",
      key: row.key || fallback.key || "sports",
      ico: row.ico || fallback.ico || "🎯",
      league: row.league || fallback.league || "Sports",
      startTime: row.startTime || row.date || "",
      sourcePath: row.sourcePath || row.espnPath || "",
      link: row.link || row.stream || "https://www.espn.com/scoreboard",
      eventName: row.eventName || row.away || row.league,
      metadata: row.metadata || {},
      stale: Boolean(row.stale),
      staleAgeMs: Number(row.staleAgeMs || 0),
    });
    return record;
  }

  function parseEdge(data, now) {
    if (!data || typeof data !== "object") return [];
    const out = [];
    ["live", "finals", "upcoming"].forEach(function (bucket) {
      const rows = Array.isArray(data[bucket]) ? data[bucket] : [];
      rows.forEach(function (row) {
        const source = asText(row && (row.source || row.sourceId), "edge").toLowerCase();
        const fallback = { key: row && row.key, label: row && row.league, sport: row && row.sport, kind: row && row.kind, ico: row && row.ico };
        const record = normalizeRow(row, source, bucket === "live" ? "live" : bucket === "finals" ? "final" : "scheduled", fallback);
        if (record) {
          record.updatedAt = row.updatedAt || data.generatedAt || new Date(now).toISOString();
          record.confidence = row.confidence || (source === "edge" ? "aggregate" : "authoritative");
          out.push(record);
        }
      });
    });
    return out;
  }

  function parseMLB(data, now) {
    const records = [];
    (data && data.dates || []).forEach(function (day) {
      (day.games || []).forEach(function (game) {
        const away = game.teams && game.teams.away;
        const home = game.teams && game.teams.home;
        const awayName = cleanName(away && away.team && (away.team.teamName || away.team.name || away.team.abbreviation));
        const homeName = cleanName(home && home.team && (home.team.teamName || home.team.name || home.team.abbreviation));
        if (genericName(awayName) || genericName(homeName)) return;
        const stateText = asText(game.status && (game.status.detailedState || game.status.abstractGameState || game.status.statusCode));
        const lower = stateText.toLowerCase();
        const state = /live|progress|warmup|manager challenge/.test(lower)
          ? "live"
          : /final|complete|game over/.test(lower)
            ? "final"
            : /scheduled|pre-game|preview|delayed/.test(lower)
              ? "scheduled" : "unknown";
        if (state === "unknown") return;
        const competitors = [
          makeCompetitor({ id: away && away.team && away.team.id, team: { name: awayName }, score: away && away.score }),
          makeCompetitor({ id: home && home.team && home.team.id, team: { name: homeName }, score: home && home.score }),
        ];
        if ((state === "live" || state === "final") && !competitors.every(function (item) { return hasScore(item.score); })) return;
        const record = baseRecord("mlb", { key: "mlb", label: "MLB", sport: "baseball", kind: "team", ico: "⚾" }, state, competitors, game.gamePk, "", stateText, null, {
          kind: "team", sport: "baseball", key: "mlb", ico: "⚾", league: "MLB",
          startTime: game.gameDate || "", sourcePath: "statsapi.mlb.com/api/v1/schedule", link: "https://www.mlb.com/scores",
          confidence: "authoritative", metadata: { inning: game.linescore && game.linescore.currentInning, detailedState: stateText },
        });
        if (record) records.push(record);
      });
    });
    return records;
  }

  function parseNHL(data, now) {
    const records = [];
    (data && data.games || []).forEach(function (game) {
      const awayName = cleanName(game.awayTeam && (game.awayTeam.name && (game.awayTeam.name.default || game.awayTeam.name) || game.awayTeam.placeName && game.awayTeam.placeName.default || game.awayTeam.abbrev));
      const homeName = cleanName(game.homeTeam && (game.homeTeam.name && (game.homeTeam.name.default || game.homeTeam.name) || game.homeTeam.placeName && game.homeTeam.placeName.default || game.homeTeam.abbrev));
      if (genericName(awayName) || genericName(homeName)) return;
      const rawState = asText(game.gameState || game.gameScheduleState || game.gameStatus);
      const state = /live|crit|critical/.test(rawState.toLowerCase()) ? "live"
        : /final|off|over|complete/.test(rawState.toLowerCase()) ? "final"
          : /scheduled|pre|fut/.test(rawState.toLowerCase()) ? "scheduled" : "unknown";
      if (state === "unknown") return;
      const competitors = [
        makeCompetitor({ id: game.awayTeam && game.awayTeam.id, team: { name: awayName }, score: game.awayTeam && game.awayTeam.score }),
        makeCompetitor({ id: game.homeTeam && game.homeTeam.id, team: { name: homeName }, score: game.homeTeam && game.homeTeam.score }),
      ];
      if ((state === "live" || state === "final") && !competitors.every(function (item) { return hasScore(item.score); })) return;
      const record = baseRecord("nhl", { key: "nhl", label: "NHL", sport: "hockey", kind: "team", ico: "🏒" }, state, competitors, game.id || game.gameId, "", rawState, null, {
        kind: "team", sport: "hockey", key: "nhl", ico: "🏒", league: "NHL",
        startTime: game.startTimeUTC || game.startTime || "", sourcePath: "api-web.nhle.com/v1/score", link: "https://www.nhl.com/scores",
        confidence: "authoritative", metadata: { period: game.periodDescriptor && game.periodDescriptor.number, gameState: rawState },
      });
      if (record) records.push(record);
    });
    return records;
  }

  function parseAFL(data, now) {
    const records = [];
    (data && data.games || []).forEach(function (game) {
      const awayName = cleanName(game.away || game.ateam);
      const homeName = cleanName(game.home || game.hteam);
      if (genericName(awayName) || genericName(homeName)) return;
      const complete = Number(game.complete);
      const awayScore = game.awayscore !== undefined ? game.awayscore : game.ascore;
      const homeScore = game.homescore !== undefined ? game.homescore : game.hscore;
      if (!Number.isFinite(complete)) return;
      const state = complete > 0 && complete < 100 ? "live" : complete >= 100 ? "final" : "scheduled";
      if ((state === "live" || state === "final") && (!hasScore(awayScore) || !hasScore(homeScore))) return;
      const competitors = [
        makeCompetitor({ team: { name: awayName }, score: awayScore }),
        makeCompetitor({ team: { name: homeName }, score: homeScore }),
      ];
      const record = baseRecord("afl", { key: "afl", label: "AFL", sport: "afl", kind: "team", ico: "🏉" }, state, competitors, game.id || game.gameid, "", state === "live" ? "LIVE" : state === "final" ? "FINAL" : "UPCOMING", null, {
        kind: "team", sport: "afl", key: "afl", ico: "🏉", league: "AFL",
        startTime: game.date || game.start || "", sourcePath: "api.squiggle.com.au/?q=games", link: "https://www.afl.com.au/fixture",
        confidence: "authoritative", metadata: { complete: complete },
      });
      if (record) records.push(record);
    });
    return records;
  }

  function tsdbLiveMarker(value) {
    const text = asText(value).toLowerCase();
    if (!text) return false;
    // Numeric-only progress is intentionally rejected; it caused false LIVE rows.
    return /\blive\b|in[ -]?play|1st half|2nd half|half[- ]?time|extra time|\bq[1-4]\b|\bot\b|\bset\s*[1-5]\b|\bperiod\s*[1-4]\b|\bround\s*\d+/.test(text);
  }

  function parseTSDB(data, definition) {
    const records = [];
    const list = data && (data.events || data.livescore);
    (Array.isArray(list) ? list : []).forEach(function (event) {
      const awayName = cleanName(event.strAwayTeam);
      const homeName = cleanName(event.strHomeTeam);
      if (genericName(awayName) || genericName(homeName)) return;
      const status = asText(event.strStatus || event.strProgress);
      if (!tsdbLiveMarker(status)) return;
      const awayScore = event.intAwayScore;
      const homeScore = event.intHomeScore;
      if (!hasScore(awayScore) || !hasScore(homeScore)) return;
      const competitors = [
        makeCompetitor({ team: { name: awayName }, score: awayScore }),
        makeCompetitor({ team: { name: homeName }, score: homeScore }),
      ];
      const record = baseRecord("thesportsdb", { key: definition.key, label: asText(event.strLeague, definition.sportName), sport: definition.sport, kind: definition.kind, ico: definition.ico }, "live", competitors, event.idEvent, "", "LIVE " + status, null, {
        kind: definition.kind, sport: definition.sport, key: definition.key, ico: definition.ico,
        league: asText(event.strLeague, definition.sportName), sourcePath: "www.thesportsdb.com/api/v1/json/123/livescore.php",
        link: "https://www.thesportsdb.com/", confidence: "secondary", metadata: { progress: status },
      });
      if (record) records.push(record);
    });
    return records;
  }

  function fromLegacyRace(game) {
    if (!game || (!game.away && !game.home)) return null;
    const key = asText(game.key).toLowerCase();
    const source = key === "nascar" ? "nascar" : "openf1";
    const label = asText(game.league, key === "nascar" ? "NASCAR" : "F1");
    const driverText = asText(game.home || game.away, label);
    const competitors = [
      makeCompetitor({ athlete: { displayName: asText(game.away, label) }, score: "" }),
      makeCompetitor({ athlete: { displayName: driverText }, score: "" }),
    ];
    const record = baseRecord(source, { key: key || source, label: label, sport: "racing", kind: "racing", ico: game.ico || "🏎️" }, "live", competitors, game.eventId || key + ":live", "", game.status || "LIVE", null, {
      kind: "racing", sport: "racing", key: key || source, ico: game.ico || "🏎️", league: label,
      link: game.link || "https://www.nascar.com/", sourcePath: source, confidence: "authoritative",
      metadata: { raw: game.home || game.away || "" },
    });
    if (record) {
      record.away = asText(game.away, label);
      record.home = driverText;
      record.aScore = "";
      record.hScore = "";
      record.staleAgeMs = 0;
    }
    return record;
  }

  function canonicalKey(record) {
    const people = (record.competitors || []).map(function (item) { return nameKey(item.name); }).filter(Boolean).sort();
    const day = dateKey(record.startTime || record.updatedAt);
    const matchup = people.join("|");
    if (record.kind === "golf") return record.kind + ":" + record.league + ":" + day;
    return record.kind + ":" + record.sport + ":" + day + ":" + matchup;
  }

  function prefer(a, b) {
    if (!b) return a;
    if (a.stale !== b.stale) return a.stale ? b : a;
    if (a.state === "live" && b.state !== "live") return a;
    if (b.state === "live" && a.state !== "live") return b;
    const ap = Number(a.sourcePriority || 0);
    const bp = Number(b.sourcePriority || 0);
    if (ap !== bp) return ap > bp ? a : b;
    return String(a.updatedAt || "") >= String(b.updatedAt || "") ? a : b;
  }

  function mergeRecords(records) {
    const map = new Map();
    (records || []).forEach(function (record) {
      if (!record || !record.competitors || record.competitors.length < 2) return;
      const key = canonicalKey(record);
      const current = map.get(key);
      const winner = prefer(record, current);
      const loser = winner === record ? current : record;
      if (winner && loser) {
        winner.metadata = Object.assign({}, loser.metadata || {}, winner.metadata || {});
        winner.sources = Array.from(new Set([].concat(loser.sources || loser.source || [], winner.sources || winner.source || [])));
      }
      if (winner) map.set(key, winner);
    });
    return Array.from(map.values());
  }

  function sourceCacheKey(sourceId) {
    return "dash:sports:v6:" + sourceId;
  }

  function readCache(sourceId, now) {
    try {
      const saved = JSON.parse(root.localStorage.getItem(sourceCacheKey(sourceId)) || "null");
      if (!saved || !Array.isArray(saved.records) || !saved.at) return null;
      const age = now - Number(saved.at);
      if (!Number.isFinite(age) || age > MAX_STALE_MS) return null;
      return {
        records: saved.records.map(function (record) {
          return Object.assign({}, record, { stale: true, staleAgeMs: age });
        }),
        at: Number(saved.at),
        age: age,
      };
    } catch (error) {
      return null;
    }
  }

  function writeCache(sourceId, records, now) {
    try {
      root.localStorage.setItem(sourceCacheKey(sourceId), JSON.stringify({ at: now, records: records }));
    } catch (error) {
      // Storage is a bonus; the in-memory current result remains valid.
    }
  }

  async function fetchJson(fetcher, url, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 7000) : null;
    try {
      const response = await fetcher(url, controller ? { signal: controller.signal, cache: "no-store" } : { cache: "no-store" });
      if (!response || !response.ok) throw new Error("HTTP " + (response && response.status || 0));
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function mapLimit(items, limit, task) {
    const output = new Array(items.length);
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          output[index] = await task(items[index], index);
        } catch (error) {
          output[index] = { error: error };
        }
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
    await Promise.all(workers);
    return output;
  }

  function report(id, started, records, ok, error, cached, now, endpoint) {
    const definition = REGISTRY.find(function (item) { return item.id === id; }) || { label: id, priority: 0, role: "source" };
    return {
      id: id,
      label: definition.label,
      role: definition.role,
      priority: definition.priority,
      endpoint: endpoint || definition.endpoint,
      ok: Boolean(ok),
      count: records.length,
      cached: Boolean(cached),
      stale: Boolean(cached),
      error: error ? asText(error.message || error, "unavailable") : "",
      checkedAt: new Date(now).toISOString(),
      latencyMs: Math.max(0, Date.now() - started),
    };
  }

  function applyCached(sourceId, reports, records, now, endpoint) {
    const cached = readCache(sourceId, now);
    if (!cached) return [];
    records.push.apply(records, cached.records.filter(function (item) {
      return item.state !== "live" || cached.age <= MAX_STALE_LIVE_MS;
    }));
    reports.push(report(sourceId, Date.now() - 1, cached.records, false, new Error("using last-good"), true, now, endpoint));
    return cached.records;
  }

  function edgeCoverage(data) {
    const statuses = Array.isArray(data && data.sources) ? data.sources : [];
    if (statuses.length) {
      return {
        rich: true,
        espn: statuses.some(function (s) { return /espn/i.test(String(s.id || s.source || "")) && s.ok !== false; }),
        mlb: statuses.some(function (s) { return String(s.id || s.source) === "mlb" && s.ok !== false; }),
        nhl: statuses.some(function (s) { return String(s.id || s.source) === "nhl" && s.ok !== false; }),
        afl: statuses.some(function (s) { return String(s.id || s.source) === "afl" && s.ok !== false; }),
        tsdb: statuses.some(function (s) { return /sportsdb/i.test(String(s.id || s.source || "")) && s.ok !== false; }),
      };
    }
    const oldOk = data && data.sourceStatus && Number(data.sourceStatus.ok) > 0;
    return { rich: false, espn: Boolean(oldOk), mlb: false, nhl: false, afl: false, tsdb: false };
  }

  async function run(options) {
    const opts = options || {};
    const now = Date.now();
    const fetcher = opts.fetcher || (root.fetch && root.fetch.bind(root));
    if (typeof fetcher !== "function") throw new Error("fetch unavailable");
    const proxy = typeof opts.proxy === "function" ? opts.proxy : function (url) { return url; };
    const records = [];
    const reports = [];
    const edgeData = opts.edge || null;
    let edge = edgeData;

    const edgeTimestamp = function (value) {
      const parsed = Date.parse(value && value.generatedAt || "");
      return Number.isFinite(parsed) ? parsed : now;
    };
    const edgeIsStale = function (value) {
      const age = Math.max(0, now - edgeTimestamp(value));
      return Boolean(value && value.stale) || age > 4 * 60 * 1000;
    };

    if (!edge && opts.workerUrl) {
      const started = Date.now();
      try {
        edge = await fetchJson(fetcher, String(opts.workerUrl).replace(/\/$/, "") + "/sports", 8000);
        const edgeRecords = parseEdge(edge, now);
        const edgeAge = Math.max(0, now - edgeTimestamp(edge));
        if (edgeIsStale(edge)) edgeRecords.forEach(function (record) { record.stale = true; record.staleAgeMs = edgeAge; });
        records.push.apply(records, edgeRecords);
        writeCache("edge", edgeRecords, edgeTimestamp(edge));
        reports.push(report("edge", started, edgeRecords, !edgeIsStale(edge), edgeIsStale(edge) ? new Error("edge snapshot stale") : null, edgeIsStale(edge), now, "/sports"));
      } catch (error) {
        applyCached("edge", reports, records, now, "/sports");
      }
    } else if (edge) {
      const started = Date.now();
      const edgeRecords = parseEdge(edge, now);
      const edgeAge = Math.max(0, now - edgeTimestamp(edge));
      if (edgeIsStale(edge)) edgeRecords.forEach(function (record) { record.stale = true; record.staleAgeMs = edgeAge; });
      if (edgeRecords.length || (edge.sourceStatus && Number(edge.sourceStatus.ok) > 0) || Array.isArray(edge.sources)) {
        records.push.apply(records, edgeRecords);
        writeCache("edge", edgeRecords, edgeTimestamp(edge));
        reports.push(report("edge", started, edgeRecords, !edgeIsStale(edge), edgeIsStale(edge) ? new Error("edge snapshot stale") : null, edgeIsStale(edge), now, "/bundle.sports"));
      } else {
        applyCached("edge", reports, records, now, "/bundle.sports");
      }
    } else {
      applyCached("edge", reports, records, now, "/sports");
    }

    const coverage = edgeIsStale(edge)
      ? { rich: false, espn: false, mlb: false, nhl: false, afl: false, tsdb: false }
      : edgeCoverage(edge);
    const directPromises = [];
    const addDirect = function (id, task) {
      directPromises.push({ id: id, task: task });
    };

    if (!edge || (!coverage.espn && !coverage.rich)) {
      addDirect("espn", async function () {
        const started = Date.now();
        const packs = await mapLimit(ESPN_BOARDS, 4, async function (board) {
          const url = "https://site.api.espn.com/apis/site/v2/sports/" + board.path + "/scoreboard";
          const data = await fetchJson(fetcher, url, 7500);
          return { board: board, data: data };
        });
        const parsed = [];
        packs.forEach(function (pack) {
          if (pack && !pack.error) parsed.push.apply(parsed, parseESPN(pack.data, pack.board, "espn", now));
        });
        return { started: started, records: parsed, endpoint: "ESPN curated scoreboard set" };
      });
    }
    if (!coverage.mlb) {
      addDirect("mlb", async function () {
        const started = Date.now();
        const data = await fetchJson(fetcher, "https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=linescore,team", 7500);
        return { started: started, records: parseMLB(data, now), endpoint: "statsapi.mlb.com/api/v1/schedule" };
      });
    }
    if (!coverage.nhl) {
      addDirect("nhl", async function () {
        const started = Date.now();
        const date = dateKey(new Date(now));
        const data = await fetchJson(fetcher, "https://api-web.nhle.com/v1/score/" + date, 7500);
        return { started: started, records: parseNHL(data, now), endpoint: "api-web.nhle.com/v1/score/" + date };
      });
    }
    if (!coverage.afl) {
      addDirect("afl", async function () {
        const started = Date.now();
        const year = new Date(now).getUTCFullYear();
        const data = await fetchJson(fetcher, "https://api.squiggle.com.au/?q=games;year=" + year + ";live=1", 7500);
        return { started: started, records: parseAFL(data, now), endpoint: "api.squiggle.com.au/?q=games;year=" + year + ";live=1" };
      });
    }
    if (!coverage.tsdb && (!edge || !coverage.rich)) {
      addDirect("thesportsdb", async function () {
        const started = Date.now();
        const packs = await mapLimit(TSDB_SPORTS, 3, async function (definition) {
          const upstream = "https://www.thesportsdb.com/api/v1/json/123/livescore.php?s=" + encodeURIComponent(definition.sportName);
          const data = await fetchJson(fetcher, proxy(upstream), 7500);
          return { definition: definition, data: data };
        });
        const parsed = [];
        packs.forEach(function (pack) {
          if (pack && !pack.error) parsed.push.apply(parsed, parseTSDB(pack.data, pack.definition));
        });
        return { started: started, records: parsed, endpoint: "TheSportsDB four-sport live set" };
      });
    }

    const results = await mapLimit(directPromises, 2, async function (item) {
      try {
        const value = await item.task();
        return { id: item.id, value: value };
      } catch (error) {
        return { id: item.id, error: error };
      }
    });
    results.forEach(function (result) {
      if (result.error || !result.value) {
        applyCached(result.id, reports, records, now);
        if (!reports.some(function (item) { return item.id === result.id; })) {
          reports.push(report(result.id, now, [], false, result.error || new Error("unavailable"), false, now));
        }
        return;
      }
      const value = result.value;
      records.push.apply(records, value.records || []);
      writeCache(result.id, value.records || [], now);
      reports.push(report(result.id, value.started || now, value.records || [], true, null, false, now, value.endpoint));
    });

    // Racing remains on its own high-frequency poller, but enters the same
    // normalized model before dedupe/rendering.
    (Array.isArray(opts.racingGames) ? opts.racingGames : []).forEach(function (game) {
      const record = fromLegacyRace(game);
      if (record) records.push(record);
    });
    if (Array.isArray(opts.racingGames) && opts.racingGames.length) {
      reports.push(report("nascar", now, opts.racingGames, true, null, false, now, "existing strict race poller"));
    }

    const merged = mergeRecords(records).filter(function (record) {
      if (record.state === "live" && record.stale && record.staleAgeMs > MAX_STALE_LIVE_MS) return false;
      return record.state === "live" || record.state === "final" || record.state === "scheduled";
    });
    const favorites = asText(opts.favorites).toLowerCase().split(",").map(function (item) { return item.trim(); }).filter(Boolean);
    const favorite = function (record) {
      const text = [record.league, record.away, record.home].join(" ").toLowerCase();
      return favorites.some(function (item) { return item.length > 1 && text.indexOf(item) !== -1; });
    };
    const sortRecords = function (left, right) {
      const favDiff = Number(favorite(right)) - Number(favorite(left));
      if (favDiff) return favDiff;
      if (left.state === "live" && right.state !== "live") return -1;
      if (right.state === "live" && left.state !== "live") return 1;
      return String(right.startTime || right.updatedAt || "").localeCompare(String(left.startTime || left.updatedAt || ""));
    };
    const today = dateKey(new Date(now));
    // Scoreboard providers often key their slate by UTC while the dashboard
    // is read in Central time. Keep the local-day finals plus the previous
    // overnight window so a 3 AM refresh does not hide last night's finals.
    const recentFinalCutoff = now - 18 * 60 * 60 * 1000;
    const live = merged.filter(function (record) { return record.state === "live"; }).sort(sortRecords).slice(0, 80);
    const finals = merged.filter(function (record) {
      if (record.state !== "final") return false;
      if (!record.startTime) return true;
      const start = new Date(record.startTime).getTime();
      return dateKey(record.startTime) === today || (Number.isFinite(start) && start >= recentFinalCutoff && start <= now);
    }).sort(sortRecords).slice(0, 120);
    const upcoming = merged.filter(function (record) {
      return record.state === "scheduled" && (favorite(record) || !record.startTime || new Date(record.startTime).getTime() < now + 36 * 60 * 60 * 1000);
    }).sort(function (left, right) {
      const favDiff = Number(favorite(right)) - Number(favorite(left));
      if (favDiff) return favDiff;
      return String(left.startTime || "").localeCompare(String(right.startTime || ""));
    }).slice(0, 40);
    const freshSources = reports.filter(function (item) { return item.ok && !item.stale; }).length;
    const staleSources = reports.filter(function (item) { return item.stale; }).length;
    const failedSources = reports.filter(function (item) { return !item.ok && !item.stale; }).length;
    return {
      version: VERSION,
      generatedAt: new Date(now).toISOString(),
      live: live,
      finals: finals,
      upcoming: upcoming,
      sources: reports.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); }),
      freshness: {
        fresh: freshSources,
        stale: staleSources,
        failed: failedSources,
        tried: reports.length,
      },
    };
  }

  root.DashSports = {
    VERSION: VERSION,
    registry: REGISTRY,
    espnBoards: ESPN_BOARDS,
    run: run,
    normalizeEdge: parseEdge,
    merge: mergeRecords,
    canonicalKey: canonicalKey,
  };
})(typeof window !== "undefined" ? window : globalThis);
