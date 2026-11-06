import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { Drone } from '../lib/types';
import { tone, type Tone } from '../lib/format';

export const TONE_COLOR: Record<Tone, string> = { offline: '#5b6670', critical: '#ff4b4b', warning: '#f5c242', airborne: '#3b8cff', normal: '#3ddc84' };

const LAYERS = {
  sat: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' }),
  street: () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
};

export function useMap(el: React.RefObject<HTMLDivElement>, center: [number, number] = [12.97, 77.6], zoom = 11) {
  const [map, setMap] = useState<L.Map | null>(null);
  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView(center, zoom);
    let which: 'sat' | 'street' = 'sat';
    try { which = (localStorage.getItem('cc.layer') as 'sat' | 'street') || 'sat'; } catch { /* ignore */ }
    let layer = LAYERS[which]().addTo(m);
    const Toggle = L.Control.extend({
      onAdd() {
        const b = L.DomUtil.create('button', 'map-toggle');
        b.type = 'button';
        b.textContent = which === 'sat' ? 'Street map' : 'Satellite';
        L.DomEvent.disableClickPropagation(b);
        b.onclick = () => {
          m.removeLayer(layer);
          which = which === 'sat' ? 'street' : 'sat';
          layer = LAYERS[which]().addTo(m);
          b.textContent = which === 'sat' ? 'Street map' : 'Satellite';
          try { localStorage.setItem('cc.layer', which); } catch { /* ignore */ }
        };
        return b;
      },
    });
    new Toggle({ position: 'topright' }).addTo(m);
    setMap(m);
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); m.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return map;
}

export function droneIcon(d: Drone, opts: { selected?: boolean; small?: boolean } = {}) {
  const c = TONE_COLOR[tone(d)];
  const s = opts.small ? 24 : 32;
  const ring = opts.selected ? `<circle cx="16" cy="16" r="14.5" fill="none" stroke="#54c8e8" stroke-width="2.5"/>` : '';
  return L.divIcon({
    className: 'drone-pin', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
    html: `<svg viewBox="0 0 32 32" width="${s}" height="${s}" style="transform:rotate(${d.heading ?? 0}deg)">${ring}
      <path d="M16 3 L25 26 L16 21 L7 26 Z" fill="${c}" stroke="#05070a" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <span class="pin-label">${d.drone_id}${d.alt != null && d.airborne ? ` · ${Math.round(d.alt)} m` : ''}</span>`,
  });
}

export const homeIcon = (label = 'H') => L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="home-pin">${label}</div>` });

export function MapBox({ className = '', onMap, center, zoom }: { className?: string; onMap: (m: L.Map) => void | (() => void); center?: [number, number]; zoom?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useMap(el, center, zoom);
  useEffect(() => { if (map) return onMap(map) || undefined; }, [map]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} className={`mapbox ${className}`} />;
}
