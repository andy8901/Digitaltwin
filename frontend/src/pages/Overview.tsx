import { go } from '../App';
import { Battery, Icon, SignalBars, ToneChip } from '../components/Bits';
import { Video } from '../components/Video';
import { ago, CONN_LABEL, dur, flightStatus, fmt, gpsLabel, signal, tone } from '../lib/format';
import { useLive } from '../lib/live';
import type { Drone } from '../lib/types';

export function DroneTile({ d }: { d: Drone }) {
  const t = tone(d);
  const live = d.conn !== 'offline' && d.enabled;
  const warn = d.alerts.critical + d.alerts.warning;
  const offMsg = !d.enabled ? 'Slot disabled' : d.conn === 'offline' ? (d.last_seen_s == null ? 'GCS never connected' : `Offline · last seen ${ago(d.last_seen_s)}`)
    : !d.video.configured ? 'No video source configured' : 'No video stream';
  return (
    <button className={`tile tone-${t}`} onClick={() => go(`drone/${d.key}`)} aria-label={`${d.drone_id}: ${flightStatus(d)}`}>
      <div className="tile-h">
        <b className="tile-id">{d.drone_id}</b>
        <span className="tile-gcs">{d.gcs_id}</span>
        {warn > 0 && <span className={`tile-warn ${d.alerts.critical ? 'crit' : ''}`} title={`${d.alerts.critical} critical, ${d.alerts.warning} warnings`}><Icon name="warn" size={14} />{warn}</span>}
        <ToneChip d={d} />
      </div>
      <Video path={d.video.sub_path || d.video.path} enabled={live && d.video.ready} offMessage={offMsg} className="tile-video">
        <div className="vo vo-bl">{flightStatus(d)}{d.mode ? ` · ${d.mode}` : ''}</div>
        {d.video.recording && d.video.ready && <div className="vo vo-tr rec">REC</div>}
      </Video>
      <div className="tile-m">
        <div><span>Battery</span><b className="num"><Battery pct={d.batt_pct} /> {fmt(d.batt_pct)}%</b></div>
        <div><span>Altitude</span><b className="num">{fmt(d.alt, 0)} m</b></div>
        <div><span>Speed</span><b className="num">{fmt(d.gs, 1)} m/s</b></div>
        <div><span>Flight</span><b className="num">{d.flight_s != null && d.armed ? dur(d.flight_s) : '—'}</b></div>
        <div><span>GPS</span><b className="num">{gpsLabel(d)}</b></div>
        <div><span>Signal</span><b><SignalBars v={live ? signal(d) : null} /></b></div>
        <div><span>Mode</span><b>{d.mode || '—'}</b></div>
        <div><span>Link</span><b className={`conn conn-${d.conn}`}>{d.conn === 'flying' || d.conn === 'online' ? 'Live' : CONN_LABEL[d.conn]}</b></div>
      </div>
    </button>
  );
}

export function Overview() {
  const drones = useLive((s) => s.drones);
  return (
    <div className="grid15">
      {drones.map((d) => <DroneTile key={d.key} d={d} />)}
    </div>
  );
}
