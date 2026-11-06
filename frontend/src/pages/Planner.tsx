/* eslint-disable @typescript-eslint/no-explicit-any */
// Demo planner: DGCA zone check, safest flying direction and demo route for a customer's site.
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { MapBox } from '../components/MapView';
import { api } from '../lib/api';
import { dateTimeOf } from '../lib/format';

type Plan = any;
const ZONE: Record<string, string> = { green: '#3ddc84', yellow: '#f5c242', red: '#ff4b4b' };
const scoreColor = (s: number, blocked: boolean) => (blocked || s < 50 ? '#ff4b4b' : s < 75 ? '#f5c242' : '#3ddc84');
const ICON: Record<string, string> = { ok: '✓', caution: '!', no: '✕' };

function nextHour() {
  const d = new Date(Date.now() + 3600e3);
  d.setMinutes(0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

function Compass({ r }: { r: Plan }) {
  const n = r.sectors.length, cx = 110, cy = 110, R = 92, r0 = 22;
  const pt = (a: number, rad: number) => [cx + rad * Math.sin((a * Math.PI) / 180), cy - rad * Math.cos((a * Math.PI) / 180)];
  const w = r.weather?.hour;
  const [bx, by] = pt(r.best.az, R - 8);
  return (
    <svg viewBox="-10 -10 240 240" className="pl-compass" role="img" aria-label="Score of each direction">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#9fd8ee" /></marker>
        <marker id="arrW" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#e6edf2" /></marker>
      </defs>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#1e272f" />
      {r.sectors.map((s: any) => {
        const a0 = s.az - 180 / n + 1, a1 = s.az + 180 / n - 1;
        const len = r0 + (R - r0) * Math.max(0.15, s.usable_m / r.input.radius_m);
        const [x0, y0] = pt(a0, r0), [x1, y1] = pt(a0, len), [x2, y2] = pt(a1, len), [x3, y3] = pt(a1, r0);
        const best = s.i === r.best.i;
        return <path key={s.i} d={`M${x0},${y0} L${x1},${y1} A${len},${len} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0} Z`}
          fill={scoreColor(s.score, !!s.blocked)} fillOpacity={best ? 0.95 : 0.5} stroke={best ? '#e6edf2' : '#07090b'} strokeWidth={best ? 2 : 1}>
          <title>{`${s.dir}: ${s.blocked ? 'blocked' : `score ${s.score}`}, clear ${s.usable_m} m`}</title></path>;
      })}
      {['N', 'E', 'S', 'W'].map((l, k) => { const [x, y] = pt(k * 90, R + 12); return <text key={l} x={x} y={y + 4} textAnchor="middle" className="pl-cl">{l}</text>; })}
      {w?.wind_direction_120m != null && (() => { const [x1, y1] = pt(w.wind_direction_120m, R + 4), [x2, y2] = pt(w.wind_direction_120m, R - 16); return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#9fd8ee" strokeWidth={2} markerEnd="url(#arr)" />; })()}
      {r.best.score > 0 && <line x1={cx} y1={cy} x2={bx} y2={by} stroke="#e6edf2" strokeWidth={3} markerEnd="url(#arrW)" />}
      <circle cx={cx} cy={cy} r={5} fill="#e6edf2" />
    </svg>
  );
}

function bestWindow(day: any[] | undefined) {
  if (!day?.length) return null;
  let best: { from: string; to: string; w: number } | null = null;
  for (let i = 0; i < day.length - 1; i++) {
    const a = day[i], b = day[i + 1];
    if (a.rain > 0.2 || b.rain > 0.2) continue;
    const w = Math.max(a.wind120, b.wind120, a.gust, b.gust);
    if (!best || w < best.w) best = { from: a.time, to: b.time.replace(':00', ':59'), w };
  }
  return best;
}

export function Planner() {
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [form, setForm] = useState({ coords: '', name: '', customer: '', when: nextHour(), profile: 'tavas', altitude_m: 60, radius_m: '' as string | number });
  const [r, setR] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [zf, setZf] = useState({ name: '', color: 'red', coords: '', radius_m: 1000 });
  const mapRef = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const picking = useRef(false);
  const [pickOn, setPickOn] = useState(false);
  const loadSaved = () => api<any[]>('/api/planner/plans').then(setSaved);
  const loadZones = () => api<any[]>('/api/zones').then(setZones);
  useEffect(() => { api<Record<string, any>>('/api/planner/profiles').then(setProfiles); loadSaved(); loadZones(); }, []);

  const onMap = (m: L.Map) => {
    mapRef.current = m;
    m.setView([12.97, 77.59], 10);
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (!picking.current) return;
      setForm((f) => ({ ...f, coords: `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}` }));
      picking.current = false;
      setPickOn(false);
      m.getContainer().style.cursor = '';
    });
  };
  const startPick = () => { picking.current = !picking.current; setPickOn(picking.current); if (mapRef.current) mapRef.current.getContainer().style.cursor = picking.current ? 'crosshair' : ''; };

  const analyze = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true); setErr('');
    try {
      const j = await api<Plan>('/api/planner/analyze', { json: { ...form, radius_m: Number(form.radius_m) || null } });
      setR(j); loadSaved();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !r) return;
    layer.current?.remove();
    const g = L.layerGroup().addTo(m);
    layer.current = g;
    const o = r.overlay;
    o.airspace.forEach((s: any) => {
      const c = ZONE[s.color] || '#ff4b4b';
      if (s.type === 'ring') L.polyline([...s.coords, s.coords[0]], { color: c, weight: 2, dashArray: '6 6' }).bindTooltip(s.name, { sticky: true }).addTo(g);
      else if (s.type === 'border') L.polyline(s.coords, { color: c, weight: 3 }).bindTooltip(s.name, { sticky: true }).addTo(g);
      else if (s.type === 'area' || s.type === 'custom') L.polygon(s.coords, { color: c, weight: 2, fillOpacity: 0.18 }).bindTooltip(s.name, { sticky: true }).addTo(g);
      else if (s.type === 'airport') L.circleMarker([s.lat, s.lon], { radius: 5, color: '#e6edf2', weight: 2, fillColor: '#07090b', fillOpacity: 1 }).bindTooltip(s.name).addTo(g);
    });
    o.sectors.forEach((s: any) => {
      const sec = r.sectors[s.i];
      const best = s.i === r.best.i;
      L.polygon(s.coords, { color: best ? '#e6edf2' : scoreColor(s.score, s.blocked), weight: best ? 2.5 : 0.5, fillColor: scoreColor(s.score, s.blocked), fillOpacity: best ? 0.32 : 0.15 })
        .bindTooltip(`${sec.dir}: ${sec.blocked ? 'blocked' : `score ${sec.score}`}, clear ${sec.usable_m} m`, { sticky: true }).addTo(g);
    });
    L.polyline([...o.radius, o.radius[0]], { color: '#54c8e8', weight: 1.5, dashArray: '3 5' }).addTo(g);
    o.lines.forEach((l: any) => L.polyline(l.coords, l.kind === 'power_line' ? { color: '#ff6b6b', weight: 3 } : l.kind === 'railway' ? { color: '#c9a6ff', weight: 2, dashArray: '8 4' } : { color: '#b8c7d3', weight: 2, opacity: 0.7 }).bindTooltip(l.label, { sticky: true }).addTo(g));
    o.obstacles.forEach((b: any) => { const tall = b.h >= r.input.altitude_m - 20; L.circleMarker([b.lat, b.lon], { radius: tall ? 6 : 3, color: tall ? '#ff6b6b' : '#f5c242', weight: 1.5, fillOpacity: 0.7 }).bindTooltip(`${b.label}: ${b.h} m${b.known ? '' : ' (estimated)'}`).addTo(g); });
    o.crowd.forEach((c: any) => L.circleMarker([c.lat, c.lon], { radius: 5, color: '#c9a6ff', weight: 2, fillOpacity: 0.3 }).bindTooltip(c.label).addTo(g));
    if (r.route) {
      const pts = [[r.input.lat, r.input.lon], ...r.route.waypoints.map((w: any) => [w.lat, w.lon]), [r.input.lat, r.input.lon]] as [number, number][];
      L.polyline(pts, { color: '#000', weight: 7, opacity: 0.6 }).addTo(g);
      L.polyline(pts, { color: '#54c8e8', weight: 3.5 }).addTo(g);
      r.route.waypoints.forEach((w: any, k: number) => L.marker([w.lat, w.lon], { icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: `<div class="pl-wp">${k + 1}</div>` }) }).bindTooltip(`${k + 1}. ${w.name} · ${w.alt_m} m`).addTo(g));
    }
    L.marker([r.input.lat, r.input.lon], { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="pl-takeoff">T</div>' }), zIndexOffset: 1000 }).bindTooltip('Take-off').addTo(g);
    m.fitBounds(L.polyline(o.radius).getBounds(), { padding: [30, 30] });
    if (r.takeoff.zone !== 'green') m.setZoom(m.getZoom() - 2);
  }, [r]);

  const v = r?.verdict;
  const z = r?.takeoff;
  const win = r ? bestWindow(r.weather?.day) : null;
  const srcNames: Record<string, string> = { osm: 'Obstacle map (OpenStreetMap)', elevation: 'Terrain (Copernicus DEM via Open-Meteo)', weather: 'Weather forecast (Open-Meteo)' };
  return (
    <div className="planner-page">
      <div className="pl-side">
        <h1>Demo planner</h1>
        <p className="muted">Paste the customer's coordinates or click the map. The planner checks DGCA zones, obstacles, terrain, weather and the drone's limits, then picks the safest direction for the demo.</p>
        <form className="form-grid" onSubmit={analyze}>
          <label className="wide">Coordinates<span className="row"><input required value={form.coords} placeholder="12.9716, 77.5946 or a Google Maps link" onChange={(e) => setForm({ ...form, coords: e.target.value })} />
            <button type="button" className={`btn ${pickOn ? 'primary' : ''}`} onClick={startPick}>{pickOn ? 'Click the map…' : 'Pick on map'}</button></span></label>
          <label>Site name<input value={form.name} placeholder="e.g. Hoskote yard" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Customer<input value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} /></label>
          <label>Demo date and time<input type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} /></label>
          <label>Drone<select value={form.profile} onChange={(e) => setForm({ ...form, profile: e.target.value })}>{Object.entries(profiles).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}</select></label>
          <label>Flight height (m AGL)<input type="number" min={15} max={120} step={5} value={form.altitude_m} onChange={(e) => setForm({ ...form, altitude_m: Number(e.target.value) })} /></label>
          <label>Demo radius (m)<input type="number" min={300} max={3000} step={100} value={form.radius_m} placeholder={`${profiles[form.profile]?.video_range_m ?? 1500} (video range)`} onChange={(e) => setForm({ ...form, radius_m: e.target.value })} /></label>
          <button className="btn primary wide" disabled={busy}>{busy ? 'Checking zones, obstacles, terrain and weather…' : 'Check site'}</button>
          {err && <p className="bad wide">{err}</p>}
        </form>
        {r && <>
          <section className={`pl-verdict v-${v.level}`}>
            <div className="pl-vl">{v.label}</div>
            <div className="muted num">{r.name}{r.customer ? ` · ${r.customer}` : ''} · {r.input.lat.toFixed(5)}, {r.input.lon.toFixed(5)}</div>
            {v.reasons.length > 0 && <ul>{v.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}
          </section>
          <section className="pl-sec"><h3>Airspace at the take-off point</h3>
            <div className="row"><span className={`zchip z-${z.zone}`}>{z.zone} zone</span>
              <span>{z.zone === 'green' ? <>Green up to <b>{z.max_green_agl_m} m</b> ({Math.round(z.max_green_agl_m * 3.281)} ft) AGL</> : z.zone === 'yellow' ? 'ATC permission needed through DigitalSky' : 'No-fly without Central Government permission'}</span></div>
            {z.reasons.length ? <ul className="pl-list">{z.reasons.map((x: any, i: number) => <li key={i} className={`z-${x.zone}`}>{x.text}</li>)}</ul> : <p className="muted">No airport, border or restricted area within range.</p>}
            {r.nearest_airports.length > 0 && <p className="muted small">Nearest: {r.nearest_airports.slice(0, 3).map((a: any) => `${a.name} ${a.dist_km} km`).join(' · ')}</p>}
          </section>
          <section className="pl-sec"><h3>Best direction to fly</h3>
            <div className="pl-dir"><Compass r={r} />
              <div>{r.best.score > 0 ? <>
                <div className="pl-big">{r.best.dir} <small>{Math.round(r.best.az)}°</small></div>
                <div className="muted small">Score {r.best.score} / 100 · clear for {r.best.usable_m} m{r.clear_arc ? ` · good from ${r.clear_arc.from} to ${r.clear_arc.to}` : ''}</div>
                <ul className="pl-list">{(r.best.notes.length ? r.best.notes : ['No obstacles, crowds or airspace limits found in this direction.']).map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></>
                : <><div className="pl-big bad">No safe direction</div><p className="muted">Every direction is blocked within 300 m. Pick another take-off point.</p></>}
              </div></div>
            <details><summary>All 16 directions</summary>
              <table className="tbl tight"><thead><tr><th>Dir</th><th>Score</th><th>Clear</th><th>Why</th></tr></thead><tbody>
                {[...r.sectors].sort((a: any, b: any) => b.score - a.score || b.usable_m - a.usable_m).map((s: any) => (
                  <tr key={s.i}><td>{s.dir}</td><td className="num"><span className="pl-bar"><i style={{ width: `${s.score}%`, background: scoreColor(s.score, !!s.blocked) }} /></span>{s.blocked ? 'blocked' : s.score}</td>
                    <td className="num">{s.usable_m} m</td><td>{(s.blocked ? [s.blocked] : s.notes).join('; ') || 'clear'}</td></tr>))}
              </tbody></table></details>
          </section>
          {r.route && <section className="pl-sec"><h3>Demo route</h3>
            <p>Take off, climb to <b>{r.input.altitude_m} m</b>, fly <b>{r.route.dir}</b> to {r.route.reach_m} m, hold 10 s at the demo point, sweep the camera and return.</p>
            <div className="kvs four"><div><span>Distance</span><b className="num">{(r.route.distance_m / 1000).toFixed(2)} km</b></div><div><span>Flight time</span><b className="num">{r.route.minutes} min</b></div>
              <div><span>Battery</span><b className="num">{r.route.battery_pct}%</b></div><div><span>Waypoints</span><b className="num">{r.route.waypoints.length}</b></div></div>
            <div className="row"><a className="btn primary" href={`/api/planner/plans/${r.id}/mission.waypoints`}>Mission Planner file</a><a className="btn" href={`/api/planner/plans/${r.id}/mission.plan`}>QGroundControl file</a></div>
          </section>}
          <section className="pl-sec"><h3>{r.profile.name} limits on the day</h3>
            <table className="tbl tight checks"><tbody>{r.checks.map((c: any) => <tr key={c.name} className={`ck-${c.status}`}><td className="st">{ICON[c.status]}</td><td><b>{c.name}</b><div className="muted small">{c.limit}</div></td><td>{c.value}</td></tr>)}</tbody></table>
            {win && <p className="muted small">Calmest dry window that day: <b>{win.from}–{win.to}</b> (wind and gusts up to {win.w.toFixed(1)} m/s).</p>}
            <p className="muted small">{r.profile.category}. Fly in visual line of sight, by day, and don't fly over crowds.</p>
          </section>
          <section className="pl-sec pl-foot">
            <p><b>Confirm on DigitalSky before every demo.</b> Zones are estimated from the DGCA airspace-map rules and public data; the official map is at <a href="https://digitalsky.dgca.gov.in" target="_blank" rel="noopener">digitalsky.dgca.gov.in</a>.</p>
            <p className="muted small">Map data © OpenStreetMap contributors · weather and terrain by Open-Meteo.com · airports from OurAirports · borders from Natural Earth.</p>
            <p className="muted small">{Object.entries(r.sources).map(([k, s]: [string, any]) => <span key={k}>{srcNames[k]}: {s.ok ? 'checked' : <span className="warn">not available ({s.error})</span>}<br /></span>)}</p>
          </section>
        </>}
        <details className="pl-box"><summary>Saved sites ({saved.length})</summary>
          <table className="tbl tight"><tbody>{saved.map((p) => <tr key={p.id}><td><b>{p.name}</b><div className="muted small">{p.customer}</div></td><td className="num small">{dateTimeOf(p.created)}</td>
            <td><span className={`zchip z-${p.verdict === 'go' ? 'green' : p.verdict === 'no' ? 'red' : 'yellow'}`}>{p.best_dir}</span></td>
            <td><button className="btn sm" onClick={() => api<Plan>(`/api/planner/plans/${p.id}`).then(setR)}>Open</button> <button className="btn sm ghost" onClick={() => api(`/api/planner/plans/${p.id}`, { method: 'DELETE' }).then(loadSaved)}>✕</button></td></tr>)}</tbody></table>
        </details>
        <details className="pl-box"><summary>Your restricted areas ({zones.length})</summary>
          <p className="muted small">Areas the planner can't know about, such as a red zone seen on DigitalSky or a customer's no-fly area. Used for every site.</p>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); api('/api/zones', { json: zf }).then(() => { setZf({ ...zf, name: '', coords: '' }); loadZones(); }).catch((x) => setErr(x.message)); }}>
            <label>Name<input required value={zf.name} onChange={(e) => setZf({ ...zf, name: e.target.value })} /></label>
            <label>Zone<select value={zf.color} onChange={(e) => setZf({ ...zf, color: e.target.value })}><option value="red">Red</option><option value="yellow">Yellow</option></select></label>
            <label>Centre<input required value={zf.coords} placeholder="lat, lon" onChange={(e) => setZf({ ...zf, coords: e.target.value })} /></label>
            <label>Radius (m)<input type="number" value={zf.radius_m} onChange={(e) => setZf({ ...zf, radius_m: Number(e.target.value) })} /></label>
            <button className="btn wide">Add circle</button>
          </form>
          <label className="file-in">Import GeoJSON or KML polygons <input type="file" accept=".geojson,.json,.kml" onChange={(e) => {
            const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); fd.append('color', 'red');
            fetch('/api/zones/import', { method: 'POST', body: fd }).then(() => loadZones()); }} /></label>
          <table className="tbl tight"><tbody>{zones.map((zz) => <tr key={zz.id}><td><span className={`zchip z-${zz.color}`}>{zz.color}</span></td><td>{zz.name}</td>
            <td><button className="btn sm ghost" onClick={() => api(`/api/zones/${zz.id}`, { method: 'DELETE' }).then(loadZones)}>✕</button></td></tr>)}</tbody></table>
        </details>
      </div>
      <MapBox className="pl-map" onMap={onMap} />
    </div>
  );
}
