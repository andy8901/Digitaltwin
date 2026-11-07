// Satellite flight map (MapLibre GL): satellite / terrain / street base maps, optional 3D terrain and buildings,
// roads and place-name overlays, free rotation and pitch. The travelled path is drawn from recorded GPS points only.
// In 3D the path, drop lines and the drone model are drawn at their recorded altitude by a three.js layer.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { altColor } from '../lib/paths';
import type { MissionItem } from '../lib/types';
import { buildTavas } from './TavasModel';

export type Base = 'satellite' | 'terrain' | 'street';
export type Cam = 'chase' | 'follow' | 'free' | 'whole';
export interface Pose { lat: number | null; lon: number | null; alt: number | null; heading: number | null; roll: number | null; pitch: number | null; yaw: number | null; track?: number | null; gs?: number | null }
export type TrackPt = [number, number, number | null];   // lon, lat, altitude above home
export interface Other { key: string; label: string; lat: number; lon: number; heading: number | null; color: string; alt: number | null }
export interface Layers { base: Base; terrain3d: boolean; buildings: boolean; roads: boolean; labels: boolean }

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    satellite: { type: 'raster', tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
    terrain: { type: 'raster', tiles: [`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19, attribution: 'Topography © Esri' },
    street: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' },
    roads: { type: 'raster', tiles: [`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
    labels: { type: 'raster', tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
    dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 15, encoding: 'terrarium',
      attribution: 'Terrain: Mapzen / AWS Terrain Tiles' },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b1116' } },
    { id: 'satellite', type: 'raster', source: 'satellite' },
    { id: 'terrain', type: 'raster', source: 'terrain', layout: { visibility: 'none' } },
    { id: 'street', type: 'raster', source: 'street', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.3, 'raster-brightness-max': 0.85 } },
    { id: 'roads', type: 'raster', source: 'roads', layout: { visibility: 'none' } },
    { id: 'labels', type: 'raster', source: 'labels', layout: { visibility: 'none' } },
  ],
};

function trackRuns(pts: TrackPt[], colorBy: 'altitude' | string) {
  const feats: GeoJSON.Feature[] = [];
  let cur: number[][] = [], key = '';
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const k = colorBy === 'altitude' ? altColor(p[2]) : colorBy;
    if (k !== key && cur.length) {
      cur.push([p[0], p[1]]);
      feats.push({ type: 'Feature', properties: { c: key }, geometry: { type: 'LineString', coordinates: cur } });
      cur = [];
    }
    key = k;
    cur.push([p[0], p[1]]);
  }
  if (cur.length > 1) feats.push({ type: 'Feature', properties: { c: key }, geometry: { type: 'LineString', coordinates: cur } });
  return { type: 'FeatureCollection', features: feats } as GeoJSON.FeatureCollection;
}

const fc = (features: GeoJSON.Feature[]) => ({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection);

function aircraftEl(color: string, size = 34) {
  const el = document.createElement('div');
  el.className = 'sm-drone';
  el.innerHTML = `<svg viewBox="0 0 40 40" width="${size}" height="${size}"><g>
    <circle cx="20" cy="20" r="18" fill="rgba(5,7,10,.35)" stroke="${color}" stroke-width="2"/>
    <path d="M20 4 L29 30 L20 25 L11 30 Z" fill="${color}" stroke="#05070a" stroke-width="1.5" stroke-linejoin="round"/></g></svg>`;
  return el;
}
function pinEl(letter: string, cls: string) {
  const el = document.createElement('div');
  el.className = `sm-pin ${cls}`;
  el.textContent = letter;
  return el;
}

/** three.js layer: path at true altitude with drop lines, and the drone model posed from attitude. */
class Alt3D implements maplibregl.CustomLayerInterface {
  id = 'alt3d';
  type = 'custom' as const;
  renderingMode = '3d' as const;
  map!: maplibregl.Map;
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.Camera();
  origin: maplibregl.MercatorCoordinate | null = null;
  ref: [number, number] | null = null;
  ground = 0;
  scale = 1;
  path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
  drops = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
  model: THREE.Group;
  constructor() {
    const { g } = buildTavas();
    this.model = new THREE.Group();
    g.rotation.x = Math.PI / 2;           // model is Y-up; this scene is Z-up (x east, y north)
    this.model.add(g);
    this.scene.add(this.path, this.drops, this.model);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(100, -100, 300);
    this.scene.add(sun);
  }
  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGLRenderingContext, antialias: true });
    this.renderer.autoClear = false;
  }
  setRef(lon: number, lat: number) {
    this.ref = [lon, lat];
    this.origin = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
    this.scale = this.origin.meterInMercatorCoordinateUnits();
  }
  local(lon: number, lat: number, alt: number) {
    const r = this.ref!;
    return new THREE.Vector3((lon - r[0]) * 111320 * Math.cos((r[1] * Math.PI) / 180), (lat - r[1]) * 110540, alt + this.ground);
  }
  setPath(pts: TrackPt[]) {
    if (!this.ref) return;
    const pos: number[] = [], col: number[] = [], drop: number[] = [];
    const c = new THREE.Color();
    pts.forEach((p, i) => {
      const v = this.local(p[0], p[1], Math.max(0, p[2] ?? 0));
      pos.push(v.x, v.y, v.z);
      c.set(altColor(p[2]));
      col.push(c.r, c.g, c.b);
      if (i % Math.max(5, Math.ceil(pts.length / 250)) === 0) drop.push(v.x, v.y, v.z, v.x, v.y, this.ground);
    });
    this.path.geometry.dispose();
    this.path.geometry = new THREE.BufferGeometry();
    this.path.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.path.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.drops.geometry.dispose();
    this.drops.geometry = new THREE.BufferGeometry();
    this.drops.geometry.setAttribute('position', new THREE.Float32BufferAttribute(drop, 3));
  }
  setPose(p: Pose | null) {
    if (!this.ref || !p || p.lat == null || p.lon == null) { this.model.visible = false; return; }
    this.model.visible = true;
    const v = this.local(p.lon, p.lat, Math.max(0, p.alt ?? 0));
    this.model.position.copy(v);
    const e = new THREE.Euler(THREE.MathUtils.degToRad(p.pitch ?? 0), THREE.MathUtils.degToRad(p.roll ?? 0), -THREE.MathUtils.degToRad(p.yaw ?? p.heading ?? 0), 'ZXY');
    this.model.setRotationFromEuler(e);
  }
  render(_gl: WebGLRenderingContext, matrix: ArrayLike<number>) {
    if (!this.origin) return;
    // the model is drawn ~45 px across whatever the zoom (not to scale), so it stays visible
    const mpp = (156543.03 * Math.cos(((this.ref?.[1] ?? 0) * Math.PI) / 180)) / 2 ** this.map.getZoom();
    this.model.scale.setScalar(Math.max(4, mpp * 90));
    const m = new THREE.Matrix4().fromArray(matrix as unknown as number[]);
    const l = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale));
    this.camera.projectionMatrix = m.multiply(l);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
}

export function SatMap({ pose, track, ghost, mission, missionSeq, home, takeoff, landing, others, color = '#ffffff', view, layers, cam, onSelect,
  focusKey, children, className = '' }: {
  pose: Pose | null; track: TrackPt[]; ghost?: TrackPt[]; mission?: MissionItem[]; missionSeq?: number | null;
  home?: [number, number] | null; takeoff?: [number, number] | null; landing?: [number, number] | null; others?: Other[]; color?: string;
  view: '2d' | '3d'; layers: Layers; cam: Cam; onSelect?: (key: string) => void; focusKey?: string; children?: React.ReactNode; className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const st = useRef<{ map: maplibregl.Map; ready: boolean; drone: maplibregl.Marker; pins: Record<string, maplibregl.Marker>; others: Record<string, maplibregl.Marker>;
    alt3d: Alt3D; fitted: string | null; lastN: number; lastCam: Cam | null } | null>(null);
  const [ready, setReady] = useState(false);
  const sel = useRef(onSelect);
  sel.current = onSelect;

  useEffect(() => {
    const map = new maplibregl.Map({ container: host.current!, style: STYLE, center: [77.59, 12.97], zoom: 15, maxPitch: 80,
      attributionControl: { compact: true }, antialias: true });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    const alt3d = new Alt3D();
    const drone = new maplibregl.Marker({ element: aircraftEl(color), rotationAlignment: 'map', pitchAlignment: 'map' });
    st.current = { map, ready: false, drone, pins: {}, others: {}, alt3d, fitted: null, lastN: -1, lastCam: null };
    map.on('error', () => undefined);   // tile servers that can't be reached just leave that layer empty
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(host.current!);
    map.on('load', () => {
      map.addSource('track', { type: 'geojson', data: fc([]) });
      map.addSource('ghost', { type: 'geojson', data: fc([]) });
      map.addSource('plan', { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'ghost', type: 'line', source: 'ghost', paint: { 'line-color': '#e6edf2', 'line-width': 2, 'line-opacity': 0.35, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'plan-done', type: 'line', source: 'plan', filter: ['==', ['get', 'done'], true], paint: { 'line-color': '#8796a3', 'line-width': 2.5, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'plan', type: 'line', source: 'plan', filter: ['!=', ['get', 'done'], true], paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [3, 2.5] } });
      map.addLayer({ id: 'track-casing', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': 7, 'line-opacity': 0.45 } });
      map.addLayer({ id: 'track', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 4 } });
      map.addLayer(alt3d);
      st.current!.ready = true;
      setReady(true);
    });
    return () => { ro.disconnect(); map.remove(); st.current = null; };
  }, []);

  // layers & view
  useEffect(() => {
    const s = st.current;
    if (!s || !ready) return;
    const { map } = s;
    (['satellite', 'terrain', 'street'] as const).forEach((b) => map.setLayoutProperty(b, 'visibility', layers.base === b ? 'visible' : 'none'));
    map.setLayoutProperty('roads', 'visibility', layers.roads ? 'visible' : 'none');
    map.setLayoutProperty('labels', 'visibility', layers.labels ? 'visible' : 'none');
    // 3D buildings (OpenFreeMap vector tiles) are added only when first needed, so an unreachable tile server
    // never stops the rest of the map from loading
    const wantB = layers.buildings && view === '3d';
    if (wantB && !map.getSource('omt')) {
      try {
        map.addSource('omt', { type: 'vector', url: 'https://tiles.openfreemap.org/planet' });
        map.addLayer({ id: 'buildings', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14,
          paint: { 'fill-extrusion-color': '#b9c2c9', 'fill-extrusion-opacity': 0.8,
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] } }, 'ghost');
      } catch { /* not available */ }
    }
    if (map.getLayer('buildings')) map.setLayoutProperty('buildings', 'visibility', wantB ? 'visible' : 'none');
    map.setTerrain(view === '3d' && layers.terrain3d ? { source: 'dem', exaggeration: 1 } : null);
    map.setLayoutProperty('alt3d', 'visibility', view === '3d' ? 'visible' : 'none');
    map.easeTo({ pitch: view === '3d' ? 60 : 0, duration: 600 });
  }, [ready, view, layers.base, layers.terrain3d, layers.buildings, layers.roads, layers.labels]);

  // reference point for the 3D layer and the ground height under it
  const refLon = home?.[1] ?? takeoff?.[1] ?? track[0]?.[0] ?? pose?.lon ?? null;
  const refLat = home?.[0] ?? takeoff?.[0] ?? track[0]?.[1] ?? pose?.lat ?? null;
  useEffect(() => {
    const s = st.current;
    if (!s || !ready || refLon == null || refLat == null) return;
    s.alt3d.setRef(refLon, refLat);
    s.lastN = -1;
  }, [ready, refLon, refLat]);

  // data
  useEffect(() => {
    const s = st.current;
    if (!s || !ready) return;
    const { map } = s;
    if (view === '3d' && layers.terrain3d && refLon != null) {
      const g = map.queryTerrainElevation([refLon, refLat!]);
      if (g != null && Math.abs(g - s.alt3d.ground) > 0.5) { s.alt3d.ground = g; s.lastN = -1; }
    } else if (s.alt3d.ground !== 0) { s.alt3d.ground = 0; s.lastN = -1; }
    if (track.length !== s.lastN) {
      (map.getSource('track') as maplibregl.GeoJSONSource).setData(trackRuns(track, 'altitude'));
      s.alt3d.setPath(track);
      s.lastN = track.length;
    }
    (map.getSource('ghost') as maplibregl.GeoJSONSource).setData(ghost && ghost.length > 1
      ? fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ghost.map((p) => [p[0], p[1]]) } }]) : fc([]));
    const items = mission ?? [];
    const k = missionSeq == null ? 0 : Math.max(0, items.findIndex((it) => it.seq >= missionSeq));
    const plan: GeoJSON.Feature[] = [];
    if (items.length > 1) {
      if (k > 0) plan.push({ type: 'Feature', properties: { done: true }, geometry: { type: 'LineString', coordinates: items.slice(0, k + 1).map((i) => [i.lon, i.lat]) } });
      plan.push({ type: 'Feature', properties: { done: false }, geometry: { type: 'LineString', coordinates: items.slice(k).map((i) => [i.lon, i.lat]) } });
    }
    (map.getSource('plan') as maplibregl.GeoJSONSource).setData(fc(plan));
    // pins
    const pin = (id: string, p: [number, number] | null | undefined, letter: string, cls: string, title: string) => {
      if (!p) { s.pins[id]?.remove(); delete s.pins[id]; return; }
      if (!s.pins[id]) { const el = pinEl(letter, cls); el.title = title; s.pins[id] = new maplibregl.Marker({ element: el }).setLngLat([p[1], p[0]]).addTo(map); }
      else s.pins[id].setLngLat([p[1], p[0]]);
    };
    pin('home', home, 'H', 'home', 'Home');
    pin('takeoff', takeoff, 'T', 'to', 'Take-off');
    pin('landing', landing, 'L', 'land', 'Landing / last position');
    // drone
    if (pose?.lat != null && pose.lon != null) {
      s.drone.setLngLat([pose.lon, pose.lat]).setRotation(pose.heading ?? 0);
      if (!s.drone.getElement().isConnected) s.drone.addTo(map);
      s.drone.getElement().style.opacity = view === '3d' ? '0.55' : '1';
    } else s.drone.remove();
    s.alt3d.setPose(view === '3d' ? pose : null);
    // others
    const seen = new Set<string>();
    for (const o of others ?? []) {
      seen.add(o.key);
      let mk = s.others[o.key];
      if (!mk) {
        const el = aircraftEl(o.color, 26);
        el.classList.add('other');
        const lab = document.createElement('span');
        lab.className = 'sm-label';
        el.appendChild(lab);
        el.addEventListener('click', (e) => { e.stopPropagation(); sel.current?.(o.key); });
        mk = s.others[o.key] = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'viewport' }).setLngLat([o.lon, o.lat]).addTo(map);
      }
      mk.setLngLat([o.lon, o.lat]).setRotation(o.heading ?? 0);
      (mk.getElement().querySelector('.sm-label') as HTMLElement).textContent = `${o.label}${o.alt != null ? ` · ${Math.round(o.alt)} m` : ''}`;
    }
    for (const k2 of Object.keys(s.others)) if (!seen.has(k2)) { s.others[k2].remove(); delete s.others[k2]; }
    // camera
    const fitKey = `${focusKey ?? ''}`;
    const p = pose?.lat != null && pose.lon != null ? [pose.lon, pose.lat] as [number, number] : null;
    const all: [number, number][] = [...track.map((t) => [t[0], t[1]] as [number, number]), ...(ghost ?? []).map((t) => [t[0], t[1]] as [number, number])];
    if (p) all.push(p);
    if (home) all.push([home[1], home[0]]);
    const fit = () => {
      if (!all.length) return;
      const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
      map.fitBounds(b, { padding: 70, maxZoom: 18, duration: 600, pitch: view === '3d' ? 60 : 0, bearing: map.getBearing() });
    };
    if (s.fitted !== fitKey && all.length) { fit(); s.fitted = fitKey; }
    else if (cam === 'whole' && s.lastCam !== 'whole') fit();
    else if (p && !map.isMoving()) {
      if (cam === 'follow') map.easeTo({ center: p, duration: 300 });
      else if (cam === 'chase') map.easeTo({ center: p, bearing: pose!.heading ?? map.getBearing(), duration: 300 });
    }
    s.lastCam = cam;
    map.triggerRepaint();
  });

  return (
    <div className={`satmap ${className}`}>
      <div ref={host} className="satmap-gl" />
      {children}
    </div>
  );
}

export const DEFAULT_LAYERS: Layers = { base: 'satellite', terrain3d: true, buildings: true, roads: false, labels: false };

export function LayerPanel({ layers, onChange, view }: { layers: Layers; onChange: (l: Layers) => void; view: '2d' | '3d' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`sm-layers ${open ? 'open' : ''}`}>
      <button className="sm-layers-btn" onClick={() => setOpen(!open)} aria-expanded={open} title="Map layers">≡ Layers</button>
      {open && (
        <div className="sm-layers-box">
          <b>Base map</b>
          {(['satellite', 'terrain', 'street'] as const).map((b) => (
            <label key={b}><input type="radio" name="base" checked={layers.base === b} onChange={() => onChange({ ...layers, base: b })} /> {b === 'satellite' ? 'Satellite' : b === 'terrain' ? 'Terrain (topographic)' : 'Street map'}</label>
          ))}
          <b>Overlays</b>
          <label><input type="checkbox" checked={layers.roads} onChange={(e) => onChange({ ...layers, roads: e.target.checked })} /> Roads</label>
          <label><input type="checkbox" checked={layers.labels} onChange={(e) => onChange({ ...layers, labels: e.target.checked })} /> Place names</label>
          <b>3D view</b>
          <label className={view === '2d' ? 'dim' : ''}><input type="checkbox" checked={layers.terrain3d} onChange={(e) => onChange({ ...layers, terrain3d: e.target.checked })} /> Terrain elevation</label>
          <label className={view === '2d' ? 'dim' : ''}><input type="checkbox" checked={layers.buildings} onChange={(e) => onChange({ ...layers, buildings: e.target.checked })} /> Buildings</label>
        </div>
      )}
    </div>
  );
}
