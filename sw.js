/*
 * Static Frequency: offline cache (web only; the iPhone app carries every file and has no service worker).
 *
 * The build step (vite.config.ts, `assetList`) replaces BUILD_ID with a hash of what was shipped, and writes
 * asset-list.json beside this file. The cache is named by that id, so a new deploy gets an empty cache of its own
 * and this build's `activate` deletes every older one: a stale build is never served.
 *
 *   - index.html, navigations, asset-list.json, sw.js: network first (cache only when the network fails or is slow)
 *   - every other file of the game: cache first, filled from the network on a miss
 *   - Range requests (video) are answered from a cached whole file; uncached ones go straight to the network
 *
 * Everything is guarded: if the cache API fails, the request simply goes to the network.
 */
const BUILD_ID = '97f5bf2b923a';
const PREFIX = 'sf-';
const CACHE = PREFIX + BUILD_ID;
const SHELL_WAIT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        // (The page and the list of files, so a first offline start has something to open; failures are not fatal.)
        await Promise.allSettled(['./', './index.html', './asset-list.json'].map((u) => cache.add(new Request(u, { cache: 'reload' }))));
        // And the code (assets/*.js, *.css: a few MB, named by their hash): without it the page above is a white screen
        // offline, since the chunks the page loaded before this worker took over (or under the build before it, whose
        // cache `activate` deletes) are not in this cache.
        const listed = await cache.match('./asset-list.json');
        const files = listed ? ((await listed.json()).files ?? []) : [];
        const code = files.map((f) => f && f.p).filter((p) => typeof p === 'string' && /^assets\/[^/]+\.(js|css)$/.test(p));
        await Promise.allSettled(code.map((p) => cache.add(p)));
      } catch {
        // No cache: the worker still works as a pass-through.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
      } catch {
        // Old caches stay; they are never read.
      }
      await self.clients.claim();
    })(),
  );
});

function isShell(request, url) {
  return request.mode === 'navigate' || /\/(index\.html|asset-list\.json|sw\.js)$/.test(url.pathname) || url.pathname.endsWith('/');
}

async function fromCache(request) {
  try {
    const cache = await caches.open(CACHE);
    return await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  } catch {
    return undefined;
  }
}

function put(request, response) {
  if (!response || response.status !== 200 || response.type === 'opaque') return;
  const copy = response.clone();
  caches
    .open(CACHE)
    .then((cache) => cache.put(request, copy))
    .catch(() => {});
}

async function shell(request) {
  const fresh = fetch(request).then((r) => {
    if (r.ok) put(request, r);
    return r;
  });
  const cached = await fromCache(request).then((r) => r ?? fromCache('./index.html'));
  if (!cached) return fresh;
  // A slow network with a copy in hand: the copy after a few seconds, the network if it answers first.
  const wait = new Promise((resolve) => setTimeout(() => resolve(cached), SHELL_WAIT_MS));
  try {
    return await Promise.race([fresh, wait]);
  } catch {
    return cached;
  }
}

async function ranged(request, response) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (!m) return response;
  // (A Blob, sliced: the film is some 18 MB, and the player asks for it in many small ranges; reading the whole of it
  // into memory for each one is enough for iOS to close the tab.)
  const buf = await response.blob();
  const size = buf.size;
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

async function asset(request) {
  // The menu's Download fills the cache itself: no second copy from here.
  if (request.headers.has('x-sf-download')) return fetch(request);
  const cached = await fromCache(request);
  if (request.headers.has('range')) {
    if (cached) {
      try {
        return await ranged(request, cached);
      } catch {
        // Fall through to the network.
      }
    }
    return fetch(request);
  }
  if (cached) return cached;
  const response = await fetch(request);
  put(request, response);
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.location.href).pathname)) return;
  event.respondWith((isShell(request, url) ? shell(request) : asset(request)).catch(() => fetch(request)));
});
