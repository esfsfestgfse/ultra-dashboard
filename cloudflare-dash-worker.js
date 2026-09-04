/**
 * DASH 5.1 edge backend.
 *
 * The browser receives one bounded, cached bundle. Upstream credentials stay
 * in Worker secrets; the public dashboard never receives them.
 *
 * Existing Spotify callback URI (preserved exactly):
 * https://lucky-unit-4667.tdy1990.workers.dev/spotify/callback
 *
 * Optional bindings:
 *   DASH_BUCKET       R2 bucket for a last-good bundle
 * Optional secrets:
 *   SPOTIFY_CLIENT_SECRET, GNEWS_API_KEY, THENEWS_API_KEY, NEWSAPI_KEY
 */

const VERSION = "5.1";
const APP_ORIGIN = "https://esfsfestgfse.github.io";
const WORKER_ORIGIN = "https://lucky-unit-4667.tdy1990.workers.dev";
const SPOTIFY_CLIENT_ID = "10cd2b5a4c74436f9d11c61c7f13b2c1";
const SPOTIFY_CALLBACK_URI = "https://lucky-unit-4667.tdy1990.workers.dev/spotify/callback";
const BUNDLE_CACHE_SECONDS = 30;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RSS_BYTES = 512 * 1024;
const DEFAULT_LOCATION = { lat: 32.7767, lon: -96.797, name: "Dallas, TX" };

const RSS_FEEDS = [
  ["BBC", "https://feeds.bbci.co.uk/news/rss.xml"],
  ["BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["NPR", "https://feeds.npr.org/1001/rss.xml"],
  ["Guardian", "https://www.theguardian.com/world/rss"],
  ["Texas Tribune", "https://www.texastribune.org/feeds/feed.rss"],
  ["Google News", "https://news.google.com/rss/search?q=when:1d&hl=en-US&gl=US&ceid=US:en"],
  ["Google Texas", "https://news.google.com/rss/search?q=Texas+when:1d&hl=en-US&gl=US&ceid=US:en"],
];

const ESPN_NEWS_PATHS = [
  "football/nfl/news",
  "baseball/mlb/news",
  "basketball/nba/news",
  "hockey/nhl/news",
  "soccer/eng.1/news",
  "soccer/usa.1/news",
];

const SPORT_LEAGUES = [
  { key: "nfl", path: "football/nfl", label: "NFL" },
  { key: "mlb", path: "baseball/mlb", label: "MLB" },
  { key: "nba", path: "basketball/nba", label: "NBA" },
  { key: "nhl", path: "hockey/nhl", label: "NHL" },
  { key: "wnba", path: "basketball/wnba", label: "WNBA" },
  { key: "cfb", path: "football/college-football", label: "CFB" },
  { key: "cbb", path: "basketball/mens-college-basketball", label: "CBB" },
  { key: "mls", path: "soccer/usa.1", label: "MLS" },
  { key: "epl", path: "soccer/eng.1", label: "EPL" },
  { key: "laliga", path: "soccer/esp.1", label: "La Liga" },
  { key: "ucl", path: "soccer/uefa.champions", label: "UCL" },
  { key: "nwsl", path: "soccer/usa.w.1", label: "NWSL" },
  { key: "afl", path: "australian-football/afl", label: "AFL" },
  { key: "pga", path: "golf/pga", label: "PGA" },
];

const PROXY_HOSTS = new Set([
  "feeds.bbci.co.uk",
  "feeds.npr.org",
  "www.theguardian.com",
  "www.texastribune.org",
  "news.google.com",
  "site.api.espn.com",
  "api.open-meteo.com",
  "api.weather.gov",
  "query1.finance.yahoo.com",
]);

function requestId() {
  try {
    return crypto.randomUUID();
  } catch (error) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(function (value) {
      return value.toString(16).padStart(2, "0");
    }).join("");
  }
}

function logEvent(event, data) {
  try {
    console.log(JSON.stringify(Object.assign({
      event: event,
      service: "dash-edge",
      version: VERSION,
      at: new Date().toISOString(),
    }, data || {})));
  } catch (error) {
    console.log(JSON.stringify({ event: event, service: "dash-edge", version: VERSION }));
  }
}

function corsHeaders(request, extra) {
  const headers = new Headers(extra || {});
  const origin = request.headers.get("Origin");
  if (origin === APP_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", APP_ORIGIN);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function jsonResponse(request, value, status, extra) {
  const headers = corsHeaders(request, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }, extra || {}));
  return new Response(JSON.stringify(value), { status: status || 200, headers: headers });
}

function textResponse(request, value, status, extra) {
  const headers = corsHeaders(request, Object.assign({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }, extra || {}));
  return new Response(value, { status: status || 200, headers: headers });
}

function errorResponse(request, status, code) {
  return jsonResponse(request, {
    ok: false,
    error: code || "Request unavailable",
    version: VERSION,
  }, status);
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function boundedNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return fallback;
  return number;
}

function boundedText(value, max, fallback) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text || (fallback || "");
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch (error) {
    return "";
  }
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (_, code) {
      return String.fromCodePoint(Math.min(0x10ffff, Number(code)));
    })
    .replace(/&#x([0-9a-f]+);/gi, function (_, code) {
      return String.fromCodePoint(Math.min(0x10ffff, parseInt(code, 16)));
    })
    .replace(/\s+/g, " ")
    .trim();
}

function readXmlTag(block, tag) {
  const matcher = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i");
  const match = matcher.exec(block);
  return match ? decodeEntities(match[1]) : "";
}

function parseRss(xml, source) {
  if (!xml) return [];
  const items = [];
  const matcher = /<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi;
  let match;
  while (items.length < 32 && (match = matcher.exec(xml))) {
    const block = match[0];
    const title = boundedText(readXmlTag(block, "title"), 260);
    const linkTag = readXmlTag(block, "link");
    const linkAttribute = /<link[^>]+href=["']([^"']+)["']/i.exec(block);
    const link = safeHttpUrl(linkTag || (linkAttribute && linkAttribute[1]));
    const date = readXmlTag(block, "pubDate") ||
      readXmlTag(block, "published") ||
      readXmlTag(block, "updated") ||
      readXmlTag(block, "dc:date");
    const ts = Date.parse(date || "");
    if (!title || title.length < 8 || !link) continue;
    items.push({
      src: boundedText(source, 40, "News"),
      title: title,
      link: link,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    });
  }
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(function (item) {
    const key = String(item.link || item.title || "").toLowerCase().replace(/\/$/, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isFresh(timestamp) {
  return Number.isFinite(timestamp) && timestamp > Date.now() - 36 * 60 * 60 * 1000;
}

function isSportsHeadline(title, source) {
  return /espn|sports|nfl|nba|wnba|mlb|nhl|soccer|football|baseball|hockey|golf|tennis|ufc|racing|olympic/i
    .test(String(title || "") + " " + String(source || ""));
}

async function readLimited(response, limit) {
  const maxBytes = limit || MAX_JSON_BYTES;
  const length = Number(response.headers.get("content-length") || 0);
  if (length && length > maxBytes) throw new Error("Upstream response too large");
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("Upstream response too large");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Upstream response too large");
      }
      output += decoder.decode(part.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function fetchText(url, timeoutMs, limit, requestIdValue) {
  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, timeoutMs || 7000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, application/rss+xml, application/xml, text/xml, text/plain",
        "User-Agent": "DASH/" + VERSION,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      logEvent("upstream_http_error", {
        requestId: requestIdValue,
        host: new URL(url).host,
        status: response.status,
      });
      throw new Error("Upstream HTTP error");
    }
    return await readLimited(response, limit || MAX_JSON_BYTES);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs, requestIdValue) {
  const text = await fetchText(url, timeoutMs, MAX_JSON_BYTES, requestIdValue);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Upstream JSON invalid");
  }
}

async function mapLimit(items, limit, task) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        output[index] = await task(items[index], index);
      } catch (error) {
        output[index] = null;
      }
    }
  }
  const workers = [];
  for (let index = 0; index < Math.min(limit, items.length); index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return output;
}

async function buildNews(env, requestIdValue) {
  const jobs = RSS_FEEDS.map(function (feed) {
    return fetchText(feed[1], 6500, MAX_RSS_BYTES, requestIdValue)
      .then(function (xml) {
        return parseRss(xml, feed[0]);
      });
  });

  ESPN_NEWS_PATHS.forEach(function (path) {
    jobs.push(fetchJson(
      "https://site.api.espn.com/apis/site/v2/sports/" + path + "?limit=8",
      6500,
      requestIdValue
    ).then(function (data) {
      const articles = data && (data.articles || data.headlines);
      return (Array.isArray(articles) ? articles : []).map(function (article) {
        const link = article.links && article.links.web && article.links.web.href;
        const ts = Date.parse(article.published || article.lastModified || "");
        return {
          src: "ESPN",
          title: boundedText(article.headline || article.title, 260),
          link: safeHttpUrl(link || article.link || "https://www.espn.com"),
          ts: Number.isFinite(ts) ? ts : Date.now(),
        };
      }).filter(function (article) {
        return article.title && article.link;
      });
    }));
  });

  if (env && env.GNEWS_API_KEY) {
    jobs.push(fetchJson(
      "https://gnews.io/api/v4/top-headlines?country=us&lang=en&max=20&apikey=" +
        encodeURIComponent(env.GNEWS_API_KEY),
      6500,
      requestIdValue
    ).then(function (data) {
      return (data && Array.isArray(data.articles) ? data.articles : []).map(function (article) {
        return {
          src: boundedText(article.source && article.source.name, 40, "GNews"),
          title: boundedText(article.title, 260),
          link: safeHttpUrl(article.url),
          ts: Date.parse(article.publishedAt || "") || Date.now(),
        };
      }).filter(function (article) {
        return article.title && article.link;
      });
    }));
  }

  if (env && env.THENEWS_API_KEY) {
    jobs.push(fetchJson(
      "https://api.thenewsapi.com/v1/news/top?locale=us&language=en&limit=20&api_token=" +
        encodeURIComponent(env.THENEWS_API_KEY),
      6500,
      requestIdValue
    ).then(function (data) {
      return (data && Array.isArray(data.data) ? data.data : []).map(function (article) {
        return {
          src: boundedText(article.source, 40, "TheNews"),
          title: boundedText(article.title, 260),
          link: safeHttpUrl(article.url),
          ts: Date.parse(article.published_at || "") || Date.now(),
        };
      }).filter(function (article) {
        return article.title && article.link;
      });
    }));
  }

  if (env && env.NEWSAPI_KEY) {
    jobs.push(fetchJson(
      "https://newsapi.org/v2/top-headlines?country=us&pageSize=20&apiKey=" +
        encodeURIComponent(env.NEWSAPI_KEY),
      6500,
      requestIdValue
    ).then(function (data) {
      return (data && Array.isArray(data.articles) ? data.articles : []).map(function (article) {
        return {
          src: boundedText(article.source && article.source.name, 40, "NewsAPI"),
          title: boundedText(article.title, 260),
          link: safeHttpUrl(article.url),
          ts: Date.parse(article.publishedAt || "") || Date.now(),
        };
      }).filter(function (article) {
        return article.title && article.link;
      });
    }));
  }

  const settled = await Promise.allSettled(jobs);
  let items = [];
  settled.forEach(function (result) {
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      items = items.concat(result.value);
    }
  });
  items = dedupe(items.filter(function (item) {
    return item && item.title && item.title.length > 8 && item.link;
  }));
  const fresh = items.filter(function (item) {
    return isFresh(item.ts);
  });
  const pool = (fresh.length >= 8 ? fresh : items).sort(function (a, b) {
    return (b.ts || 0) - (a.ts || 0);
  });
  const sports = pool.filter(function (item) {
    return isSportsHeadline(item.title, item.src);
  });
  const main = pool.filter(function (item) {
    return !isSportsHeadline(item.title, item.src);
  });
  return {
    main: (main.length ? main : pool).slice(0, 32),
    sports: (sports.length ? sports : pool.filter(function (item) {
      return item.src === "ESPN";
    })).slice(0, 24),
    sourcesOk: settled.filter(function (result) {
      return result.status === "fulfilled";
    }).length,
    sourcesTried: settled.length,
    generatedAt: new Date().toISOString(),
  };
}

function teamName(competitor) {
  const team = competitor && competitor.team;
  if (team) return boundedText(
    team.shortDisplayName || team.displayName || team.name || team.abbreviation,
    60
  );
  const athlete = competitor && competitor.athlete;
  if (athlete) return boundedText(athlete.displayName || athlete.shortName, 60);
  return boundedText(competitor && (competitor.name || competitor.displayName), 60);
}

async function buildSportsLive(requestIdValue) {
  const packs = await mapLimit(SPORT_LEAGUES, 5, async function (league) {
    const data = await fetchJson(
      "https://site.api.espn.com/apis/site/v2/sports/" + league.path + "/scoreboard",
      7500,
      requestIdValue
    );
    return {
      league: league,
      events: data && Array.isArray(data.events) ? data.events : [],
      ok: Boolean(data && Array.isArray(data.events)),
    };
  });
  const live = [];
  const finals = [];
  packs.filter(Boolean).forEach(function (pack) {
    pack.events.forEach(function (event) {
      const competition = event.competitions && event.competitions[0];
      if (!competition) return;
      const status = (competition.status && competition.status.type) || {};
      const state = String(status.state || "");
      const description = boundedText(
        status.detail || status.shortDetail || status.description,
        70,
        ""
      );
      let isLive = state === "in" || state === "halftime";
      if (isLive && /postponed|cancel|suspended|abandoned/i.test(description)) isLive = false;
      if (isLive && /^delay/i.test(description) && !/\d|Q\d|period|inning|set /i.test(description)) {
        isLive = false;
      }
      const isFinal = state === "post";
      if (!isLive && !isFinal) return;
      const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
      const home = competitors.find(function (item) {
        return item.homeAway === "home";
      }) || competitors[1];
      const away = competitors.find(function (item) {
        return item.homeAway === "away";
      }) || competitors[0];
      const awayName = teamName(away);
      const homeName = teamName(home);
      if (!awayName || !homeName || /^(away|home|tbd)$/i.test(awayName + " " + homeName)) return;
      const awayScore = away && away.score !== undefined ? String(away.score) : "";
      const homeScore = home && home.score !== undefined ? String(home.score) : "";
      const hasScore = awayScore !== "" && homeScore !== "";
      if (isLive && !hasScore) return;
      const eventLink = event.links && event.links[0] && event.links[0].href;
      const row = {
        league: pack.league.label,
        key: pack.league.key,
        away: awayName,
        home: homeName,
        aScore: hasScore ? awayScore : "—",
        hScore: hasScore ? homeScore : "—",
        status: description || (isLive ? "LIVE" : "FINAL"),
        link: safeHttpUrl(eventLink || "https://www.espn.com/scoreboard"),
      };
      if (isLive) live.push(row);
      else if (hasScore) finals.push(row);
    });
  });
  return {
    live: live.slice(0, 30),
    finals: finals.slice(0, 36),
    sourceStatus: {
      ok: packs.filter(function (pack) { return pack && pack.ok; }).length,
      tried: SPORT_LEAGUES.length,
    },
    generatedAt: new Date().toISOString(),
  };
}

const WMO_LABELS = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Showers",
  81: "Showers",
  82: "Heavy showers",
  95: "Thunderstorm",
  96: "Thunderstorm",
  99: "Severe thunderstorm",
};

async function buildWeather(lat, lon, name, requestIdValue) {
  const forecastUrl =
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat +
    "&longitude=" + lon +
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation" +
    "&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit" +
    "&wind_speed_unit=mph&timezone=auto&forecast_days=3";
  const forecastPromise = fetchJson(forecastUrl, 7500, requestIdValue);
  const alertsPromise = fetchJson(
    "https://api.weather.gov/alerts/active?point=" + lat + "," + lon,
    7500,
    requestIdValue
  );
  const results = await Promise.allSettled([forecastPromise, alertsPromise]);
  const forecast = results[0].status === "fulfilled" ? results[0].value : null;
  const alertData = results[1].status === "fulfilled" ? results[1].value : null;
  const current = forecast && forecast.current;
  const daily = forecast && forecast.daily;
  const weatherName = boundedText(name, 80, DEFAULT_LOCATION.name);
  const link = "https://forecast.weather.gov/MapClick.php?lat=" + lat + "&lon=" + lon;
  const items = [];
  if (current) {
    items.push({
      src: weatherName,
      text: Math.round(Number(current.temperature_2m)) + "°F · " +
        (WMO_LABELS[current.weather_code] || "Conditions") +
        " · Feels " + Math.round(Number(current.apparent_temperature)) + "°",
      link: link,
    });
    const highs = daily && Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
    const lows = daily && Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
    if (highs.length && lows.length) {
      items.push({
        src: "Today",
        text: "High " + Math.round(Number(highs[0])) + "° / Low " +
          Math.round(Number(lows[0])) + "° · Wind " +
          Math.round(Number(current.wind_speed_10m)) + " mph · Humidity " +
          Math.round(Number(current.relative_humidity_2m)) + "%",
        link: link,
      });
      for (let index = 1; index < Math.min(highs.length, 3); index += 1) {
        items.push({
          src: "Forecast",
          text: "Day " + (index + 1) + " · High " + Math.round(Number(highs[index])) +
            "° / Low " + Math.round(Number(lows[index])) + "°",
          link: link,
        });
      }
    }
  }
  const alerts = [];
  const features = alertData && Array.isArray(alertData.features) ? alertData.features : [];
  features.forEach(function (feature) {
    if (alerts.length >= 5) return;
    const properties = feature && feature.properties ? feature.properties : {};
    const event = boundedText(properties.event, 80, "Weather alert");
    const severity = boundedText(properties.severity, 30, "");
    const status = boundedText(properties.status, 30, "").toLowerCase();
    if (status && status !== "actual") return;
    if (!/warning|watch|advisory/i.test(event) && !/extreme|severe/i.test(severity)) return;
    alerts.push({
      event: event,
      headline: boundedText(properties.headline || properties.description, 180, "See weather.gov for details"),
    });
  });
  alerts.forEach(function (alert) {
    items.push({
      src: "ALERT",
      text: alert.event + ": " + alert.headline,
      link: "https://www.weather.gov/",
    });
  });
  return {
    temp: current && isFiniteNumber(current.temperature_2m) ? Math.round(Number(current.temperature_2m)) : null,
    items: items,
    alerts: alerts,
    alertCount: alerts.length,
    name: weatherName,
    sourceStatus: {
      forecast: Boolean(forecast),
      alerts: Boolean(alertData),
    },
    generatedAt: new Date().toISOString(),
  };
}

async function buildStocks(symbols, requestIdValue) {
  const list = Array.isArray(symbols) && symbols.length ? symbols : ["SPY", "QQQ", "DIA", "IWM", "VTI"];
  const safeSymbols = list.map(function (symbol) {
    return String(symbol || "").trim().toUpperCase();
  }).filter(function (symbol, index, all) {
    return /^[A-Z0-9.-]{1,10}$/.test(symbol) && all.indexOf(symbol) === index;
  }).slice(0, 8);
  const results = await mapLimit(safeSymbols, 4, async function (symbol) {
    const data = await fetchJson(
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(symbol) + "?interval=1d&range=2d",
      6500,
      requestIdValue
    );
    const meta = data && data.chart && data.chart.result && data.chart.result[0] &&
      data.chart.result[0].meta;
    if (!meta || !isFiniteNumber(meta.regularMarketPrice)) return null;
    const price = Number(meta.regularMarketPrice);
    const previous = Number(meta.chartPreviousClose || meta.previousClose || price);
    const percent = previous ? ((price - previous) / previous) * 100 : 0;
    return {
      sym: symbol,
      price: Number(price.toFixed(2)),
      pct: Number(percent.toFixed(2)),
      dir: percent > 0.05 ? "up" : percent < -0.05 ? "down" : "flat",
    };
  });
  return {
    quotes: results.filter(Boolean),
    generatedAt: new Date().toISOString(),
  };
}

function parseLocation(url) {
  return {
    lat: boundedNumber(url.searchParams.get("lat"), -90, 90, DEFAULT_LOCATION.lat),
    lon: boundedNumber(url.searchParams.get("lon"), -180, 180, DEFAULT_LOCATION.lon),
    name: boundedText(url.searchParams.get("name"), 80, DEFAULT_LOCATION.name),
  };
}

function parseSymbols(url) {
  return String(url.searchParams.get("symbols") || "")
    .split(",")
    .map(function (symbol) { return symbol.trim().toUpperCase(); })
    .filter(function (symbol, index, all) {
      return /^[A-Z0-9.-]{1,10}$/.test(symbol) && all.indexOf(symbol) === index;
    })
    .slice(0, 8);
}

async function buildBundle(location, symbols, env, requestIdValue) {
  const results = await Promise.allSettled([
    buildNews(env, requestIdValue),
    buildSportsLive(requestIdValue),
    buildWeather(location.lat, location.lon, location.name, requestIdValue),
    buildStocks(symbols, requestIdValue),
  ]);
  const news = results[0].status === "fulfilled" ? results[0].value : {
    main: [], sports: [], sourcesOk: 0, sourcesTried: 0, generatedAt: new Date().toISOString(),
  };
  const sports = results[1].status === "fulfilled" ? results[1].value : {
    live: [], finals: [], sourceStatus: { ok: 0, tried: SPORT_LEAGUES.length },
    generatedAt: new Date().toISOString(),
  };
  const weather = results[2].status === "fulfilled" ? results[2].value : {
    temp: null, items: [], alerts: [], alertCount: 0, name: location.name,
    sourceStatus: { forecast: false, alerts: false }, generatedAt: new Date().toISOString(),
  };
  const stocks = results[3].status === "fulfilled" ? results[3].value : {
    quotes: [], generatedAt: new Date().toISOString(),
  };
  return {
    ok: true,
    version: VERSION,
    location: location,
    news: news,
    sports: sports,
    weather: weather,
    stocks: stocks,
    generatedAt: new Date().toISOString(),
  };
}

function cacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

async function readLastGood(env, key) {
  if (!env || !env.DASH_BUCKET) return null;
  try {
    const object = await env.DASH_BUCKET.get(key);
    if (!object) return null;
    const text = await object.text();
    if (text.length > MAX_JSON_BYTES) return null;
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

async function writeLastGood(env, key, value) {
  if (!env || !env.DASH_BUCKET) return;
  try {
    await env.DASH_BUCKET.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (error) {
    logEvent("last_good_write_failed", { key: key });
  }
}

async function cachedBundle(request, env, ctx, location, symbols, id) {
  const keyRequest = cacheKey(request);
  const cached = await caches.default.match(keyRequest);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Dash-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers: corsHeaders(request, headers) });
  }
  const r2Key = "bundle/" + location.lat + "/" + location.lon + ".json";
  try {
    const bundle = await buildBundle(location, symbols, env, id);
    const response = jsonResponse(request, bundle, 200, {
      "Cache-Control": "public, max-age=" + BUNDLE_CACHE_SECONDS,
      "X-Dash-Cache": "MISS",
    });
    ctx.waitUntil(caches.default.put(keyRequest, response.clone()));
    ctx.waitUntil(writeLastGood(env, r2Key, bundle));
    return response;
  } catch (error) {
    logEvent("bundle_failed", { requestId: id, message: "upstream bundle failure" });
    const stale = await readLastGood(env, r2Key);
    if (stale) {
      return jsonResponse(request, Object.assign({}, stale, {
        stale: true,
        staleAt: new Date().toISOString(),
      }), 200, { "X-Dash-Cache": "R2-LAST-GOOD" });
    }
    return errorResponse(request, 503, "Bundle unavailable");
  }
}

function cookieValue(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const matcher = new RegExp("(?:^|;\\s*)" + name + "=([^;]*)");
  const match = matcher.exec(cookieHeader);
  return match ? decodeURIComponent(match[1]) : "";
}

function cookie(name, value, maxAge) {
  return name + "=" + encodeURIComponent(value) +
    "; Path=/; Max-Age=" + String(maxAge) +
    "; Secure; HttpOnly; SameSite=Lax";
}

function expiredCookie(name) {
  return cookie(name, "", 0);
}

function randomBase64Url(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = "";
  values.forEach(function (value) {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  new Uint8Array(digest).forEach(function (value) {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(first, second) {
  const left = new TextEncoder().encode(String(first || ""));
  const right = new TextEncoder().encode(String(second || ""));
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function spotifyHtml(payload) {
  const safePayload = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const message = payload.ok ? "Spotify connected. You can close this window." : "Spotify connection was not completed.";
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>DASH Spotify</title>" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#08070b;color:#f6eaf1;font:16px system-ui}main{text-align:center;padding:32px}strong{color:#ff5bb7}</style>" +
    "</head><body><main><strong>DASH</strong><p>" + escapeHtml(message) + "</p></main>" +
    "<script>(function(){var data=" + safePayload + ";if(window.opener){window.opener.postMessage(data,\"" +
    APP_ORIGIN + "\");}window.setTimeout(function(){window.close();},700);})();</script></body></html>";
  return html;
}

async function spotifyLogin(request) {
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(24);
  const challenge = await sha256Base64Url(verifier);
  const authorize = new URL("https://accounts.spotify.com/authorize");
  authorize.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", SPOTIFY_CALLBACK_URI);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set(
    "scope",
    "user-read-currently-playing user-read-playback-state user-modify-playback-state"
  );
  const headers = new Headers({
    Location: authorize.href,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append("Set-Cookie", cookie("dash_sp_verifier", verifier, 600));
  headers.append("Set-Cookie", cookie("dash_sp_state", state, 600));
  return new Response(null, { status: 302, headers: headers });
}

async function spotifyCallback(request, env, id) {
  const url = new URL(request.url);
  const returnedState = url.searchParams.get("state") || "";
  const savedState = cookieValue(request, "dash_sp_state");
  const verifier = cookieValue(request, "dash_sp_verifier");
  const clearHeaders = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
  });
  clearHeaders.append("Set-Cookie", expiredCookie("dash_sp_state"));
  clearHeaders.append("Set-Cookie", expiredCookie("dash_sp_verifier"));
  if (!savedState || !returnedState || !constantTimeEqual(savedState, returnedState) || !verifier) {
    logEvent("spotify_state_rejected", { requestId: id });
    return new Response(spotifyHtml({ type: "spotify", ok: false, error: "Authorization expired" }), {
      status: 400,
      headers: clearHeaders,
    });
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    return new Response(spotifyHtml({ type: "spotify", ok: false, error: "Authorization cancelled" }), {
      status: 400,
      headers: clearHeaders,
    });
  }
  if (!env || !env.SPOTIFY_CLIENT_SECRET) {
    logEvent("spotify_secret_missing", { requestId: id });
    return new Response(spotifyHtml({ type: "spotify", ok: false, error: "Spotify is not configured" }), {
      status: 503,
      headers: clearHeaders,
    });
  }
  try {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", url.searchParams.get("code"));
    body.set("redirect_uri", SPOTIFY_CALLBACK_URI);
    body.set("client_id", SPOTIFY_CLIENT_ID);
    body.set("code_verifier", verifier);
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!tokenResponse.ok) throw new Error("Spotify token exchange failed");
    const tokenText = await readLimited(tokenResponse, 64 * 1024);
    const token = JSON.parse(tokenText);
    return new Response(spotifyHtml({
      type: "spotify",
      ok: true,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_in: Number(token.expires_in) || 3600,
      token_type: token.token_type || "Bearer",
    }), { status: 200, headers: clearHeaders });
  } catch (error) {
    logEvent("spotify_exchange_failed", { requestId: id });
    return new Response(spotifyHtml({ type: "spotify", ok: false, error: "Spotify authorization failed" }), {
      status: 502,
      headers: clearHeaders,
    });
  }
}

async function spotifyRefresh(request, env, id) {
  let body;
  try {
    const text = await readLimited(request, 16 * 1024);
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    return errorResponse(request, 400, "Invalid request");
  }
  const refreshToken = boundedText(body && body.refresh_token, 600);
  if (!refreshToken || !env || !env.SPOTIFY_CLIENT_SECRET) {
    return errorResponse(request, 400, "Refresh unavailable");
  }
  try {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);
    params.set("client_id", SPOTIFY_CLIENT_ID);
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!response.ok) throw new Error("Spotify refresh failed");
    const token = JSON.parse(await readLimited(response, 64 * 1024));
    return jsonResponse(request, {
      ok: true,
      access_token: token.access_token,
      refresh_token: token.refresh_token || refreshToken,
      expires_in: Number(token.expires_in) || 3600,
      token_type: token.token_type || "Bearer",
    });
  } catch (error) {
    logEvent("spotify_refresh_failed", { requestId: id });
    return errorResponse(request, 502, "Spotify refresh failed");
  }
}

async function handleProxy(request, id) {
  if (request.method !== "GET") return errorResponse(request, 405, "GET required");
  const url = new URL(request.url);
  const targetValue = url.searchParams.get("url");
  let target;
  try {
    target = new URL(targetValue || "");
  } catch (error) {
    return errorResponse(request, 400, "Invalid target");
  }
  if (target.protocol !== "https:" || !PROXY_HOSTS.has(target.hostname)) {
    return errorResponse(request, 403, "Target not allowed");
  }
  try {
    const body = await fetchText(target.href, 7000, MAX_RSS_BYTES, id);
    return textResponse(request, body, 200, {
      "Cache-Control": "public, max-age=30",
    });
  } catch (error) {
    return errorResponse(request, 502, "Proxy target unavailable");
  }
}

export default {
  async fetch(request, env, ctx) {
    const id = requestId();
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    try {
      if (url.pathname === "/spotify/login" && request.method === "GET") {
        return await spotifyLogin(request);
      }
      if (url.pathname === "/spotify/callback" && request.method === "GET") {
        return await spotifyCallback(request, env, id);
      }
      if (url.pathname === "/spotify/refresh" && request.method === "POST") {
        return await spotifyRefresh(request, env, id);
      }
      if (url.pathname === "/geocode" && request.method === "GET") {
        const query = boundedText(url.searchParams.get("q"), 80);
        if (!query) return errorResponse(request, 400, "Location required");
        const geocodeUrl =
          "https://geocoding-api.open-meteo.com/v1/search?name=" +
          encodeURIComponent(query) + "&count=5&language=en&format=json";
        const data = await fetchJson(geocodeUrl, 7500, id);
        const results = (data && Array.isArray(data.results) ? data.results : [])
          .filter(function (item) {
            return isFiniteNumber(item.latitude) && isFiniteNumber(item.longitude);
          })
          .slice(0, 5)
          .map(function (item) {
            return {
              name: boundedText(item.name, 60, query),
              admin1: boundedText(item.admin1, 60),
              country: boundedText(item.country, 60),
              latitude: boundedNumber(item.latitude, -90, 90, 0),
              longitude: boundedNumber(item.longitude, -180, 180, 0),
            };
          });
        return jsonResponse(request, { results: results, version: VERSION });
      }
      if (url.pathname === "/bundle" && request.method === "GET") {
        const location = parseLocation(url);
        return await cachedBundle(request, env, ctx, location, parseSymbols(url), id);
      }
      if (url.pathname === "/news" && request.method === "GET") {
        return jsonResponse(request, await buildNews(env, id));
      }
      if (url.pathname === "/sports" && request.method === "GET") {
        return jsonResponse(request, await buildSportsLive(id));
      }
      if (url.pathname === "/weather" && request.method === "GET") {
        const location = parseLocation(url);
        return jsonResponse(request, await buildWeather(location.lat, location.lon, location.name, id));
      }
      if (url.pathname === "/stocks" && request.method === "GET") {
        return jsonResponse(request, await buildStocks(parseSymbols(url), id));
      }
      if (url.pathname === "/proxy" && request.method === "GET") {
        return await handleProxy(request, id);
      }
      if (url.pathname === "/" && request.method === "GET") {
        return jsonResponse(request, {
          service: "DASH edge backend",
          version: VERSION,
          routes: ["/bundle", "/geocode", "/news", "/sports", "/weather", "/stocks", "/spotify/login"],
        });
      }
      return errorResponse(request, 404, "Route not found");
    } catch (error) {
      logEvent("request_failed", {
        requestId: id,
        path: url.pathname,
        message: "request failed",
      });
      return errorResponse(request, 500, "Request unavailable");
    }
  },
};
