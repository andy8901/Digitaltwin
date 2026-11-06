import { useEffect, useState } from 'react';
import { Bars } from '../components/Chart';
import { api } from '../lib/api';
import { fmt } from '../lib/format';

interface A {
  period: string;
  drones: { key: string; drone_id: string; gcs_id: string; flights: number; hours: number; km: number; max_alt: number | null; avg_batt_used: number | null; critical: number; warning: number; failsafes: number; crashes: number }[];
  totals: { flights: number; hours: number; km: number; crashes: number };
  alert_counts: { critical: number; warning: number; info: number };
  alerts_by_rule: [string, number][];
  daily_hours: [string, number][];
  stats: { averages: { key: string; label: string; unit: string; value: number | null; n: number }[]; failsafes: { key: string; label: string; unit: string; value: number | null; flights: number }[]; counts: { key: string; label: string; value: number }[] };
}

export function Analytics() {
  const [period, setPeriod] = useState('30d');
  const [a, setA] = useState<A | null>(null);
  useEffect(() => { api<A>(`/api/analytics?period=${period}`).then(setA); }, [period]);
  return (
    <div className="analytics-page">
      <div className="page-bar">
        <h1>Analytics & reports</h1>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
          <option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option>
        </select>
        <span className="spacer" />
        <a className="btn" href={`/api/reports/fleet.pdf?period=${period}`}>Fleet report (PDF)</a>
        <a className="btn ghost" href={`/api/export/flights.csv?period=${period}`}>Flights CSV</a>
        <a className="btn ghost" href="/api/export/alerts.csv?hours=720">Alerts CSV</a>
      </div>
      {!a ? <p className="muted">Loading…</p> : <>
        <div className="kpis">
          <div><b className="num">{a.totals.flights}</b><span>Completed flights</span></div>
          <div><b className="num">{a.totals.hours.toFixed(1)} h</b><span>Flight hours</span></div>
          <div><b className="num">{a.totals.km.toFixed(1)} km</b><span>Distance flown</span></div>
          <div className="k-crit"><b className="num">{a.alert_counts.critical}</b><span>Critical alerts</span></div>
          <div className="k-warn"><b className="num">{a.alert_counts.warning}</b><span>Warnings</span></div>
          <div><b className="num">{a.totals.crashes}</b><span>Crashes</span></div>
        </div>
        <div className="an-grid">
          <section className="panel"><div className="panel-h"><h2>Flight hours by drone</h2></div><Bars rows={a.drones.map((d) => [d.drone_id, d.hours])} unit=" h" /></section>
          <section className="panel"><div className="panel-h"><h2>Alerts by drone</h2></div>
            <h3 className="sub-h">Critical</h3><Bars rows={a.drones.map((d) => [d.drone_id, d.critical])} color="#ff4b4b" />
            <h3 className="sub-h">Warnings</h3><Bars rows={a.drones.map((d) => [d.drone_id, d.warning])} color="#f5c242" />
          </section>
          <section className="panel"><div className="panel-h"><h2>Alerts by type</h2></div>{a.alerts_by_rule.length ? <Bars rows={a.alerts_by_rule.slice(0, 14)} color="#f5c242" /> : <p className="muted">None.</p>}</section>
          <section className="panel"><div className="panel-h"><h2>Flight hours per day</h2></div>{a.daily_hours.length ? <Bars rows={a.daily_hours.map(([d, h]) => [d.slice(5), h])} unit=" h" color="#3b8cff" /> : <p className="muted">No flights yet.</p>}</section>
        </div>
        <section className="panel">
          <div className="panel-h"><h2>Fleet performance</h2><span className="muted">averages per recorded flight</span></div>
          <div className="tiles">
            {a.stats.averages.map((x) => <div className="tile-s" key={x.key}><span>{x.label}</span><b className="num">{fmt(x.value, x.unit === 'V' ? 2 : 1)} <small>{x.unit}</small></b><em>{x.n} flights</em></div>)}
            {a.stats.failsafes.map((x) => <div className="tile-s" key={x.key}><span>{x.label}</span><b className="num">{fmt(x.value, 1)} <small>{x.unit}</small></b><em>{x.flights} flights</em></div>)}
            {a.stats.counts.map((x) => <div className={`tile-s ${x.value ? 'warn' : ''}`} key={x.key}><span>{x.label}</span><b className="num">{x.value}</b><em>flights</em></div>)}
          </div>
        </section>
        <section className="panel">
          <div className="panel-h"><h2>By drone</h2></div>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Drone</th><th>GCS</th><th>Flights</th><th>Hours</th><th>Distance</th><th>Max altitude</th><th>Avg battery used</th><th>Critical</th><th>Warnings</th><th>Failsafes</th><th>Crashes</th><th /></tr></thead>
            <tbody>{a.drones.map((d) => (
              <tr key={d.key}><td><b>{d.drone_id}</b></td><td className="muted">{d.gcs_id}</td><td className="num">{d.flights}</td><td className="num">{d.hours.toFixed(2)}</td>
                <td className="num">{d.km.toFixed(1)} km</td><td className="num">{fmt(d.max_alt, 0)} m</td><td className="num">{fmt(d.avg_batt_used, 0)}%</td>
                <td className="num">{d.critical}</td><td className="num">{d.warning}</td><td className="num">{d.failsafes}</td><td className="num">{d.crashes}</td>
                <td><a className="btn sm ghost" href={`#/history/${d.key}`}>Flights</a></td></tr>))}</tbody>
          </table></div>
        </section>
      </>}
    </div>
  );
}
