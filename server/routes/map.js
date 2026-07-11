// /map - a lightweight alerts map for PagerMon.
//
// Renders a Leaflet map of pages from the last N hours. Because messages have no
// coordinate columns, each page's street address is extracted from the message
// text and geocoded (see geocode.js, results cached to disk). Two endpoints:
//
//   GET /map        -> the map page (HTML)
//   GET /map/data   -> JSON { stats, units, points } for the requested window
//
// Access follows the same messages:apiSecurity setting as the message feed, so
// if the instance is public the map is public, and if it's locked down a login
// (or API key) is required.

var express = require('express');
var router = express.Router();
var nconf = require('nconf');
var logger = require('./../log');
var db = require('./../knex/knex.js');
var authHelper = require('./../middleware/authhelper');
var geocode = require('./geocode');

var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

var MAX_HOURS = 24;
var MAX_ROWS = 8000;
var combinedPool = null;

function getCombinedPool() {
  var dsn = process.env.SNO911_PG_DSN;
  if (!dsn) return null;
  if (!combinedPool) {
    var Pool = require('pg').Pool;
    combinedPool = new Pool({
      connectionString: dsn,
      ssl: process.env.SNO911_PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    combinedPool.on('error', function (err) {
      logger.main.error('[map] Postgres pool error: ' + err.message);
    });
  }
  return combinedPool;
}

function clampHours(v) {
  var h = parseInt(v, 10);
  if (isNaN(h) || h <= 0) h = 24;
  if (h > MAX_HOURS) h = MAX_HOURS;
  return h;
}

// Build the base message query for a time window, excluding ignored capcodes.
function windowQuery(cutoff) {
  return db.from('messages')
    .leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
    .where('messages.timestamp', '>=', cutoff)
    .andWhere(function () {
      this.where('capcodes.ignore', 0).orWhereNull('capcodes.ignore');
    });
}

var COMBINED_SQL = `
WITH combined AS (
  SELECT extract(epoch from o.occurred_at)::bigint AS timestamp,
         ST_Y(o.geom) AS lat, ST_X(o.geom) AS lon,
         'PagerMon'::text AS source, 'Fire/Aid'::text AS category,
         coalesce(d.agency, '') AS agency, coalesce(d.call_type, '') AS call_type,
         coalesce(array_to_string(d.units, ', '), '') AS units,
         coalesce(d.address, d.place_name, o.body, '') AS detail,
         NULL::double precision AS magnitude
    FROM observations o
    JOIN page_details d ON d.observation_id = o.id
   WHERE o.has_geo AND o.kind = 'page' AND o.occurred_at >= to_timestamp($1)
  UNION ALL
  SELECT extract(epoch from o.occurred_at)::bigint,
         ST_Y(o.geom), ST_X(o.geom), 'FirstWatch',
         CASE WHEN fd.agency_type = 'Police' THEN 'Police' ELSE 'Fire/Aid' END,
         coalesce(fd.agency, ''), coalesce(fd.call_type, ''),
         coalesce(array_to_string(fd.units, ', '), ''),
         coalesce(fd.address_masked, o.body, ''), NULL::double precision
    FROM observations o
    JOIN firstwatch_details fd ON fd.observation_id = o.id
   WHERE o.has_geo AND o.kind = 'firstwatch' AND o.occurred_at >= to_timestamp($1)
  UNION ALL
  SELECT extract(epoch from received_at)::bigint,
         ST_Y(geom), ST_X(geom), 'IceOut', 'ICE sighting',
         'iceout.org', coalesce(body, ''), '', coalesce(body, ''), NULL::double precision
    FROM iceout_push_alert
   WHERE geom IS NOT NULL AND received_at >= to_timestamp($1)
  UNION ALL
  SELECT extract(epoch from o.occurred_at)::bigint,
         ST_Y(o.geom), ST_X(o.geom), 'Earthquake', 'Earthquake',
         coalesce(q.net, ''), 'M' || coalesce(q.magnitude::text, '?') ||
           ' @' || round(coalesce(q.depth_km, 0)::numeric, 0) || 'km',
         '', coalesce(q.place, o.body, ''), q.magnitude
    FROM observations o
    JOIN quake_details q ON q.observation_id = o.id
   WHERE o.has_geo AND o.kind = 'earthquake' AND q.magnitude >= 2
     AND o.occurred_at >= to_timestamp($1)
)
SELECT * FROM combined
 WHERE ($2 = '' OR source = $2)
 ORDER BY timestamp DESC
 LIMIT $3`;

function markerStyle(source, category) {
  if (source === 'FirstWatch') {
    return { shape: 'square', color: category === 'Police' ? '#3274D9' : '#E0243F' };
  }
  if (source === 'IceOut') return { shape: 'triangle', color: '#FADE2A' };
  if (source === 'Earthquake') return { shape: 'cross', color: '#F2A93B' };
  return { shape: 'circle', color: '#E0243F' };
}

async function combinedMapData(hours, source, now) {
  var pool = getCombinedPool();
  if (!pool) return null;
  var cutoff = now - hours * 3600;
  var result = await pool.query(COMBINED_SQL, [cutoff, source, MAX_ROWS]);
  var counts = {};
  var recent = 0;
  var points = result.rows.map(function (row) {
    var timestamp = Number(row.timestamp);
    var style = markerStyle(row.source, row.category);
    counts[row.source] = (counts[row.source] || 0) + 1;
    if (timestamp >= now - 3600) recent++;
    return {
      lat: Number(row.lat), lon: Number(row.lon), timestamp: timestamp,
      source: row.source, category: row.category, agency: row.agency,
      callType: row.call_type, units: row.units, detail: row.detail,
      magnitude: row.magnitude == null ? null : Number(row.magnitude),
      shape: style.shape, color: style.color, recent: timestamp >= now - 3600
    };
  });
  return {
    generated: now, hours: hours, source: source, mode: 'combined',
    stats: { total: points.length, mapped: points.length, unmapped: 0, pending: 0, recent: recent, bySource: counts },
    sources: ['PagerMon', 'FirstWatch', 'IceOut', 'Earthquake'],
    points: points
  };
}

// GET /map - the page
router.get('/', function (req, res, next) {
  nconf.load();
  if (nconf.get('messages:apiSecurity') && !req.isAuthenticated()) {
    req.flash('loginMessage', 'You need to be logged in to access this page');
    return res.redirect('/auth/login');
  }
  res.render('map', {
    pageTitle: 'Alerts Map',
    monitorName: nconf.get('global:monitorName') || 'PagerMon',
    login: req.isAuthenticated(),
    user: req.user || false,
    defaultCenter: nconf.get('map:center') || '47.9789,-122.2021', // Everett, WA (Snohomish County)
    defaultZoom: nconf.get('map:zoom') || 10
  });
});

// GET /map/data - geocoded points for the requested window
router.get('/data', authHelper.isLoggedInMessages, async function (req, res) {
  nconf.load();
  var hours = clampHours(req.query.hours);
  var now = Math.floor(Date.now() / 1000);
  var cutoff = now - hours * 3600;
  var unit = (req.query.unit || '').trim();
  var source = (req.query.source || '').trim();
  var geocodeBudget = parseInt(nconf.get('map:geocodeBudget'), 10);
  if (isNaN(geocodeBudget)) geocodeBudget = 150;

  try {
    var combined = await combinedMapData(hours, source, now);
    if (combined) return res.status(200).json(combined);

    // Distinct units in the window (for the filter dropdown), independent of the
    // currently-selected unit so the list stays stable.
    var unitRows = await windowQuery(cutoff)
      .distinct('capcodes.alias as alias', 'capcodes.agency as agency', 'capcodes.color as color')
      .whereNotNull('capcodes.alias');
    var units = unitRows
      .filter(function (u) { return u.alias; })
      .map(function (u) { return { alias: u.alias, agency: u.agency || '', color: u.color || '' }; })
      .sort(function (a, b) { return a.alias.localeCompare(b.alias); });

    // Messages in the window (optionally filtered by unit).
    var q = windowQuery(cutoff)
      .select(
        'messages.id as id',
        'messages.address as address',
        'messages.message as message',
        'messages.source as source',
        'messages.timestamp as timestamp',
        'capcodes.alias as alias',
        'capcodes.agency as agency',
        'capcodes.icon as icon',
        'capcodes.color as color'
      )
      .orderBy('messages.timestamp', 'desc')
      .limit(MAX_ROWS);

    if (unit) {
      q = q.andWhere(function () {
        this.where('capcodes.alias', 'like', '%' + unit + '%')
            .orWhere('capcodes.agency', 'like', '%' + unit + '%');
      });
    }

    var rows = await q;

    var points = [];
    var stats = { total: rows.length, mapped: 0, unmapped: 0, geocodedNow: 0, pending: 0 };

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var loc = geocode.extractLocation(row.message);
      var coords = null;

      if (loc && loc.coords) {
        coords = loc.coords;
      } else if (loc && loc.address) {
        var cached = geocode.fromCache(loc.address);
        if (cached && cached.lat != null) {
          coords = { lat: cached.lat, lon: cached.lon };
        } else if (cached === null) {
          // known geocoding miss - leave unmapped
        } else if (geocodeBudget > 0) {
          // not cached yet - spend part of this request's budget on it
          geocodeBudget--;
          var g = await geocode.geocode(loc.address);
          if (g) {
            coords = { lat: g.lat, lon: g.lon };
            stats.geocodedNow++;
          }
        } else {
          stats.pending++;
        }
      }

      if (coords) {
        stats.mapped++;
        points.push({
          id: row.id,
          lat: coords.lat,
          lon: coords.lon,
          address: loc && loc.address ? loc.address : null,
          capcode: row.address,
          alias: row.alias || null,
          agency: row.agency || null,
          icon: row.icon || null,
          color: row.color || null,
          message: row.message,
          source: row.source,
          timestamp: row.timestamp
        });
      } else {
        stats.unmapped++;
      }
    }

    res.status(200).json({
      generated: now,
      hours: hours,
      unit: unit,
      mode: 'pagermon',
      stats: stats,
      units: units,
      sources: ['PagerMon'],
      points: points
    });
  } catch (err) {
    logger.main.error('[map] data error: ' + (err && err.message ? err.message : err));
    res.status(500).json({ error: 'Failed to load map data' });
  }
});

module.exports = router;
