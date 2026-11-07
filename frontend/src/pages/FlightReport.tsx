// Flight incident report: what the recorded log shows, measured from its telemetry and the flight controller's messages.
import { useEffect, useMemo, useState } from 'react';
import { can, go, useMe } from '../App';
import { Icon } from '../components/Bits';
import { LineChart } from '../components/Chart';
import { api } from '../lib/api';
import { dateOf, dateTimeOf, dur, fmt, timeOf } from '../lib/format';
import type { Analysis, Timeline } from './Replay';

const TERM: Record<string, string> = {
  landed: 'LANDED AND DISARMED', log_ends_airborne: 'LOG ENDS IN MID-AIR', disarmed_in_air: 'DISARMED IN THE AIR',
  ends_armed: 'ENDS ARMED ON GROUND', no_flight: 'NO FLIGHT', unknown: 'END NOT RECORDED', crash: 'CRASH DETECTED',
};
const ROOT: Record<string, string> = { pilot_error: 'Pilot error', system_error: 'System error', undetermined: 'Yet to decide' };

export function FlightReport({ fid }: { fid: number }) {
  const me = useMe();
  const [a, setA] = useState<Analysis | null>(null);
  const [tl, setTl] = useState<Timeline | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [root, setRoot] = useState('');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    let alive = true, timer = 0;
    const load = () => api<Analysis>(`/api/flights/${fid}/analysis`).then((r) => {
      if (!alive) return;
      setA(r); setRoot(r.conclusion || ''); setNote(r.note || '');
      if (r.analysis_status === 'done') api<Timeline>(`/api/flights/${fid}/timeline`).then((t) => alive && setTl(t)).catch(() => undefined);
      else if (r.analysis_status !== 'error') timer = window.setTimeout(load, 2500);
    }).catch((e) => setErr(e.message));
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [fid]);
  const charts = useMemo(() => {
    if (!tl) return null;
    const k = Math.max(1, Math.ceil(tl.n / 1500));
    const pick = (c: string) => tl.cols[c].filter((_, i) => i % k === 0).map((v) => (typeof v === 'number' ? v : null));
    return { t: tl.cols.ts.filter((_, i) => i % k === 0) as number[], alt: pick('alt'), gs: pick('gs'), volt: pick('volt'), curr: pick('curr'),
      vx: pick('vibe_x'), vy: pick('vibe_y'), vz: pick('vibe_z'), sats: pick('sats') };
  }, [tl]);
  if (err) return <div className="empty">{err}</div>;
  if (!a) return <div className="empty">Loading report…</div>;
  const r = a.report;
  const head = (
    <div className="page-bar">
      <button className="btn back" onClick={() => history.length > 1 ? history.back() : go('history')}>← Back</button>
      <h1>Flight incident report</h1>
      {r && <span className={`chip ${r.level === 'critical' ? 'sev-critical' : r.level === 'warning' ? 'sev-warning' : 'tone-normal'}`}>{r.termination === 'log_ends_airborne' ? 'LOG ENDS IN FLIGHT' : r.level}</span>}
      <span className="spacer" />
      <a className="btn ghost" href={`/api/flights/${fid}/report.pdf`}><Icon name="report" size={15} /> PDF</a>
      <a className="btn ghost" href={`/api/flights/${fid}/telemetry.csv`}>Telemetry CSV</a>
      {(a.source === 'upload' || a.analysis_status) && <a className="btn ghost" href={`/api/flights/${fid}/log`}>Download log</a>}
    </div>
  );
  if (!r) {
    return (
      <div className="report-page">{head}
        <div className="panel">
          {a.analysis_status === 'error'
            ? <><h2 className="bad">The log could not be analysed</h2><p>{a.analysis_error}</p></>
            : <><h2>Analysing the flight log…</h2><p className="muted">{a.queue_position ? `Position ${a.queue_position} in the queue. ` : ''}This page updates by itself.</p></>}
          {can(me, 'operator') && a.analysis_status === 'error' && <button className="btn" onClick={() => api(`/api/flights/${fid}/reanalyse`, { method: 'POST' }).then(() => location.reload())}>Try again</button>}
        </div>
      </div>
    );
  }
  const crit = r.findings.filter((f) => f.level === 'critical');
  const summaryText = [
    `${a.drone_id} · ${a.log_name || `flight ${fid}`} · ${dateTimeOf(r.start_ts)}`,
    `Verdict: ${r.headline}`,
    `Flight time ${dur(r.flight_time_s)}, max height ${fmt(r.max_alt_m, 1)} m, top speed ${fmt(r.max_speed_ms, 1)} m/s, distance ${fmt(r.distance_m)} m.`,
    `Battery ${fmt(r.volt_takeoff, 2)} V at take-off → ${fmt(r.volt_landing, 2)} V at the end.`,
    `Termination: ${r.termination_text}`,
    ...r.findings.map((f) => `- [${f.level}] T+${f.t != null ? dur(f.t) : '?'} ${f.title}: ${f.detail}`),
    `Report: ${location.origin}/#/flight/${fid}`,
  ].join('\n');
  const copy = () => navigator.clipboard?.writeText(summaryText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  const saveRoot = () => api(`/api/flights/${fid}/conclusion`, { json: { conclusion: root || null, note } }).then(() => { setSaved('Saved'); setTimeout(() => setSaved(''), 1500); });
  return (
    <div className="report-page">
      {head}
      <div className="rep-top">
        <section className={`panel verdict v-${r.level}`}>
          <div className="mon-kicker">VERDICT · {a.model || 'TAVAS'} · {a.drone_id} · {dateOf(r.start_ts)}{a.source === 'upload' ? ` · uploaded by ${a.uploaded_by}` : ' · recorded live'}</div>
          <h2 className="verdict-h">{r.headline}</h2>
          <div className="row">
            <span className={`chip ${r.level === 'critical' ? 'sev-critical' : r.level === 'warning' ? 'sev-warning' : 'tone-normal'}`}>status {r.level}</span>
            <span className={`chip ${r.termination === 'landed' ? 'tone-normal' : 'sev-critical'}`}>{TERM[r.termination] ?? r.termination}</span>
            {r.counts.critical > 0 && <span className="chip sev-critical">{r.counts.critical} critical finding{r.counts.critical > 1 ? 's' : ''}</span>}
            {r.counts.warning > 0 && <span className="chip sev-warning">{r.counts.warning} warning{r.counts.warning > 1 ? 's' : ''}</span>}
          </div>
          <p>{r.termination_text}</p>
          <div className="row">
            <button className="btn replay-btn" onClick={() => go(`replay/${fid}`)}><Icon name="replay" size={16} /> Replay · 2D / 3D map</button>
            <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy summary'}</button>
          </div>
        </section>
        <section className="panel readouts">
          <h3>Flight read-outs</h3>
          <div className="ro-grid">
            <div><span>Flight time</span><b className="num">{dur(r.flight_time_s)}</b></div>
            <div><span>Max height</span><b className="num">{fmt(r.max_alt_m, 1)} m</b></div>
            <div><span>Farthest</span><b className="num">{r.max_range_m != null ? `${fmt(r.max_range_m)} m` : 'N/A'}</b></div>
            <div><span>Top speed</span><b className="num">{fmt(r.max_speed_ms, 1)} m/s</b></div>
            <div><span>Findings</span><b className="num">{r.counts.critical + r.counts.warning}</b></div>
            <div><span>FC messages</span><b className="num">{r.fc_messages}</b></div>
            <div className="wide"><span>Battery, take-off → end</span><b className="num">{r.volt_takeoff != null ? `${fmt(r.volt_takeoff, 2)} V` : 'N/A'} → {r.volt_landing != null ? `${fmt(r.volt_landing, 2)} V` : 'N/A'}</b></div>
          </div>
        </section>
      </div>
      {a.same_log && a.same_log.length > 0 && <p className="muted center">The same log file was also uploaded as {a.same_log.map((x) => <a key={x} href={`#/flight/${x}`}>report #{x} </a>)}.</p>}
      <div className="rep-grid">
        <section className="panel">
          <div className="panel-h"><h2>Incident summary</h2></div>
          <table className="tbl tight kvt"><tbody>
            <tr><th>Drone ID</th><td>{a.drone_id} <span className="muted">{a.gcs_id}</span></td></tr>
            <tr><th>Flight log ID</th><td>#{a.id} · {a.log_name || 'recorded live by the command centre'} <span className="muted">({r.kind === 'bin' ? 'on-board .bin log' : r.kind === 'tlog' ? 'telemetry .tlog' : '1 Hz telemetry record'})</span></td></tr>
            <tr><th>Flight date</th><td>{dateTimeOf(r.start_ts)}</td></tr>
            <tr><th>Flight duration</th><td>{dur(r.flight_time_s)} in the air · {dur(r.armed_s)} armed · log {dur(r.log_duration_s)}</td></tr>
            <tr><th>Maximum altitude</th><td>{r.max_alt_m != null ? `${fmt(r.max_alt_m, 1)} m above home` : 'N/A'}</td></tr>
            <tr><th>Maximum speed</th><td>{r.max_speed_ms != null ? `${fmt(r.max_speed_ms, 1)} m/s` : 'N/A'}</td></tr>
            <tr><th>Total flight distance</th><td>{fmt(r.distance_m)} m <span className="muted">(summed from recorded positions)</span></td></tr>
            <tr><th>Battery at take-off</th><td>{r.volt_takeoff != null ? `${fmt(r.volt_takeoff, 2)} V` : 'N/A'}{r.batt_start_pct != null ? ` · ${r.batt_start_pct}%` : ''}</td></tr>
            <tr><th>Battery at landing / end</th><td>{r.volt_landing != null ? `${fmt(r.volt_landing, 2)} V` : 'N/A'}{r.batt_end_pct != null ? ` · ${r.batt_end_pct}%` : ''} · lowest {r.volt_min != null ? `${fmt(r.volt_min, 2)} V` : 'N/A'}{r.max_current_a != null ? ` · max ${fmt(r.max_current_a, 1)} A` : ''}</td></tr>
            <tr><th>Flight termination</th><td className={r.termination === 'landed' ? 'ok' : 'bad'}>{r.termination_text}</td></tr>
            <tr><th>Flight modes</th><td>{r.modes.join(', ') || 'N/A'}</td></tr>
            <tr><th>Position data</th><td>{r.position_source}{r.position_rate_hz ? ` at ${r.position_rate_hz} Hz` : ''} · {r.samples.toLocaleString()} samples at {r.sample_hz} Hz</td></tr>
            {(a.department || a.customer || a.location) && <tr><th>Organisation</th><td>{[a.department, a.customer, a.location].filter(Boolean).join(' · ')}</td></tr>}
          </tbody></table>
        </section>
        <section className="panel">
          <div className="panel-h"><h2>Critical flight events</h2><span className="muted small">from recorded telemetry and flight-controller messages</span></div>
          {r.findings.length ? (
            <div className="findings">
              {r.findings.map((f, k) => (
                <div key={k} className={`fnd ${f.level}`}>
                  <span className={`chip ${f.level === 'critical' ? 'sev-critical' : 'sev-warning'}`}>{f.level}</span>
                  <span className="num muted">{f.t != null ? `T+${dur(f.t)}` : ''}</span>
                  <b>{f.title}</b>
                  {f.t != null && <button className="btn sm ghost" onClick={() => go(`replay/${fid}/${Math.max(0, Math.round(f.t! - 5))}`)}>Replay from here</button>}
                  <p>{f.detail}{f.alt != null ? <span className="muted"> · {fmt(f.alt, 1)} m above home</span> : null}</p>
                </div>
              ))}
            </div>
          ) : <p className="ok-line">No abnormalities found in this log.</p>}
          {crit.length === 0 && r.findings.length > 0 && <p className="muted small">No critical findings.</p>}
          <h3 className="sub-h">Operator review</h3>
          {can(me, 'operator') ? (
            <div className="row">
              <select value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Root cause"><option value="">Root cause not set</option>{Object.entries(ROOT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note" style={{ flex: 1, minWidth: 180 }} />
              <button className="btn" onClick={saveRoot}>{saved || 'Save review'}</button>
            </div>
          ) : <p>{a.conclusion ? ROOT[a.conclusion] : 'Not reviewed yet.'}</p>}
          {a.reviewed_by && <p className="muted small">Reviewed by {a.reviewed_by}</p>}
          <p className="muted small">The root cause is the operator's decision: the report lists what the log shows and doesn't assign blame.</p>
        </section>
      </div>
      {charts && (
        <section className="panel">
          <div className="panel-h"><h2>Recorded telemetry</h2><span className="muted small">whole log</span></div>
          <div className="charts rep-charts">
            <div><span className="ch-k">Altitude above home <b>max {fmt(r.max_alt_m, 1)} m</b></span><LineChart t={charts.t} series={[{ values: charts.alt, color: '#54c8e8' }]} windowS={tl!.duration_s + 1} /></div>
            <div><span className="ch-k">Ground speed <b>max {fmt(r.max_speed_ms, 1)} m/s</b></span><LineChart t={charts.t} series={[{ values: charts.gs, color: '#3b8cff' }]} min={0} windowS={tl!.duration_s + 1} /></div>
            <div><span className="ch-k">Battery voltage <b>{fmt(r.volt_takeoff, 2)} → {fmt(r.volt_landing, 2)} V</b></span><LineChart t={charts.t} series={[{ values: charts.volt, color: '#3ddc84' }]} windowS={tl!.duration_s + 1} /></div>
            <div><span className="ch-k">Current <b>max {fmt(r.max_current_a, 1)} A</b></span><LineChart t={charts.t} series={[{ values: charts.curr, color: '#f5c242' }]} min={0} windowS={tl!.duration_s + 1} /></div>
            <div><span className="ch-k">Vibration X / Y / Z <b>m/s²</b></span><LineChart t={charts.t} series={[{ values: charts.vx, color: '#54c8e8' }, { values: charts.vy, color: '#c9a6ff' }, { values: charts.vz, color: '#ff9f43' }]} min={0} windowS={tl!.duration_s + 1} /></div>
            <div><span className="ch-k">GPS satellites</span><LineChart t={charts.t} series={[{ values: charts.sats, color: '#a3e635' }]} min={0} windowS={tl!.duration_s + 1} /></div>
          </div>
        </section>
      )}
      {tl && (
        <section className="panel">
          <div className="panel-h"><h2>Flight-controller messages</h2><span className="muted small">{tl.msgs.length}</span></div>
          <div className="msgs tall">
            {tl.msgs.map((m, i) => <div key={i} className={`msg s${m.sev}`}><span className="num">{timeOf(m.ts)} · T+{dur(m.ts - tl.t0)}</span><span>{m.text}</span></div>)}
            {!tl.msgs.length && <p className="muted">No messages in this log.</p>}
          </div>
        </section>
      )}
    </div>
  );
}
