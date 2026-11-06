import { useEffect, useState } from 'react';
import { go } from '../App';
import { api } from '../lib/api';
import type { Health } from '../lib/types';

const COMPS = ['Battery', 'Motors', 'ESC', 'GPS', 'Flight controller', 'Communication link', 'Camera', 'Sensors', 'Temperature'];
const LABEL: Record<string, string> = { healthy: 'Healthy', warning: 'Warning', critical: 'Critical', unavailable: 'No data' };

export function FleetHealth() {
  const [rows, setRows] = useState<Health[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api<Health[]>('/api/health').then((r) => alive && setRows(r)).catch(() => undefined);
    load();
    const i = setInterval(load, 3000);
    return () => { alive = false; clearInterval(i); };
  }, []);
  const counts = { healthy: 0, warning: 0, critical: 0, unavailable: 0 } as Record<string, number>;
  rows.forEach((r) => { counts[r.overall] = (counts[r.overall] || 0) + 1; });
  return (
    <div className="health-page">
      <div className="page-bar">
        <h1>Fleet health</h1>
        <span className="hl hl-healthy">{counts.healthy} healthy</span><span className="hl hl-warning">{counts.warning} warning</span>
        <span className="hl hl-critical">{counts.critical} critical</span><span className="hl hl-unavailable">{counts.unavailable} no data</span>
      </div>
      <p className="muted note">Each component is judged only from data the drone actually sends. "No data" means the drone or its GCS doesn't report it (for example ESC telemetry), and it is left out of the score: healthy 100, warning 60, critical 0, averaged over the components with data.</p>
      <div className="table-wrap">
        <table className="tbl health-tbl">
          <thead><tr><th>Drone</th><th>GCS</th><th>Score</th>{COMPS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} onClick={() => go(`drone/${r.key}`)}>
                <td><b>{r.drone_id}</b></td>
                <td className="muted">{r.gcs_id}</td>
                <td><span className={`score s-${r.overall}`}>{r.score ?? '—'}</span><div className="muted small">{r.available}/{r.total} with data</div></td>
                {COMPS.map((c) => {
                  const x = r.components.find((y) => y.name === c);
                  return <td key={c} className={`hcell hc-${x?.status ?? 'unavailable'}`} title={x?.detail}>
                    <b>{LABEL[x?.status ?? 'unavailable']}</b><span>{x?.detail}</span>
                  </td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
