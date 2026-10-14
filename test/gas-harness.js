// Runs apps-script/Code.gs in a vm with in-memory fakes of the Apps Script services and the Calendar REST API.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const MIN = 60e3, DAY = 864e5, OFF = 300 * MIN;

function makeCalendars() {
  // Real shape of Jay's day (05.10): prayer events (free), gym, an evening meeting; repeated for 25 days.
  const cal = { primary: [], 'javokhir.k@alliancevs.io': [] };
  const t0 = Math.floor((Date.now() + OFF) / DAY) * DAY - OFF; // Tashkent midnight today
  const at = (d, h, m) => t0 + d * DAY + (h * 60 + m) * MIN;
  for (let d = 0; d < 25; d++) {
    cal.primary.push(ev(at(d, 8, 30), at(d, 10, 30), '1FIT gym'));
    cal.primary.push(ev(at(d, 12, 11), at(d, 12, 31), 'Dhuhr', 'transparent'));
    cal.primary.push(ev(at(d, 15, 25), at(d, 15, 45), 'Asr', 'transparent'));
    cal.primary.push(ev(at(d, 17, 58), at(d, 18, 18), 'Maghrib', 'transparent'));
    cal.primary.push({ ...ev(at(d, 0, 0), at(d + 1, 0, 0), 'All-day thing'), start: { date: 'x' }, end: { date: 'y' } });
  }
  cal.primary.push(ev(at(0, 19, 0), at(0, 20, 0), 'Meeting Otabek aka'));
  cal.primary.push({ ...ev(at(1, 11, 0), at(1, 12, 0), 'Declined invite'), attendees: [{ self: true, responseStatus: 'declined' }] });
  cal['javokhir.k@alliancevs.io'].push(ev(at(3, 13, 45), at(3, 15, 0), "Go'zal opa massaj center")); // future day: busy_ only reads from now on
  return cal;
  function ev(s, e, summary, transparency) {
    return { id: Math.random().toString(36).slice(2), status: 'confirmed', summary, transparency,
      start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(e).toISOString() } };
  }
}

function load(opts = {}) {
  const calendars = opts.calendars || makeCalendars();
  const cache = new Map();
  const inserted = [];
  const notified = [];
  const props = opts.props || {};
  const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });

  function http(url, o = {}) {
    if (url.startsWith('https://api.telegram.org/')) { notified.push(o.payload); return res(200, { ok: true }); }
    const m = url.match(/calendars\/([^/]+)\/events(?:\/([^?]+))?\?(.*)$/);
    if (!m) throw new Error('unexpected url ' + url);
    const id = decodeURIComponent(m[1]) === 'primary' ? 'primary' : decodeURIComponent(m[1]);
    const q = new URLSearchParams(m[3]);
    if (!calendars[id] || (opts.deny || []).includes(id)) return res(404, { error: { code: 404 } });
    if ((o.method || 'get') === 'post') {
      const body = JSON.parse(o.payload);
      const ev = { id: 'ev' + (inserted.length + 1), status: 'confirmed', ...body,
        hangoutLink: body.conferenceData && !opts.asyncMeet ? 'https://meet.google.com/abc-defg-hij' : undefined };
      calendars[id].push(ev); inserted.push({ ev, query: Object.fromEntries(q) });
      return res(200, ev);
    }
    if (m[2]) { const ev = calendars[id].find(e => e.id === m[2]); return res(200, { id: ev.id, hangoutLink: 'https://meet.google.com/late-link-xyz' }); }
    const lo = Date.parse(q.get('timeMin')), hi = Date.parse(q.get('timeMax'));
    const items = calendars[id].filter(e => {
      const s = Date.parse(e.start.dateTime || '1970-01-01'), en = Date.parse(e.end.dateTime || '1970-01-01');
      return e.start.dateTime ? (en > lo && s < hi) : true;
    });
    return res(200, { items });
  }

  const pad = n => String(n).padStart(2, '0');
  const ctx = {
    console: { log() {}, warn() {}, error: e => { if (opts.verbose) console.error(e); } },
    ScriptApp: { getOAuthToken: () => 'tok' },
    UrlFetchApp: { fetch: http, fetchAll: reqs => reqs.map(r => http(r.url, r)) },
    CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
    Utilities: {
      getUuid: () => 'uuid-' + Math.random(), sleep() {},
      formatDate: (d, tz, f) => { const x = new Date(d.getTime() + OFF); return f.replace('yyyy', x.getUTCFullYear()).replace('MM', pad(x.getUTCMonth() + 1)).replace('dd', pad(x.getUTCDate())).replace('HH', pad(x.getUTCHours())).replace('mm', pad(x.getUTCMinutes())).replace('EEE', 'Mon'); },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
    CalendarApp: { getDefaultCalendar: () => ({ getId: () => 'javohirdiamond06@gmail.com' }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.CODE_GS || path.join(__dirname, "../apps-script/Code.gs"), "utf8"), ctx);
  const get = p => JSON.parse(ctx.doGet({ parameter: p }).s);
  const post = p => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(p) } }).s);
  return { ctx, get, post, inserted, notified, cache, calendars };
}

module.exports = { load, MIN, DAY, OFF };
