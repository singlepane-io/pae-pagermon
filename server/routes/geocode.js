// Geocoding helper for the /map view.
//
// PagerMon messages are plain POCSAG text with no coordinate columns, so to put
// pages on a map we have to pull a street address (or explicit lat/lon) out of
// the message body and geocode it. Results are cached to a JSON file so we only
// ever hit an external geocoder once per unique address.
//
// Two providers are used, in order:
//   1. US Census geocoder  - free, no API key, US-only, great for CAD addresses
//   2. Nominatim (OSM)      - fallback, throttled to respect the usage policy
//
// Everything here is best-effort: if geocoding fails the page is simply reported
// as "unmapped" rather than breaking the map.

var fs = require('fs');
var path = require('path');
var axios = require('axios').default;
var nconf = require('nconf');
var logger = require('./../log');

// --- configuration (all overridable via config.json under the "map" key) -----

// Region hint appended to an extracted address when it doesn't already name a
// state. SNO911 is Snohomish County, WA, so bias to Washington by default.
function cfg(key, fallback) {
  var v = nconf.get('map:' + key);
  return (v === undefined || v === null || v === '') ? fallback : v;
}

var MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-try a failed lookup after a week
var NOMINATIM_MIN_INTERVAL_MS = 1100;      // >= 1 req/sec per Nominatim policy

// --- cache -------------------------------------------------------------------

var cache = null;       // { normalizedAddress: { lat, lon, provider, ts } | { miss: true, ts } }
var cacheDirty = false;
var cacheFile = null;
var saveTimer = null;

function cachePath() {
  if (cacheFile) return cacheFile;
  // Store the cache next to the sqlite database when we can, otherwise in ./config.
  var dbFile = nconf.get('database:file');
  var dir;
  if (dbFile && nconf.get('database:type') === 'sqlite3') {
    dir = path.dirname(path.resolve(dbFile));
  } else {
    dir = path.resolve('./config');
  }
  cacheFile = path.join(dir, 'geocache.json');
  return cacheFile;
}

function loadCache() {
  if (cache) return cache;
  cache = {};
  try {
    var raw = fs.readFileSync(cachePath(), 'utf8');
    cache = JSON.parse(raw) || {};
  } catch (e) {
    // Missing/unreadable cache is fine - we start empty.
    cache = {};
  }
  return cache;
}

function scheduleSave() {
  cacheDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      fs.writeFileSync(cachePath(), JSON.stringify(cache));
    } catch (e) {
      logger.main.warn('[map] could not persist geocode cache: ' + e.message);
    }
  }, 2000);
  if (saveTimer.unref) saveTimer.unref();
}

// --- address extraction ------------------------------------------------------

var STREET_SUFFIX = 'ST|STREET|AVE?|AVENUE|BLVD|BOULEVARD|RD|ROAD|DR|DRIVE|LN|LANE|WAY|CT|COURT|PL|PLACE|HWY|HIGHWAY|PKWY|PARKWAY|TER|TERRACE|CIR|CIRCLE|LOOP|TRL|TRAIL|SQ|SQUARE|PT|POINT|SR|CV|COVE|XING|CROSSING|ALY|ALLEY|RUN|ROW|WALK|BND|BEND';
var DIRECTIONAL = 'N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST';

// number + [optional leading direction] + street words + suffix + [optional trailing direction]
var ADDRESS_RE = new RegExp(
  '\\b(\\d{1,6}\\s+(?:(?:' + DIRECTIONAL + ')\\s+)?[0-9A-Za-z.\\-\']+(?:\\s+[0-9A-Za-z.\\-\']+){0,4}\\s+(?:' + STREET_SUFFIX + ')(?:\\s+(?:' + DIRECTIONAL + '))?)\\b',
  'i'
);

// explicit decimal coordinates, e.g. "47.9789,-122.2021" or "47.9789 -122.2021"
var COORD_RE = /(-?\d{1,2}\.\d{3,})[,\s]+(-?\d{2,3}\.\d{3,})/;

// A caller may supply a custom extraction regex (single capture group) via config.
function customRegex() {
  var src = cfg('addressRegex', null);
  if (!src) return null;
  try {
    return new RegExp(src, 'i');
  } catch (e) {
    logger.main.warn('[map] invalid map:addressRegex, ignoring: ' + e.message);
    return null;
  }
}

// Returns { coords: {lat, lon} } or { address: 'string' } or null.
function extractLocation(message) {
  if (!message) return null;
  var text = String(message);

  var coordM = text.match(COORD_RE);
  if (coordM) {
    var lat = parseFloat(coordM[1]);
    var lon = parseFloat(coordM[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001)) {
      return { coords: { lat: lat, lon: lon } };
    }
  }

  var custom = customRegex();
  if (custom) {
    var cm = text.match(custom);
    if (cm) return { address: (cm[1] || cm[0]).trim() };
  }

  var m = text.match(ADDRESS_RE);
  if (m) return { address: m[1].replace(/\s+/g, ' ').trim() };

  return null;
}

// --- geocoding ---------------------------------------------------------------

function normalizeAddress(address) {
  var region = cfg('region', 'WA');
  var addr = address.trim();
  // Only append the region hint when the address doesn't already carry a state.
  // A trailing directional (RD SE, ST NW, ...) must NOT be mistaken for a state,
  // so require a comma before the two-letter code.
  var hasState = /,\s*[A-Z]{2}\b/i.test(addr) || new RegExp('\\b' + region + '\\b', 'i').test(addr);
  if (region && !hasState) {
    addr = addr + ', ' + region;
  }
  return addr.replace(/\s+/g, ' ').trim();
}

var lastNominatim = 0;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function geocodeCensus(address) {
  var url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
  var res = await axios.get(url, {
    params: { address: address, benchmark: 'Public_AR_Current', format: 'json' },
    timeout: 8000
  });
  var matches = res.data && res.data.result && res.data.result.addressMatches;
  if (matches && matches.length) {
    var c = matches[0].coordinates;
    return { lat: c.y, lon: c.x, provider: 'census' };
  }
  return null;
}

async function geocodeNominatim(address) {
  var wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  var res = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: address, format: 'json', limit: 1, countrycodes: cfg('countryCodes', 'us') },
    timeout: 8000,
    headers: { 'User-Agent': 'PagerMon-Map/1.0 (self-hosted)' }
  });
  if (res.data && res.data.length) {
    return { lat: parseFloat(res.data[0].lat), lon: parseFloat(res.data[0].lon), provider: 'nominatim' };
  }
  return null;
}

// Look an address up in cache; return coords or null. Does NOT hit the network.
function fromCache(address) {
  loadCache();
  var key = normalizeAddress(address).toLowerCase();
  var hit = cache[key];
  if (!hit) return undefined; // unknown - caller may choose to geocode
  if (hit.miss) {
    if (Date.now() - hit.ts < MISS_TTL_MS) return null; // known miss, still fresh
    return undefined; // stale miss - allow a retry
  }
  return { lat: hit.lat, lon: hit.lon, provider: hit.provider };
}

// Geocode an address, hitting the network only on a cache miss.
async function geocode(address) {
  loadCache();
  var key = normalizeAddress(address).toLowerCase();
  var cached = fromCache(address);
  if (cached !== undefined) return cached;

  var query = normalizeAddress(address);
  var result = null;
  try {
    result = await geocodeCensus(query);
  } catch (e) {
    logger.main.debug('[map] census geocode error: ' + e.message);
  }
  if (!result) {
    try {
      result = await geocodeNominatim(query);
    } catch (e) {
      logger.main.debug('[map] nominatim geocode error: ' + e.message);
    }
  }

  if (result) {
    cache[key] = { lat: result.lat, lon: result.lon, provider: result.provider, ts: Date.now() };
  } else {
    cache[key] = { miss: true, ts: Date.now() };
  }
  scheduleSave();
  return result;
}

module.exports = {
  extractLocation: extractLocation,
  geocode: geocode,
  fromCache: fromCache,
  normalizeAddress: normalizeAddress
};
