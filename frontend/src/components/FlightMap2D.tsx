// 2D flight-path map (GCS style): every drone's GPS track as a continuous line, its current position with heading
// arrow and movement vector, home (H) and take-off (T), and the planned mission (flown part solid, remaining dashed)
// when the mission was heard on the GCS link. Only received telemetry is drawn; gaps in telemetry stay gaps.
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { tone } from '../lib/format';
import { altColor, droneColor, type DronePath, type PathPt } from '../lib/paths';
import type { Drone } from '../lib/types';
import { homeIcon, MapBox, TONE_COLOR } from './MapView';

type ColorBy = 'drone' | 'altitude';
interface Track { group: L.LayerGroup; cur: L.Polyline | null; curKey: string; n: number; flightId: number | null; colorBy: ColorBy; color: string }
interface Mark { m: L.Marker; vec: L.Polyline; home: L.Marker | null; to: L.Marker | null }
interface Plan { group: L.LayerGroup; ver: number; seq: number | null }

export function arrowIcon(d: Drone, color: string, opts: { focus?: boolean; label?: boolean } = {}) {
  const s = opts.focus ? 40 : 30;
  const ring = TONE_COLOR[tone(d)];
  const stale = d.ages?.pos == null || d.ages.pos > 3;
  return L.divIcon({
    className: 'drone-pin', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
    html: `<svg viewBox="0 0 40 40" width="${s}" height="${s}" style="opacity:${stale ? 0.5 : 1}">
      <circle cx="20" cy="20" r="17" fill="rgba(5,7,10,.55)" stroke="${ring}" stroke-width="${opts.focus ? 3 : 2.2}" ${stale ? 'stroke-dasharray="4 3"' : ''}/>
      <g transform="rotate(${d.heading ?? 0} 20 20)"><path d="M20 6 L28 29 L20 24.5 L12 29 Z" fill="${color}" stroke="#05070a" stroke-width="1.4" stroke-linejoin="round"/></g></svg>
      ${opts.label === false ? '' : `<span class="pin-label">${d.drone_id}${d.alt != null && d.airborne ? ` · ${Math.round(d.alt)} m` : ''}${stale ? ' · no data' : ''}</span>`}`,
  });
}

function wpIcon(n: number, done: boolean) {
  return L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: `<div class="wp-pin ${done ? 'done' : ''}">${n}</div>` });
}

export function FlightMap2D({ drones, paths, focusKey, colorBy = 'drone', showOthers = true, follow = false, onSelect, className = '', fitKey }: {
  drones: Drone[]; paths: Record<string, DronePath>; focusKey?: string | null; colorBy?: ColorBy; showOthers?: boolean; follow?: boolean;
  onSelect?: (key: string) => void; className?: string; fitKey?: string | number;
}) {
  const r = useRef<{ m: L.Map; tracks: Record<string, Track>; marks: Record<string, Mark>; plans: Record<string, Plan>; fitted: string | number | null } | null>(null);
  const onSel = useRef(onSelect);
  onSel.current = onSelect;

  const onMap = (m: L.Map) => { r.current = { m, tracks: {}, marks: {}, plans: {}, fitted: null }; };

  useEffect(() => {
    const R = r.current;
    if (!R) return;
    const { m } = R;
    const vis = drones.filter((d) => d.key === focusKey || showOthers || !focusKey);
    const visKeys = new Set(vis.map((d) => d.key));
    // remove drones no longer shown
    for (const k of Object.keys(R.marks)) if (!visKeys.has(k)) { const x = R.marks[k]; x.m.remove(); x.vec.remove(); x.home?.remove(); x.to?.remove(); delete R.marks[k]; }
    for (const k of Object.keys(R.tracks)) if (!visKeys.has(k)) { R.tracks[k].group.remove(); delete R.tracks[k]; }
    for (const k of Object.keys(R.plans)) if (!visKeys.has(k)) { R.plans[k].group.remove(); delete R.plans[k]; }

    for (const d of vis) {
      const focus = d.key === focusKey;
      const dim = !!focusKey && !focus;
      const col = droneColor(d);
      const p = paths[d.key];
      // --- trajectory (incremental: only new points are added)
      const mode: ColorBy = focus ? colorBy : 'drone';
      let tr = R.tracks[d.key];
      const pts: PathPt[] = p?.pts ?? [];
      if (tr && (tr.flightId !== (p?.flightId ?? null) || pts.length < tr.n || tr.colorBy !== mode || tr.color !== col)) { tr.group.remove(); tr = undefined as unknown as Track; delete R.tracks[d.key]; }
      if (!tr) tr = R.tracks[d.key] = { group: L.layerGroup().addTo(m), cur: null, curKey: '', n: 0, flightId: p?.flightId ?? null, colorBy: mode, color: col };
      for (let i = tr.n; i < pts.length; i++) {
        const pt = pts[i];
        const key = mode === 'altitude' ? altColor(pt.alt) : col;
        const ll: L.LatLngTuple = [pt.lat, pt.lon];
        if (!tr.cur || pt.gap || key !== tr.curKey) {
          const prev = i > 0 && !pt.gap ? [pts[i - 1].lat, pts[i - 1].lon] as L.LatLngTuple : null;
          tr.cur = L.polyline(prev ? [prev, ll] : [ll], { color: key, weight: focus ? 4 : focusKey ? 2.5 : 3, opacity: dim ? 0.45 : 0.95, interactive: false }).addTo(tr.group);
          tr.curKey = key;
        } else tr.cur.addLatLng(ll);
      }
      tr.n = pts.length;
      // --- planned mission
      const items = p?.mission ?? [];
      let pl = R.plans[d.key];
      const seq = d.mission_seq;
      if (pl && (pl.ver !== (p?.missionVer ?? 0) || pl.seq !== seq)) { pl.group.remove(); delete R.plans[d.key]; pl = undefined as unknown as Plan; }
      if (!pl && items.length && (focus || !focusKey)) {
        const g = L.layerGroup().addTo(m);
        pl = R.plans[d.key] = { group: g, ver: p?.missionVer ?? 0, seq };
        const lls = items.map((it) => [it.lat, it.lon] as L.LatLngTuple);
        const k = seq == null ? 0 : Math.max(0, items.findIndex((it) => it.seq >= seq));
        if (k > 0) L.polyline(lls.slice(0, k + 1), { color: '#8796a3', weight: 2, opacity: 0.7, interactive: false }).addTo(g);
        L.polyline(lls.slice(k), { color: focus ? '#e6edf2' : col, weight: 2, dashArray: '7 7', opacity: 0.85, interactive: false }).addTo(g);
        if (focus) items.forEach((it, i) => L.marker([it.lat, it.lon], { icon: wpIcon(i + 1, seq != null && it.seq < seq), interactive: true })
          .bindTooltip(`${i + 1}. ${it.kind} · ${Math.round(it.alt)} m ${it.alt_ref === 'home' ? 'above home' : 'AMSL'}`).addTo(g));
      }
      // --- markers
      if (d.lat == null || d.lon == null) continue;
      const ll: L.LatLngTuple = [d.lat, d.lon];
      let mk = R.marks[d.key];
      if (!mk) {
        const marker = L.marker(ll, { icon: arrowIcon(d, col, { focus }), zIndexOffset: focus ? 1000 : 0 }).addTo(m);
        marker.on('click', () => onSel.current?.(d.key));
        mk = R.marks[d.key] = { m: marker, vec: L.polyline([ll, ll], { color: '#ffffff', weight: 2, opacity: 0.9, dashArray: '2 4', interactive: false }).addTo(m), home: null, to: null };
      } else mk.m.setLatLng(ll).setIcon(arrowIcon(d, col, { focus }));
      mk.m.setOpacity(d.conn === 'offline' ? 0.5 : dim ? 0.8 : 1);
      // movement vector: where the drone will be in 10 s at its current ground speed and course
      if (d.track != null && (d.gs ?? 0) > 0.5 && d.conn !== 'offline') {
        const dist = (d.gs ?? 0) * 10, a = (d.track * Math.PI) / 180;
        const to: L.LatLngTuple = [d.lat + (dist * Math.cos(a)) / 111320, d.lon + (dist * Math.sin(a)) / (111320 * Math.cos((d.lat * Math.PI) / 180))];
        mk.vec.setLatLngs([ll, to]);
      } else mk.vec.setLatLngs([ll, ll]);
      if (d.home && (focus || !focusKey)) {
        if (!mk.home) mk.home = L.marker(d.home, { icon: focusKey ? homeIcon('H') : L.divIcon({ className: '', iconSize: [12, 12], iconAnchor: [6, 6], html: `<div class="home-dot" style="border-color:${col}"></div>` }), interactive: true }).bindTooltip(`${d.drone_id} home`).addTo(m);
        else mk.home.setLatLng(d.home);
      }
      if (d.takeoff && focus) {
        if (!mk.to) mk.to = L.marker(d.takeoff, { icon: homeIcon('T'), interactive: true }).bindTooltip(`${d.drone_id} take-off point`).addTo(m);
        else mk.to.setLatLng(d.takeoff);
      }
    }
    // --- view
    const fk = fitKey ?? focusKey ?? 'fleet';
    const f = focusKey ? drones.find((d) => d.key === focusKey) : null;
    if (R.fitted !== fk) {
      const pts: L.LatLngTuple[] = [];
      if (f) {
        (paths[f.key]?.pts ?? []).forEach((p) => pts.push([p.lat, p.lon]));
        (paths[f.key]?.mission ?? []).forEach((p) => pts.push([p.lat, p.lon]));
        if (f.lat != null) pts.push([f.lat, f.lon!]);
        if (f.home) pts.push(f.home);
      } else vis.forEach((d) => d.lat != null && d.conn !== 'offline' && pts.push([d.lat, d.lon!]));
      if (pts.length) { m.fitBounds(pts, { padding: [36, 36], maxZoom: 17 }); R.fitted = fk; }
    } else if (follow && f?.lat != null) {
      const c = m.latLngToContainerPoint([f.lat, f.lon!]), sz = m.getSize();
      if (c.x < sz.x * 0.2 || c.x > sz.x * 0.8 || c.y < sz.y * 0.2 || c.y > sz.y * 0.8) m.panTo([f.lat, f.lon!]);
    }
  });

  return <MapBox className={className} onMap={onMap} />;
}

export function AltLegend() {
  return (
    <div className="alt-legend" aria-label="Altitude colours">
      <span>Altitude above home</span>
      <i style={{ background: 'linear-gradient(90deg,#3ddc84,#a3e635,#facc15,#ff9f43,#ff4b4b)' }} />
      <em>0</em><em>30</em><em>60</em><em>90</em><em>120 m</em>
    </div>
  );
}

/** Fit everything again (e.g. a "Fit" button): bump the key. */
export const fitAll = () => Date.now();
