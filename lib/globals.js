// The browser globals the engine assumes, and nothing more.
//
// Ordering is load-bearing. assets.js:45 does
//
//     const origin = typeof window !== "undefined" ? window.location.origin : "";
//
// at MODULE SCOPE, so `window` must exist before the first game import or every
// asset URL is built relative-only for the life of the process. That single line
// is why the whole harness imports game code dynamically.
//
// What is deliberately NOT shimmed matters as much as what is:
//
//   document   only startTranslator() touches it, and nothing calls that
//   caches     absent -> getPersistentCache() returns null (assets.js:306) and
//              cache persistence is skipped, which is what we want anyway
//   Worker     absent -> regionSeed.js:96 falls back to parsing inline, free
//              since stock geometry ships no geojson
//
// Shimming those would invite the engine down browser paths a headless run has no
// business exercising.

import { fileURLToPath } from "node:url";

/**
 * localStorage, in memory.
 *
 * Required, not optional: mapSettings.js:22 getMapSetting calls
 * localStorage.getItem unguarded, and simulateTimelineJump calls it
 * (gameplay.js:2459) to decide whether to bound generation. It is also how the
 * harness injects the provider and API key, since the game stores those nowhere
 * else.
 */
export class MemoryStorage {
  #map = new Map();

  // MUST return null rather than undefined. providerConfig.readStoredValue:114
  // tests `!== null` to decide whether to fall through to legacyKeys and then to
  // a default, so undefined would make every provider setting look explicitly set
  // to nothing.
  getItem(key) {
    const value = this.#map.get(String(key));
    return value === undefined ? null : value;
  }

  setItem(key, value) {
    this.#map.set(String(key), String(value));
  }

  removeItem(key) {
    this.#map.delete(String(key));
  }

  clear() {
    this.#map.clear();
  }

  key(index) {
    return [...this.#map.keys()][index] ?? null;
  }

  get length() {
    return this.#map.size;
  }

  /** Test/report seam: what the run actually configured. */
  toObject() {
    return Object.fromEntries(this.#map);
  }
}

const installed = { active: false, restore: [] };

const define = (name, value) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const previous = globalThis[name];
  installed.restore.push(() => {
    if (had) globalThis[name] = previous;
    else delete globalThis[name];
  });
  globalThis[name] = value;
};

/**
 * Install window, localStorage and the fetch resolver.
 *
 * `settings` seeds localStorage — provider, API key, and the generation limit.
 */
export const installGlobals = ({ baseUrl, fetchImpl, settings = {} } = {}) => {
  if (installed.active) throw new Error("[harness globals] already installed");
  if (!baseUrl) throw new Error("[harness globals] installGlobals needs a baseUrl");

  const url = new URL(baseUrl);
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined && value !== null) storage.setItem(key, value);
  }

  // A real origin means assets.js builds ABSOLUTE urls, so buildAbsoluteUrl,
  // withRuntimeToken and the pmtiles FetchSource all work with no rewriting.
  // EventTarget covers the events the engine dispatches after a turn
  // (gameplay.js:1817) and after a colour change (assets.js:189); Node has had
  // Event and CustomEvent globally since 19.
  const windowShim = Object.assign(new EventTarget(), {
    location: {
      origin: url.origin,
      href: `${url.origin}/`,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: "/",
      search: "",
      hash: "",
      toString: () => `${url.origin}/`,
    },
    localStorage: storage,
    // Some code paths read these off window rather than globalThis.
    fetch: fetchImpl ?? globalThis.fetch,
  });

  // Defining `window` is what convinces maplibre-gl it is in a browser, and its
  // module-scope init then calls window.URL.createObjectURL to install a worker
  // (maplibre-gl.js:34). Without `window` it takes a quieter path — so the shim
  // has to finish the illusion it started. The harness never constructs a Map, so
  // the worker URL is never dereferenced and a stub costs nothing.
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:oh-harness/never-fetched";
    URL.revokeObjectURL = () => {};
    installed.restore.push(() => {
      delete URL.createObjectURL;
      delete URL.revokeObjectURL;
    });
  }
  windowShim.URL = URL;
  windowShim.Blob = globalThis.Blob;

  define("window", windowShim);
  define("localStorage", storage);
  define("self", windowShim);
  if (fetchImpl) define("fetch", fetchImpl);

  installed.active = true;
  return { window: windowShim, localStorage: storage };
};

export const uninstallGlobals = () => {
  while (installed.restore.length) installed.restore.pop()();
  installed.active = false;
};

export const areGlobalsInstalled = () => installed.active;

/** Resolve a module inside the target checkout, for dynamic import. */
export const gameModuleUrl = (targetPath, relative) =>
  new URL(`file://${targetPath.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}/${relative}`).href;

export { fileURLToPath };
