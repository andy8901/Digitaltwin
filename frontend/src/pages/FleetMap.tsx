import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { go } from '../App';
import { droneIcon, homeIcon, MapBox, TONE_COLOR } from '../components/MapView';
import { CONN_LABEL, dur, flightStatus, fmt, gpsLabel, tone, TONE_LABEL } from '../lib/format';
import { useLive } from '../lib/live';
import type { Drone } from '../lib/types';

interface Layers { m: L.Map; marks: Record<string, L.Marker>; trails: Record<string, L.Polyline & { _fid?: number | null }>; homes: Record<string, L.Marker>; fences: Record<string, L.Circle>; fitted: boolean }

function popup(d: Drone) {
  return `<div class="pop"><b>${d.drone_id}</b> <span class="muted">${d.gcs_id ?? ''}</span><br>
    <span class="chip tone-${tone(d)}">${TONE_LABEL[tone(d)]}</span> ${flightStatus(d)} · ${d.mode || '—'}<br>
    Altitude <b>${fmt(d.alt, 0)} m</b> · speed <b>${fmt(d.gs, 1)} m/s</b><br>
    Battery <b>${fmt(d.batt_pct)}%</b> · GPS <b>${gpsLabel(d)}</b><br>
    Flight <b>${d.armed && d.flight_s != null ? dur(d.flight_s) : '—'}</b> · ${CONN_LABEL[d.conn]}<br>
    <a href="#/drone/${d.key}">Open digital twin →</a></div>`;
}

export function FleetMap() {
  const drones = useLive((s) => s.drones);
  const L0 = useRef<Layers | null>(null);
  const [showTrails, setShowTrails] = useState(true);
  const onMap = (m: L.Map) => { L0.current = { m, marks: {}, trails: {}, homes: {}, fences: {}, fitted: false }; };
  useEffect(() => {
    const r = L0.current;
    if (!r) return;
    const pts: [number, number][] = [];
    for (const d of drones) {
      if (d.lat == null || d.lon == null) continue;
      const ll: [number, number] = [d.lat, d.lon];
      if (d.conn !== 'offline') pts.push(ll);
      if (!r.marks[d.key]) {
        r.marks[d.key] = L.marker(ll, { icon: droneIcon(d) }).bindPopup(popup(d)).addTo(r.m);
        r.marks[d.key].on('dblclick', () => go(`drone/${d.key}`));
      } else {
        r.marks[d.key].setLatLng(ll).setIcon(droneIcon(d));
        r.marks[d.key].getPopup()?.setContent(popup(d));
      }
      r.marks[d.key].setOpacity(d.conn === 'offline' ? 0.55 : 1);
      if (d.home) {
        if (!r.homes[d.key]) r.homes[d.key] = L.marker(d.home, { icon: homeIcon('H') }).bindTooltip(`${d.drone_id} home`).addTo(r.m);
        else r.homes[d.key].setLatLng(d.home);
        if (!r.fences[d.key]) r.fences[d.key] = L.circle(d.home, { radius: 1500, color: '#f5c242', weight: 1, opacity: 0.45, dashArray: '4 6', fill: false }).bindTooltip(`${d.drone_id} geofence`).addTo(r.m);
        else r.fences[d.key].setLatLng(d.home);
      }
      let tr = r.trails[d.key];
      if (d.airborne && (!tr || tr._fid !== d.flight_id)) {
        tr?.remove();
        tr = r.trails[d.key] = Object.assign(L.polyline([], { color: TONE_COLOR[tone(d)], weight: 2.5, opacity: 0.85 }), { _fid: d.flight_id });
        if (showTrails) tr.addTo(r.m);
      }
      if (tr && d.airborne) {
        const p = tr.getLatLngs() as L.LatLng[];
        const last = p[p.length - 1];
        if (!last || r.m.distance(last, ll) > 3) tr.addLatLng(ll);
        tr.setStyle({ color: TONE_COLOR[tone(d)] });
      }
    }
    if (!r.fitted && pts.length) { r.m.fitBounds(pts, { padding: [40, 40], maxZoom: 15 }); r.fitted = true; }
  }, [drones, showTrails]);
  useEffect(() => {
    const r = L0.current;
    if (!r) return;
    Object.values(r.trails).forEach((t) => (showTrails ? t.addTo(r.m) : t.remove()));
  }, [showTrails]);
  const fit = () => {
    const r = L0.current;
    const pts = drones.filter((d) => d.lat != null && d.conn !== 'offline').map((d) => [d.lat!, d.lon!] as [number, number]);
    if (r && pts.length) r.m.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  };
  return (
    <div className="map-page">
      <div className="page-bar">
        <h1>Fleet map</h1>
        <span className="muted">{drones.filter((d) => d.airborne).length} airborne · click a drone for its telemetry, double-click to open its twin</span>
        <span className="spacer" />
        <label className="tgl"><input type="checkbox" checked={showTrails} onChange={(e) => setShowTrails(e.target.checked)} /> Trajectories</label>
        <button className="btn" onClick={fit}>Fit all drones</button>
      </div>
      <div className="map-wrap">
        <MapBox className="fleet-map" onMap={onMap} />
        <div className="map-legend">
          {(['airborne', 'normal', 'warning', 'critical', 'offline'] as const).map((t) => <span key={t}><i style={{ background: TONE_COLOR[t] }} />{TONE_LABEL[t]}</span>)}
          <span><i className="lg-fence" />Geofence</span><span><i className="lg-home">H</i>Home</span>
        </div>
        <div className="map-list">
          {drones.map((d) => (
            <button key={d.key} className={`ml-row tone-${tone(d)}`} onClick={() => {
              const r = L0.current;
              if (r && d.lat != null) { r.m.setView([d.lat, d.lon!], 16); r.marks[d.key]?.openPopup(); }
            }}>
              <i /><b>{d.drone_id}</b><span className="num">{d.airborne ? `${fmt(d.alt, 0)} m` : flightStatus(d)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
