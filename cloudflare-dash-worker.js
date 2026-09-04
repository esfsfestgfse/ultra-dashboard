/**
 * Ultra Dashboard — Cloudflare edge backend v3.8
 * FULL app backend: bundle + news + sports + weather + stocks + CORS proxy + Spotify OAuth + R2 last-good cache
 *
 * Optional R2 binding: name the binding DASH_BUCKET (bucket of your choice).
 * Without it, worker still works — cache is skipped.
 *
 * Paste ALL of this into your worker → Save & Deploy
 *
 * Routes:
 *   GET  /bundle?lat=&lon=&name=
 *   GET  /news
 *   GET  /sports-live
 *   GET  /weather?lat=&lon=&name=
 *   GET  /stocks
 *   GET  /?url=https://...
 *   GET  /spotify/login
 *   GET  /spotify/callback
 *   POST /spotify/refresh
 *
 * Spotify Developer Dashboard → Redirect URI must include:
 *   https://lucky-unit-4667.tdy1990.workers.dev/spotify/callback
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const WACO = { lat: 31.5497, lon: -97.1467, name: "Waco, TX" };
const SPOTIFY_CLIENT_ID = "10cd7e3140894d0a957f3dc6ecfd62a2";
const SPOTIFY_SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

function json(data, maxAge = 30) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=" + maxAge,
      ...CORS,
    },
  });
}

function err(msg, status = 500) {
  return new Response(JSON.stringify({ error: String(msg) }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function html(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

async function fetchText(url, ms = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { "User-Agent": "ultra-dash-worker/3.2", Accept: "*/*" },
    });
    if (!r.ok) return "";
    return await r.text();
  } catch (e) {
    return "";
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, ms = 9000) {
  const t = await fetchText(url, ms);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

function stripXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const NEWS_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function normalizeTs(ts) {
  let t = Number(ts) || 0;
  if (t > 0 && t < 1e12) t *= 1000;
  return t;
}

function isFresh(ts) {
  const t = normalizeTs(ts);
  if (!t) return false;
  const age = Date.now() - t;
  return age >= -5 * 60 * 1000 && age <= NEWS_MAX_AGE_MS;
}

function parseRss(xml, src) {
  const out = [];
  const chunks = String(xml || "").split(/<item[\s>]/i).slice(1);
  for (const block of chunks.slice(0, 16)) {
    const tm = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const lm =
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) ||
      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const dm =
      block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
      block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
      block.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
    const title = stripXml(tm && tm[1]);
    if (!title || title.length < 12) continue;
    // drop archive-year titles unless current year mentioned
    if (/\b(20(15|16|17|18|19|20|21|22|23|24))\b/.test(title) && !/\b202[56]\b/.test(title))
      continue;
    const ts = Date.parse(stripXml(dm && dm[1]) || "") || 0;
    // require a real, fresh pubDate from RSS
    if (!ts || !isFresh(ts)) continue;
    out.push({
      src: src,
      title: title,
      link: stripXml(lm && lm[1]) || "https://news.google.com",
      ts: ts,
    });
  }
  return out;
}

function isSportsHeadline(title, src) {
  const t = String(title || "").toLowerCase();
  const s = String(src || "").toLowerCase();
  if (/espn/.test(s)) return true;
  return /\b(nfl|nba|mlb|nhl|mls|wnba|ufc|ncaa|pga|lpga|atp|wta|f1|nascar|motogp|indycar|premier league|la liga|serie a|bundesliga|champions league|world series|super bowl|playoffs?|touchdown|home run|grand prix|training camp|quarterback|pitcher|goalie|midfielder|striker|wide receiver|free agent|roster)\b/i.test(
    t
  );
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(function (h) {
    const k = String(h.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .slice(0, 80);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function base64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return base64url(a);
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(hash);
}

// News API keys (worker-side only)
const KEY_GNEWS = "520272ea2573a7435dde8ea284cee1a3";
const KEY_THE = "ShVRkOsLbCrVECNRIuWM2wv5vCHDmzRbFaxhPUve";
const KEY_NEWSAPI = "8ff0d63323c141d48422cccad62cf6b9";
const KEY_CURRENTS = ""; // paste Currents key here when you have one

async function softJson(url, ms) {
  try {
    return await fetchJson(url, ms || 5500);
  } catch (e) {
    return null;
  }
}

async function buildNews() {
  const jobs = [];

  // RSS — short timeout each, soft-fail
  const feeds = [
    ["BBC", "https://feeds.bbci.co.uk/news/rss.xml"],
    ["BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"],
    ["NPR", "https://feeds.npr.org/1001/rss.xml"],
    ["Guardian", "https://www.theguardian.com/world/rss"],
    ["Google", "https://news.google.com/rss/search?q=when:1d&hl=en-US&gl=US&ceid=US:en"],
    ["Google TX", "https://news.google.com/rss/search?q=Texas+when:1d&hl=en-US&gl=US&ceid=US:en"],
    ["Texas Tribune", "https://www.texastribune.org/feeds/feed.rss"],
  ];
  feeds.forEach(function (pair) {
    jobs.push(
      (async function () {
        return parseRss(await fetchText(pair[1], 5000), pair[0]);
      })()
    );
  });

  // GNews top headlines (US)
  if (KEY_GNEWS) {
    jobs.push(
      (async function () {
        const data = await softJson(
          "https://gnews.io/api/v4/top-headlines?country=us&lang=en&max=20&apikey=" +
            KEY_GNEWS,
          5500
        );
        const arts = (data && data.articles) || [];
        return arts.map(function (a) {
          return {
            src: (a.source && (a.source.name || a.source)) || "GNews",
            title: a.title || "",
            link: a.url || a.link || "https://news.google.com",
            ts: Date.parse(a.publishedAt || a.published || 0) || Date.now(),
          };
        });
      })()
    );
  }

  // TheNewsAPI top
  if (KEY_THE) {
    jobs.push(
      (async function () {
        const data = await softJson(
          "https://api.thenewsapi.com/v1/news/top?locale=us&language=en&limit=20&api_token=" +
            KEY_THE,
          5500
        );
        const arts = (data && data.data) || [];
        return arts.map(function (a) {
          return {
            src: a.source || "TheNews",
            title: a.title || "",
            link: a.url || "https://news.google.com",
            ts: Date.parse(a.published_at || a.publishedAt || 0) || Date.now(),
          };
        });
      })()
    );
  }

  // NewsAPI.org top-headlines (may fail outside localhost free tier — soft)
  if (KEY_NEWSAPI) {
    jobs.push(
      (async function () {
        const data = await softJson(
          "https://newsapi.org/v2/top-headlines?country=us&pageSize=20&apiKey=" +
            KEY_NEWSAPI,
          5500
        );
        const arts = (data && data.articles) || [];
        return arts.map(function (a) {
          return {
            src: (a.source && a.source.name) || "NewsAPI",
            title: a.title || "",
            link: a.url || "https://news.google.com",
            ts: Date.parse(a.publishedAt || 0) || Date.now(),
          };
        });
      })()
    );
  }

  // Currents (optional key)
  if (KEY_CURRENTS) {
    jobs.push(
      (async function () {
        const data = await softJson(
          "https://api.currentsapi.services/v1/latest-news?language=en&apiKey=" +
            KEY_CURRENTS,
          5500
        );
        const arts = (data && data.news) || [];
        return arts.map(function (a) {
          return {
            src: a.author || (a.source && a.source[0]) || "Currents",
            title: a.title || "",
            link: a.url || "https://news.google.com",
            ts: Date.parse(a.published || 0) || Date.now(),
          };
        });
      })()
    );
  }

  // ESPN sports headlines (for sports strip)
  const espnPaths = [
    "football/nfl/news",
    "baseball/mlb/news",
    "basketball/nba/news",
    "hockey/nhl/news",
    "soccer/eng.1/news",
    "soccer/usa.1/news",
  ];
  espnPaths.forEach(function (path) {
    jobs.push(
      (async function () {
        const data = await softJson(
          "https://site.api.espn.com/apis/site/v2/sports/" + path + "?limit=8",
          5000
        );
        const arts = (data && (data.articles || data.headlines)) || [];
        return arts.map(function (a) {
          return {
            src: "ESPN",
            title: a.headline || a.title || "",
            link:
              (a.links && a.links.web && a.links.web.href) ||
              a.link ||
              "https://www.espn.com",
            ts: Date.parse(a.published || a.lastModified || 0) || Date.now(),
          };
        });
      })()
    );
  });

  const settled = await Promise.allSettled(jobs);
  let items = [];
  settled.forEach(function (r) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      items = items.concat(r.value);
    }
  });

  items = items.filter(function (h) {
    if (!h || !h.title || String(h.title).length <= 10) return false;
    if (/cnn/i.test(String(h.src || ""))) return false; // no CNN
    return true;
  });
  items = dedupe(items);

  // Prefer fresh (36h), but NEVER return empty if we have anything
  const fresh = items.filter(function (h) {
    return isFresh(h.ts);
  });
  const pool = fresh.length >= 8 ? fresh : items;

  pool.sort(function (a, b) {
    return (b.ts || 0) - (a.ts || 0);
  });

  const sports = [];
  const main = [];
  pool.forEach(function (h) {
    if (isSportsHeadline(h.title, h.src)) sports.push(h);
    else main.push(h);
  });

  // Guarantee lanes aren't empty if the other has content
  const mainOut = main.length ? main : pool.filter(function (h) {
    return !/^espn$/i.test(h.src);
  });
  const sportsOut = sports.length ? sports : pool.filter(function (h) {
    return isSportsHeadline(h.title, h.src) || /^espn$/i.test(h.src);
  });

  return {
    main: mainOut.slice(0, 70),
    sports: sportsOut.slice(0, 50),
    sourcesOk: settled.filter(function (r) {
      return r.status === "fulfilled";
    }).length,
    sourcesTried: settled.length,
    generatedAt: new Date().toISOString(),
  };
}

const SPORT_LEAGUES = [
  { key: "mlb", path: "baseball/mlb", label: "MLB", ico: "⚾" },
  { key: "nba", path: "basketball/nba", label: "NBA", ico: "🏀" },
  { key: "nhl", path: "hockey/nhl", label: "NHL", ico: "🏒" },
  { key: "nfl", path: "football/nfl", label: "NFL", ico: "🏈" },
  { key: "wnba", path: "basketball/wnba", label: "WNBA", ico: "🏀" },
  { key: "ncaaf", path: "football/college-football", label: "CFB", ico: "🏈" },
  { key: "ncaam", path: "basketball/mens-college-basketball", label: "CBB", ico: "🏀" },
  { key: "epl", path: "soccer/eng.1", label: "EPL", ico: "⚽" },
  { key: "eng2", path: "soccer/eng.2", label: "EFL", ico: "⚽" },
  { key: "laliga", path: "soccer/esp.1", label: "La Liga", ico: "⚽" },
  { key: "seriea", path: "soccer/ita.1", label: "Serie A", ico: "⚽" },
  { key: "bundesliga", path: "soccer/ger.1", label: "Bundesliga", ico: "⚽" },
  { key: "ligue1", path: "soccer/fra.1", label: "Ligue 1", ico: "⚽" },
  { key: "mls", path: "soccer/usa.1", label: "MLS", ico: "⚽" },
  { key: "mex", path: "soccer/mex.1", label: "Liga MX", ico: "⚽" },
  { key: "ucl", path: "soccer/uefa.champions", label: "UCL", ico: "⚽" },
  { key: "uel", path: "soccer/uefa.europa", label: "UEL", ico: "⚽" },
  { key: "bra", path: "soccer/bra.1", label: "Brasileirão", ico: "⚽" },
  { key: "arg", path: "soccer/arg.1", label: "Liga Pro", ico: "⚽" },
  { key: "j1", path: "soccer/jpn.1", label: "J1", ico: "⚽" },
  { key: "kl", path: "soccer/kor.1", label: "K League", ico: "⚽" },
  { key: "saudi", path: "soccer/ksa.1", label: "Saudi PL", ico: "⚽" },
  { key: "aus", path: "soccer/aus.1", label: "A-League", ico: "⚽" },
  { key: "por", path: "soccer/por.1", label: "Liga Portugal", ico: "⚽" },
  { key: "ned", path: "soccer/ned.1", label: "Eredivisie", ico: "⚽" },
  { key: "tur", path: "soccer/tur.1", label: "Süper Lig", ico: "⚽" },
  { key: "atp", path: "tennis/atp", label: "ATP", ico: "🎾" },
  { key: "wta", path: "tennis/wta", label: "WTA", ico: "🎾" },
  { key: "pga", path: "golf/pga", label: "PGA", ico: "⛳" },
  { key: "ufc", path: "mma/ufc", label: "UFC", ico: "🥊" },
  { key: "afl", path: "australian-football/afl", label: "AFL", ico: "🏉" },
  { key: "nrl", path: "rugby-league/3", label: "NRL", ico: "🏉" },
  { key: "cfl", path: "football/cfl", label: "CFL", ico: "🏈" },
  { key: "kbo", path: "baseball/kbo", label: "KBO", ico: "⚾" },
  { key: "npb", path: "baseball/npb", label: "NPB", ico: "⚾" },
  { key: "ahl", path: "hockey/ahl", label: "AHL", ico: "🏒" },
  { key: "khl", path: "hockey/khl", label: "KHL", ico: "🏒" },
  { key: "del", path: "hockey/del", label: "DEL", ico: "🏒" },
  { key: "euroleague", path: "basketball/euroleague", label: "EuroLeague", ico: "🏀" },
  { key: "acb", path: "basketball/acb", label: "ACB", ico: "🏀" },
  { key: "cba", path: "basketball/cba", label: "CBA", ico: "🏀" },
  { key: "nwsl", path: "soccer/usa.w.1", label: "NWSL", ico: "⚽" },
  { key: "ligaarg", path: "soccer/arg.1", label: "Liga Pro", ico: "⚽" },
  { key: "libertadores", path: "soccer/conmebol.libertadores", label: "Libertadores", ico: "⚽" },
  { key: "sudamericana", path: "soccer/conmebol.sudamericana", label: "Sudamericana", ico: "⚽" },
  { key: "scotland", path: "soccer/sco.1", label: "SPL", ico: "⚽" },
  { key: "belgium", path: "soccer/bel.1", label: "Belgian Pro", ico: "⚽" },
  { key: "denmark", path: "soccer/den.1", label: "Superliga", ico: "⚽" },
  { key: "sweden", path: "soccer/swe.1", label: "Allsvenskan", ico: "⚽" },
  { key: "norway", path: "soccer/nor.1", label: "Eliteserien", ico: "⚽" },
  { key: "switzerland", path: "soccer/sui.1", label: "Swiss Super", ico: "⚽" },
  { key: "austria", path: "soccer/aut.1", label: "Austrian BL", ico: "⚽" },
  { key: "poland", path: "soccer/pol.1", label: "Ekstraklasa", ico: "⚽" },
  { key: "greece", path: "soccer/gre.1", label: "Super League", ico: "⚽" },
  { key: "india", path: "soccer/ind.1", label: "Indian SL", ico: "⚽" },
  { key: "chile", path: "soccer/chi.1", label: "Chile", ico: "⚽" },
  { key: "colombia", path: "soccer/col.1", label: "Colombia", ico: "⚽" },
  { key: "egypt", path: "soccer/egy.1", label: "Egypt PL", ico: "⚽" },
  { key: "southafrica", path: "soccer/rsa.1", label: "SA PSL", ico: "⚽" },
];

function teamName(c) {
  if (!c) return "";
  if (c.team)
    return c.team.shortDisplayName || c.team.displayName || c.team.name || c.team.abbreviation || "";
  if (c.athlete) return c.athlete.displayName || c.athlete.shortName || "";
  return c.name || c.displayName || "";
}

async function buildSportsLive() {
  const results = await Promise.all(
    SPORT_LEAGUES.map(async function (league) {
      const data = await fetchJson(
        "https://site.api.espn.com/apis/site/v2/sports/" + league.path + "/scoreboard"
      );
      return { league: league, events: (data && data.events) || [] };
    })
  );

  const live = [];
  const finals = [];

  results.forEach(function (pack) {
    const league = pack.league;
    pack.events.forEach(function (ev) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      const st = (comp.status && comp.status.type) || {};
      const state = String(st.state || "");
      const blob =
        String(st.detail || "") +
        " " +
        String(st.shortDetail || "") +
        " " +
        String(st.description || "");
      var isLive = state === "in" || state === "halftime";
      if (isLive && /postponed|cancel|suspended|abandoned/i.test(blob)) isLive = false;
      if (
        isLive &&
        /^delay/i.test(String(st.detail || "").trim()) &&
        !/\d|Q\d|period|inning|set /i.test(blob)
      )
        isLive = false;
      const isFinal = state === "post";
      if (!isLive && !isFinal) return;

      const home =
        (comp.competitors || []).find(function (c) {
          return c.homeAway === "home";
        }) || (comp.competitors || [])[1];
      const away =
        (comp.competitors || []).find(function (c) {
          return c.homeAway === "away";
        }) || (comp.competitors || [])[0];
      if (!home || !away) return;

      const aName = teamName(away);
      const hName = teamName(home);
      if (!aName || !hName) return;
      if (/^(away|home|tbd)$/i.test(aName) || /^(away|home|tbd)$/i.test(hName)) return;

      const aSc = away.score;
      const hSc = home.score;
      const hasScore = aSc != null && aSc !== "" && hSc != null && hSc !== "";
      // Live matches must have scores (0-0 kickoff is fine when state is in)
      if (isLive && !hasScore) return;

      const row = {
        league: league.label,
        key: league.key,
        ico: league.ico,
        away: aName,
        home: hName,
        aScore: hasScore ? aSc : "",
        hScore: hasScore ? hSc : "",
        aLogo: (away.team && away.team.logo) || "",
        hLogo: (home.team && home.team.logo) || "",
        status: st.shortDetail || st.detail || (isLive ? "LIVE" : "FINAL"),
        link: "https://www.espn.com",
      };
      if (isLive) live.push(row);
      else if (hasScore) finals.push(row);
    });
  });

  return {
    live: live,
    finals: finals.slice(0, 40),
    generatedAt: new Date().toISOString(),
  };
}

async function buildWeather(lat, lon, name) {
  const locName = name || "Local";
  const wx = await fetchJson(
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat +
      "&longitude=" + lon +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=3"
  );
  const WMO = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
    80: "Showers", 95: "Thunderstorm",
  };
  const cur = wx && wx.current;
  const daily = wx && wx.daily;
  const items = [];
  const link = "https://forecast.weather.gov/MapClick.php?lat=" + lat + "&lon=" + lon;
  if (cur) {
    items.push({
      src: locName,
      text: Math.round(cur.temperature_2m) + "°F · " + (WMO[cur.weather_code] || "—") +
        " · Feels " + Math.round(cur.apparent_temperature) + "°",
      link: link,
    });
    if (daily) {
      items.push({
        src: "Today",
        text: "High " + Math.round(daily.temperature_2m_max[0]) + "° / Low " +
          Math.round(daily.temperature_2m_min[0]) + "° · Wind " +
          Math.round(cur.wind_speed_10m) + " mph · Hum " + cur.relative_humidity_2m + "%",
        link: link,
      });
    }
  }

  let alerts = [];
  try {
    const al = await fetchJson("https://api.weather.gov/alerts/active?point=" + lat + "," + lon);
    alerts = ((al && al.features) || [])
      .filter(function (f) {
        const p = f.properties || {};
        const event = String(p.event || "");
        const sev = String(p.severity || "").toLowerCase();
        const status = String(p.status || "").toLowerCase();
        if (status && status !== "actual") return false;
        return /warning|watch/i.test(event) || sev === "extreme" || sev === "severe";
      })
      .slice(0, 3)
      .map(function (f) {
        const p = f.properties || {};
        return {
          event: p.event || "Alert",
          headline: String(p.headline || p.description || "").replace(/\s+/g, " ").slice(0, 100),
        };
      });
    alerts.forEach(function (a) {
      items.push({ src: "ALERT", text: a.event + ": " + a.headline, link: "https://www.weather.gov/" });
    });
  } catch (e) {}

  return {
    temp: cur ? Math.round(cur.temperature_2m) : null,
    items: items,
    alerts: alerts,
    alertCount: alerts.length,
    name: locName,
    generatedAt: new Date().toISOString(),
  };
}

async function buildStocks(symbolList) {
  const symbols = (symbolList && symbolList.length)
    ? symbolList
    : ["SPY", "QQQ", "DIA", "IWM", "VTI"];
  const parts = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = String(symbols[i] || "").trim().toUpperCase();
    if (!sym) continue;
    try {
      const data = await fetchJson(
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
          encodeURIComponent(sym) +
          "?interval=1d&range=2d",
        6000
      );
      const meta =
        data &&
        data.chart &&
        data.chart.result &&
        data.chart.result[0] &&
        data.chart.result[0].meta;
      if (!meta || meta.regularMarketPrice == null) continue;
      const price = Number(meta.regularMarketPrice);
      const prev = Number(meta.chartPreviousClose || meta.previousClose || price);
      const pct = prev ? ((price - prev) / prev) * 100 : 0;
      parts.push({
        sym: sym,
        price: +price.toFixed(2),
        pct: +pct.toFixed(2),
        dir: pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat",
      });
    } catch (e) {}
  }
  return { quotes: parts, generatedAt: new Date().toISOString() };
}

async function buildBundle(lat, lon, name, symbols) {
  const out = await Promise.all([
    buildNews(),
    buildSportsLive(),
    buildWeather(lat, lon, name),
    buildStocks(symbols),
  ]);
  return {
    news: out[0],
    sports: out[1],
    weather: out[2],
    stocks: out[3],
    generatedAt: new Date().toISOString(),
  };
}

async function cachePut(env, key, data) {
  if (!env || !env.DASH_BUCKET) return;
  try {
    await env.DASH_BUCKET.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {}
}

async function cacheGet(env, key) {
  if (!env || !env.DASH_BUCKET) return null;
  try {
    const obj = await env.DASH_BUCKET.get(key);
    if (!obj) return null;
    return await obj.json();
  } catch (e) {
    return null;
  }
}

function newsHasContent(n) {
  return n && ((n.main && n.main.length) || (n.sports && n.sports.length));
}

function spotifyRedirectUri(requestUrl) {
  return new URL(requestUrl).origin + "/spotify/callback";
}

async function handleSpotifyLogin(request) {
  const redirectUri = spotifyRedirectUri(request.url);
  const verifier = randomString(64);
  const challenge = await sha256(verifier);
  const state = randomString(16);

  const auth =
    "https://accounts.spotify.com/authorize" +
    "?client_id=" + encodeURIComponent(SPOTIFY_CLIENT_ID) +
    "&response_type=code" +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&scope=" + encodeURIComponent(SPOTIFY_SCOPES) +
    "&state=" + encodeURIComponent(state) +
    "&code_challenge_method=S256" +
    "&code_challenge=" + encodeURIComponent(challenge);

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth,
      "Set-Cookie": "sp_verifier=" + encodeURIComponent(verifier) + "; Path=/; Max-Age=600; SameSite=Lax",
    },
  });
}

async function handleSpotifyCallback(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const redirectUri = spotifyRedirectUri(request.url);

  if (error || !code) {
    return html(
      "<!doctype html><html><body style='font-family:sans-serif;background:#120a12;color:#e8d5e0;padding:24px'>" +
      "<h2>Spotify " + (error || "missing code") + "</h2><p>Close and try again.</p></body></html>"
    );
  }

  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\\s*)sp_verifier=([^;]+)/);
  const verifier = m ? decodeURIComponent(m[1]) : "";
  if (!verifier) {
    return html(
      "<!doctype html><html><body style='font-family:sans-serif;background:#120a12;color:#e8d5e0;padding:24px'>" +
      "<h2>Session expired</h2><p>Close this window and click Spotify again.</p></body></html>"
    );
  }

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  let tokenJson;
  try {
    const tr = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    tokenJson = await tr.json();
    if (!tr.ok || !tokenJson.access_token) {
      return html(
        "<!doctype html><html><body style='font-family:sans-serif;background:#120a12;color:#e8d5e0;padding:24px'>" +
        "<h2>Token exchange failed</h2><pre>" + JSON.stringify(tokenJson, null, 2) + "</pre></body></html>"
      );
    }
  } catch (e) {
    return html(
      "<!doctype html><html><body style='font-family:sans-serif;background:#120a12;color:#e8d5e0;padding:24px'>" +
      "<h2>Token error</h2><p>" + String(e) + "</p></body></html>"
    );
  }

  const payload = JSON.stringify({
    type: "spotify_token",
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token || "",
    expires_in: tokenJson.expires_in || 3600,
  });

  return html(
    "<!doctype html><html><body style='font-family:sans-serif;background:#120a12;color:#e8d5e0;padding:24px'>" +
    "<h2>Spotify linked</h2><p>You can close this window.</p>" +
    "<script>try{var data=" + payload + ";if(window.opener)window.opener.postMessage(data,'*');setTimeout(function(){window.close()},600);}catch(e){document.body.innerHTML+='<pre>'+e+'</pre>';}</script></body></html>"
  );
}

async function handleSpotifyRefresh(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return err("Bad JSON", 400);
  }
  const refresh = body && body.refresh_token;
  if (!refresh) return err("refresh_token required", 400);

  const form = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refresh,
  });

  try {
    const tr = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const tokenJson = await tr.json();
    if (!tr.ok || !tokenJson.access_token) {
      return new Response(JSON.stringify(tokenJson), {
        status: tr.status || 400,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    return json({
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token || refresh,
      expires_in: tokenJson.expires_in || 3600,
    }, 0);
  } catch (e) {
    return err(String(e), 502);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/spotify/login") return handleSpotifyLogin(request);
      if (path === "/spotify/callback") return handleSpotifyCallback(request);
      if (path === "/spotify/refresh" && request.method === "POST")
        return handleSpotifyRefresh(request);

      if (path === "/bundle") {
        const lat = parseFloat(url.searchParams.get("lat")) || WACO.lat;
        const lon = parseFloat(url.searchParams.get("lon")) || WACO.lon;
        const name = url.searchParams.get("name") || WACO.name;
        const symParam = url.searchParams.get("symbols") || "";
        const symbols = symParam
          ? symParam.split(",").map(function (s) {
              return s.trim().toUpperCase();
            }).filter(Boolean)
          : null;
        try {
          const data = await buildBundle(lat, lon, name, symbols);
          if (newsHasContent(data.news)) await cachePut(env, "bundle-latest.json", data);
          data.cached = false;
          data.r2 = !!(env && env.DASH_BUCKET);
          return json(data, 20);
        } catch (e) {
          const cached = await cacheGet(env, "bundle-latest.json");
          if (cached) {
            cached.cached = true;
            cached.cacheError = String(e && e.message ? e.message : e);
            return json(cached, 15);
          }
          throw e;
        }
      }

      if (path === "/news") {
        try {
          const data = await buildNews();
          if (newsHasContent(data)) await cachePut(env, "news-latest.json", data);
          data.cached = false;
          data.r2 = !!(env && env.DASH_BUCKET);
          return json(data, 45);
        } catch (e) {
          const cached = await cacheGet(env, "news-latest.json");
          if (cached) {
            cached.cached = true;
            return json(cached, 20);
          }
          throw e;
        }
      }

      if (path === "/sports-live") {
        try {
          const data = await buildSportsLive();
          // live-only quality: require team names
          data.live = (data.live || []).filter(function (g) {
            return g && g.away && g.home && !/^(away|home|tbd)$/i.test(g.away);
          });
          await cachePut(env, "sports-latest.json", data);
          data.cached = false;
          return json(data, 20);
        } catch (e) {
          const cached = await cacheGet(env, "sports-latest.json");
          if (cached) {
            cached.cached = true;
            return json(cached, 15);
          }
          throw e;
        }
      }

      if (path === "/weather") {
        const lat = parseFloat(url.searchParams.get("lat")) || WACO.lat;
        const lon = parseFloat(url.searchParams.get("lon")) || WACO.lon;
        const name = url.searchParams.get("name") || WACO.name;
        return json(await buildWeather(lat, lon, name), 120);
      }
      if (path === "/stocks") {
        const symParam = url.searchParams.get("symbols") || "";
        const symbols = symParam
          ? symParam.split(",").map(function (s) {
              return s.trim().toUpperCase();
            }).filter(Boolean)
          : null;
        return json(await buildStocks(symbols), 120);
      }

      const target = url.searchParams.get("url");
      if (target) {
        let dest;
        try {
          dest = new URL(target);
        } catch (e) {
          return err("Bad url", 400);
        }
        if (!/^https?:$/i.test(dest.protocol)) return err("Blocked URL", 400);
        const upstream = await fetch(dest.toString(), {
          headers: {
            "User-Agent": "ultra-dash-worker/3.8",
            Accept: request.headers.get("Accept") || "*/*",
          },
        });
        const headers = new Headers(upstream.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        headers.delete("content-encoding");
        headers.delete("content-length");
        return new Response(upstream.body, {
          status: upstream.status,
          headers: headers,
        });
      }

      return json(
        {
          ok: true,
          version: "4.2",
          r2: !!(env && env.DASH_BUCKET),
          routes: [
            "/bundle",
            "/news",
            "/sports-live",
            "/weather",
            "/stocks",
            "/spotify/login",
            "/spotify/callback",
            "/spotify/refresh",
            "/?url=",
          ],
        },
        60
      );
    } catch (e) {
      return err(e && e.message ? e.message : e);
    }
  },
};
