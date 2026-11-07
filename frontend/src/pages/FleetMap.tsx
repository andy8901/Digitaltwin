// Fleet flight monitoring: all 15 drones with their live GPS tracks on one map (2D) or in 3D.
// Each drone has its own path colour and labelled marker; click a drone to open its detail screen.
import { useState } from 'react';
import { go } from '../App';
import { FlightMap2D, fitAll } from '../components/FlightMap2D';
import { FlightView3D } from '../components/FlightView3D';
import { TONE_COLOR } from '../components/MapView';
import { flightStatus, fmt, tone, TONE_LABEL } from '../lib/format';
import { useLive } from '../lib/live';
import { droneColor, usePaths } from '../lib/paths';

export function FleetMap() {
  const drones = useLive((s) => s.drones);
  const paths = usePaths();
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [fitK, setFitK] = useState(0);
  return (
    <div className="map-page">
      <div className="page-bar">
        <h1>Fleet map</h1>
        <div className="seg"><button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>2D map</button><button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D</button></div>
        <span className="muted">{drones.filter((d) => d.airborne).length} airborne · each drone has its own path colour · click a drone to open it</span>
        <span className="spacer" />
        {view === '2d' && <button className="btn" onClick={() => setFitK(fitAll())}>Fit all drones</button>}
      </div>
      <div className="map-wrap">
        <div className="fleet-map-box">
          {view === '2d'
            ? <FlightMap2D drones={drones} paths={paths} onSelect={(k) => go(`drone/${k}`)} className="fleet-map" fitKey={`fm:${fitK}`} />
            : <FlightView3D drones={drones} focusKey={null} />}
          {view === '2d' && <div className="map-legend">
            <span>Ring = status:</span>
            {(['airborne', 'normal', 'warning', 'critical', 'offline'] as const).map((t) => <span key={t}><i style={{ background: TONE_COLOR[t] }} />{TONE_LABEL[t]}</span>)}
            <span>· arrow = heading · dotted line = movement (next 10 s) · dashed = planned mission</span>
          </div>}
        </div>
        <div className="map-list">
          {drones.map((d) => (
            <button key={d.key} className={`ml-row tone-${tone(d)}`} onClick={() => go(`drone/${d.key}`)}>
              <i style={{ background: droneColor(d) }} /><b>{d.drone_id}</b>
              <span className="num">{d.airborne ? `${fmt(d.alt, 0)} m · ${fmt(d.gs, 1)} m/s` : flightStatus(d)}</span>
              {(paths[d.key]?.pts.length ?? 0) > 0 && <em className="ml-pts">{paths[d.key].pts.length} pts</em>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
