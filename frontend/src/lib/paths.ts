// Flight paths of every drone, built only from telemetry the server received:
// the server's 1 Hz flight track is loaded once, then each live position update is appended.
// Nothing is interpolated or invented: a gap in telemetry stays a gap (the line is broken there).
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Drone, MissionItem } from './types';

export interface PathPt { t: number; lat: number; lon: number; alt: number | null; gap?: boolean }
export interface DronePath { flightId: number | null; live: boolean; pts: PathPt[]; mission: MissionItem[]; missionVer: number; simulated: boolean }

/** One distinct colour per drone, so paths on the fleet map and 3D view can't be confused. */
export const DRONE_COLORS = ['#54c8e8', '#ff9f43', '#a78bfa', '#3ddc84', '#f472b6', '#facc15', '#60a5fa', '#fb7185',
  '#34d399', '#c084fc', '#f97316', '#22d3ee', '#e879f9', '#a3e635', '#fda4af'];
export const droneColor = (d: Pick<Drone, 'slot'>) => DRONE_COLORS[((d.slot ?? 1) - 1) % DRONE_COLORS.length];

/** Altitude colour scale used on every flight-path view (metres above home). */
export const ALT_STOPS: [number, string][] = [[0, '#3ddc84'], [30, '#a3e635'], [60, '#facc15'], [90, '#ff9f43'], [120, '#ff4b4b']];
export function altColor(alt: number | null): string {
  if (alt == null) return '#8796a3';
  for (let i = ALT_STOPS.length - 1; i >= 0; i--) if (alt >= ALT_STOPS[i][0]) return ALT_STOPS[i][1];
  return ALT_STOPS[0][1];
}

const GAP_S = 5;      // no position for this long: break the line
let paths: Record<string, DronePath> = {};
let ver = 0;
const subs = new Set<() => void>();
const emit = () => { ver++; subs.forEach((f) => f()); };
let loading = false;
let lastLoad = 0;

async function loadAll() {
  if (loading) return;
  loading = true;
  try {
    const r = await api<Record<string, { live: boolean; points: [number, number, number, number | null][]; simulated: boolean; mission: MissionItem[]; mission_ver: number }>>('/api/fleet/paths');
    const next: Record<string, DronePath> = {};
    for (const [k, v] of Object.entries(r)) {
      const old = paths[k];
      const pts: PathPt[] = v.points.map(([, lat, lon, alt]) => ({ t: 0, lat, lon, alt }));
      next[k] = { flightId: old?.flightId ?? null, live: v.live, pts: v.live ? pts : [], mission: v.mission, missionVer: v.mission_ver, simulated: v.simulated };
    }
    paths = next;
    lastLoad = Date.now();
    emit();
  } catch { /* retried on the next fleet update */ } finally { loading = false; }
}

/** Feed every fleet update in. */
export function updatePaths(drones: Drone[], t: number) {
  let changed = false;
  let reload = false;
  for (const d of drones) {
    let p = paths[d.key];
    if (!p) { reload = true; continue; }
    if (d.mission_ver !== p.missionVer) reload = true;
    const inFlight = d.armed && d.conn !== 'offline';
    if (!inFlight) {
      if (p.live) { p = paths[d.key] = { ...p, live: false }; changed = true; }
      continue;
    }
    if (p.flightId !== d.flight_id) {
      // new flight: start a clean path
      p = paths[d.key] = { ...p, flightId: d.flight_id, live: true, pts: p.flightId == null && p.live ? p.pts : [] };
      changed = true;
    }
    const age = d.ages?.pos;
    if (d.lat == null || d.lon == null || age == null || age > 2) continue;  // no fresh position: add nothing
    const last = p.pts[p.pts.length - 1];
    const moved = !last || Math.abs(last.lat - d.lat) > 3e-6 || Math.abs(last.lon - d.lon) > 3e-6 || Math.abs((last.alt ?? 0) - (d.alt ?? 0)) > 0.5;
    if (!moved) continue;
    const gap = !!last && t - last.t > GAP_S && last.t > 1e6;
    p.pts.push({ t, lat: d.lat, lon: d.lon, alt: d.alt, gap });
    if (p.pts.length > 20000) p.pts.splice(0, p.pts.length - 20000);
    changed = true;
  }
  if (reload && Date.now() - lastLoad > 3000) loadAll();
  if (changed) emit();
}

export function usePaths(): Record<string, DronePath> {
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => ver);
  return paths;
}
export const getPaths = () => paths;
export const pathsVersion = () => ver;

export function initPaths() { loadAll(); }
