// GLT new-place alert.
// Reads the Firestore `visits` collection, finds check-ins that are more than
// THRESHOLD_MILES from every earlier check-in, and sends a push via ntfy.
// Usage:
//   NTFY_TOPIC=... node scripts/new-place-alert.mjs
//   node scripts/new-place-alert.mjs --file visits.json --dry   (local test)
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ID = 'greg-local-time';
const API_KEY = 'AIzaSyAy03xmndT-oMbxrBWoKgsiJc4W_HZmspI'; // public by design (same as the website)
const THRESHOLD_MILES = 50;
const STATE_FILE = process.env.STATE_FILE || '.state/last-visit.txt';
const MAP_URL = 'https://greglocaltime.com/map.html';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const TOPIC = process.env.NTFY_TOPIC;

function haversineMiles(a, b) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseDoc(doc) {
  const f = doc.fields || {};
  const num = (v) => v ? parseFloat(v.doubleValue ?? v.integerValue) : null;
  const lat = num(f.lat), lon = num(f.lon);
  // createTime is set by the server, so it is more trustworthy than the client's ts.
  const when = doc.createTime || f.ts?.timestampValue || null;
  if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon) || !when) return null;
  return { lat, lon, city: f.city?.stringValue || '', when };
}

async function loadVisits() {
  if (fileArg) {
    const data = JSON.parse(fs.readFileSync(fileArg, 'utf8'));
    return (data.documents || data).map(parseDoc).filter(Boolean);
  }
  const all = [];
  let pageToken = null;
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/visits` +
      `?key=${API_KEY}&pageSize=300` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Firestore ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    (data.documents || []).forEach((d) => { const v = parseDoc(d); if (v) all.push(v); });
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return all;
}

function readState() {
  try { return fs.readFileSync(STATE_FILE, 'utf8').trim() || null; } catch { return null; }
}
function writeState(value) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, value + '\n');
}

async function notify(v, nearestMiles) {
  const place = v.city || `${v.lat.toFixed(1)}, ${v.lon.toFixed(1)}`;
  const detail = nearestMiles === null
    ? 'first check-in ever'
    : `${Math.round(nearestMiles)} mi from the nearest earlier check-in`;
  const body = `${place} (${detail})`;
  if (DRY || !TOPIC) { console.log(`[dry] would notify: ${body}`); return; }
  const resp = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}`, {
    method: 'POST',
    headers: { Title: 'New GLT place', Tags: 'world_map', Click: MAP_URL },
    body,
  });
  if (!resp.ok) throw new Error(`ntfy ${resp.status}: ${await resp.text()}`);
  console.log(`notified: ${body}`);
}

const visits = (await loadVisits()).sort((a, b) => a.when.localeCompare(b.when));
if (visits.length === 0) { console.log('no visits yet'); process.exit(0); }
const newest = visits[visits.length - 1].when;
const state = readState();

if (!state) {
  // First run: remember where we are and stay quiet, so existing places don't spam you.
  console.log(`first run: starting from ${newest} (${visits.length} existing visits, no notifications)`);
  if (!DRY) writeState(newest);
  process.exit(0);
}

let sent = 0;
for (let i = 0; i < visits.length; i++) {
  const v = visits[i];
  if (v.when <= state) continue;
  let nearest = null;
  for (let j = 0; j < i; j++) {
    const d = haversineMiles(v, visits[j]);
    if (nearest === null || d < nearest) nearest = d;
  }
  if (nearest === null || nearest > THRESHOLD_MILES) { await notify(v, nearest); sent++; }
}
console.log(`checked ${visits.length} visits; ${sent} new-place alert(s)`);
if (!DRY && newest > state) writeState(newest);
