/* Demo planner: check a customer's site against DGCA zones, obstacles, terrain, weather and the drone's limits,
   recommend the safest direction and export a demo route. Uses the map shared by app.js (window.TWIN.map). */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
const T = window.TWIN;
const map = T.map;
const ZONE = { green: '#4fd18b', yellow: '#f2b63d', red: '#f0524d' };
const LEVEL = { go: 'go', caution: 'caution', permission: 'permission', no: 'no' };
const STATUS_ICON = { ok: '✓', caution: '!', no: '✕' };
const scoreColor = (s, blocked) => blocked || s < 50 ? '#f0524d' : s < 75 ? '#f2b63d' : '#4fd18b';

let layer = null, picking = false, pickMarker = null, current = null, profiles = {};

function nextHour() {
    const d = new Date(Date.now() + 3600e3);
    d.setMinutes(0, 0, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

function firstRange() {
    const p = Object.values(profiles)[0];
    return p && p.video_range_m ? p.video_range_m : 1500;
}

function formHtml() {
    const prof = Object.entries(profiles).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    return `
    <div class="pl-head"><h1>Demo planner</h1><button class="btn" type="button" id="plClose">Back to live view</button></div>
    <p class="pl-lead">Paste the customer's coordinates or click the map. The planner checks DGCA zones, obstacles, terrain, weather and the drone's limits, then picks the safest direction for the demo.</p>
    <form id="plForm" class="pl-form" autocomplete="off">
        <label class="wide">Coordinates<span class="row"><input id="plCoords" placeholder="12.9716, 77.5946 or a Google Maps link" required>
            <button class="btn" type="button" id="plPick" title="Click a point on the map">Pick on map</button></span></label>
        <label>Site name<input id="plName" placeholder="e.g. Hoskote warehouse"></label>
        <label>Customer<input id="plCustomer" placeholder="e.g. ABC Logistics"></label>
        <label>Demo date and time<input id="plWhen" type="datetime-local" value="${nextHour()}"></label>
        <label>Drone<select id="plProfile">${prof}</select></label>
        <label>Flight height (m AGL)<input id="plAlt" type="number" min="15" max="120" step="5" value="60"></label>
        <label>Demo radius (m)<input id="plRadius" type="number" min="300" max="3000" step="100" placeholder="${firstRange()} (video range)"></label>
        <button class="btn primary wide" type="submit" id="plGo">Check site</button>
        <div class="pl-err wide" id="plErr" hidden></div>
    </form>
    <div id="plResult"></div>
    <details class="pl-box" id="plSaved"><summary>Saved sites</summary><div id="plSavedList" class="nothing">Loading…</div></details>
    <details class="pl-box" id="plZones"><summary>Your restricted areas</summary>
        <p class="pl-small">Add areas the planner can't know about, for example a red or yellow zone you saw on DigitalSky or a customer's no-fly area. They are used for every site.</p>
        <form id="zForm" class="pl-form" autocomplete="off">
            <label>Name<input id="zName" placeholder="e.g. Army camp" required></label>
            <label>Zone<select id="zColor"><option value="red">Red</option><option value="yellow">Yellow</option></select></label>
            <label>Centre coordinates<input id="zCoords" placeholder="lat, lon" required></label>
            <label>Radius (m)<input id="zRadius" type="number" min="50" step="50" value="1000" required></label>
            <button class="btn wide" type="submit">Add circle</button>
        </form>
        <form id="zImport" class="pl-form"><label class="wide">Or import polygons (GeoJSON or KML)<input id="zFile" type="file" accept=".geojson,.json,.kml"></label>
            <label>Zone if not set in the file<select id="zImpColor"><option value="red">Red</option><option value="yellow">Yellow</option></select></label>
            <button class="btn" type="submit">Import</button></form>
        <div id="zList"></div>
    </details>`;
}

// ------------------------------------------------------------------ open / close
async function open() {
    T.closeDrawers();
    T.plannerOpen = true;
    T.stopFollow();
    $('btnPlanner').classList.add('on');
    $('sel').hidden = true;
    $('noSel').hidden = true;
    const p = $('plannerPanel');
    p.hidden = false;
    if (!Object.keys(profiles).length) {
        try { profiles = await (await fetch('/api/planner/profiles')).json(); } catch (e) { profiles = { tavas: { name: 'TAVAS' } }; }
    }
    if (!p.dataset.ready) {
        p.innerHTML = formHtml();
        p.dataset.ready = '1';
        wire();
    }
    loadSaved();
    loadZones();
    if (current) draw(current);
}
function close() {
    T.plannerOpen = false;
    stopPick();
    $('btnPlanner').classList.remove('on');
    $('plannerPanel').hidden = true;
    if (layer) { map.removeLayer(layer); layer = null; }
    T.showDrone();
}
T.closePlanner = close;
$('btnPlanner').onclick = () => (T.plannerOpen ? close() : open());

function wire() {
    $('plClose').onclick = close;
    $('plPick').onclick = () => (picking ? stopPick() : startPick());
    $('plForm').onsubmit = (e) => { e.preventDefault(); analyze(); };
    $('zForm').onsubmit = async (e) => {
        e.preventDefault();
        const r = await fetch('/api/zones', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: $('zName').value, color: $('zColor').value, coords: $('zCoords').value, radius_m: $('zRadius').value }) });
        if (!r.ok) { alertBox((await r.json()).detail || 'Could not add the area.'); return; }
        $('zForm').reset();
        loadZones();
    };
    $('zImport').onsubmit = async (e) => {
        e.preventDefault();
        const f = $('zFile').files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        fd.append('color', $('zImpColor').value);
        const r = await fetch('/api/zones/import', { method: 'POST', body: fd });
        const j = await r.json();
        alertBox(r.ok ? `${j.added} area(s) imported.` : (j.detail || 'Import failed.'), r.ok);
        loadZones();
    };
}
function alertBox(text, ok) {
    const e = $('plErr');
    e.textContent = text;
    e.className = `pl-err wide ${ok ? 'okmsg' : ''}`;
    e.hidden = false;
    e.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ pick on map
function onMapClick(e) {
    const { lat, lng } = e.latlng;
    $('plCoords').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    if (pickMarker) pickMarker.setLatLng(e.latlng); else pickMarker = L.marker(e.latlng, { icon: takeoffIcon() }).addTo(map);
    stopPick();
}
function startPick() {
    picking = true;
    $('plPick').classList.add('primary');
    $('plPick').textContent = 'Click the map…';
    map.getContainer().style.cursor = 'crosshair';
    map.once('click', onMapClick);
}
function stopPick() {
    picking = false;
    map.off('click', onMapClick);
    map.getContainer().style.cursor = '';
    const b = $('plPick');
    if (b) { b.classList.remove('primary'); b.textContent = 'Pick on map'; }
}
function takeoffIcon() {
    return L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="pl-takeoff">T</div>' });
}

// ------------------------------------------------------------------ analyse
async function analyze() {
    $('plErr').hidden = true;
    $('plGo').disabled = true;
    $('plGo').textContent = 'Checking zones, obstacles, terrain and weather…';
    try {
        const r = await fetch('/api/planner/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            coords: $('plCoords').value, name: $('plName').value, customer: $('plCustomer').value, when: $('plWhen').value,
            profile: $('plProfile').value, altitude_m: Number($('plAlt').value) || 60, radius_m: Number($('plRadius').value) || null,
        }) });
        const j = await r.json();
        if (!r.ok) { alertBox(j.detail || 'The check failed.'); return; }
        current = j;
        show(j);
        loadSaved();
    } catch (e) {
        alertBox('Could not reach the server.');
    } finally {
        $('plGo').disabled = false;
        $('plGo').textContent = 'Check site';
    }
}

function compassSvg(r) {
    const n = r.sectors.length, cx = 110, cy = 110, R = 92, r0 = 22;
    const pt = (a, rad) => [cx + rad * Math.sin(a * Math.PI / 180), cy - rad * Math.cos(a * Math.PI / 180)];
    let g = '';
    r.sectors.forEach((s) => {
        const a0 = s.az - 180 / n + 1, a1 = s.az + 180 / n - 1;
        const len = r0 + (R - r0) * Math.max(0.15, s.usable_m / r.input.radius_m);
        const [x0, y0] = pt(a0, r0), [x1, y1] = pt(a0, len), [x2, y2] = pt(a1, len), [x3, y3] = pt(a1, r0);
        const best = s.i === r.best.i;
        g += `<path d="M${x0},${y0} L${x1},${y1} A${len},${len} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0} Z"
            fill="${scoreColor(s.score, s.blocked)}" fill-opacity="${best ? 0.95 : 0.55}" stroke="${best ? '#e3eef4' : '#0e1a24'}" stroke-width="${best ? 2 : 1}">
            <title>${s.dir}: ${s.blocked ? 'blocked' : `score ${s.score}`}, clear ${s.usable_m} m</title></path>`;
    });
    ['N', 'E', 'S', 'W'].forEach((l, k) => {
        const [x, y] = pt(k * 90, R + 12);
        g += `<text x="${x}" y="${y + 4}" text-anchor="middle" class="pl-cl">${l}</text>`;
    });
    const w = r.weather && r.weather.hour;
    if (w && w.wind_direction_120m != null) {
        const a = w.wind_direction_120m;
        const [x1, y1] = pt(a, R + 4), [x2, y2] = pt(a, R - 16);
        g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9fd8ee" stroke-width="2" marker-end="url(#arr)"><title>Wind from ${Math.round(a)}°</title></line>`;
    }
    const [bx, by] = pt(r.best.az, R - 8);
    if (r.best.score > 0) g += `<line x1="${cx}" y1="${cy}" x2="${bx}" y2="${by}" stroke="#e3eef4" stroke-width="3" marker-end="url(#arrW)"/>`;
    return `<svg viewBox="-10 -10 240 240" class="pl-compass" role="img" aria-label="Score of each direction">
        <defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#9fd8ee"/></marker>
        <marker id="arrW" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#e3eef4"/></marker></defs>
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#22394b"/>${g}<circle cx="${cx}" cy="${cy}" r="5" fill="#e3eef4"/></svg>`;
}

function bestWindow(day) {
    if (!day || !day.length) return null;
    let best = null;
    for (let i = 0; i < day.length - 1; i++) {
        const a = day[i], b = day[i + 1];
        if (a.rain > 0.2 || b.rain > 0.2) continue;
        const w = Math.max(a.wind120, b.wind120, a.gust, b.gust);
        if (!best || w < best.w) best = { from: a.time, to: day[i + 1].time.replace(':00', ':59'), w };
    }
    return best;
}

function show(r) {
    const v = r.verdict;
    const z = r.takeoff;
    const ozone = { green: 'Green zone', yellow: 'Yellow zone', red: 'Red zone' }[z.zone];
    const best = r.best;
    const route = r.route;
    const win = bestWindow(r.weather && r.weather.day);
    const srcNames = { osm: 'Obstacle map (OpenStreetMap)', elevation: 'Terrain (Copernicus DEM via Open-Meteo)', weather: 'Weather forecast (Open-Meteo)' };
    const prof = r.profile;
    const sorted = [...r.sectors].sort((a, b) => b.score - a.score || b.usable_m - a.usable_m);
    $('plResult').innerHTML = `
    <section class="pl-verdict ${LEVEL[v.level]}">
        <div class="pl-vl">${esc(v.label)}</div>
        <div class="pl-site">${esc(r.name)}${r.customer ? ` · ${esc(r.customer)}` : ''} · ${r.input.lat.toFixed(5)}, ${r.input.lon.toFixed(5)}</div>
        ${v.reasons.length ? `<ul>${v.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </section>

    <section class="pl-sec"><h3>Airspace at the take-off point</h3>
        <div class="pl-zone"><span class="pl-chip ${z.zone}">${ozone}</span>
            <span>${z.zone === 'green' ? `Green up to <b>${z.max_green_agl_m} m</b> (${Math.round(z.max_green_agl_m * 3.281)} ft) AGL` : z.zone === 'yellow' ? 'ATC permission needed through DigitalSky' : 'No-fly without Central Government permission'}</span></div>
        ${z.reasons.length ? `<ul class="pl-list">${z.reasons.map((x) => `<li class="${x.zone}">${esc(x.text)}</li>`).join('')}</ul>` : '<p class="pl-small">No airport, border or restricted area within range.</p>'}
        ${r.nearest_airports.length ? `<p class="pl-small">Nearest: ${r.nearest_airports.slice(0, 3).map((a) => `${esc(a.name)} ${a.dist_km} km`).join(' · ')}</p>` : ''}
    </section>

    <section class="pl-sec"><h3>Best direction to fly</h3>
        <div class="pl-dir">
            ${compassSvg(r)}
            <div>
                ${best.score > 0 ? `<div class="pl-big">${esc(best.dir)} <small>${Math.round(best.az)}°</small></div>
                <div class="pl-small">Score ${best.score} / 100 · clear for ${best.usable_m} m${r.clear_arc ? ` · good from ${esc(r.clear_arc.from)} to ${esc(r.clear_arc.to)}` : ''}</div>
                <ul class="pl-list">${(best.notes.length ? best.notes : ['No obstacles, crowds or airspace limits found in this direction.']).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
                : '<div class="pl-big red">No safe direction</div><p class="pl-small">Every direction is blocked within 300 m. Pick another take-off point.</p>'}
                <p class="pl-small">Colours: green good, amber caution, red blocked. Wedge length is the clear distance. The blue arrow is the wind.</p>
            </div>
        </div>
        <details><summary>All 16 directions</summary><table class="pl-table"><thead><tr><th>Dir</th><th>Score</th><th>Clear</th><th>Why</th></tr></thead><tbody>
        ${sorted.map((s) => `<tr><td>${s.dir}</td><td><span class="pl-bar"><i style="width:${s.score}%;background:${scoreColor(s.score, s.blocked)}"></i></span>${s.blocked ? 'blocked' : s.score}</td><td class="num">${s.usable_m} m</td><td>${esc((s.blocked ? [s.blocked] : s.notes).join('; ') || 'clear')}</td></tr>`).join('')}
        </tbody></table></details>
    </section>

    ${route ? `<section class="pl-sec"><h3>Demo route</h3>
        <p>Take off, climb to <b>${r.input.altitude_m} m</b>, fly <b>${esc(route.dir)}</b> to ${route.reach_m} m, hold 10 s at the demo point, sweep the camera and return.</p>
        <div class="pl-kv"><div><span>Distance</span><b>${(route.distance_m / 1000).toFixed(2)} km</b></div><div><span>Flight time</span><b>${route.minutes} min</b></div>
            <div><span>Battery</span><b>${route.battery_pct}%</b></div><div><span>Waypoints</span><b>${route.waypoints.length}</b></div></div>
        <p class="pl-small">Includes ${route.hover_s / 60} min of hovering for the camera demo. ${prof.name} endurance is ${prof.endurance_min} min; keep at least 30% for landing.</p>
        <div class="actions"><a class="btn primary" href="/api/planner/plans/${r.id}/mission.waypoints">Mission Planner file</a>
            <a class="btn" href="/api/planner/plans/${r.id}/mission.plan">QGroundControl file</a>
            <button class="btn" type="button" id="plFit">Show on map</button></div>
    </section>` : ''}

    <section class="pl-sec"><h3>${esc(prof.name)} limits on the day</h3>
        <table class="pl-table pl-checks"><tbody>${r.checks.map((c) => `<tr class="${c.status}"><td class="st">${STATUS_ICON[c.status]}</td><td><b>${esc(c.name)}</b><div class="pl-small">${esc(c.limit)}</div></td><td>${esc(c.value)}</td></tr>`).join('')}</tbody></table>
        ${win ? `<p class="pl-small">Calmest dry window that day: <b>${win.from}–${win.to}</b> (wind and gusts up to ${win.w.toFixed(1)} m/s).</p>` : ''}
        <p class="pl-small">${esc(prof.category)}. Fly in visual line of sight, by day, and don't fly over crowds. Recovery area ${prof.recovery_space_m} m × ${prof.recovery_space_m} m.</p>
    </section>

    <section class="pl-sec pl-foot">
        <p><b>Confirm on DigitalSky before every demo.</b> These zones are estimated from the DGCA airspace-map rules and public data: airports from OurAirports, borders from Natural Earth, and sensitive areas from OpenStreetMap. The official map is at <a href="https://digitalsky.dgca.gov.in" target="_blank" rel="noopener">digitalsky.dgca.gov.in</a>.</p>
        <p class="pl-small">Map data © OpenStreetMap contributors · weather and terrain by Open-Meteo.com · airports from OurAirports · borders from Natural Earth.</p>
        <p class="pl-small">${Object.entries(r.sources).map(([k, s]) => `${srcNames[k]}: ${s.ok ? 'checked' : `<span class="warn">not available (${esc(s.error)})</span>`}`).join('<br>')}</p>
    </section>`;
    const f = $('plFit');
    if (f) f.onclick = () => fit(r);
    draw(r);
    fit(r);
    $('plResult').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ------------------------------------------------------------------ map overlay
function draw(r) {
    if (layer) map.removeLayer(layer);
    layer = L.layerGroup().addTo(map);
    if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
    const o = r.overlay;
    o.airspace.forEach((s) => {
        const c = ZONE[s.color] || '#f0524d';
        if (s.type === 'ring') L.polyline(s.coords.concat([s.coords[0]]), { color: c, weight: 2, dashArray: '6 6', opacity: 0.9 }).bindTooltip(esc(s.name), { sticky: true }).addTo(layer);
        else if (s.type === 'border') L.polyline(s.coords, { color: c, weight: 3, opacity: 0.9 }).bindTooltip(esc(s.name), { sticky: true }).addTo(layer);
        else if (s.type === 'area' || s.type === 'custom') L.polygon(s.coords, { color: c, weight: 2, fillOpacity: 0.18 }).bindTooltip(esc(s.name), { sticky: true }).addTo(layer);
        else if (s.type === 'airport') L.circleMarker([s.lat, s.lon], { radius: 5, color: '#e3eef4', weight: 2, fillColor: '#0e1a24', fillOpacity: 1 }).bindTooltip(esc(s.name)).addTo(layer);
    });
    o.sectors.forEach((s) => {
        const sec = r.sectors[s.i];
        L.polygon(s.coords, { color: s.i === r.best.i ? '#e3eef4' : scoreColor(s.score, s.blocked), weight: s.i === r.best.i ? 2.5 : 0.5,
            fillColor: scoreColor(s.score, s.blocked), fillOpacity: s.i === r.best.i ? 0.32 : 0.16 })
            .bindTooltip(`${sec.dir}: ${sec.blocked ? 'blocked' : `score ${sec.score}`}, clear ${sec.usable_m} m`, { sticky: true }).addTo(layer);
    });
    L.polyline(o.radius.concat([o.radius[0]]), { color: '#54c8e8', weight: 1.5, dashArray: '3 5' }).addTo(layer);
    o.lines.forEach((l) => {
        const style = l.kind === 'power_line' ? { color: '#ff6b6b', weight: 3 } : l.kind === 'railway' ? { color: '#c9a6ff', weight: 2, dashArray: '8 4' }
            : l.kind === 'road' ? { color: '#b8c7d3', weight: 2, opacity: 0.7 } : { color: '#7fb3ff', weight: 2 };
        L.polyline(l.coords, style).bindTooltip(esc(l.label), { sticky: true }).addTo(layer);
    });
    o.obstacles.forEach((b) => {
        L.circleMarker([b.lat, b.lon], { radius: b.h >= r.input.altitude_m - 20 ? 6 : 3, color: b.h >= r.input.altitude_m - 20 ? '#ff6b6b' : '#f2b63d', weight: 1.5, fillOpacity: 0.7 })
            .bindTooltip(`${esc(b.label)}: ${b.h} m${b.known ? '' : ' (estimated)'}`).addTo(layer);
    });
    o.crowd.forEach((c) => L.circleMarker([c.lat, c.lon], { radius: 5, color: '#c9a6ff', weight: 2, fillOpacity: 0.3 }).bindTooltip(esc(c.label)).addTo(layer));
    if (r.route) {
        const pts = [[r.input.lat, r.input.lon]].concat(r.route.waypoints.map((w) => [w.lat, w.lon])).concat([[r.input.lat, r.input.lon]]);
        L.polyline(pts, { color: '#0e1a24', weight: 7, opacity: 0.7 }).addTo(layer);
        L.polyline(pts, { color: '#54c8e8', weight: 3.5 }).addTo(layer);
        r.route.waypoints.forEach((w, k) => L.marker([w.lat, w.lon], { icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: `<div class="pl-wp">${k + 1}</div>` }) })
            .bindTooltip(`${k + 1}. ${esc(w.name)} · ${w.alt_m} m`).addTo(layer));
    }
    L.marker([r.input.lat, r.input.lon], { icon: takeoffIcon(), zIndexOffset: 1000 }).bindTooltip('Take-off').addTo(layer);
}
function fit(r) {
    map.fitBounds(L.polyline(r.overlay.radius).getBounds(), { padding: [30, 30] });
    // outside the green zone, zoom out so the airport rings / border that cause it are in view
    if (r.takeoff.zone !== 'green') map.setZoom(map.getZoom() - 2);
}

// ------------------------------------------------------------------ saved sites & zones
async function loadSaved() {
    const r = await fetch('/api/planner/plans');
    const rows = r.ok ? await r.json() : [];
    const dt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    $('plSavedList').innerHTML = rows.length ? `<table class="pl-table"><tbody>${rows.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.customer ? `<div class="pl-small">${esc(p.customer)}</div>` : ''}</td>
        <td class="pl-small">${dt.format(new Date(p.created * 1000))}</td><td><span class="pl-chip ${p.verdict === 'go' ? 'green' : p.verdict === 'no' ? 'red' : 'yellow'}">${esc(p.best_dir)}</span></td>
        <td style="white-space:nowrap"><button class="btn" type="button" data-open="${p.id}">Open</button> <button class="btn" type="button" data-del="${p.id}" aria-label="Delete">✕</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="pl-small">Sites you check are saved here.</p>';
    $('plSavedList').className = '';
    $('plSavedList').querySelectorAll('[data-open]').forEach((b) => { b.onclick = async () => { const j = await (await fetch(`/api/planner/plans/${b.dataset.open}`)).json(); current = j; show(j); }; });
    $('plSavedList').querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { await fetch(`/api/planner/plans/${b.dataset.del}`, { method: 'DELETE' }); loadSaved(); }; });
}
async function loadZones() {
    const r = await fetch('/api/zones');
    const zs = r.ok ? await r.json() : [];
    $('zList').innerHTML = zs.length ? `<table class="pl-table"><tbody>${zs.map((z) => `<tr><td><span class="pl-chip ${z.color}">${z.color}</span></td><td>${esc(z.name)}<div class="pl-small">${z.center ? `${z.center[0].toFixed(4)}, ${z.center[1].toFixed(4)}, ${Math.round(z.radius_m)} m` : `polygon, ${z.ring.length} points`}</div></td>
        <td><button class="btn" type="button" data-zdel="${z.id}" aria-label="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="pl-small">None yet.</p>';
    $('zList').querySelectorAll('[data-zdel]').forEach((b) => { b.onclick = async () => { await fetch(`/api/zones/${b.dataset.zdel}`, { method: 'DELETE' }); loadZones(); }; });
}
})();
