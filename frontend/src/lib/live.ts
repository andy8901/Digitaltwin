// Live connection to the server: the whole fleet 4x/s, the viewed drone's full twin, and alerts as they happen.
import { useEffect, useSyncExternalStore } from 'react';
import { initPaths, updatePaths } from './paths';
import type { Alert, Drone, DroneDetail, GcsInfo, Summary } from './types';

interface State {
  connected: boolean;
  t: number;
  drones: Drone[];
  byKey: Record<string, Drone>;
  summary: Summary | null;
  gcs: GcsInfo[];
  videoApi: { ok: boolean | null; error: string };
  alerts: Alert[];           // open alerts (active, or critical and not acknowledged)
  detail: DroneDetail | null;
  toasts: (Alert & { toastId: number })[];
  history: Record<string, { t: number; alt: number | null; batt: number | null; volt: number | null; gs: number | null; link: number | null; rssi: number | null }[]>;
}

let state: State = {
  connected: false, t: 0, drones: [], byKey: {}, summary: null, gcs: [], videoApi: { ok: null, error: '' }, alerts: [], detail: null, toasts: [], history: {},
};
const subs = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export function useLive<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
}
export const getLive = () => state;

let ws: WebSocket | null = null;
let wantSub: string | null = null;
let delay = 1000;
let toastSeq = 0;
const HIST_S = 600;

function record(drones: Drone[], t: number) {
  const h = { ...state.history };
  for (const d of drones) {
    const arr = h[d.key] ? h[d.key] : [];
    const last = arr[arr.length - 1];
    if (last && t - last.t < 1) continue;
    const next = arr.concat([{ t, alt: d.alt, batt: d.batt_pct, volt: d.volt, gs: d.gs, link: d.link_pct, rssi: d.rssi }]);
    while (next.length && t - next[0].t > HIST_S) next.shift();
    h[d.key] = next;
  }
  return h;
}

export function connectLive() {
  if (ws) return;
  initPaths();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live`);
  ws.onopen = () => { delay = 1000; set({ connected: true }); if (wantSub) ws?.send(JSON.stringify({ sub: wantSub })); };
  ws.onmessage = (e) => {
    const j = JSON.parse(e.data);
    if (j.type === 'fleet') {
      const byKey: Record<string, Drone> = {};
      for (const d of j.drones as Drone[]) byKey[d.key] = d;
      set({ t: j.t, drones: j.drones, byKey, summary: j.summary, gcs: j.gcs, videoApi: j.video_api, history: record(j.drones, j.t) });
      updatePaths(j.drones, j.t);
    } else if (j.type === 'detail') {
      if (j.drone.key === wantSub) {
        const prev = state.detail && state.detail.key === j.drone.key ? state.detail : null;
        set({ detail: { ...j.drone, health: j.drone.health || prev?.health } });
      }
    } else if (j.type === 'alerts') {
      set({ alerts: j.alerts });
    } else if (j.type === 'alert') {
      const a: Alert = j.alert;
      let alerts = state.alerts.filter((x) => x.id !== a.id);
      const open = a.severity !== 'info' && (a.resolved_ts == null || (a.severity === 'critical' && a.ack_ts == null));
      if (open) alerts = [a, ...alerts];
      const patch: Partial<State> = { alerts };
      if (j.kind === 'new') {
        const toast = { ...a, toastId: ++toastSeq };
        patch.toasts = [toast, ...state.toasts].slice(0, 5);
        setTimeout(() => set({ toasts: state.toasts.filter((x) => x.toastId !== toast.toastId) }), a.severity === 'critical' ? 12000 : 7000);
      }
      set(patch);
    }
  };
  ws.onclose = (e) => {
    ws = null;
    set({ connected: false });
    if (e.code === 4401) { location.href = '/login'; return; }
    setTimeout(connectLive, delay);
    delay = Math.min(15000, delay * 2);
  };
  setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 20000);
}

/** Ask the server for the full twin of one drone while a component is showing it. */
export function useDetail(key: string | null) {
  useEffect(() => {
    wantSub = key;
    if (state.detail && state.detail.key !== key) set({ detail: null });
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ sub: key }));
    return () => {
      wantSub = null;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ sub: null }));
    };
  }, [key]);
  return useLive((s) => (s.detail && s.detail.key === key ? s.detail : null));
}

export function dismissToast(id: number) {
  set({ toasts: state.toasts.filter((x) => x.toastId !== id) });
}

export function applyAlertUpdate(a: Alert) {
  let alerts = state.alerts.filter((x) => x.id !== a.id);
  const open = a.severity !== 'info' && (a.resolved_ts == null || (a.severity === 'critical' && a.ack_ts == null));
  if (open) alerts = [a, ...alerts];
  set({ alerts });
}
