// Main dashboard: everything an operator needs to read the fleet in a few seconds —
// all 15 live camera feeds with their flight status, the fleet's live flight paths, and the alerts that need attention.
import { useState } from 'react';
import { ackAlert, can, go, useMe } from '../App';
import { Battery, Icon, SevChip, SignalBars } from '../components/Bits';
import { FlightMap2D, fitAll } from '../components/FlightMap2D';
import { FlightView3D } from '../components/FlightView3D';
import { freshness } from '../components/Telem';
import { Video } from '../components/Video';
import { ago, flightStatus, fmt, signal, timeOf, tone, TONE_LABEL } from '../lib/format';
import { useLive } from '../lib/live';
import { droneColor, usePaths } from '../lib/paths';
import type { Drone } from '../lib/types';

const na = (v: string | null) => (v == null ? <i className="na">N/A</i> : v);

export function DroneTile({ d }: { d: Drone }) {
  const t = tone(d);
  const live = d.conn !== 'offline' && d.enabled;
  const warn = d.alerts.critical + d.alerts.warning;
  const offMsg = !d.enabled ? 'Slot disabled' : d.conn === 'offline' ? (d.last_seen_s == null ? 'GCS never connected' : `Drone offline · last seen ${ago(d.last_seen_s)}`)
    : !d.video.configured ? 'No video source configured' : 'No stream from the camera';
  const pos = freshness(d, 'pos');
  const stale = live && (d.conn === 'stale' || d.conn === 'link_lost' || pos === 'stale');
  return (
    <button className={`tile tone-${t}`} onClick={() => go(`drone/${d.key}`)} aria-label={`${d.drone_id}: ${flightStatus(d)}. Open detail`}>
      <div className="tile-h">
        <i className="id-dot" style={{ background: droneColor(d) }} />
        <b className="tile-id">{d.drone_id}</b>
        <span className="spacer" />
        {warn > 0 && <span className={`tile-warn ${d.alerts.critical ? 'crit' : ''}`} title={`${d.alerts.critical} critical, ${d.alerts.warning} warnings`}><Icon name="warn" size={13} />{warn}</span>}
        <span className={`chip tone-${t}`}>{TONE_LABEL[t]}</span>
      </div>
      <Video path={d.video.sub_path || d.video.path} enabled={live && d.video.ready} offMessage={offMsg} className="tile-video" simulated={d.simulated && live}>
        <div className="vo vo-bl">{flightStatus(d)}{d.mode ? ` · ${d.mode}` : ''}</div>
      </Video>
      <div className={`tile-strip ${stale ? 'stale' : ''}`}>
        <span title="Battery"><Battery pct={d.batt_pct} /> {d.batt_pct != null ? `${d.batt_pct}%` : na(null)}</span>
        <span title="Altitude above home">{d.alt != null && pos !== 'none' ? `${fmt(d.alt, 0)} m` : na(null)}</span>
        <span title="Ground speed">{d.gs != null ? `${fmt(d.gs, 1)} m/s` : na(null)}</span>
        <span title="Signal"><SignalBars v={live ? signal(d) : null} /></span>
      </div>
      {stale && <div className="tile-stale">NO DATA {d.last_seen_s != null ? `${Math.round(d.last_seen_s)} s` : ''}</div>}
    </button>
  );
}

function AlertList() {
  const alerts = useLive((s) => s.alerts);
  const me = useMe();
  const sorted = [...alerts].sort((a, b) => (a.severity === b.severity ? b.ts - a.ts : a.severity === 'critical' ? -1 : 1));
  return (
    <div className="dash-alerts">
      {sorted.length ? sorted.slice(0, 40).map((a) => (
        <div key={a.id} className={`da sev-${a.severity} ${!a.ack_ts && a.severity === 'critical' ? 'unacked' : ''}`} onClick={() => go(`drone/${a.drone_key}`)} role="button" tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && go(`drone/${a.drone_key}`)}>
          <SevChip s={a.severity} />
          <b>{a.drone_id}</b>
          <span className="da-l">{a.label}</span>
          <span className="num muted">{timeOf(a.ts)}</span>
          <span className="da-m">{a.message}</span>
          {!a.ack_ts && a.severity === 'critical' && can(me, 'operator') && <button className="btn sm" onClick={(e) => { e.stopPropagation(); ackAlert(a); }}>Ack</button>}
        </div>
      )) : <p className="ok-line">No active alerts. All drones within limits.</p>}
    </div>
  );
}

export function Overview() {
  const drones = useLive((s) => s.drones);
  const paths = usePaths();
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [fitK, setFitK] = useState(0);
  const counts = { c: useLive((s) => s.alerts.filter((a) => a.severity === 'critical').length), w: useLive((s) => s.alerts.filter((a) => a.severity === 'warning').length) };
  return (
    <div className="dash">
      <div className="dash-left">
        <div className="grid15">
          {drones.map((d) => <DroneTile key={d.key} d={d} />)}
        </div>
        <section className="panel dash-al">
          <div className="panel-h"><h2>Alerts</h2><span className="chip sev-critical">{counts.c} critical</span><span className="chip sev-warning">{counts.w} warning</span><span className="spacer" /><a className="btn sm ghost" href="#/alerts">All alerts</a></div>
          <AlertList />
        </section>
      </div>
      <div className="dash-side">
        <section className="panel dash-map">
          <div className="panel-h">
            <h2>Fleet flight paths</h2>
            <div className="seg"><button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>2D</button><button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D</button></div>
            <span className="spacer" />
            {view === '2d' && <button className="btn sm ghost" onClick={() => setFitK(fitAll())}>Fit</button>}
            <button className="btn sm ghost" onClick={() => go('map')} title="Open the full-screen fleet map"><Icon name="expand" size={14} /></button>
          </div>
          <div className="dash-path">
            {view === '2d'
              ? <FlightMap2D drones={drones} paths={paths} onSelect={(k) => go(`drone/${k}`)} className="dash-leaflet" fitKey={`fleet:${fitK}`} />
              : <FlightView3D drones={drones} focusKey={null} />}
          </div>
          <div className="id-legend">{drones.filter((d) => d.lat != null && d.conn !== 'offline').map((d) => <button key={d.key} onClick={() => go(`drone/${d.key}`)}><i style={{ background: droneColor(d) }} />{d.drone_id.replace('TAVAS ', '')}</button>)}</div>
        </section>
      </div>
    </div>
  );
}
