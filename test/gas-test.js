const assert = require('assert');
const { load, MIN, DAY, OFF } = require('./gas-harness');
let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };

const t0 = Math.floor((Date.now() + OFF) / DAY) * DAY - OFF;
// first working day >= 2 days ahead (Mon-Fri)
let d = 2; while (![1, 2, 3, 4, 5].includes(new Date(t0 + d * DAY + OFF).getUTCDay())) d++;
const at = (h, m, dd = d) => t0 + dd * DAY + (h * 60 + m) * MIN;
const base = { action: 'book', name: 'Ali Valiyev', contact: '+998 90 111 22 33', mode: 'online', duration: 30 };

console.log('slots');
ok('GET returns settings + merged busy', () => {
  const { get } = load(); const r = get({ action: 'slots' });
  assert.equal(r.ok, true); assert.deepEqual(r.settings.durations, [30, 45, 60]); assert.equal(r.settings.offsetMin, 300);
  assert.ok(r.busy.length > 50, 'busy count ' + r.busy.length);
  for (let i = 1; i < r.busy.length; i++) assert.ok(r.busy[i][0] > r.busy[i - 1][1], 'not merged/sorted');
});
ok('free-marked prayer events block, all-day and declined do not', () => {
  const { get } = load(); const r = get({ fresh: '1' });
  const covers = (s, e) => r.busy.some(([a, b]) => a <= s && b >= e);
  assert.ok(covers(at(12, 11), at(12, 31)), 'Dhuhr should block');
  assert.ok(!covers(at(0, 0), at(23, 59)), 'all-day must not block whole day');
  const tomorrow11 = t0 + DAY + 11 * 60 * MIN;
  assert.ok(!r.busy.some(([a, b]) => a < tomorrow11 + 60 * MIN && b > tomorrow11), 'declined event must not block');
});
ok('second calendar is merged in; unreadable calendar is skipped', () => {
  const a = load().get({ fresh: '1' });
  const b = load({ deny: ['javokhir.k@alliancevs.io'] }).get({ fresh: '1' });
  assert.equal(b.ok, true);
  assert.notDeepEqual(a.busy, b.busy);
});
ok('cache: second GET served from cache, fresh=1 bypasses', () => {
  const h = load(); h.get({}); assert.ok(h.cache.has('slots'));
  h.cache.set('slots', JSON.stringify({ ok: true, marker: 1 })); assert.equal(h.get({}).marker, 1); assert.equal(h.get({ fresh: '1' }).marker, undefined);
});

console.log('booking');
ok('valid online booking creates event with Meet + returns link', () => {
  const h = load(); const r = h.post({ ...base, start: at(11, 0), email: 'ali@x.uz', topic: 'CRM' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.meet, 'https://meet.google.com/abc-defg-hij');
  assert.equal(r.end - r.start, 30 * MIN);
  const { ev, query } = h.inserted[0];
  assert.equal(query.conferenceDataVersion, '1'); assert.equal(query.sendUpdates, 'all');
  assert.equal(ev.attendees[0].email, 'ali@x.uz'); assert.match(ev.summary, /Ali Valiyev/); assert.ok(!/клиент|client/i.test(ev.summary));
  assert.equal(ev.start.timeZone, 'Asia/Tashkent');
});
ok('no email -> no attendees, sendUpdates=none', () => {
  const h = load(); const r = h.post({ ...base, start: at(11, 0) });
  assert.equal(r.ok, true); assert.equal(h.inserted[0].query.sendUpdates, 'none'); assert.equal(h.inserted[0].ev.attendees.length, 0);
});
ok('offline -> no conference, default location text in event, empty location to page', () => {
  const h = load(); const r = h.post({ ...base, mode: 'offline', duration: 60, start: at(16, 0) });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.meet, ''); assert.equal(r.location, '');
  assert.equal(h.inserted[0].ev.conferenceData, undefined); assert.match(h.inserted[0].ev.location, /Oflayn/);
});
ok('async Meet link is re-read', () => {
  const h = load({ asyncMeet: true }); const r = h.post({ ...base, start: at(11, 0) });
  assert.equal(r.meet, 'https://meet.google.com/late-link-xyz');
});
ok('double booking: same slot twice -> slot_taken', () => {
  const h = load(); assert.equal(h.post({ ...base, start: at(11, 0) }).ok, true);
  const r = h.post({ ...base, contact: '@other', start: at(11, 0) }); assert.equal(r.error, 'slot_taken');
});
ok('buffer: 10:30 right after gym rejected, 12:00 overlapping Dhuhr rejected, 11:00 ok', () => {
  const h = load();
  assert.equal(h.post({ ...base, start: at(10, 30) }).error, 'slot_taken');
  assert.equal(h.post({ ...base, start: at(12, 0) }).error, 'slot_taken');
  assert.equal(h.post({ ...base, contact: '@b', start: at(11, 0) }).ok, true);
});
ok('outside hours / off-grid / Sunday / too soon / too far / bad duration', () => {
  const h = load();
  assert.equal(h.post({ ...base, start: at(9, 0) }).error, 'outside_hours');
  assert.equal(h.post({ ...base, start: at(18, 45) }).error, 'outside_hours');
  assert.equal(h.post({ ...base, start: at(11, 10) }).error, 'outside_hours');
  let sun = 1; while (new Date(t0 + sun * DAY + OFF).getUTCDay() !== 0) sun++;
  assert.equal(h.post({ ...base, start: at(11, 0, sun) }).error, 'outside_hours');
  assert.equal(h.post({ ...base, start: Date.now() + 30 * MIN }).error, 'out_of_range');
  assert.equal(h.post({ ...base, start: at(11, 0, 40) }).error, 'out_of_range');
  assert.equal(h.post({ ...base, duration: 90, start: at(11, 0) }).error, 'bad_duration');
});
ok('validation: missing fields, bad email, honeypot', () => {
  const h = load();
  assert.equal(h.post({ ...base, name: ' ', start: at(11, 0) }).error, 'missing_fields');
  assert.equal(h.post({ ...base, email: 'nope', start: at(11, 0) }).error, 'bad_email');
  assert.equal(h.post({ ...base, website: 'spam.com', start: at(11, 0) }).error, 'invalid');
  assert.equal(h.inserted.length, 0);
});
ok('rate limit: 3rd booking from same contact -> too_many', () => {
  const h = load();
  assert.equal(h.post({ ...base, start: at(11, 0) }).ok, true);
  assert.equal(h.post({ ...base, start: at(16, 0) }).ok, true);
  assert.equal(h.post({ ...base, start: at(16, 0, d + 1) }).error, 'too_many');
});
ok('booking invalidates cached slots', () => {
  const h = load(); h.get({}); assert.ok(h.cache.has('slots')); h.post({ ...base, start: at(11, 0) }); assert.ok(!h.cache.has('slots'));
});
ok('telegram ping only when script properties are set', () => {
  const a = load(); a.post({ ...base, start: at(11, 0) }); assert.equal(a.notified.length, 0);
  const b = load({ props: { TG_BOT_TOKEN: 't', TG_CHAT_ID: '1' } }); b.post({ ...base, start: at(11, 0), company: 'Acme' });
  assert.equal(b.notified.length, 1); assert.match(b.notified[0].text, /Ali Valiyev \(Acme\)/); assert.match(b.notified[0].text, /meet\.google/);
});
ok('control chars stripped, lengths capped', () => {
  const h = load(); const r = h.post({ ...base, name: 'A\u0000l\ni' + 'x'.repeat(200), start: at(11, 0) });
  assert.equal(r.ok, true); const nm = h.inserted[0].ev.summary; assert.ok(!/[\u0000\n]/.test(nm)); assert.ok(nm.length < 140, nm.length);
});
ok('bad json / unknown action', () => {
  const h = load();
  assert.equal(JSON.parse(h.ctx.doPost({ postData: { contents: '{oops' } }).s).error, 'bad_json');
  assert.equal(h.post({ action: 'x' }).error, 'unknown_action');
});
console.log(`\n${pass} passed`);
