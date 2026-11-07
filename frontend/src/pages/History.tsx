import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { can, go, useMe } from '../App';
import { SevChip } from '../components/Bits';
import { MapBox } from '../components/MapView';
import { api } from '../lib/api';
import { dateOf, dur, fmt, timeOf } from '../lib/format';
import { useLive } from '../lib/live';
import type { Alert } from '../lib/types';

interface FlightRow {
  id: number; drone_key: string; drone_id: string; gcs_id: string | null; start_ts: number; end_ts: number | null; status: string;
  conclusion: string | null; has_tlog: boolean; events: string[]; source?: string; log_name?: string | null; analysis_status?: string | null;
  verdict?: { level: string; headline: string; termination: string } | null;
  summary: { flight_time_min?: number; max_alt_m?: number; max_speed_ms?: number; distance_m?: number; takeoff_ts?: number; landing_ts?: number;
    batt_start_pct?: number; batt_end_pct?: number; mah_used?: number; mission?: { completed?: boolean; flown_auto?: boolean }; crash?: boolean };
}
const EV: Record<string, string> = { crash: 'Crash', thrust_loss: 'Thrust loss', motor_issue: 'Motor issue', battery_fs: 'Battery failsafe', gcs_fs: 'GCS failsafe',
  rc_fs: 'RC failsafe', ekf_issue: 'EKF issue', gps_issue: 'GPS issue', vibration_issue: 'Vibration' };
const RED = new Set(['crash', 'thrust_loss', 'motor_issue', 'battery_fs', 'gcs_fs', 'rc_fs']);

function FlightDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [f, setF] = useState<(FlightRow & { track: number[][]; alerts: Alert[]; messages: { ts: number; sev: number; text: string }[]; summary: FlightRow['summary'] & { events?: { type: string; t: number; text: string; lat: number | null; lon: number | null }[] } }) | null>(null);
  const map = useRef<L.Map | null>(null);
  useEffect(() => { api<typeof f>(`/api/flights/${id}`).then(setF); }, [id]);
  useEffect(() => {
    const m = map.current;
    if (!m || !f) return;
    const pts = f.track.map((p) => [p[1], p[2]] as [number, number]);
    const g = L.layerGroup().addTo(m);
    if (pts.length) {
      L.polyline(pts, { color: '#000', weight: 7, opacity: 0.5 }).addTo(g);
      L.polyline(pts, { color: '#54c8e8', weight: 3.5 }).addTo(g);
      L.circleMarker(pts[0], { radius: 6, color: '#3ddc84', fillOpacity: 1 }).bindTooltip('Take-off').addTo(g);
      L.circleMarker(pts[pts.length - 1], { radius: 6, color: f.summary.crash ? '#ff4b4b' : '#e6edf2', fillOpacity: 1 }).bindTooltip(f.summary.crash ? 'Crash site' : 'Landing').addTo(g);
      m.fitBounds(pts, { padding: [30, 30], maxZoom: 18 });
    }
    (f.summary.events || []).forEach((e) => e.lat != null && L.circleMarker([e.lat, e.lon!], { radius: 7, color: RED.has(e.type) ? '#ff4b4b' : '#f5c242', weight: 3, fillOpacity: 0.3 }).bindTooltip(`${EV[e.type] || e.type} at ${dur(e.t)}: ${e.text}`).addTo(g));
    return () => { g.remove(); };
  }, [f]);
  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="panel-h"><h2>{f ? `${f.drone_id} · flight ${f.id}` : 'Loading…'}</h2><span className="muted">{f && `${dateOf(f.start_ts)} ${timeOf(f.start_ts)}`}</span><span className="spacer" />
          {f && <><a className="btn" href={`/api/flights/${id}/report.pdf`}>PDF report</a><a className="btn ghost" href={`/api/flights/${id}/telemetry.csv`}>Telemetry CSV</a>
            {f.has_tlog && <a className="btn ghost" href={`/api/flights/${id}/tlog`}>.tlog</a>}</>}
          <button className="btn ghost" onClick={onClose}>Close</button></div>
        <div className="fd-grid">
          <MapBox className="fd-map" onMap={(m) => { map.current = m; }} />
          <div className="fd-side">
            {f && <>
              <div className="kvs">
                <div><span>Take-off</span><b className="num">{f.summary.takeoff_ts ? timeOf(f.summary.takeoff_ts) : '—'}</b></div>
                <div><span>Landing</span><b className="num">{f.summary.landing_ts ? timeOf(f.summary.landing_ts) : '—'}</b></div>
                <div><span>Duration</span><b className="num">{dur((f.summary.flight_time_min || 0) * 60)}</b></div>
                <div><span>Max altitude</span><b className="num">{fmt(f.summary.max_alt_m, 1)} m</b></div>
                <div><span>Max speed</span><b className="num">{fmt(f.summary.max_speed_ms, 1)} m/s</b></div>
                <div><span>Battery used</span><b className="num">{f.summary.batt_start_pct != null && f.summary.batt_end_pct != null ? `${f.summary.batt_start_pct - f.summary.batt_end_pct}%` : '—'}{f.summary.mah_used ? ` · ${fmt(f.summary.mah_used)} mAh` : ''}</b></div>
                <div><span>Distance</span><b className="num">{fmt(f.summary.distance_m)} m</b></div>
                <div><span>Mission</span><b>{f.summary.mission?.completed ? 'Completed' : f.summary.mission?.flown_auto ? 'Not completed' : 'Manual'}</b></div>
              </div>
              <h3 className="sub-h">Alerts ({f.alerts.length})</h3>
              <div className="fd-list">{f.alerts.map((a) => <div key={a.id} className="ev"><SevChip s={a.severity} /><span className="num">{timeOf(a.ts)}</span><span>{a.label}: {a.message}</span></div>)}
                {!f.alerts.length && <span className="muted">None</span>}</div>
              <h3 className="sub-h">Errors from the flight controller</h3>
              <div className="fd-list">{f.messages.filter((m) => m.sev <= 4).map((m, i) => <div key={i} className={`msg s${m.sev}`}><span className="num">{timeOf(m.ts)}</span><span>{m.text}</span></div>)}
                {!f.messages.some((m) => m.sev <= 4) && <span className="muted">None</span>}</div>
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function History({ droneKey }: { droneKey?: string }) {
  const me = useMe();
  const drones = useLive((s) => s.drones);
  const [drone, setDrone] = useState(droneKey || '');
  const [period, setPeriod] = useState('30d');
  const [rows, setRows] = useState<FlightRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { setDrone(droneKey || ''); }, [droneKey]);
  useEffect(() => {
    const q = new URLSearchParams({ period });
    if (drone) q.set('drone', drone);
    api<FlightRow[]>(`/api/flights?${q}`).then(setRows);
  }, [drone, period]);
  const setRoot = (id: number, v: string) => api(`/api/flights/${id}/conclusion`, { json: { conclusion: v || null } });
  return (
    <div className="history-page">
      <div className="page-bar">
        <h1>Flight history</h1>
        <select value={drone} onChange={(e) => { setDrone(e.target.value); go(e.target.value ? `history/${e.target.value}` : 'history'); }} aria-label="Drone">
          <option value="">All drones</option>{drones.map((d) => <option key={d.key} value={d.key}>{d.drone_id}</option>)}
        </select>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
          <option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option>
        </select>
        <span className="muted">{rows.length} flights</span>
        <span className="spacer" />
        <a className="btn ghost" href={`/api/export/flights.csv?period=${period}${drone ? `&drone=${drone}` : ''}`}>Export CSV</a>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Drone</th><th>Take-off</th><th>Landing</th><th>Duration</th><th>Max alt</th><th>Max speed</th><th>Battery used</th><th>Mission</th><th>Events</th><th>Report</th><th>Root cause</th><th /></tr></thead>
          <tbody>
            {rows.map((f) => {
              const s = f.summary;
              return (
                <tr key={f.id} onClick={() => go(`flight/${f.id}`)}>
                  <td className="num">{dateOf(f.start_ts)}</td>
                  <td><b>{f.drone_id}</b> <span className="muted">{f.gcs_id}</span></td>
                  <td className="num">{s.takeoff_ts ? timeOf(s.takeoff_ts) : timeOf(f.start_ts)}</td>
                  <td className="num">{s.landing_ts ? timeOf(s.landing_ts) : f.status === 'flying' ? <span className="active-tag">in the air</span> : '—'}</td>
                  <td className="num">{dur((s.flight_time_min || 0) * 60)}</td>
                  <td className="num">{fmt(s.max_alt_m, 0)} m</td>
                  <td className="num">{fmt(s.max_speed_ms, 1)} m/s</td>
                  <td className="num">{s.batt_start_pct != null && s.batt_end_pct != null ? `${s.batt_start_pct - s.batt_end_pct}%` : '—'}</td>
                  <td>{s.mission?.completed ? 'Completed' : s.mission?.flown_auto ? 'Not completed' : 'Manual'}</td>
                  <td>{[...new Set(f.events)].map((e) => <span key={e} className={`tag ${RED.has(e) ? 'tag-red' : ''}`}>{EV[e] || e}</span>)}{f.status !== 'completed' && f.status !== 'flying' && <span className="tag">{f.status.replace('_', ' ')}</span>}</td>
                  <td className="verdict-cell">{f.verdict ? <><span className={`chip ${f.verdict.level === 'critical' ? 'sev-critical' : f.verdict.level === 'warning' ? 'sev-warning' : 'tone-normal'}`}>{f.verdict.level}</span> <span className="small">{f.verdict.headline}</span></>
                    : f.status === 'flying' ? '—' : f.analysis_status === 'error' ? <span className="bad small">analysis failed</span> : <span className="muted small">analysing…</span>}
                    {f.source === 'upload' && <span className="tag">uploaded</span>}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select defaultValue={f.conclusion || ''} disabled={!can(me, 'operator')} onChange={(e) => setRoot(f.id, e.target.value)} aria-label="Root cause">
                      <option value="">Not set</option><option value="pilot_error">Pilot error</option><option value="system_error">System error</option><option value="undetermined">Yet to decide</option>
                    </select>
                  </td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                    {f.verdict && <><a className="btn sm" href={`#/replay/${f.id}`}>Replay</a> </>}<button className="btn sm ghost" onClick={() => setOpen(f.id)}>Map</button> <a className="btn sm ghost" href={`/api/flights/${f.id}/report.pdf`}>PDF</a> <a className="btn sm ghost" href={`/api/flights/${f.id}/telemetry.csv`}>CSV</a>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={13} className="empty-row">No flights in this period.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <FlightDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
