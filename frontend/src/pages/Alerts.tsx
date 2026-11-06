import { useEffect, useState } from 'react';
import { ackAlert, can, go, useMe } from '../App';
import { SevChip } from '../components/Bits';
import { api } from '../lib/api';
import { applyAlertUpdate, useLive } from '../lib/live';
import { dateTimeOf, timeOf } from '../lib/format';
import type { Alert } from '../lib/types';

export function Alerts() {
  const me = useMe();
  const open = useLive((s) => s.alerts);
  const drones = useLive((s) => s.drones);
  const [view, setView] = useState<'open' | 'history'>('open');
  const [sev, setSev] = useState('');
  const [drone, setDrone] = useState('');
  const [hours, setHours] = useState(24);
  const [hist, setHist] = useState<Alert[]>([]);
  useEffect(() => {
    if (view !== 'history') return;
    const q = new URLSearchParams({ hours: String(hours), limit: '2000' });
    if (sev) q.set('severity', sev);
    if (drone) q.set('drone', drone);
    api<Alert[]>(`/api/alerts?${q}`).then(setHist);
  }, [view, sev, drone, hours]);
  const rows = (view === 'open' ? open : hist).filter((a) => (!sev || a.severity === sev) && (!drone || a.drone_key === drone));
  const unacked = open.filter((a) => !a.ack_ts);
  const ackAll = async (severity: string) => {
    await api('/api/alerts/ack', { json: { severity, drone: drone || undefined } });
    open.filter((a) => !a.ack_ts && a.severity === severity && (!drone || a.drone_key === drone)).forEach((a) => applyAlertUpdate({ ...a, ack_ts: Date.now() / 1000, ack_by: me.user.username }));
  };
  return (
    <div className="alerts-page">
      <div className="page-bar">
        <h1>Alerts & notifications</h1>
        <div className="seg">
          <button className={view === 'open' ? 'on' : ''} onClick={() => setView('open')}>Open ({open.length})</button>
          <button className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>History</button>
        </div>
        <select value={sev} onChange={(e) => setSev(e.target.value)} aria-label="Severity">
          <option value="">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Information</option>
        </select>
        <select value={drone} onChange={(e) => setDrone(e.target.value)} aria-label="Drone">
          <option value="">All drones</option>{drones.map((d) => <option key={d.key} value={d.key}>{d.drone_id}</option>)}
        </select>
        {view === 'history' && <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Period">
          <option value={1}>Last hour</option><option value={24}>Last 24 hours</option><option value={168}>Last 7 days</option><option value={720}>Last 30 days</option>
        </select>}
        <span className="spacer" />
        {view === 'open' && can(me, 'operator') && unacked.some((a) => a.severity === 'warning') && <button className="btn" onClick={() => ackAll('warning')}>Acknowledge all warnings</button>}
        <a className="btn ghost" href={`/api/export/alerts.csv?hours=${view === 'history' ? hours : 720}${drone ? `&drone=${drone}` : ''}`}>Export CSV</a>
      </div>
      <p className="muted note">Alerts come only from the flight controller's own messages (quoted as sent) or from threshold rules in System settings. Critical alerts stay open until acknowledged. Click a row to open that drone.</p>
      <div className="table-wrap">
        <table className="tbl alerts-tbl">
          <thead><tr><th>Time</th><th>Severity</th><th>Drone</th><th>GCS</th><th>Alert</th><th>Message</th><th>Parameter</th><th>Location</th><th>Source</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={`sev-row-${a.severity} ${!a.ack_ts && a.severity === 'critical' ? 'unacked' : ''}`} onClick={() => go(`drone/${a.drone_key}`)}>
                <td className="num">{view === 'open' ? timeOf(a.ts) : dateTimeOf(a.ts)}</td>
                <td><SevChip s={a.severity} /></td>
                <td><b>{a.drone_id}</b></td>
                <td>{a.gcs_id}</td>
                <td>{a.label}</td>
                <td className="msg-cell">{a.message}</td>
                <td className="num">{a.param ? `${a.param}${a.value != null ? `: ${a.value}` : ''}${a.threshold ? ` (${a.threshold})` : ''}` : '—'}</td>
                <td className="num">{a.lat != null ? `${a.lat.toFixed(5)}, ${a.lon!.toFixed(5)}` : '—'}</td>
                <td>{a.source}</td>
                <td>{a.resolved_ts ? <span className="muted">cleared {timeOf(a.resolved_ts)}</span> : <span className="active-tag">active</span>}
                  {a.ack_ts ? <div className="muted">ack {a.ack_by} {timeOf(a.ack_ts)}</div> : a.severity !== 'info' ? <div className="unack-tag">not acknowledged</div> : null}</td>
                <td onClick={(e) => e.stopPropagation()}>{!a.ack_ts && a.severity !== 'info' && can(me, 'operator') && <button className="btn sm" onClick={() => ackAlert(a)}>Acknowledge</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={11} className="empty-row">{view === 'open' ? 'No open alerts. Every drone is within its limits.' : 'No alerts in this period.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
