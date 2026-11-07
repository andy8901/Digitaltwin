// Live flight monitor: satellite map with the drone's GPS track (2D or 3D) and the flight panel beside it.
import { useEffect, useState } from 'react';
import { go } from '../App';
import { SevChip, ToneChip } from '../components/Bits';
import { AltLegend } from '../components/FlightMap2D';
import { FlightPanel, type PanelState } from '../components/Instruments';
import { DEFAULT_LAYERS, LayerPanel, SatMap, type Cam, type Layers, type TrackPt } from '../components/SatMap';
import { dur, timeOf } from '../lib/format';
import { useDetail, useLive } from '../lib/live';
import { droneColor, usePaths } from '../lib/paths';
import type { DroneDetail } from '../lib/types';

function load<T>(k: string, def: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : def; } catch { return def; } }
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

export function useMapPrefs(prefix: string) {
  const [view, setView] = useState<'2d' | '3d'>(() => load(`${prefix}.view`, '2d'));
  const [cam, setCam] = useState<Cam>(() => load(`${prefix}.cam`, 'follow'));
  const [layers, setLayers] = useState<Layers>(() => ({ ...DEFAULT_LAYERS, ...load(`${prefix}.layers`, {}) }));
  useEffect(() => save(`${prefix}.view`, view), [prefix, view]);
  useEffect(() => save(`${prefix}.cam`, cam), [prefix, cam]);
  useEffect(() => save(`${prefix}.layers`, layers), [prefix, layers]);
  return { view, setView, cam, setCam, layers, setLayers };
}

export function ViewControls({ view, setView, cam, setCam }: { view: '2d' | '3d'; setView: (v: '2d' | '3d') => void; cam: Cam; setCam: (c: Cam) => void }) {
  return (
    <div className="sm-ctrl">
      <div className="seg"><button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>2D</button><button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D</button></div>
      <div className="seg">
        {(['chase', 'follow', 'free', 'whole'] as const).map((c) => (
          <button key={c} className={cam === c ? 'on' : ''} onClick={() => setCam(c)}
            title={{ chase: 'Centre on the drone and turn the map to its heading', follow: 'Keep the drone centred', free: 'Move the map yourself', whole: 'Show the whole flight' }[c]}>
            {{ chase: 'Chase', follow: 'Follow', free: 'Free', whole: 'Whole flight' }[c]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function livePanel(d: DroneDetail): PanelState {
  const stale = d.ages?.pos == null || d.ages.pos > 3;
  return {
    lat: d.lat, lon: d.lon, alt: d.alt, alt_msl: d.alt_msl, fix: d.fix, sats: d.sats, hdop: d.hdop, h_acc: d.h_acc ?? null,
    heading: d.heading, roll: d.roll, pitch: d.pitch, gs: d.gs, vz: d.climb ?? d.vz, dist_home: d.range, volt: d.volt, cells: d.battery_cells ?? null,
    batt_pct: d.batt_pct, curr: d.curr, flight_s: d.flight ? d.flight.time_s : null, vibe: d.vibe ? [d.vibe[0], d.vibe[1], d.vibe[2]] : null,
    clip: d.vibe ? d.vibe[3] : null, motors: d.motors?.length ? d.motors : null, posSource: 'EKF (GLOBAL_POSITION_INT)', stale,
  };
}

export function Monitor({ droneKey }: { droneKey?: string }) {
  const drones = useLive((s) => s.drones);
  const key = droneKey && drones.some((x) => x.key === droneKey) ? droneKey : drones.find((x) => x.airborne)?.key || drones[0]?.key || null;
  const d = useDetail(key);
  const alerts = useLive((s) => s.alerts);
  const paths = usePaths();
  const prefs = useMapPrefs('cc.mon');
  if (!key) return <div className="empty">No drones registered.</div>;
  if (!d) return <div className="empty">Loading {key}…</div>;
  const p = paths[d.key];
  const track: TrackPt[] = (p?.pts ?? []).map((x) => [x.lon, x.lat, x.alt]);
  const others = drones.filter((x) => x.key !== d.key && x.lat != null && x.conn !== 'offline')
    .map((x) => ({ key: x.key, label: x.drone_id, lat: x.lat!, lon: x.lon!, heading: x.heading, color: droneColor(x), alt: x.alt }));
  const mine = alerts.filter((a) => a.drone_key === d.key);
  const st = livePanel(d);
  return (
    <div className="mon-page">
      <div className="mon-head">
        <button className="btn back" onClick={() => go(`drone/${d.key}`)}>← Drone</button>
        <div>
          <div className="mon-kicker">LIVE MONITOR · {d.model || 'TAVAS'} · {d.gcs_id}</div>
          <select className="mon-sel" value={d.key} onChange={(e) => go(`monitor/${e.target.value}`)} aria-label="Drone">
            {drones.map((x) => <option key={x.key} value={x.key}>{x.drone_id}</option>)}
          </select>
        </div>
        <ToneChip d={d} />
        {d.simulated ? <span className="data-badge sim">SIMULATION</span> : d.conn === 'offline' ? <span className="data-badge none">NO LIVE DATA</span> : <span className="data-badge real">REAL-TIME</span>}
        <span className="spacer" />
        <span className="prec">Live track · EKF position (GLOBAL_POSITION_INT) · {track.length.toLocaleString()} points</span>
        <button className="btn" onClick={() => go(`history/${d.key}`)}>Flight logs</button>
      </div>
      <div className="mon-body">
        <SatMap pose={d.lat != null ? { lat: d.lat, lon: d.lon, alt: d.alt, heading: d.heading, roll: d.roll, pitch: d.pitch, yaw: d.yaw } : null}
          track={track} mission={p?.mission} missionSeq={d.mission_seq} home={d.home} takeoff={d.takeoff} others={others} color={droneColor(d)}
          view={prefs.view} layers={prefs.layers} cam={prefs.cam} focusKey={d.key} onSelect={(k) => go(`monitor/${k}`)}>
          <div className="sm-chips">
            <span className="sm-chip num">T+{d.flight ? dur(d.flight.time_s) : '—'}</span>
            <span className="sm-chip">{d.mode || 'mode N/A'}</span>
            <span className={`sm-chip ${d.armed ? 'armed' : ''}`}>{d.armed ? 'ARMED' : 'DISARMED'}</span>
            {d.lat != null && <span className="sm-chip num">{d.lat.toFixed(6)}, {d.lon!.toFixed(6)}</span>}
            {st.stale && d.conn !== 'offline' && <span className="sm-chip bad">NO POSITION FOR {Math.round(d.ages?.pos ?? 0)} s</span>}
          </div>
          <LayerPanel layers={prefs.layers} onChange={prefs.setLayers} view={prefs.view} />
          <ViewControls view={prefs.view} setView={prefs.setView} cam={prefs.cam} setCam={prefs.setCam} />
          <AltLegend />
          {d.lat == null && <div className="path-nodata">NO POSITION DATA FROM THIS DRONE</div>}
          {d.simulated && <div className="sim-badge path">SIMULATION</div>}
        </SatMap>
        <FlightPanel s={st} motorNote="This drone's GCS link isn't sending motor outputs (SERVO_OUTPUT_RAW)." />
      </div>
      <div className="mon-alarms">
        {mine.length ? mine.map((a) => <span key={a.id} className={`ma-inline sev-${a.severity}`}><SevChip s={a.severity} /> {a.label}: {a.message} <span className="muted num">{timeOf(a.ts)}</span></span>)
          : <span className="ok-line">No alarms at this moment</span>}
      </div>
    </div>
  );
}
