/* Neosky Live Twin front end: live map, drone list, camera, 3D attitude twin, ODS radar, readouts, charts,
   messages, fleet statistics and flight history. State arrives over /ws/live four times a second. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATUS = { flying: 'Flying', online: 'On the ground', stale: 'Weak link', link_lost: 'Link lost', offline: 'Offline' };
const ORDER = { link_lost: 0, flying: 1, stale: 2, online: 3, offline: 4 };
const EVENT = {
    crash: 'Crash', thrust_loss: 'Potential thrust loss', motor_issue: 'Motor issue', battery_fs: 'Battery failsafe',
    gcs_fs: 'GCS failsafe', rc_fs: 'RC failsafe', ekf_issue: 'EKF issue', gps_issue: 'GPS issue', vibration_issue: 'High vibration',
};
const RED_EVENTS = new Set(['crash', 'thrust_loss', 'motor_issue']);
const FIX = ['No GPS', 'No fix', '2D fix', '3D fix', 'DGPS', 'RTK float', 'RTK fixed', 'Static', 'PPP'];
const COLORS = { flying: '#4fd18b', online: '#4fd18b', stale: '#f2b63d', link_lost: '#f0524d', offline: '#5d778b' };

const S = { drones: {}, list: [], sel: store.get('twin.sel'), cfg: null, follow: true, hist: {}, replay: null };

// ------------------------------------------------------------------ clock
let clockFmt = null;
function tick() {
    if (!clockFmt) return;
    $('clock').innerHTML = `${clockFmt.format(new Date())}<small>${S.cfg.tz === 'Asia/Kolkata' ? 'IST' : esc(S.cfg.tz)}</small>`;
}

// ------------------------------------------------------------------ map
const map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([22.5, 79], 5);
const layers = {
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Imagery &copy; Esri' }),
    street: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }),
};
let layer = store.get('twin.layer') === 'street' ? 'street' : 'sat';
layers[layer].addTo(map);
$('btnLayer').textContent = layer === 'sat' ? 'Street map' : 'Satellite';
$('btnLayer').onclick = () => {
    map.removeLayer(layers[layer]);
    layer = layer === 'sat' ? 'street' : 'sat';
    layers[layer].addTo(map);
    store.set('twin.layer', layer);
    $('btnLayer').textContent = layer === 'sat' ? 'Street map' : 'Satellite';
};
$('btnFollow').onclick = () => { S.follow = !S.follow; $('btnFollow').classList.toggle('on', S.follow); };
$('btnFleet').onclick = () => fitFleet();
map.on('dragstart', () => { S.follow = false; $('btnFollow').classList.remove('on'); });

const markers = {}, trails = {}, homes = {};
// shared with planner.js
window.TWIN = Object.assign(window.TWIN || {}, {
    map, plannerOpen: false,
    stopFollow() { S.follow = false; $('btnFollow').classList.remove('on'); },
    showDrone() {
        if (S.sel && S.drones[S.sel]) { $('noSel').hidden = true; $('sel').hidden = false; render(); } else { $('noSel').hidden = false; }
    },
    closeDrawers: () => closeDrawers(),
    cfg: () => S.cfg,
});
function droneIcon(d, selected) {
    const c = COLORS[d.status] || COLORS.offline;
    const ring = selected ? '<circle cx="17" cy="17" r="15" fill="none" stroke="#54c8e8" stroke-width="2.5"/>' : '';
    return L.divIcon({
        className: '', iconSize: [34, 34], iconAnchor: [17, 17],
        html: `<div class="dmark"><svg viewBox="0 0 34 34" style="transform:rotate(${d.heading || 0}deg)">${ring}
            <path d="M17 4 L26 27 L17 22 L8 27 Z" fill="${c}" stroke="#0e1a24" stroke-width="1.5" stroke-linejoin="round"/></svg>
            <span class="lbl">${esc(d.msn)}</span></div>`,
    });
}
function updateMap(d) {
    if (d.lat == null || d.lon == null) return;
    const ll = [d.lat, d.lon];
    const sel = d.key === S.sel;
    const sig = `${d.status}|${Math.round(d.heading || 0)}|${sel}`;
    let m = markers[d.key];
    if (!m) {
        m = markers[d.key] = L.marker(ll, { icon: droneIcon(d, sel), zIndexOffset: sel ? 1000 : 0, keyboard: false }).addTo(map);
        m.on('click', () => select(d.key));
        m._sig = sig;
    } else {
        m.setLatLng(ll);
        if (m._sig !== sig) { m.setIcon(droneIcon(d, sel)); m.setZIndexOffset(sel ? 1000 : 0); m._sig = sig; }
    }
    // trail of the current flight
    const fid = d.flight ? d.flight.id : null;
    let tr = trails[d.key];
    if (fid && (!tr || tr._fid !== fid)) {
        if (tr) map.removeLayer(tr);
        tr = trails[d.key] = L.polyline([], { color: '#54c8e8', weight: 3, opacity: 0.9 }).addTo(map);
        tr._fid = fid;
        if (sel) loadTrail(d.key);
    }
    if (tr && fid) {
        const pts = tr.getLatLngs();
        const last = pts[pts.length - 1];
        if (!last || map.distance(last, ll) > 1) tr.addLatLng(ll);
        tr.setStyle({ color: sel ? '#54c8e8' : '#9fb7c7', weight: sel ? 3.5 : 2, opacity: sel ? 0.95 : 0.6 });
    }
    if (d.home) {
        if (!homes[d.key]) homes[d.key] = L.marker(d.home, { icon: L.divIcon({ className: '', iconSize: [20, 20], html: '<div class="homemark" title="Home">H</div>' }), keyboard: false });
        else homes[d.key].setLatLng(d.home);
        if (sel && !map.hasLayer(homes[d.key])) homes[d.key].addTo(map);
        if (!sel && map.hasLayer(homes[d.key])) map.removeLayer(homes[d.key]);
    }
    if (sel && S.follow && !S.replay && !window.TWIN.plannerOpen) {
        if (!map.getBounds().pad(-0.25).contains(ll)) map.panTo(ll, { animate: true });
    }
}
async function loadTrail(key) {
    try {
        const r = await fetch(`/api/drones/${encodeURIComponent(key)}/trail`);
        if (!r.ok) return;
        const j = await r.json();
        const tr = trails[key];
        if (tr && j.points.length) tr.setLatLngs(j.points.map((p) => [p[1], p[2]]));
    } catch (e) { /* next snapshot will fill it */ }
}
function fitFleet() {
    const pts = S.list.filter((d) => d.lat != null).map((d) => [d.lat, d.lon]);
    if (pts.length === 1) map.setView(pts[0], 16);
    else if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
}

// ------------------------------------------------------------------ drone list
function alertFor(d) {
    const f = d.flight;
    if (d.status === 'link_lost') return ['red', `No telemetry for ${fmt(d.last_seen_s)} s while armed`];
    if (f && f.events.length) {
        const e = f.events[f.events.length - 1];
        return [RED_EVENTS.has(e.type) ? 'red' : '', `${EVENT[e.type] || e.type} at ${mmss(e.t)}`];
    }
    if (d.batt_pct != null && d.batt_pct < 25 && d.armed) return ['red', `Battery ${d.batt_pct}%`];
    if (d.prearm && d.prearm.length && !d.armed && d.status !== 'offline') return ['', d.prearm[d.prearm.length - 1]];
    return null;
}
function renderList() {
    const el = $('droneList');
    if (!S.list.length) return;
    const sorted = [...S.list].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || String(a.msn).localeCompare(String(b.msn)));
    // Keyed update: each drone keeps its own button, only its contents change, so clicks are never lost
    // to a button being replaced mid-click (the list refreshes 4 times a second).
    if (el.querySelector('.empty')) el.innerHTML = '';
    const seen = new Set();
    sorted.forEach((d, idx) => {
        const a = alertFor(d);
        const vals = d.status === 'offline' ? `<span>Last seen ${d.last_seen_s != null ? ago(d.last_seen_s) : 'earlier'}</span>`
            : `<span><b>${fmt(d.alt, 0)}</b> m</span><span><b>${fmt(d.batt_pct)}</b>%</span><span><b>${fmt(d.sats)}</b> sats</span><span><b>${fmt(d.range, 0)}</b> m out</span>`;
        const inner = `<span class="bar"></span>
            <span><span class="msn">${esc(d.msn)}</span><span class="model">${esc(d.model || '')}</span></span>
            <span class="state"><b>${STATUS[d.status]}</b>${esc(d.mode || '')}</span>
            <span class="vals">${vals}</span>
            ${a ? `<span class="alert ${a[0]}">${esc(a[1])}</span>` : ''}`;
        let b = el.querySelector(`.drone[data-key="${CSS.escape(d.key)}"]`);
        if (!b) {
            b = document.createElement('button');
            b.type = 'button';
            b.dataset.key = d.key;
        }
        const cls = `drone s-${d.status}${d.key === S.sel ? ' sel' : ''}`;
        if (b.className !== cls) b.className = cls;
        if (b._inner !== inner) { b.innerHTML = inner; b._inner = inner; }
        if (el.children[idx] !== b) el.insertBefore(b, el.children[idx] || null);
        seen.add(d.key);
    });
    [...el.querySelectorAll('.drone')].forEach((b) => { if (!seen.has(b.dataset.key)) b.remove(); });
    const c = { flying: 0, online: 0, link_lost: 0, offline: 0 };
    S.list.forEach((d) => { c[d.status === 'stale' ? 'online' : d.status] += 1; });
    $('fleetcount').innerHTML = `<span class="flying"><b>${c.flying}</b>flying</span><span><b>${c.online}</b>on the ground</span>`
        + (c.link_lost ? `<span class="lost"><b>${c.link_lost}</b>link lost</span>` : '') + `<span class="off"><b>${c.offline}</b>offline</span>`;
}
$('droneList').addEventListener('click', (e) => {
    const b = e.target.closest('.drone');
    if (b) select(b.dataset.key);
});
function ago(s) {
    if (s < 90) return `${Math.round(s)} s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
}
function mmss(t) {
    if (t == null) return '—';
    t = Math.max(0, Math.round(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ selection & detail
function select(key) {
    if (!S.drones[key]) return;
    if (window.TWIN.plannerOpen) window.TWIN.closePlanner();
    const changed = S.sel !== key;
    S.sel = key;
    store.set('twin.sel', key);
    S.follow = true;
    $('btnFollow').classList.add('on');
    if (S.replay) endReplay();
    $('noSel').hidden = true;
    $('sel').hidden = false;
    const d = S.drones[key];
    Object.values(markers).forEach((m) => { m._sig = ''; });
    if (changed) {
        videoStart(d.video);
        loadTrail(key);
        msgSig = '';
    }
    if (d.lat != null) map.setView([d.lat, d.lon], Math.max(map.getZoom(), 17));
    render();
}

function readout(k, v, unit, cls) {
    return `<div class="ro ${cls || ''}"><div class="k">${k}</div><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div></div>`;
}
const lvl = (v, caution, warning, low) => {
    if (v == null) return '';
    if (low) return v < warning ? 'warning' : v < caution ? 'caution' : '';
    return v >= warning ? 'warning' : v >= caution ? 'caution' : '';
};

let msgSig = '';
function renderDetail() {
    const d = S.drones[S.sel];
    if (!d) return;
    const f = d.flight;
    $('dMsn').textContent = d.msn;
    $('dModel').textContent = d.model || '';
    $('dStatus').textContent = STATUS[d.status];
    $('dStatus').className = `pill ${d.status}`;
    $('dMode').textContent = d.mode || '';
    $('dTimer').textContent = f ? mmss(f.time_s) : '';
    const vibe = d.vibe ? Math.max(d.vibe[0], d.vibe[1], d.vibe[2]) : null;
    const ekf = d.ekf ? d.ekf.max : null;
    $('readouts').innerHTML = [
        readout('Altitude', fmt(d.alt, 1), 'm'),
        readout('Range from home', fmt(d.range, 0), 'm'),
        readout('Ground speed', fmt(d.gs, 1), 'm/s'),
        readout('Climb rate', fmt(d.climb, 1), 'm/s'),
        readout('Satellites', fmt(d.sats), '', lvl(d.sats, 10, 6, true)),
        readout('HDOP', fmt(d.hdop, 2), '', lvl(d.hdop, 1.5, 2.5)),
        readout('GPS', d.fix != null ? FIX[d.fix] || d.fix : '—', '', d.fix != null && d.fix < 3 ? 'warning' : ''),
        readout('Link quality', fmt(d.link_pct), '%', lvl(d.link_pct, 90, 70, true)),
        readout('Battery', fmt(d.volt, 2), 'V'),
        readout('Current', fmt(d.curr, 1), 'A'),
        readout('Battery left', fmt(d.batt_pct), '%', lvl(d.batt_pct, 30, 20, true)),
        readout('Used', fmt(d.mah), 'mAh'),
        readout('Distance flown', fmt(f ? f.distance_m : null), 'm'),
        readout('EKF variance', fmt(ekf, 2), '', lvl(ekf, 0.5, 0.8)),
        readout('Vibration', fmt(vibe, 0), 'm/s²', lvl(vibe, 30, 60)),
        readout('Throttle', fmt(d.throttle), '%'),
    ].join('');
    // this flight
    const ev = [];
    if (f) {
        ev.push(`<div class="ev" style="border-left-color:var(--cyan)"><span class="t">${mmss(0)}</span><span>Armed${f.cold_start_s != null ? ` · cold start ${fmt(f.cold_start_s, 0)} s after power-on` : ''}</span></div>`);
        f.events.forEach((e) => ev.push(`<div class="ev ${e.type}"><span class="t">${mmss(e.t)}</span><span>${esc(EVENT[e.type] || e.type)}<div class="sub">${esc(e.text)}${e.dist_m != null ? ` · ${e.dist_m} m from home` : ''}${e.alt_m != null ? `, ${e.alt_m} m up` : ''}${e.voltage != null ? `, ${e.voltage} V` : ''}</div></span></div>`));
        if (!f.events.length) ev.push('<div class="nothing">No failsafes or faults so far.</div>');
    } else {
        ev.push(`<div class="nothing">${d.status === 'offline' ? 'Not connected.' : 'Not armed.'}${d.last_flight_id ? ' The last flight is in Flight history.' : ''}</div>`);
    }
    $('events').innerHTML = ev.join('');
    const pre = (f ? f.prearm : d.prearm) || [];
    $('prearm').innerHTML = pre.slice(-6).map((p) => `<li>${esc(p)}</li>`).join('');
    // messages (only redraw when they change)
    const sig = d.msgs.length + '|' + (d.msgs.length ? d.msgs[d.msgs.length - 1].ts : 0);
    if (sig !== msgSig) {
        msgSig = sig;
        $('msgs').innerHTML = d.msgs.length ? [...d.msgs].reverse().map((m) => `<div class="msg s${m.sev}"><span class="t">${timeOf(m.ts)}</span><span>${esc(m.text)}</span></div>`).join('')
            : '<div class="nothing" style="padding:8px">No messages yet.</div>';
    }
    const fid = f ? f.id : d.last_flight_id;
    $('actions').innerHTML = fid ? `<a class="btn" href="/api/flights/${fid}/tlog">Download telemetry log (.tlog)</a>
        <button type="button" class="btn" id="btnPath">Show ${f ? 'flight so far' : 'last flight'} on the map</button>` : '';
    const bp = $('btnPath');
    if (bp) bp.onclick = () => showFlight(fid);
    $('att').innerHTML = `Roll <b>${fmt(d.roll, 0)}°</b> Pitch <b>${fmt(d.pitch, 0)}°</b> Heading <b>${fmt(d.heading, 0)}°</b>`;
    drawRadar(d);
    drawCharts(d);
}
let tFmt = null;
function timeOf(ts) {
    if (!tFmt) tFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: S.cfg ? S.cfg.tz : undefined });
    return tFmt.format(new Date(ts * 1000));
}

// ------------------------------------------------------------------ charts (rolling 5 minutes per drone)
function record(d) {
    const h = S.hist[d.key] || (S.hist[d.key] = []);
    const now = Date.now() / 1000;
    if (h.length && now - h[h.length - 1].t < 1) return;
    h.push({ t: now, alt: d.alt, volt: d.volt, sats: d.sats, curr: d.curr });
    while (h.length && now - h[0].t > 300) h.shift();
}
function spark(canvas, h, key, color) {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    const pts = h.filter((p) => p[key] != null);
    if (pts.length < 2) return null;
    let lo = Math.min(...pts.map((p) => p[key])), hi = Math.max(...pts.map((p) => p[key]));
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.1;
    lo -= pad; hi += pad;
    const t0 = Date.now() / 1000 - 300;
    const X = (t) => ((t - t0) / 300) * r.width, Y = (v) => r.height - 2 - ((v - lo) / (hi - lo)) * (r.height - 4);
    c.strokeStyle = 'rgba(139,163,181,.18)';
    c.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach((f) => { c.beginPath(); c.moveTo(0, r.height * f); c.lineTo(r.width, r.height * f); c.stroke(); });
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p[key])) : c.moveTo(X(p.t), Y(p[key]))));
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.stroke();
    return pts[pts.length - 1][key];
}
function drawCharts(d) {
    const h = S.hist[d.key] || [];
    const a = spark($('cAlt'), h, 'alt', '#54c8e8');
    const v = spark($('cVolt'), h, 'volt', '#4fd18b');
    const s = spark($('cSat'), h, 'sats', '#f2b63d');
    const c = spark($('cCur'), h, 'curr', '#c9a6ff');
    $('cAltV').textContent = a != null ? `${fmt(a, 1)} m` : '';
    $('cVoltV').textContent = v != null ? `${fmt(v, 2)} V` : '';
    $('cSatV').textContent = s != null ? `${s}` : '';
    $('cCurV').textContent = c != null ? `${fmt(c, 1)} A` : '';
}

// ------------------------------------------------------------------ ODS radar
function drawRadar(d) {
    const cv = $('radar');
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    const cx = r.width / 2, cy = r.height / 2 + 4, R = Math.min(r.width, r.height) / 2 - 22;
    const sectors = (d.ods || []).filter((o) => typeof o.a === 'number');
    const maxd = Math.max(10, ...sectors.map((o) => Math.min(o.max || 10, 40)));
    c.strokeStyle = 'rgba(139,163,181,.25)';
    c.fillStyle = 'rgba(139,163,181,.7)';
    c.font = '11px Barlow, sans-serif';
    [0.33, 0.66, 1].forEach((f) => {
        c.beginPath(); c.arc(cx, cy, R * f, 0, Math.PI * 2); c.stroke();
        c.fillText(`${Math.round(maxd * f)} m`, cx + 3, cy - R * f + 11);
    });
    const n = sectors.length > 8 ? sectors.length : 8;
    const half = Math.PI / n;
    sectors.forEach((o) => {
        const a = (o.a - 90) * Math.PI / 180;
        const rr = Math.min(1, o.d / maxd) * R;
        const col = o.d < 2 ? '#f0524d' : o.d < 5 ? '#f2b63d' : '#54c8e8';
        c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, rr, a - half * 0.85, a + half * 0.85); c.closePath();
        c.fillStyle = col + '33'; c.fill();
        c.beginPath(); c.arc(cx, cy, rr, a - half * 0.85, a + half * 0.85);
        c.strokeStyle = col; c.lineWidth = 3; c.stroke();
    });
    // the drone, nose up
    c.fillStyle = '#e3eef4';
    c.beginPath(); c.moveTo(cx, cy - 9); c.lineTo(cx + 6, cy + 7); c.lineTo(cx, cy + 3); c.lineTo(cx - 6, cy + 7); c.closePath(); c.fill();
    const up = (d.ods || []).find((o) => o.a === 'up');
    const near = sectors.length ? sectors.reduce((a, b) => (b.d < a.d ? b : a)) : null;
    $('radarCap').innerHTML = sectors.length || d.rangefinder || up
        ? [near ? `Nearest <b>${fmt(near.d, 1)} m</b> at ${near.a}°` : '', d.rangefinder ? `down <b>${fmt(d.rangefinder.d, 1)} m</b>` : '', up ? `up <b>${fmt(up.d, 1)} m</b>` : ''].filter(Boolean).join(', ')
        : 'No obstacle sensor data';
}

// ------------------------------------------------------------------ 3D attitude twin (three.js)
const twin = (() => {
    const cv = $('twin');
    if (typeof THREE === 'undefined') return { update() {} };
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(38, 2, 0.1, 50);
    cam.position.set(0, 2.3, 3.3);
    cam.lookAt(0, -0.05, 0);
    scene.add(new THREE.HemisphereLight(0xcdefff, 0x0e1a24, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const grid = new THREE.GridHelper(10, 20, 0x2f5269, 0x1c3446);
    grid.position.y = -0.9;
    scene.add(grid);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.9, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.89;
    scene.add(shadow);

    const drone = new THREE.Group();
    const mat = (c, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.6, metalness: 0.2 }, o));
    drone.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.72), mat(0x34444f)));
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.46), mat(0x54c8e8, { roughness: 0.35 }));
    canopy.position.y = 0.1;
    drone.add(canopy);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 16), mat(0x54c8e8));
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0, -0.46);
    drone.add(nose);
    // ArduPilot quad X order: 1 front-right, 2 rear-left, 3 front-left, 4 rear-right. Nose is -z (away from camera).
    const arms = [[1, -1], [-1, 1], [-1, -1], [1, 1]];
    const pods = [], props = [];
    arms.forEach(([sx, sz], i) => {
        const len = 0.85;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, len * 1.42), mat(0x1f2a33));
        arm.position.set(sx * len / 2, 0, sz * len / 2);
        arm.rotation.y = Math.atan2(sx, sz);
        drone.add(arm);
        const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 16), mat(0x56636d));
        pod.position.set(sx * len, 0.04, sz * len);
        drone.add(pod);
        pods.push(pod);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.34, 32), new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(sx * len, 0.11, sz * len);
        drone.add(disc);
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.012, 0.05), mat(0xdfe8ee));
        blade.position.set(sx * len, 0.12, sz * len);
        blade.userData.dir = i % 2 ? 1 : -1;
        drone.add(blade);
        props.push(blade);
        // navigation lights: red on the left, green on the right
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), new THREE.MeshBasicMaterial({ color: sx < 0 ? 0xff4d4d : 0x45e08f }));
        lamp.position.set(sx * (len + 0.09), 0.02, sz * (len + 0.09));
        drone.add(lamp);
    });
    scene.add(drone);
    let target = { roll: 0, pitch: 0, motors: [], alt: 0, armed: false };
    let last = performance.now();
    function resize() {
        const r = cv.getBoundingClientRect();
        if (!r.width) return;
        renderer.setSize(r.width, r.height, false);
        cam.aspect = r.width / r.height;
        cam.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const k = 1 - Math.exp(-dt * 10);
        drone.rotation.order = 'YXZ';
        drone.rotation.x += (THREE.MathUtils.degToRad(target.pitch) - drone.rotation.x) * k;
        drone.rotation.z += (THREE.MathUtils.degToRad(-target.roll) - drone.rotation.z) * k;
        const lift = Math.min(0.35, (target.alt || 0) / 100);
        drone.position.y += (lift - drone.position.y) * k;
        shadow.material.opacity = 0.35 - lift * 0.6;
        props.forEach((p, i) => {
            const pwm = target.motors[i] || 1000;
            const speed = target.armed ? Math.max(0, (pwm - 1000) / 1000) : 0;
            if (!reduceMotion) p.rotation.y += p.userData.dir * speed * dt * 40;
            pods[i].material.color.setHex(pwm >= 1900 && target.armed ? 0xf0524d : 0x56636d);
        });
        if (cv.offsetParent !== null) renderer.render(scene, cam);
        requestAnimationFrame(frame);
    }
    resize();
    requestAnimationFrame(frame);
    return {
        update(d) {
            if (!d) return;
            if (cv.width < 10) resize();
            target = { roll: d.roll || 0, pitch: d.pitch || 0, motors: d.motors || [], alt: d.alt || 0, armed: d.armed };
        },
        resize,
    };
})();

// ------------------------------------------------------------------ video: WebRTC (WHEP) with HLS fallback
const V = { pc: null, hls: null, path: null, mode: 'webrtc', timer: null, gen: 0 };
function vmsg(text) {
    $('vmsg').textContent = text;
    $('vmsg').hidden = !text;
    $('vtag').hidden = !!text;
}
function videoStop() {
    V.gen += 1;
    clearTimeout(V.timer);
    if (V.pc) { try { V.pc.close(); } catch (e) { /* closed */ } V.pc = null; }
    if (V.hls) { V.hls.destroy(); V.hls = null; }
    V.stream = null;
    const v = $('vid');
    v.srcObject = null;
    v.removeAttribute('src');
}
function videoRetry(gen, ms) {
    clearTimeout(V.timer);
    V.timer = setTimeout(() => { if (gen === V.gen) videoStart(V.path); }, ms);
}
function videoStart(path) {
    videoStop();
    V.path = path;
    if (!path) return;
    const gen = V.gen;
    vmsg('Connecting to the camera…');
    $('vMode').textContent = V.mode === 'webrtc' ? 'HLS' : 'WebRTC';
    (V.mode === 'webrtc' ? whep(path, gen) : hls(path, gen)).catch((e) => {
        if (gen !== V.gen) return;
        vmsg(e.message || 'Video unavailable.');
        videoRetry(gen, 5000);
    });
}
async function whep(path, gen) {
    const pc = new RTCPeerConnection();
    V.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => {
        if (gen !== V.gen) return;
        const v = $('vid');
        if (!V.stream) V.stream = new MediaStream();
        V.stream.addTrack(e.track);
        if (v.srcObject !== V.stream) v.srcObject = V.stream;
        v.play().catch(() => { /* autoplay of muted video is allowed; ignore */ });
    };
    pc.onconnectionstatechange = () => {
        if (gen !== V.gen) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            vmsg('Video connection dropped. Reconnecting…');
            videoRetry(gen, 3000);
        }
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((res) => {
        if (pc.iceGatheringState === 'complete') return res();
        const t = setTimeout(res, 1500);
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
    const r = await fetch(`/video/webrtc/${encodeURIComponent(path)}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
    if (r.status === 404) throw new Error('No video from this drone yet. It appears here as soon as the field relay sends the camera stream.');
    if (r.status === 400 && V.mode === 'webrtc') {
        // usually "codecs not supported": this browser can't take the camera's codec over WebRTC, try HLS
        pc.close();
        V.mode = 'hls';
        $('vMode').textContent = 'WebRTC';
        return hls(path, gen);
    }
    if (r.status === 502) throw new Error('The video server is not reachable. Check that MediaMTX is running.');
    if (!r.ok) throw new Error(`Video server answered ${r.status}. Retrying…`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
}
async function hls(path, gen) {
    const url = `/video/hls/${encodeURIComponent(path)}/index.m3u8`;
    const v = $('vid');
    if (window.Hls && Hls.isSupported()) {
        const h = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 });
        V.hls = h;
        h.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal && gen === V.gen) {
                vmsg(data.response && data.response.code === 404 ? 'No video from this drone yet.'
                    : data.type === 'mediaError' ? 'This browser cannot decode the camera\'s video format. Set the camera to H.264, or start the field relay with --transcode.'
                        : 'HLS stream interrupted. Reconnecting…');
                videoRetry(gen, 5000);
            }
        });
        h.loadSource(url);
        h.attachMedia(v);
    } else {
        v.src = url;
    }
}
$('vid').addEventListener('playing', () => vmsg(''));
$('vRetry').onclick = () => videoStart(V.path);
$('vMode').onclick = () => { V.mode = V.mode === 'webrtc' ? 'hls' : 'webrtc'; videoStart(V.path); };

// ------------------------------------------------------------------ live connection
let ws = null, wsDelay = 1000;
function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live`);
    ws.onopen = () => { $('conn').className = 'conn ok'; $('conn').title = 'Live'; wsDelay = 1000; };
    ws.onmessage = (e) => {
        const j = JSON.parse(e.data);
        if (j.type === 'snapshot') onSnapshot(j.drones);
    };
    ws.onclose = (e) => {
        $('conn').className = 'conn bad';
        $('conn').title = 'Disconnected, retrying';
        if (e.code === 4401) { location.href = '/login'; return; }
        setTimeout(connect, wsDelay);
        wsDelay = Math.min(15000, wsDelay * 2);
    };
}
setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 20000);

let firstSnap = true;
function onSnapshot(list) {
    S.list = list;
    S.drones = {};
    list.forEach((d) => { S.drones[d.key] = d; record(d); updateMap(d); });
    renderList();
    if (firstSnap) {
        firstSnap = false;
        fitFleet();
        if (S.sel && S.drones[S.sel]) select(S.sel);
        else {
            const flying = list.find((d) => d.status === 'flying') || list.find((d) => d.status !== 'offline');
            if (flying) select(flying.key);
        }
        fillDroneSelects();
    }
    render();
}
function render() {
    if (!S.sel || !S.drones[S.sel] || window.TWIN.plannerOpen) return;
    renderDetail();
    twin.update(S.drones[S.sel]);
}

// ------------------------------------------------------------------ fleet statistics
function fillDroneSelects() {
    const opts = '<option value="">All drones</option>' + S.list.map((d) => `<option value="${esc(d.msn)}">${esc(d.msn)}${d.model ? ` · ${esc(d.model)}` : ''}</option>`).join('');
    ['stDrone', 'hiDrone'].forEach((id) => { const v = $(id).value; $(id).innerHTML = opts; $(id).value = v; });
    const per = Object.entries(S.cfg.periods).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    ['stPeriod', 'hiPeriod'].forEach((id) => { if (!$(id).options.length) $(id).innerHTML = per; });
}
function tile(k, v, unit, n, cls) {
    return `<div class="tile ${cls || ''}"><div class="k">${esc(k)}</div><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div>${n ? `<div class="n">${n}</div>` : ''}</div>`;
}
async function loadStats() {
    const msn = $('stDrone').value, period = $('stPeriod').value || 'all';
    $('stBody').innerHTML = '<p class="nothing">Loading…</p>';
    const r = await fetch(`/api/stats?msn=${encodeURIComponent(msn)}&period=${period}`);
    if (!r.ok) { $('stBody').innerHTML = '<p class="nothing">Could not load statistics.</p>'; return; }
    const s = await r.json();
    const dec = { min: 1, m: 0, V: 2, A: 1, s: 0 };
    let html = `<div class="group"><h3>Flight performance<small>averages over ${s.flights} recorded flight${s.flights === 1 ? '' : 's'}</small></h3><div class="tiles">`
        + s.averages.map((a) => tile(a.label, fmt(a.value, dec[a.unit] ?? 1), a.unit, `${a.n} flight${a.n === 1 ? '' : 's'} with data`)).join('') + '</div></div>';
    html += '<div class="group"><h3>Failsafes<small>when and where they triggered</small></h3><div class="tiles">'
        + s.failsafes.map((a) => tile(a.label, fmt(a.value, dec[a.unit] ?? 1), a.unit, `${a.flights} flight${a.flights === 1 ? '' : 's'} with this failsafe`, a.flights ? 'warm' : '')).join('') + '</div></div>';
    html += '<div class="group"><h3>Issues<small>number of flights</small></h3><div class="tiles">'
        + s.counts.map((c) => tile(c.label, c.value, '', '', c.value ? (c.key === 'crash' || c.key === 'thrust_loss' || c.key === 'motor_issue' ? 'hot' : 'warm') : '')).join('') + '</div></div>';
    const c = s.conclusions;
    html += '<div class="group"><h3>Root cause<small>as tagged in Flight history</small></h3><div class="tiles">'
        + tile('System errors', c.system_error) + tile('Pilot errors', c.pilot_error)
        + tile('Yet to decide', c.undetermined + c.none, '', `${c.none} not tagged yet`) + '</div></div>';
    html += '<div class="group"><h3>Logs and flying time</h3><div class="tiles">'
        + tile('Flights recorded', s.flights, '', s.flying_now ? `${s.flying_now} in the air now` : '')
        + tile('Telemetry logs (.tlog)', s.tlogs, '', 'download them in Flight history')
        + tile('Hours flown', fmt(s.total_hours, 1), 'h') + tile('Distance flown', fmt(s.total_km, 1), 'km') + '</div></div>';
    $('stBody').innerHTML = html;
    $('stNote').textContent = 'Every figure comes from the flights this twin recorded, from arming to disarming. Set the root cause of each flight in Flight history.';
}

// ------------------------------------------------------------------ flight history
async function loadHistory() {
    const msn = $('hiDrone').value, period = $('hiPeriod').value || 'all';
    const r = await fetch(`/api/flights?msn=${encodeURIComponent(msn)}&period=${period}`);
    const rows = r.ok ? await r.json() : [];
    const dt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: S.cfg.tz });
    $('hiBody').innerHTML = rows.length ? rows.map((f) => {
        const s = f.summary;
        const evs = [...new Set(f.events)];
        const chips = (s.crash ? ['crash'] : []).concat(evs.filter((e) => e !== 'crash')).map((e) => `<span class="chip ${RED_EVENTS.has(e) ? 'red' : ''}">${esc(EVENT[e] || e)}</span>`).join('')
            + (s.prearm_count ? `<span class="chip">${s.prearm_count} pre-arm</span>` : '')
            + (f.status === 'flying' ? '<span class="chip ok">In the air</span>' : f.status !== 'completed' ? `<span class="chip">${esc(f.status.replace('_', ' '))}</span>` : '');
        const sel = ['', 'pilot_error', 'system_error', 'undetermined'].map((v) => `<option value="${v}" ${f.conclusion === v || (!f.conclusion && !v) ? 'selected' : ''}>${{ '': 'Not set', pilot_error: 'Pilot error', system_error: 'System error', undetermined: 'Yet to decide' }[v]}</option>`).join('');
        return `<tr><td class="num">${dt.format(new Date(f.start_ts * 1000))}</td><td>${esc(f.msn)}</td>
            <td class="num">${mmss((s.flight_time_min || 0) * 60)}</td><td class="num">${fmt(s.distance_m)} m</td><td class="num">${fmt(s.range_m)} m</td>
            <td class="num">${fmt(s.max_alt_m, 1)} m</td><td class="num">${fmt(s.max_voltage, 1)}–${fmt(s.min_voltage, 1)} V</td>
            <td>${chips || '<span class="chip ok">Clean</span>'}</td>
            <td><select data-fid="${f.id}" aria-label="Root cause">${sel}</select></td>
            <td style="white-space:nowrap"><button class="btn" type="button" data-show="${f.id}">Show path</button>
            ${f.has_tlog ? `<a class="btn" href="/api/flights/${f.id}/tlog">.tlog</a>` : ''}</td></tr>`;
    }).join('') : '<tr><td colspan="10" class="nothing">No flights recorded in this period.</td></tr>';
}
$('hiBody').addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-fid]');
    if (!s) return;
    await fetch(`/api/flights/${s.dataset.fid}/conclusion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conclusion: s.value || null }) });
});
$('hiBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (b) { closeDrawers(); showFlight(Number(b.dataset.show)); }
});

// replay a recorded flight on the map
async function showFlight(fid) {
    const r = await fetch(`/api/flights/${fid}`);
    if (!r.ok) return;
    const f = await r.json();
    endReplay();
    const pts = f.track.map((p) => [p[1], p[2]]);
    const grp = L.layerGroup().addTo(map);
    if (pts.length) {
        L.polyline(pts, { color: '#0e1a24', weight: 7, opacity: 0.6 }).addTo(grp);
        L.polyline(pts, { color: '#f2b63d', weight: 3.5 }).addTo(grp);
        L.circleMarker(pts[0], { radius: 6, color: '#4fd18b', fillOpacity: 1 }).bindTooltip('Take-off').addTo(grp);
        L.circleMarker(pts[pts.length - 1], { radius: 6, color: f.summary.crash ? '#f0524d' : '#e3eef4', fillOpacity: 1 }).bindTooltip(f.summary.crash ? 'Crash site' : 'Landing').addTo(grp);
        map.fitBounds(pts, { padding: [50, 50], maxZoom: 18 });
    }
    (f.summary.events || []).forEach((e) => {
        if (e.lat == null) return;
        L.circleMarker([e.lat, e.lon], { radius: 7, color: RED_EVENTS.has(e.type) ? '#f0524d' : '#f2b63d', weight: 3, fillOpacity: 0.3 })
            .bindTooltip(`${EVENT[e.type] || e.type} at ${mmss(e.t)}: ${e.text}`).addTo(grp);
    });
    const runner = L.circleMarker(pts[0] || [0, 0], { radius: 7, color: '#54c8e8', fillColor: '#54c8e8', fillOpacity: 1 });
    S.replay = { grp, f, pts, runner, timer: null };
    S.follow = false;
    $('btnFollow').classList.remove('on');
    const s = f.summary;
    $('replaybar').hidden = false;
    $('replaybar').innerHTML = `<span><b>${esc(f.msn)}</b> flight ${f.id} · ${mmss((s.flight_time_min || 0) * 60)} · ${fmt(s.distance_m)} m flown · max ${fmt(s.max_alt_m, 1)} m up</span>
        <button class="btn" type="button" id="rpPlay">Play path</button><button class="btn primary" type="button" id="rpEnd">Back to live</button>`;
    $('rpEnd').onclick = endReplay;
    $('rpPlay').onclick = () => playReplay();
}
function playReplay() {
    const R = S.replay;
    if (!R || !R.f.track.length) return;
    clearInterval(R.timer);
    R.runner.addTo(R.grp);
    const tr = R.f.track, dur = tr[tr.length - 1][0] || 1, speed = Math.max(10, dur / 40);
    const start = performance.now();
    R.timer = setInterval(() => {
        const t = ((performance.now() - start) / 1000) * speed;
        let i = tr.findIndex((p) => p[0] >= t);
        if (i < 0) { clearInterval(R.timer); i = tr.length - 1; }
        R.runner.setLatLng([tr[i][1], tr[i][2]]);
        R.runner.bindTooltip(`${mmss(tr[i][0])} · ${fmt(tr[i][3], 1)} m`, { permanent: true, direction: 'right' }).openTooltip();
    }, 50);
}
function endReplay() {
    if (!S.replay) return;
    clearInterval(S.replay.timer);
    map.removeLayer(S.replay.grp);
    S.replay = null;
    $('replaybar').hidden = true;
    S.follow = true;
    $('btnFollow').classList.add('on');
}

// ------------------------------------------------------------------ drawers
function closeDrawers() {
    $('statsDrawer').hidden = true;
    $('histDrawer').hidden = true;
    $('btnStats').classList.remove('on');
    $('btnHistory').classList.remove('on');
}
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeDrawers; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });
$('btnStats').onclick = () => {
    const open = $('statsDrawer').hidden;
    closeDrawers();
    if (open) { fillDroneSelects(); $('statsDrawer').hidden = false; $('btnStats').classList.add('on'); loadStats(); }
};
$('btnHistory').onclick = () => {
    const open = $('histDrawer').hidden;
    closeDrawers();
    if (open) { fillDroneSelects(); $('histDrawer').hidden = false; $('btnHistory').classList.add('on'); loadHistory(); }
};
['stDrone', 'stPeriod'].forEach((id) => $(id).addEventListener('change', loadStats));
['hiDrone', 'hiPeriod'].forEach((id) => $(id).addEventListener('change', loadHistory));

// ------------------------------------------------------------------ start
fetch('/api/config').then((r) => {
    if (r.status === 401) { location.href = '/login'; return null; }
    return r.json();
}).then((cfg) => {
    if (!cfg) return;
    S.cfg = cfg;
    $('user').innerHTML = `${esc(cfg.user)} · <a href="/logout">Sign out</a>`;
    clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: cfg.tz });
    tick();
    setInterval(tick, 1000);
    fillDroneSelects();
    connect();
});
window.addEventListener('resize', () => { if (S.sel) render(); });
})();
