(function () {
  "use strict";

  const WORKER_ORIGIN = "https://lucky-unit-4667.tdy1990.workers.dev";
  const SETTINGS_KEY = "dash-settings-v2";
  const LOCATION_KEY = "dash-location-v2";
  const SPOTIFY_KEY = "dash-spotify-token";
  const DEFAULT_LOCATION = Object.freeze({
    lat: 32.7767,
    lon: -96.797,
    name: "Dallas, TX",
  });
  const REFRESH_MS = 60 * 1000;
  const MAX_BUNDLE_AGE_MS = 15 * 60 * 1000;

  const refs = {
    clock: document.getElementById("clock"),
    weatherButton: document.getElementById("weatherButton"),
    weatherMetric: document.getElementById("weatherMetric"),
    alertsButton: document.getElementById("alertsButton"),
    alertsMetric: document.getElementById("alertsMetric"),
    liveButton: document.getElementById("liveButton"),
    liveMetric: document.getElementById("liveMetric"),
    edgeStatus: document.getElementById("edgeStatus"),
    edgeStatusText: document.getElementById("edgeStatusText"),
    settingsButton: document.getElementById("settingsButton"),
    kioskButton: document.getElementById("kioskButton"),
    sportsMeta: document.getElementById("sportsMeta"),
    newsMeta: document.getElementById("newsMeta"),
    sportsNewsMeta: document.getElementById("sportsNewsMeta"),
    sourceHealth: document.getElementById("sourceHealth"),
    dataAge: document.getElementById("dataAge"),
    footerMessage: document.getElementById("footerMessage"),
    focusType: document.getElementById("focusType"),
    focusContent: document.getElementById("focusContent"),
    focusMeta: document.getElementById("focusMeta"),
    liveList: document.getElementById("liveList"),
    weatherContent: document.getElementById("weatherContent"),
    toast: document.getElementById("toast"),
    refreshButton: document.getElementById("refreshButton"),
    clearFocusButton: document.getElementById("clearFocusButton"),
    openLiveButton: document.getElementById("openLiveButton"),
    openLiveFromPanel: document.getElementById("openLiveFromPanel"),
    openWeatherButton: document.getElementById("openWeatherButton"),
    spotifyButton: document.getElementById("spotifyButton"),
    spotifyLabel: document.getElementById("spotifyLabel"),
    spotifyStatus: document.getElementById("spotifyStatus"),
    liveDialog: document.getElementById("liveDialog"),
    weatherDialog: document.getElementById("weatherDialog"),
    settingsDialog: document.getElementById("settingsDialog"),
    settingsForm: document.getElementById("settingsForm"),
    motionSetting: document.getElementById("motionSetting"),
    densitySetting: document.getElementById("densitySetting"),
    secondsSetting: document.getElementById("secondsSetting"),
    locationSetting: document.getElementById("locationSetting"),
  };

  const state = {
    bundle: null,
    location: null,
    loading: false,
    refreshTimer: 0,
    lastSuccess: 0,
    failures: 0,
    lastError: "",
    legacySportsAt: 0,
    legacySportsPending: false,
    focus: null,
    lastFocusedElement: null,
    spotifyPopup: null,
    settings: loadSettings(),
  };

  function createElement(tagName, className, label) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (label !== undefined && label !== null) node.textContent = String(label);
    return node;
  }

  function replaceChildren(node) {
    if (node) node.replaceChildren();
  }

  function clean(value, fallback) {
    const text = String(value === undefined || value === null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
    return text || (fallback || "");
  }

  function safeExternalUrl(value) {
    try {
      const parsed = new URL(String(value || ""), window.location.href);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
      if (parsed.username || parsed.password) return "";
      return parsed.href;
    } catch (error) {
      return "";
    }
  }

  function parseTime(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatRelative(timestamp) {
    if (!timestamp) return "time unavailable";
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  function formatAge(timestamp) {
    if (!timestamp) return "NO DATA";
    const age = Math.max(0, Date.now() - timestamp);
    if (age < 1000 * 60) return "FRESH";
    if (age < 1000 * 60 * 60) return Math.floor(age / 60000) + "M OLD";
    return Math.floor(age / 3600000) + "H OLD";
  }

  function formatClock(now) {
    const options = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "America/Chicago",
    };
    if (state.settings.seconds) options.second = "2-digit";
    return new Intl.DateTimeFormat("en-US", options).format(now);
  }

  function formatCentralDate(timestamp) {
    if (!timestamp) return "Date unavailable";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Chicago",
    }).format(new Date(timestamp));
  }

  function loadSettings() {
    const fallback = {
      theme: "pink",
      motion: "auto",
      density: "comfortable",
      seconds: false,
      location: "",
    };
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (!saved || typeof saved !== "object") return fallback;
      return {
        theme: ["pink", "cyan", "green", "amber", "purple"].includes(saved.theme)
          ? saved.theme
          : fallback.theme,
        motion: ["auto", "on", "off"].includes(saved.motion) ? saved.motion : fallback.motion,
        density: ["comfortable", "compact"].includes(saved.density)
          ? saved.density
          : fallback.density,
        seconds: Boolean(saved.seconds),
        location: clean(saved.location).slice(0, 80),
      };
    } catch (error) {
      return fallback;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (error) {
      showToast("Settings apply for this session only.");
    }
  }

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function motionAllowed() {
    if (state.settings.motion === "on") return true;
    if (state.settings.motion === "off") return false;
    return !prefersReducedMotion();
  }

  function applySettings() {
    document.documentElement.dataset.theme = state.settings.theme;
    document.body.classList.toggle("density-compact", state.settings.density === "compact");
    document.body.classList.toggle("reduce-motion", !motionAllowed());
    if (refs.motionSetting) refs.motionSetting.value = state.settings.motion;
    if (refs.densitySetting) refs.densitySetting.value = state.settings.density;
    if (refs.secondsSetting) refs.secondsSetting.checked = state.settings.seconds;
    if (refs.locationSetting) refs.locationSetting.value = state.settings.location;
    Object.keys(tickers).forEach(function (key) {
      tickers[key].refreshMotion();
    });
    updateClock();
  }

  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = window.setTimeout(function () {
      controller.abort();
    }, timeoutMs || 10000);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error("HTTP " + response.status);
      if (body.length > 2500000) throw new Error("Response too large");
      return body ? JSON.parse(body) : null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  class Ticker {
    constructor(track, viewport, toggle, mode) {
      this.track = track;
      this.viewport = viewport;
      this.toggle = toggle;
      this.mode = mode || "horizontal";
      this.primary = null;
      this.paused = false;
      this.raf = 0;
      this.timer = 0;
      this.offset = 0;
      this.lastFrame = 0;
      this.hovered = false;
      this.focused = false;
      this.onToggle = this.onToggle.bind(this);
      this.animate = this.animate.bind(this);
      if (this.toggle) this.toggle.addEventListener("click", this.onToggle);
      if (this.viewport) {
        this.viewport.addEventListener("mouseenter", () => {
          this.hovered = true;
        });
        this.viewport.addEventListener("mouseleave", () => {
          this.hovered = false;
        });
        this.viewport.addEventListener("focusin", () => {
          this.focused = true;
        });
        this.viewport.addEventListener("focusout", () => {
          this.focused = false;
        });
      }
      this.updateButton();
    }

    setItems(items, renderer) {
      this.stop();
      replaceChildren(this.track);
      const primary = createElement("div", "ticker-set");
      primary.setAttribute("role", "list");
      const list = Array.isArray(items) ? items : [];
      if (!list.length) {
        const empty = createElement("div", "ticker-item");
        empty.setAttribute("role", "listitem");
        empty.append(createElement("span", "ticker-copy", "No updates available."));
        primary.append(empty);
      } else {
        list.forEach((item, index) => {
          const rendered = renderer(item, index);
          if (rendered) {
            rendered.setAttribute("role", "listitem");
            primary.append(rendered);
          }
        });
      }
      this.primary = primary;
      this.track.append(primary);
      if (this.mode === "horizontal" && primary.children.length > 1) {
        const clone = primary.cloneNode(true);
        clone.setAttribute("aria-hidden", "true");
        clone.querySelectorAll("a,button").forEach(function (node) {
          node.tabIndex = -1;
        });
        this.track.append(clone);
      }
      if (this.viewport) this.viewport.scrollTop = 0;
      this.updateButton();
      window.requestAnimationFrame(() => this.start());
    }

    refreshMotion() {
      this.stop();
      this.updateButton();
      window.requestAnimationFrame(() => this.start());
    }

    onToggle() {
      this.paused = !this.paused;
      if (this.paused) this.stop();
      else this.start();
      this.updateButton();
    }

    updateButton() {
      if (!this.toggle) return;
      this.toggle.textContent = this.paused ? "Play" : "Pause";
      this.toggle.setAttribute("aria-pressed", String(this.paused));
    }

    start() {
      if (this.paused || !this.primary || !motionAllowed()) return;
      this.stop();
      if (this.mode === "vertical") {
        this.timer = window.setInterval(() => this.advanceVertical(), 4600);
      } else {
        this.lastFrame = 0;
        this.raf = window.requestAnimationFrame(this.animate);
      }
    }

    stop() {
      if (this.raf) window.cancelAnimationFrame(this.raf);
      if (this.timer) window.clearInterval(this.timer);
      this.raf = 0;
      this.timer = 0;
    }

    advanceVertical() {
      if (!this.viewport || this.hovered || this.focused || document.hidden) return;
      const first = this.primary && this.primary.querySelector(".ticker-item");
      if (!first) return;
      const step = first.getBoundingClientRect().height + 8;
      const end = this.viewport.scrollHeight - this.viewport.clientHeight;
      const next = this.viewport.scrollTop + step >= end - 2 ? 0 : this.viewport.scrollTop + step;
      this.viewport.scrollTo({
        top: next,
        behavior: motionAllowed() ? "smooth" : "auto",
      });
    }

    animate(timestamp) {
      if (!this.primary || this.paused || !motionAllowed() || document.hidden) return;
      if (!this.lastFrame) this.lastFrame = timestamp;
      const delta = Math.min(50, timestamp - this.lastFrame);
      this.lastFrame = timestamp;
      const width = this.primary.getBoundingClientRect().width;
      if (width > 0) {
        this.offset -= (34 * delta) / 1000;
        if (this.offset <= -width) this.offset += width;
        this.track.style.transform = "translate3d(" + this.offset + "px, 0, 0)";
      }
      this.raf = window.requestAnimationFrame(this.animate);
    }
  }

  const tickers = {
    sports: new Ticker(
      document.getElementById("sportsTrack"),
      document.getElementById("sportsViewport"),
      document.getElementById("sportsToggle"),
      "horizontal"
    ),
    news: new Ticker(
      document.getElementById("newsTrack"),
      document.getElementById("newsViewport"),
      document.getElementById("newsToggle"),
      "vertical"
    ),
    sportsNews: new Ticker(
      document.getElementById("sportsNewsTrack"),
      document.getElementById("sportsNewsViewport"),
      document.getElementById("sportsNewsToggle"),
      "vertical"
    ),
  };

  function normaliseHeadline(item) {
    const source = clean(item && (item.src || item.source || item.author), "News").slice(0, 40);
    const title = clean(
      item && (item.title || item.text || item.headline || item.description),
      "Headline unavailable"
    ).slice(0, 260);
    const ts = parseTime(item && (item.ts || item.publishedAt || item.published || item.date));
    return {
      src: source,
      title: title,
      link: safeExternalUrl(item && (item.link || item.url)),
      ts: ts,
    };
  }

  function normaliseSport(item, liveDefault) {
    const source = item || {};
    const live = source.live !== undefined ? Boolean(source.live) : Boolean(liveDefault);
    return {
      league: clean(source.league || source.key, "SPORT").slice(0, 30),
      away: clean(source.away || source.awayTeam || source.visitor, "Away"),
      home: clean(source.home || source.homeTeam || source.host, "Home"),
      awayScore: clean(source.aScore !== undefined ? source.aScore : source.awayScore, "—"),
      homeScore: clean(source.hScore !== undefined ? source.hScore : source.homeScore, "—"),
      status: clean(source.status || source.detail, live ? "LIVE" : "FINAL").slice(0, 50),
      link: safeExternalUrl(source.link),
      live: live,
    };
  }

  function readArray(value, limit) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, limit || 50);
  }

  function renderNewsItem(item) {
    const row = createElement("div", "ticker-item");
    const headline = normaliseHeadline(item);
    const target = headline.link
      ? createElement("a", "ticker-link")
      : createElement("button", "ticker-action");
    if (target.tagName === "A") {
      target.href = headline.link;
      target.target = "_blank";
      target.rel = "noopener noreferrer";
    } else {
      target.type = "button";
    }
    target.addEventListener("click", function () {
      setFocus({ kind: "news", item: headline });
    });
    target.append(
      createElement("span", "ticker-source", headline.src),
      createElement("span", "ticker-copy", headline.title)
    );
    row.append(target);
    return row;
  }

  function renderScoreItem(item) {
    const row = createElement("div", "ticker-item");
    const action = createElement("button", "ticker-action");
    action.type = "button";
    action.setAttribute(
      "aria-label",
      item.league +
        ": " +
        item.away +
        " " +
        item.awayScore +
        ", " +
        item.home +
        " " +
        item.homeScore
    );
    action.addEventListener("click", function () {
      setFocus({ kind: "sport", item: item });
    });
    const icon = createElement("span", "ticker-icon", item.live ? "LIVE" : item.league);
    const copy = createElement("span", "score-copy");
    const away = createElement("span", "score-line");
    away.append(createElement("span", "", item.away), createElement("strong", "", item.awayScore));
    const home = createElement("span", "score-line");
    home.append(createElement("span", "", item.home), createElement("strong", "", item.homeScore));
    copy.append(away, home, createElement("span", "score-status", item.status));
    action.append(icon, copy);
    row.append(action);
    return row;
  }

  function renderEmptyFocus() {
    state.focus = null;
    refs.focusType.textContent = "READY";
    refs.focusMeta.textContent = "Interactive details appear here";
    replaceChildren(refs.focusContent);
    refs.focusContent.append(
      createElement("p", "empty-state", "Select a score or headline to inspect it here.")
    );
  }

  function setFocus(selection) {
    if (!selection || !selection.item) return;
    state.focus = selection;
    replaceChildren(refs.focusContent);
    if (selection.kind === "sport") {
      const item = selection.item;
      refs.focusType.textContent = item.live ? "LIVE" : "FINAL";
      refs.focusMeta.textContent = item.league + " · " + item.status;
      refs.focusContent.append(
        createElement("span", "focus-overline", item.league + " · " + item.status)
      );
      const board = createElement("div", "focus-scoreboard");
      const away = createElement("div", "focus-team");
      away.append(
        createElement("span", "focus-team-name", item.away),
        createElement("span", "focus-team-score", item.awayScore)
      );
      const home = createElement("div", "focus-team");
      home.append(
        createElement("span", "focus-team-name", item.home),
        createElement("span", "focus-team-score", item.homeScore)
      );
      board.append(away, createElement("span", "focus-vs", "AT"), home);
      refs.focusContent.append(board);
      const link = safeExternalUrl(item.link);
      if (link) {
        const anchor = createElement("a", "focus-link", "Open score details ↗");
        anchor.href = link;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        refs.focusContent.append(anchor);
      }
      return;
    }
    const item = selection.item;
    refs.focusType.textContent = "HEADLINE";
    refs.focusMeta.textContent = item.src + " · " + formatRelative(item.ts);
    refs.focusContent.append(
      createElement("span", "focus-overline", item.src),
      createElement("h3", "focus-title", item.title),
      createElement("p", "focus-description", formatCentralDate(item.ts))
    );
    if (item.link) {
      const anchor = createElement("a", "focus-link", "Read source ↗");
      anchor.href = item.link;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      refs.focusContent.append(anchor);
    }
  }

  function renderLiveDialog(liveItems) {
    replaceChildren(refs.liveList);
    if (!liveItems.length) {
      refs.liveList.append(createElement("p", "empty-state", "No live games right now."));
      return;
    }
    liveItems.forEach(function (item) {
      const row = createElement("div", "modal-row");
      const main = createElement("div", "modal-row-main");
      main.append(
        createElement("strong", "modal-row-title", item.away + "  " + item.awayScore),
        createElement("span", "modal-row-meta", item.home + "  " + item.homeScore),
        createElement("span", "modal-row-meta", item.league)
      );
      row.append(main, createElement("span", "modal-row-status", item.status));
      row.addEventListener("click", function () {
        setFocus({ kind: "sport", item: item });
        closeDialog(refs.liveDialog);
      });
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          row.click();
        }
      });
      refs.liveList.append(row);
    });
  }

  function renderWeatherDialog(weather) {
    replaceChildren(refs.weatherContent);
    const data = weather || {};
    const temp = Number.isFinite(Number(data.temp)) ? Math.round(Number(data.temp)) : null;
    if (temp !== null) {
      const summary = createElement("div", "weather-summary");
      summary.append(createElement("strong", "weather-temperature", temp + "°"));
      const details = createElement("div");
      const first = Array.isArray(data.items) && data.items.length ? data.items[0] : null;
      details.append(
        createElement("strong", clean(data.name, "Local conditions")),
        createElement("span", clean(first && first.text, "Current conditions available"))
      );
      summary.append(details);
      refs.weatherContent.append(summary);
    }
    const alerts = readArray(data.alerts, 5);
    if (alerts.length) {
      alerts.forEach(function (alert) {
        const row = createElement("div", "modal-row alert-row");
        const main = createElement("div", "modal-row-main");
        main.append(
          createElement("strong", "modal-row-title", clean(alert.event, "Alert")),
          createElement("span", "modal-row-meta", clean(alert.headline, "Weather alert"))
        );
        row.append(main);
        refs.weatherContent.append(row);
      });
    }
    const forecastItems = readArray(data.items, 5).slice(1);
    forecastItems.forEach(function (item) {
      const row = createElement("div", "modal-row");
      row.append(
        createElement("div", "modal-row-main", clean(item.src, "Forecast")),
        createElement("span", "modal-row-status", clean(item.text, "—"))
      );
      refs.weatherContent.append(row);
    });
    if (!temp && !alerts.length && !forecastItems.length) {
      refs.weatherContent.append(createElement("p", "empty-state", "Weather data is unavailable."));
    }
  }

  function setEdgeStatus(status, label) {
    refs.edgeStatus.dataset.state = status;
    refs.edgeStatusText.textContent = label;
  }

  function renderBundle(bundle) {
    const news = bundle && bundle.news ? bundle.news : {};
    const sports = bundle && bundle.sports ? bundle.sports : {};
    const weather = bundle && bundle.weather ? bundle.weather : {};
    const mainNews = readArray(news.main || news.items, 18).map(normaliseHeadline);
    const sportsNews = readArray(news.sports, 14).map(normaliseHeadline);
    const live = readArray(sports.live, 30).map(function (item) {
      return normaliseSport(item, true);
    });
    const finals = readArray(sports.finals, 24).map(function (item) {
      return normaliseSport(item, false);
    });
    const scoreItems = live.concat(finals);

    tickers.sports.setItems(scoreItems.slice(0, 30), renderScoreItem);
    tickers.news.setItems(mainNews, renderNewsItem);
    tickers.sportsNews.setItems((sportsNews.length ? sportsNews : mainNews).slice(0, 16), renderNewsItem);
    renderLiveDialog(live);
    renderWeatherDialog(weather);

    refs.liveMetric.textContent = String(live.length);
    refs.alertsMetric.textContent = String(Number(weather.alertCount) || readArray(weather.alerts, 10).length);
    refs.weatherMetric.textContent =
      weather.temp === null || weather.temp === undefined ? "--°" : Math.round(Number(weather.temp)) + "°";
    refs.sportsMeta.textContent = live.length
      ? live.length + " live · " + finals.length + " final"
      : finals.length
        ? finals.length + " final · no live games"
        : "No scores available";
    refs.newsMeta.textContent = mainNews.length
      ? mainNews.length + " headlines · " + clean(news.sourcesOk, "edge") + " sources"
      : "No headlines available";
    refs.sportsNewsMeta.textContent = sportsNews.length
      ? sportsNews.length + " sports headlines"
      : "Using top news fallback";
    const generated = parseTime(bundle.generatedAt) || state.lastSuccess;
    refs.dataAge.textContent = formatAge(generated);
    const newsHealth = news.sourcesTried
      ? String(news.sourcesOk || 0) + "/" + String(news.sourcesTried) + " news feeds"
      : "Edge feeds active";
    const sportsHealth = sports.sourceStatus
      ? String(sports.sourceStatus.ok || 0) + "/" + String(sports.sourceStatus.tried || 0) + " score feeds"
      : scoreItems.length
        ? "Score feed active"
        : "Scores waiting";
    refs.sourceHealth.textContent = newsHealth + " · " + sportsHealth;
    refs.sourceHealth.dataset.state =
      (news.sourcesTried && news.sourcesOk < news.sourcesTried) || (sports.sourceStatus && sports.sourceStatus.ok < sports.sourceStatus.tried)
        ? "warn"
        : "ok";
    refs.footerMessage.textContent =
      "Updated " + formatRelative(generated) + " · All times shown in Central time";
  }

  function renderInitialState() {
    tickers.sports.setItems([], renderScoreItem);
    tickers.news.setItems([], renderNewsItem);
    tickers.sportsNews.setItems([], renderNewsItem);
    renderWeatherDialog(null);
    refs.sourceHealth.textContent = "Connecting to edge sources…";
    refs.footerMessage.textContent = "Connecting to edge sources…";
    renderEmptyFocus();
  }

  function readSavedLocation() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCATION_KEY) || "null");
      if (
        saved &&
        Number.isFinite(Number(saved.lat)) &&
        Number.isFinite(Number(saved.lon)) &&
        Number(saved.lat) >= -90 &&
        Number(saved.lat) <= 90 &&
        Number(saved.lon) >= -180 &&
        Number(saved.lon) <= 180
      ) {
        return {
          lat: Number(saved.lat),
          lon: Number(saved.lon),
          name: clean(saved.name, DEFAULT_LOCATION.name),
          query: clean(saved.query),
        };
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  async function resolveLocation() {
    const query = clean(state.settings.location).slice(0, 80);
    const cached = readSavedLocation();
    if (!query) return cached || DEFAULT_LOCATION;
    if (cached && cached.query === query) return cached;
    try {
      const url = WORKER_ORIGIN + "/geocode?q=" + encodeURIComponent(query);
      const data = await fetchJson(url, 7500);
      const result = data && data.results && data.results[0];
      if (result && Number.isFinite(Number(result.latitude)) && Number.isFinite(Number(result.longitude))) {
        const location = {
          lat: Number(result.latitude),
          lon: Number(result.longitude),
          name: clean(result.name, query) + (result.admin1 ? ", " + clean(result.admin1) : ""),
          query: query,
        };
        try {
          localStorage.setItem(LOCATION_KEY, JSON.stringify(location));
        } catch (error) {}
        return location;
      }
    } catch (error) {
      showToast("Location lookup unavailable; using the last working location.");
    }
    return cached || DEFAULT_LOCATION;
  }

  function scheduleRefresh(delay) {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    const backoff = Math.min(REFRESH_MS * Math.pow(2, Math.max(0, state.failures - 1)), 10 * 60 * 1000);
    state.refreshTimer = window.setTimeout(function () {
      loadBundle(false);
    }, delay || (state.failures ? backoff : REFRESH_MS));
  }

  async function loadBundle(manual) {
    if (state.loading) return;
    state.loading = true;
    refs.refreshButton.disabled = true;
    setEdgeStatus("loading", manual ? "Refreshing" : "Connecting");
    try {
      const location = await resolveLocation();
      state.location = location;
      const endpoint = new URL(WORKER_ORIGIN + "/bundle");
      endpoint.searchParams.set("lat", String(location.lat));
      endpoint.searchParams.set("lon", String(location.lon));
      endpoint.searchParams.set("name", location.name);
      const data = await fetchJson(endpoint.href, 15000);
      if (!data || typeof data !== "object") throw new Error("Invalid bundle");
      state.bundle = data;
      state.lastSuccess = Date.now();
      state.failures = 0;
      state.lastError = "";
      renderBundle(data);
      if (!data.sports || !data.sports.sourceStatus) loadLegacySports();
      setEdgeStatus("ok", "Edge online");
      if (manual) showToast("Dashboard refreshed.");
    } catch (error) {
      state.failures += 1;
      state.lastError = "Live data is temporarily unavailable.";
      if (state.bundle) {
        renderBundle(state.bundle);
        setEdgeStatus("error", "Stale · retrying");
        refs.footerMessage.textContent = "Showing last good data · retrying automatically";
      } else {
        setEdgeStatus("error", "Offline · retrying");
        refs.sourceHealth.textContent = "Waiting for edge sources";
        refs.footerMessage.textContent = state.lastError;
      }
      if (manual) showToast("Refresh failed; the board will retry automatically.");
    } finally {
      state.loading = false;
      refs.refreshButton.disabled = false;
      scheduleRefresh();
    }
  }

  async function loadLegacySports() {
    if (state.legacySportsPending || Date.now() - state.legacySportsAt < 90000) return;
    state.legacySportsPending = true;
    state.legacySportsAt = Date.now();
    try {
      const endpoints = ["/sports-live", "/sports"];
      for (let index = 0; index < endpoints.length; index += 1) {
        try {
          const data = await fetchJson(WORKER_ORIGIN + endpoints[index], 12000);
          if (!data || (!Array.isArray(data.live) && !Array.isArray(data.finals))) continue;
          if (!state.bundle) return;
          state.bundle = Object.assign({}, state.bundle, { sports: data });
          renderBundle(state.bundle);
          refs.sourceHealth.textContent += " · compatibility score feed";
          return;
        } catch (error) {}
      }
    } catch (error) {
      // The primary bundle remains the source of truth; this is only for the old Worker.
    } finally {
      state.legacySportsPending = false;
    }
  }

  function showToast(message) {
    refs.toast.textContent = message;
    refs.toast.classList.add("is-visible");
    if (showToast.timer) window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () {
      refs.toast.classList.remove("is-visible");
    }, 3400);
  }

  function showDialog(dialog) {
    if (!dialog) return;
    state.lastFocusedElement = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function openSettings() {
    if (refs.settingsForm) {
      const theme = refs.settingsForm.elements.namedItem("theme");
      if (theme && theme.length) {
        Array.from(theme).forEach(function (radio) {
          radio.checked = radio.value === state.settings.theme;
        });
      }
      refs.motionSetting.value = state.settings.motion;
      refs.densitySetting.value = state.settings.density;
      refs.secondsSetting.checked = state.settings.seconds;
      refs.locationSetting.value = state.settings.location;
    }
    showDialog(refs.settingsDialog);
  }

  function openLive() {
    const sports = state.bundle && state.bundle.sports;
    const live = readArray(sports && sports.live, 30).map(function (item) {
      return normaliseSport(item, true);
    });
    renderLiveDialog(live);
    showDialog(refs.liveDialog);
  }

  function openWeather() {
    renderWeatherDialog(state.bundle && state.bundle.weather);
    showDialog(refs.weatherDialog);
  }

  function loadSpotifyTokens() {
    try {
      const tokens = JSON.parse(localStorage.getItem(SPOTIFY_KEY) || "null");
      return tokens && tokens.access_token ? tokens : null;
    } catch (error) {
      return null;
    }
  }

  function saveSpotifyTokens(tokens) {
    try {
      if (tokens && tokens.access_token) localStorage.setItem(SPOTIFY_KEY, JSON.stringify(tokens));
      else localStorage.removeItem(SPOTIFY_KEY);
    } catch (error) {}
  }

  function updateSpotifyStatus() {
    const tokens = loadSpotifyTokens();
    if (tokens) {
      refs.spotifyLabel.textContent = "Spotify connected";
      refs.spotifyStatus.textContent = "Open Spotify controls";
      refs.spotifyButton.dataset.connected = "true";
    } else {
      refs.spotifyLabel.textContent = "Connect Spotify";
      refs.spotifyStatus.textContent = "Optional listening controls";
      refs.spotifyButton.dataset.connected = "false";
    }
  }

  function connectSpotify() {
    const popup = window.open(
      WORKER_ORIGIN + "/spotify/login",
      "dashSpotify",
      "popup,width=560,height=720,resizable=yes,scrollbars=yes"
    );
    if (!popup) {
      showToast("Allow pop-ups to connect Spotify.");
      return;
    }
    state.spotifyPopup = popup;
    showToast("Spotify authorization opened in a new window.");
  }

  async function toggleKiosk() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      showToast("Fullscreen is unavailable in this browser.");
    }
  }

  function updateKioskLabel() {
    const active = Boolean(document.fullscreenElement);
    refs.kioskButton.lastElementChild.textContent = active ? "Exit kiosk" : "Kiosk";
    refs.kioskButton.setAttribute("aria-pressed", String(active));
  }

  function updateClock() {
    const now = new Date();
    refs.clock.textContent = formatClock(now);
    refs.clock.dateTime = now.toISOString();
  }

  document.querySelectorAll("[data-close-dialog]").forEach(function (button) {
    button.addEventListener("click", function () {
      closeDialog(document.getElementById(button.dataset.closeDialog));
    });
  });

  [refs.liveDialog, refs.weatherDialog, refs.settingsDialog].forEach(function (dialog) {
    if (!dialog) return;
    dialog.addEventListener("close", function () {
      if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
        state.lastFocusedElement.focus();
      }
      state.lastFocusedElement = null;
    });
  });

  refs.settingsForm.addEventListener("submit", function (event) {
    const submitter = event.submitter;
    if (submitter && submitter.value === "cancel") return;
    event.preventDefault();
    const selectedTheme = refs.settingsForm.elements.namedItem("theme");
    const selected = selectedTheme && Array.from(selectedTheme).find(function (radio) {
      return radio.checked;
    });
    state.settings = {
      theme: selected ? selected.value : "pink",
      motion: refs.motionSetting.value,
      density: refs.densitySetting.value,
      seconds: refs.secondsSetting.checked,
      location: clean(refs.locationSetting.value).slice(0, 80),
    };
    saveSettings();
    applySettings();
    closeDialog(refs.settingsDialog);
    loadBundle(true);
  });

  refs.settingsButton.addEventListener("click", openSettings);
  refs.weatherButton.addEventListener("click", openWeather);
  refs.alertsButton.addEventListener("click", openWeather);
  refs.liveButton.addEventListener("click", openLive);
  refs.openLiveButton.addEventListener("click", openLive);
  refs.openLiveFromPanel.addEventListener("click", openLive);
  refs.openWeatherButton.addEventListener("click", openWeather);
  refs.refreshButton.addEventListener("click", function () {
    loadBundle(true);
  });
  refs.clearFocusButton.addEventListener("click", renderEmptyFocus);
  refs.spotifyButton.addEventListener("click", connectSpotify);
  refs.kioskButton.addEventListener("click", toggleKiosk);
  document.addEventListener("fullscreenchange", updateKioskLabel);
  window.addEventListener("online", function () {
    if (!state.loading) loadBundle(true);
  });
  window.addEventListener("message", function (event) {
    if (event.origin !== WORKER_ORIGIN) return;
    if (state.spotifyPopup && event.source !== state.spotifyPopup) return;
    const data = event.data;
    if (!data || data.type !== "spotify") return;
    if (data.ok && data.access_token) {
      saveSpotifyTokens(data);
      updateSpotifyStatus();
      showToast("Spotify connected.");
    } else {
      showToast("Spotify connection was not completed.");
    }
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !state.loading && (!state.lastSuccess || Date.now() - state.lastSuccess > REFRESH_MS)) {
      loadBundle(false);
    }
  });
  if (window.matchMedia) {
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", function () {
      applySettings();
    });
  }
  window.setInterval(updateClock, 1000);
  window.setInterval(function () {
    if (state.lastSuccess && Date.now() - state.lastSuccess > MAX_BUNDLE_AGE_MS) {
      refs.dataAge.textContent = formatAge(state.lastSuccess);
    }
  }, 30000);

  applySettings();
  updateSpotifyStatus();
  updateKioskLabel();
  renderInitialState();
  loadBundle(false);
})();
