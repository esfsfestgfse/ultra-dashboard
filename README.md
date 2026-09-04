# DASH 5.1

DASH is a static GitHub Pages display backed by one Cloudflare Worker bundle.
The browser renders text through DOM nodes, uses one guarded refresh loop, and
keeps the last good data visible when an upstream feed is slow or unavailable.

## Pages

The public dashboard is intended to run at:

https://esfsfestgfse.github.io/ultra-dashboard/

GitHub Pages should serve the repository root from main.

## Worker

cloudflare-dash-worker.js is the edge source. Deploy it with Wrangler from a
Cloudflare-authenticated environment. Keep credentials in Worker secrets:

    wrangler secret put SPOTIFY_CLIENT_SECRET
    wrangler secret put GNEWS_API_KEY
    wrangler secret put THENEWS_API_KEY
    wrangler secret put NEWSAPI_KEY

The news-provider secrets are optional; RSS and ESPN feeds provide the
no-secret fallback. An R2 binding named DASH_BUCKET is optional and enables a
last-good bundle snapshot.

The existing Spotify callback URI is intentionally unchanged:

https://lucky-unit-4667.tdy1990.workers.dev/spotify/callback

Do not place API keys in index.html, app.js, or styles.css.
