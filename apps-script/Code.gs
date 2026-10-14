/**
 * Javokhir — booking backend (Google Apps Script web app).
 *
 *   GET  ?action=slots[&fresh=1]  → { ok, now, settings, busy:[[startMs,endMs],…] }
 *   POST {action:'book', …}       → re-checks the slot under a lock, creates the event (+ Google Meet),
 *                                    returns { ok, id, start, end, mode, meet, location }
 *
 * Deploy: Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 * Required: Services → + → Google Calendar API (v3). It enables the Calendar API for the script's project;
 * without it every REST call below returns 403 and all slots look free.
 * Front-end: index.html on GitHub Pages (CONFIG.API = the /exec URL of this deployment).
 *
 * Optional Telegram ping on every booking: Project Settings → Script properties →
 *   TG_BOT_TOKEN = <bot token>, TG_CHAT_ID = <your chat id>. Nothing is sent when they are absent.
 */

const CFG = {
  TZ: 'Asia/Tashkent',
  OFFSET_MIN: 300,                 // UTC+5 — Uzbekistan has no DST
  OWNER: 'Javokhir Komiljonov',
  CALENDAR_ID: 'primary',          // bookings land here
  // Every timed event on these calendars blocks a slot. A calendar this account cannot read is skipped.
  BUSY_CALENDARS: ['primary', 'javokhir.k@alliancevs.io'],
  BLOCK_FREE_EVENTS: true,         // events marked "free" (prayer times etc.) still block slots
  DURATIONS: [30, 45, 60],
  STEP_MIN: 30,                    // slot grid
  BUFFER_MIN: 15,                  // gap kept before and after every busy event
  MIN_NOTICE_MIN: 180,             // earliest bookable slot = now + 3h
  HORIZON_DAYS: 21,
  // Working hours, Tashkent time. Weekday: 0 = Sunday … 6 = Saturday. Several ranges per day are fine.
  HOURS: {
    1: [['10:00', '19:00']],
    2: [['10:00', '19:00']],
    3: [['10:00', '19:00']],
    4: [['10:00', '19:00']],
    5: [['10:00', '19:00']],
    6: [['10:00', '15:00']],
  },
  OFFLINE_LOCATION: '',            // office address; empty → "agreed separately"
  MAX_PER_CONTACT: 2,              // bookings per phone/Telegram per 6 hours
  MAX_PER_DAY: 25,                 // all bookings per day — spam ceiling
  CACHE_SEC: 60,
};

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const API = 'https://www.googleapis.com/calendar/v3/calendars/';

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (!p.action || p.action === 'slots') return json_(slots_(p.fresh === '1'));
    if (p.action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server' });
  }
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (_) {
    return json_({ ok: false, error: 'bad_json' });
  }
  try {
    if (p.action === 'book') return json_(book_(p));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server' });
  }
}

/** Run once from the editor: grants access and prints what the page will see. */
function selfTest() {
  console.log('Bookings go to: ' + CalendarApp.getDefaultCalendar().getId());
  const r = slots_(true);
  console.log('Busy intervals in the next ' + CFG.HORIZON_DAYS + ' days: ' + r.busy.length);
  r.busy.slice(0, 10).forEach(([s, e]) => console.log(
    Utilities.formatDate(new Date(s), CFG.TZ, 'EEE dd.MM HH:mm') + ' – ' + Utilities.formatDate(new Date(e), CFG.TZ, 'HH:mm')));
}

// ---------------------------------------------------------------- availability

function slots_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('slots');
    if (hit) return JSON.parse(hit);
  }
  const now = Date.now();
  const out = {
    ok: true,
    now: now,
    settings: {
      tz: CFG.TZ,
      offsetMin: CFG.OFFSET_MIN,
      durations: CFG.DURATIONS,
      step: CFG.STEP_MIN,
      bufferMin: CFG.BUFFER_MIN,
      minNoticeMin: CFG.MIN_NOTICE_MIN,
      horizonDays: CFG.HORIZON_DAYS,
      hours: CFG.HOURS,
      offlineLocation: CFG.OFFLINE_LOCATION,
    },
    busy: busy_(now, now + (CFG.HORIZON_DAYS + 1) * DAY),
  };
  try { cache.put('slots', JSON.stringify(out), CFG.CACHE_SEC); } catch (_) { /* >100KB — just skip caching */ }
  return out;
}

/** Merged busy intervals across BUSY_CALENDARS, one parallel REST call per calendar. */
function busy_(from, to) {
  const token = ScriptApp.getOAuthToken();
  const query = qs_({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: 'true',
    maxResults: '2500',
    fields: 'items(status,start,end,transparency,attendees(self,responseStatus))',
  });
  const requests = CFG.BUSY_CALENDARS.map(id => ({
    url: API + encodeURIComponent(id) + '/events?' + query,
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  }));
  const list = [];
  UrlFetchApp.fetchAll(requests).forEach((res, i) => {
    if (res.getResponseCode() !== 200) {
      const msg = 'calendar ' + CFG.BUSY_CALENDARS[i] + ': HTTP ' + res.getResponseCode();
      // The bookings calendar must be readable, otherwise every slot would look free.
      if (CFG.BUSY_CALENDARS[i] === CFG.CALENDAR_ID) throw new Error('cannot read ' + msg);
      console.warn('skip ' + msg);
      return;
    }
    (JSON.parse(res.getContentText()).items || []).forEach(ev => {
      if (ev.status === 'cancelled' || !ev.start || !ev.start.dateTime) return; // all-day events don't block
      if (!CFG.BLOCK_FREE_EVENTS && ev.transparency === 'transparent') return;
      const me = (ev.attendees || []).find(a => a.self);
      if (me && me.responseStatus === 'declined') return;
      list.push([Date.parse(ev.start.dateTime), Date.parse(ev.end.dateTime)]);
    });
  });
  return merge_(list);
}

function merge_(list) {
  list.sort((a, b) => a[0] - b[0]);
  const out = [];
  list.forEach(([s, e]) => {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  });
  return out;
}

/** Same grid the page renders: inside a working range and on a STEP_MIN boundary from its start. */
function fitsHours_(start, dur) {
  const local = start + CFG.OFFSET_MIN * MIN;
  const dayStart = Math.floor(local / DAY) * DAY;
  const minute = (local - dayStart) / MIN;
  const ranges = CFG.HOURS[new Date(dayStart).getUTCDay()] || [];
  return ranges.some(([a, b]) => {
    const from = hm_(a);
    return minute >= from && minute + dur <= hm_(b) && (minute - from) % CFG.STEP_MIN === 0;
  });
}

// ---------------------------------------------------------------- booking

function book_(p) {
  if (p.website) return fail_('invalid'); // honeypot — humans never see this field
  const name = clean_(p.name, 80);
  const contact = clean_(p.contact, 60);
  const email = clean_(p.email, 120).toLowerCase();
  const company = clean_(p.company, 100);
  const topic = clean_(p.topic, 600);
  const mode = p.mode === 'offline' ? 'offline' : 'online';
  const dur = Number(p.duration);
  const start = Number(p.start);

  if (!name || !contact) return fail_('missing_fields');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail_('bad_email');
  if (CFG.DURATIONS.indexOf(dur) < 0) return fail_('bad_duration');
  const now = Date.now();
  if (!isFinite(start) || start < now + CFG.MIN_NOTICE_MIN * MIN || start > now + (CFG.HORIZON_DAYS + 1) * DAY) return fail_('out_of_range');
  if (!fitsHours_(start, dur)) return fail_('outside_hours');
  const end = start + dur * MIN;

  const cache = CacheService.getScriptCache();
  const who = 'rl:' + contact.toLowerCase().replace(/[^a-z0-9@+_]/g, '');
  const today = 'rl:day:' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_('busy_try_again');
  try {
    if (Number(cache.get(who) || 0) >= CFG.MAX_PER_CONTACT || Number(cache.get(today) || 0) >= CFG.MAX_PER_DAY) return fail_('too_many');

    const buf = CFG.BUFFER_MIN * MIN;
    if (busy_(start - buf, end + buf).some(([s, e]) => s < end + buf && e > start - buf)) {
      cache.remove('slots');
      return fail_('slot_taken');
    }

    const ev = createEvent_({ name, contact, email, company, topic, mode, dur, start, end });
    cache.remove('slots');
    cache.put(who, String(Number(cache.get(who) || 0) + 1), 21600);
    cache.put(today, String(Number(cache.get(today) || 0) + 1), 21600);

    notify_([
      '🗓 Yangi bron',
      Utilities.formatDate(new Date(start), CFG.TZ, 'EEE dd.MM, HH:mm') + '–' + Utilities.formatDate(new Date(end), CFG.TZ, 'HH:mm') +
        ' · ' + (mode === 'online' ? 'Online' : 'Oflayn') + ' · ' + dur + ' daq',
      '👤 ' + name + (company ? ' (' + company + ')' : ''),
      '📞 ' + contact + (email ? '\n✉️ ' + email : ''),
      topic ? '💬 ' + topic : '',
      ev.meet || '',
    ].filter(Boolean).join('\n'));

    return { ok: true, id: ev.id, start, end, mode, duration: dur, meet: ev.meet, location: mode === 'offline' ? CFG.OFFLINE_LOCATION : '' };
  } finally {
    lock.releaseLock();
  }
}

function createEvent_(o) {
  const location = o.mode === 'offline' ? (CFG.OFFLINE_LOCATION || 'Oflayn — manzil alohida kelishiladi') : '';
  const body = {
    summary: 'Javokhir × ' + o.name + ' — ' + o.dur + ' daq (' + (o.mode === 'online' ? 'Online' : 'Oflayn') + ')',
    description: [
      'Bron: meet sahifasi orqali',
      'Ism: ' + o.name,
      o.company ? 'Kompaniya: ' + o.company : '',
      'Kontakt: ' + o.contact,
      o.email ? 'Email: ' + o.email : '',
      o.topic ? '\nMavzu:\n' + o.topic : '',
    ].filter(Boolean).join('\n'),
    start: { dateTime: new Date(o.start).toISOString(), timeZone: CFG.TZ },
    end: { dateTime: new Date(o.end).toISOString(), timeZone: CFG.TZ },
    location: location,
    attendees: o.email ? [{ email: o.email, displayName: o.name }] : [],
    guestsCanModify: false,
    reminders: { useDefault: true },
    extendedProperties: { private: { bookedVia: 'meet-page', contact: o.contact } },
  };
  if (o.mode === 'online') {
    body.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  const url = API + encodeURIComponent(CFG.CALENDAR_ID) + '/events?conferenceDataVersion=1&sendUpdates=' + (o.email ? 'all' : 'none');
  const headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), headers: headers, muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('calendar insert ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 400));
  let ev = JSON.parse(res.getContentText());

  // Meet links are occasionally created asynchronously — one short re-read covers it.
  if (o.mode === 'online' && !ev.hangoutLink) {
    Utilities.sleep(1500);
    const again = UrlFetchApp.fetch(API + encodeURIComponent(CFG.CALENDAR_ID) + '/events/' + ev.id + '?fields=id,hangoutLink',
      { headers: headers, muteHttpExceptions: true });
    if (again.getResponseCode() === 200) ev = Object.assign(ev, JSON.parse(again.getContentText()));
  }
  return { id: ev.id, meet: ev.hangoutLink || '' };
}

function notify_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TG_BOT_TOKEN');
  const chat = props.getProperty('TG_CHAT_ID');
  if (!token || !chat) return;
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', payload: { chat_id: chat, text: text, disable_web_page_preview: 'true' }, muteHttpExceptions: true,
    });
  } catch (err) {
    console.warn('telegram notify failed: ' + err);
  }
}

// ---------------------------------------------------------------- helpers

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code) {
  return { ok: false, error: code };
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hm_(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function qs_(o) {
  return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
}
