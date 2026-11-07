// Organisation-wide overview: fleet statistics and flight-log management, calculated from the flights and logs stored
// by this command centre (recorded live or uploaded). Filters apply to everything on the page.
import { useEffect, useRef, useState } from 'react';
import { can, go, useMe } from '../App';
import { Icon } from '../components/Bits';
import { api } from '../lib/api';
import { dateTimeOf, dur, fmt } from '../lib/format';

interface Row {
  id: number; drone_key: string; drone_id: string; department: string; customer: string; location: string; start_ts: number; status: string;
  source: string; log_name: string | null; analysis_status: string | null; analysis_error: string | null; received_ts: number | null;
  conclusion: string | null; flight_time_min: number | null;
  verdict: null | { level: string; headline: string; termination: string; critical: number; warning: number; fc_errors: number };
}
interface K { uploads: number; analysed: number; active_drones: number; logs_received: number; analysed_today: number; critical: number; crashes: number;
  reviewed: number; flights: number; avg_flight_min: number | null; avg_distance_m: number | null; departments: number; users: number; connected_now: number }
interface O {
  kpis: K; previous: K | null; unassigned_slots: number;
  options: { departments: string[]; types: string[]; drones: { key: string; drone_id: string }[]; customers: string[]; locations: string[] };
  lists: Record<'recent' | 'pending' | 'critical' | 'errors' | 'analysed', Row[]> & { by_drone: { drone_key: string; drone_id: string; flights: number; hours: number; critical: number; warning: number; reviewed: number; uploads: number; last: number }[] };
}
const TABS: [keyof O['lists'], string][] = [['recent', 'Recently received logs'], ['pending', 'Pending analysis'], ['critical', 'Critical incidents'],
  ['by_drone', 'Drone-wise records'], ['errors', 'Logs with errors'], ['analysed', 'Analysed logs']];
const iso = (d: Date) => d.toISOString().slice(0, 10);

function Delta({ v, p, invert }: { v: number | null; p: number | null | undefined; invert?: boolean }) {
  if (p == null || v == null) return null;
  if (p === 0) return v === 0 ? <em className="kd">no change</em> : <em className={`kd ${invert ? 'down' : 'up'}`}>new in this period</em>;
  const pct = ((v - p) / p) * 100;
  const good = invert ? pct <= 0 : pct >= 0;
  return <em className={`kd ${Math.abs(pct) < 0.05 ? '' : good ? 'up' : 'down'}`}>{pct >= 0 ? '+' : ''}{pct.toFixed(1)}% vs previous period</em>;
}

export function OrgOverview() {
  const me = useMe();
  const [f, setF] = useState({ department: '', type: '', drone: '', customer: '', location: '', start: iso(new Date(Date.now() - 29 * 864e5)), end: iso(new Date()), status: '' });
  const [o, setO] = useState<O | null>(null);
  const [tab, setTab] = useState<keyof O['lists']>('recent');
  const [up, setUp] = useState({ drone: '', busy: false, msg: '' });
  const file = useRef<HTMLInputElement>(null);
  const load = () => api<O>(`/api/org/overview?${new URLSearchParams(f)}`).then(setO);
  useEffect(() => { load(); const h = setInterval(load, 10000); return () => clearInterval(h); /* eslint-disable-next-line */ }, [JSON.stringify(f)]);
  const preset = (days: number | null) => setF({ ...f, start: days == null ? '' : iso(new Date(Date.now() - (days - 1) * 864e5)), end: days == null ? '' : iso(new Date()) });
  const upload = async () => {
    const fl = file.current?.files?.[0];
    if (!fl || !up.drone) { setUp({ ...up, msg: 'Choose the drone and a .bin or .tlog file.' }); return; }
    setUp({ ...up, busy: true, msg: `Uploading ${fl.name}…` });
    const fd = new FormData(); fd.append('file', fl); fd.append('drone', up.drone);
    try {
      const r = await fetch('/api/logs/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      setUp({ drone: up.drone, busy: false, msg: j.duplicate ? `This log was already uploaded: opening report #${j.id}.` : `Uploaded. Analysing as report #${j.id}…` });
      if (file.current) file.current.value = '';
      go(`flight/${j.id}`);
    } catch (e) { setUp({ ...up, busy: false, msg: (e as Error).message }); }
  };
  const k = o?.kpis, p = o?.previous;
  const sel = (key: keyof typeof f, label: string, opts: [string, string][]) => (
    <label>{label}<select value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}><option value="">All</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
  );
  const rows = o ? o.lists[tab] : [];
  return (
    <div className="org-page">
      <div className="page-bar"><h1>Organization-wide overview</h1><span className="muted">{k ? `${k.connected_now} of 15 drones connected now` : ''}</span><span className="spacer" />
        {can(me, 'operator') && (
          <div className="upload-box">
            <select value={up.drone} onChange={(e) => setUp({ ...up, drone: e.target.value })} aria-label="Drone for the uploaded log"><option value="">Log belongs to…</option>{o?.options.drones.map((d) => <option key={d.key} value={d.key}>{d.drone_id}</option>)}</select>
            <input ref={file} type="file" accept=".bin,.tlog,.log" aria-label="Flight log file" />
            <button className="btn primary" disabled={up.busy} onClick={upload}><Icon name="upload" size={15} /> Upload flight log</button>
          </div>
        )}
      </div>
      {up.msg && <p className="muted small">{up.msg}</p>}
      <div className="org-filters">
        {sel('department', 'Department', (o?.options.departments ?? []).map((x) => [x, x]))}
        {sel('type', 'Drone type', (o?.options.types ?? []).map((x) => [x, x]))}
        {sel('drone', 'Drone', (o?.options.drones ?? []).map((d) => [d.key, d.drone_id]))}
        {sel('customer', 'Customer', (o?.options.customers ?? []).map((x) => [x, x]))}
        {sel('location', 'Location', (o?.options.locations ?? []).map((x) => [x, x]))}
        <label>From<input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
        <label>To<input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
        {sel('status', 'Flight status', [['completed', 'Landed normally'], ['incident', 'Critical incident'], ['warning', 'With warnings'], ['in_flight', 'In flight now'], ['pending', 'Awaiting analysis'], ['error', 'Analysis failed']])}
        <div className="seg presets"><button onClick={() => preset(1)}>Today</button><button onClick={() => preset(7)}>7 d</button><button onClick={() => preset(30)}>30 d</button><button onClick={() => preset(null)}>All</button></div>
      </div>
      {o && o.unassigned_slots > 0 && <p className="muted small">{o.unassigned_slots} drone slots have no department, customer or location yet: set them in System settings → Fleet &amp; GCS adapters to use those filters.</p>}
      {k && (
        <div className="org-kpis">
          <div className="okpi"><span>Total log uploads</span><b className="num">{k.uploads}</b><Delta v={k.uploads} p={p?.uploads} /></div>
          <div className="okpi"><span>Flights analysed</span><b className="num">{k.analysed}</b><Delta v={k.analysed} p={p?.analysed} /></div>
          <div className="okpi"><span>Active drones</span><b className="num">{k.active_drones}</b><em className="kd">flew in this period</em></div>
          <div className="okpi"><span>Departments</span><b className="num">{k.departments}</b></div>
          <div className="okpi"><span>Users</span><b className="num">{k.users}</b></div>
          <div className="okpi"><span>Flight logs received</span><b className="num">{k.logs_received}</b><Delta v={k.logs_received} p={p?.logs_received} /></div>
          <div className="okpi"><span>Logs analysed today</span><b className="num">{k.analysed_today}</b></div>
          <div className={`okpi ${k.critical ? 'crit' : ''}`}><span>Crashes / critical incidents</span><b className="num">{k.crashes} / {k.critical}</b><Delta v={k.critical} p={p?.critical} invert /></div>
          <div className="okpi"><span>Logs reviewed</span><b className="num">{k.reviewed}</b><em className="kd">{k.analysed ? `${Math.round((k.reviewed / Math.max(1, k.analysed)) * 100)}% of analysed` : ''}</em></div>
          <div className="okpi"><span>Total flights</span><b className="num">{k.flights}</b><Delta v={k.flights} p={p?.flights} /></div>
          <div className="okpi"><span>Average flight time</span><b className="num">{k.avg_flight_min != null ? `${fmt(k.avg_flight_min, 2)} min` : 'N/A'}</b><Delta v={k.avg_flight_min} p={p?.avg_flight_min} /></div>
          <div className="okpi"><span>Average distance travelled</span><b className="num">{k.avg_distance_m != null ? `${fmt(k.avg_distance_m)} m` : 'N/A'}</b><Delta v={k.avg_distance_m} p={p?.avg_distance_m} /></div>
        </div>
      )}
      <section className="panel">
        <div className="org-tabs">
          {TABS.map(([t, l]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{l} <em>{o ? o.lists[t].length : ''}</em></button>)}
        </div>
        {tab === 'by_drone' ? (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Drone</th><th>Flights</th><th>Hours</th><th>Uploads</th><th>Critical</th><th>Warnings</th><th>Reviewed</th><th>Last flight</th><th /></tr></thead>
            <tbody>{o?.lists.by_drone.map((b) => (
              <tr key={b.drone_key} onClick={() => go(`history/${b.drone_key}`)}><td><b>{b.drone_id}</b></td><td className="num">{b.flights}</td><td className="num">{b.hours.toFixed(2)}</td>
                <td className="num">{b.uploads}</td><td className={`num ${b.critical ? 'bad' : ''}`}>{b.critical}</td><td className={`num ${b.warning ? 'warn' : ''}`}>{b.warning}</td>
                <td className="num">{b.reviewed}</td><td className="num">{dateTimeOf(b.last)}</td><td><a className="btn sm ghost" href={`#/history/${b.drone_key}`}>Flights</a></td></tr>))}
              {!o?.lists.by_drone.length && <tr><td colSpan={9} className="empty-row">No flights in this selection.</td></tr>}</tbody>
          </table></div>
        ) : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Report</th><th>Drone</th><th>Flight date</th><th>Log</th><th>Duration</th><th>Analysis</th><th>Verdict</th><th>Review</th></tr></thead>
            <tbody>
              {(rows as Row[]).map((r) => (
                <tr key={r.id} onClick={() => go(`flight/${r.id}`)}>
                  <td className="num">#{r.id}</td>
                  <td><b>{r.drone_id}</b>{r.department && <div className="muted small">{[r.department, r.customer, r.location].filter(Boolean).join(' · ')}</div>}</td>
                  <td className="num">{dateTimeOf(r.start_ts)}</td>
                  <td>{r.source === 'upload' ? <span className="tag">uploaded</span> : <span className="tag">recorded live</span>} <span className="muted small">{r.log_name || ''}</span></td>
                  <td className="num">{r.flight_time_min != null ? dur(r.flight_time_min * 60) : '—'}</td>
                  <td>{r.status === 'flying' ? <span className="active-tag">in the air</span> : r.analysis_status === 'done' ? <span className="ok">analysed</span> : r.analysis_status === 'error' ? <span className="bad" title={r.analysis_error || ''}>failed</span> : <span className="warn">pending</span>}</td>
                  <td className="verdict-cell">{r.verdict ? <><span className={`chip ${r.verdict.level === 'critical' ? 'sev-critical' : r.verdict.level === 'warning' ? 'sev-warning' : 'tone-normal'}`}>{r.verdict.level}</span> {r.verdict.headline}</> : '—'}</td>
                  <td>{r.conclusion ? r.conclusion.replace('_', ' ') : <span className="muted">not reviewed</span>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8} className="empty-row">Nothing in this list for the current filters.</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
      <p className="muted note">All figures come from flights recorded by this command centre and logs uploaded to it. "Analysed" = the incident report was generated from the log; "reviewed" = an operator set the root cause; "active drones" = drones with at least one flight in the selected period.</p>
    </div>
  );
}
