import type { Conn, Drone, Level } from './types';

export const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

export function dur(s: number | null | undefined) {
  if (s === null || s === undefined) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function ago(s: number | null | undefined) {
  if (s === null || s === undefined) return 'never';
  if (s < 2) return 'now';
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

let tz = 'Asia/Kolkata';
export const setTz = (z: string) => { tz = z; };
const cache: Record<string, Intl.DateTimeFormat> = {};
function f(key: string, o: Intl.DateTimeFormatOptions) {
  return cache[key + tz] || (cache[key + tz] = new Intl.DateTimeFormat('en-GB', { ...o, timeZone: tz, hour12: false }));
}
export const timeOf = (ts: number) => f('t', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts * 1000));
export const dateTimeOf = (ts: number) => f('dt', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
export const dateOf = (ts: number) => f('d', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(ts * 1000));
export const clockNow = () => f('c', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
export const tzLabel = () => (tz === 'Asia/Kolkata' ? 'IST' : tz);

export const FIX = ['No GPS', 'No fix', '2D fix', '3D fix', 'DGPS', 'RTK float', 'RTK fixed', 'Static', 'PPP'];

/** Tile colour per the brief: grey offline, red critical, yellow warning, blue airborne, green normal. */
export type Tone = 'offline' | 'critical' | 'warning' | 'airborne' | 'normal';
export function tone(d: Pick<Drone, 'conn' | 'level' | 'airborne' | 'enabled'>): Tone {
  if (!d.enabled) return 'offline';
  if (d.level === 'critical' || d.conn === 'link_lost') return 'critical';
  if (d.conn === 'offline') return 'offline';
  if (d.level === 'warning' || d.conn === 'stale') return 'warning';
  if (d.airborne) return 'airborne';
  return 'normal';
}
export const TONE_LABEL: Record<Tone, string> = { offline: 'Offline', critical: 'Critical', warning: 'Warning', airborne: 'Airborne', normal: 'Normal' };

export function flightStatus(d: Drone) {
  if (!d.enabled) return 'Disabled';
  if (d.conn === 'offline') return d.last_seen_s == null ? 'Never connected' : 'Disconnected';
  if (d.conn === 'link_lost') return 'Link lost (armed)';
  if (d.airborne) return d.mode === 'RTL' || d.mode === 'SMART_RTL' ? 'Returning home' : d.mode === 'LAND' ? 'Landing' : 'In flight';
  if (d.armed) return 'Armed on ground';
  return 'On ground';
}

export const CONN_LABEL: Record<Conn, string> = { flying: 'Connected', online: 'Connected', stale: 'Weak link', link_lost: 'Link lost', offline: 'Offline' };

export function gpsLabel(d: Pick<Drone, 'fix' | 'sats' | 'hdop'>) {
  if (d.fix == null) return '—';
  return `${FIX[d.fix] ?? d.fix} · ${d.sats ?? '—'}`;
}

export function levelOf(l: Level) { return l ?? 'none'; }

export function signal(d: Pick<Drone, 'link_pct' | 'rssi'>) {
  const v = d.rssi ?? d.link_pct;
  return v == null ? null : v;
}

export const compass = (deg: number | null | undefined) => {
  if (deg == null) return '—';
  const n = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return n[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
};
