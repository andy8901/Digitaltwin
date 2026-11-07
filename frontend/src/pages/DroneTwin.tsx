import { useEffect, useMemo, useRef, useState } from 'react';
import { ackAlert, can, go, useMe } from '../App';
import { Battery, Icon, SevChip, SignalBars, ToneChip } from '../components/Bits';
import { LineChart } from '../components/Chart';
import { AltLegend, FlightMap2D, fitAll } from '../components/FlightMap2D';
import { FlightView3D, type CamMode } from '../components/FlightView3D';
import { TavasModel } from '../components/TavasModel';
import { TVal } from '../components/Telem';
import { Video, type VideoStats } from '../components/Video';
import { api } from '../lib/api';
import { ago, compass, CONN_LABEL, dur, FIX, flightStatus, fmt, timeOf } from '../lib/format';
import { useDetail, useLive } from '../lib/live';
import { usePaths } from '../lib/paths';
import type { DroneDetail } from '../lib/types';

const SYS = ['Uninitialised', 'Booting', 'Calibrating', 'Standby', 'Active', 'Critical', 'Emergency', 'Powering off', 'Terminating'];

function Row({ k, v, unit, warn }: { k: string; v: React.ReactNode; unit?: string; warn?: 'w' | 'c' | '' }) {
  const na = v === null || v === undefined || v === '—';
  return (
    <div className={`kv ${warn === 'c' ? 'kv-crit' : warn === 'w' ? 'kv-warn' : ''}`}>
      <span>{k}</span><b className={`num ${na ? 'na' : ''}`}>{na ? 'n/a' : v}{!na && unit ? <small>{unit}</small> : null}</b>
    </div>
  );
}

function TechDetails({ d, rtt }: { d: DroneDetail; rtt: number | null }) {
  const cells = d.battery_cells || 0;
  const temps = Object.entries(d.temps || {});
  return (
    <div className="telemetry">
      <h3>Position</h3>
      <Row k="Latitude" v={d.lat != null ? d.lat.toFixed(6) : null} />
      <Row k="Longitude" v={d.lon != null ? d.lon.toFixed(6) : null} />
      <Row k="Altitude AGL" v={fmt(d.alt, 1)} unit="m" />
      <Row k="Altitude AMSL" v={fmt(d.alt_msl, 1)} unit="m" />
      <Row k="Ground speed" v={fmt(d.gs, 1)} unit="m/s" />
      <Row k="Air speed" v={d.airspeed != null && d.airspeed > 0 ? fmt(d.airspeed, 1) : null} unit="m/s" />
      <Row k="Climb rate" v={fmt(d.climb, 1)} unit="m/s" />
      <Row k="Heading" v={d.heading != null ? `${fmt(d.heading)}° ${compass(d.heading)}` : null} />
      <Row k="Range from home" v={fmt(d.range)} unit="m" />
      <h3>Attitude</h3>
      <Row k="Pitch" v={fmt(d.pitch, 1)} unit="°" />
      <Row k="Roll" v={fmt(d.roll, 1)} unit="°" />
      <Row k="Yaw" v={fmt(d.yaw, 1)} unit="°" />
      <h3>Battery</h3>
      <Row k="Battery" v={fmt(d.batt_pct)} unit="%" warn={d.batt_pct != null && d.batt_pct <= 15 ? 'c' : d.batt_pct != null && d.batt_pct <= 30 ? 'w' : ''} />
      <Row k="Voltage" v={d.volt != null ? `${fmt(d.volt, 2)}${cells ? ` (${(d.volt / cells).toFixed(2)}/cell)` : ''}` : null} unit="V" />
      <Row k="Current" v={fmt(d.curr, 1)} unit="A" />
      <Row k="Consumed" v={fmt(d.mah)} unit="mAh" />
      <h3>GPS & link</h3>
      <Row k="Satellites" v={d.sats} warn={d.sats != null && d.sats < 8 ? 'w' : ''} />
      <Row k="GPS fix" v={d.fix != null ? FIX[d.fix] ?? d.fix : null} warn={d.fix != null && d.fix < 3 ? 'c' : ''} />
      <Row k="HDOP" v={fmt(d.hdop, 2)} warn={d.hdop != null && d.hdop > 2 ? 'w' : ''} />
      <Row k="Signal (RSSI)" v={fmt(d.rssi)} unit="%" />
      <Row k="Packets received" v={fmt(d.link_pct)} unit="%" />
      <Row k="GCS round trip" v={rtt != null ? fmt(rtt) : null} unit="ms" />
      <Row k="Last data" v={d.last_seen_s != null ? ago(d.last_seen_s) : null} />
      <h3>Flight</h3>
      <Row k="Flight mode" v={d.mode || null} />
      <Row k="Flight duration" v={d.flight ? dur(d.flight.time_s) : null} />
      <Row k="Distance flown" v={d.flight ? fmt(d.flight.distance_m) : null} unit="m" />
      <Row k="Mission waypoint" v={d.mission?.seq != null ? `${d.mission.seq}${d.mission.total ? ` of ${d.mission.total - 1}` : ''}` : null} />
      <h3>Flight controller</h3>
      <Row k="Status" v={d.system_status != null ? SYS[d.system_status] ?? d.system_status : null} warn={d.system_status != null && d.system_status >= 5 ? 'c' : ''} />
      <Row k="CPU load" v={fmt(d.load)} unit="%" />
      <Row k="EKF variance (max)" v={d.ekf ? fmt(d.ekf.max, 2) : null} warn={d.ekf && d.ekf.max >= 0.8 ? 'c' : d.ekf && d.ekf.max >= 0.5 ? 'w' : ''} />
      <Row k="Compass variance" v={d.ekf ? fmt(d.ekf.compass, 2) : null} warn={d.ekf && d.ekf.compass > 0.5 ? 'w' : ''} />
      <Row k="Vibration (max)" v={d.vibe ? fmt(Math.max(d.vibe[0], d.vibe[1], d.vibe[2]), 0) : null} unit="m/s²" />
      <Row k="Sensors" v={d.sensors ? (d.sensors.every((s) => s.ok) ? `${d.sensors.length} healthy` : `Unhealthy: ${d.sensors.filter((s) => !s.ok).map((s) => s.name).join(', ')}`) : null}
        warn={d.sensors && d.sensors.some((s) => !s.ok) ? 'w' : ''} />
      <h3>Motors / ESC</h3>
      {d.motors.length ? d.motors.map((m, i) => {
        const e = d.esc.find((x) => x.i === i);
        return <Row key={i} k={`Motor ${i + 1}`} v={`${m} µs${e ? ` · ${e.rpm} rpm · ${e.temp} °C` : ''}`} warn={m >= 1900 && d.armed ? 'c' : e && e.temp >= 60 ? 'w' : ''} />;
      }) : <Row k="Motor outputs" v={null} />}
      <h3>Temperatures</h3>
      {temps.length ? temps.map(([k, v]) => <Row key={k} k={k[0].toUpperCase() + k.slice(1)} v={fmt(v)} unit="°C" warn={v >= 60 ? 'w' : ''} />) : <Row k="System temperature" v={null} />}
    </div>
  );
}

function Ods({ d }: { d: DroneDetail }) {
  const get = (a: number | string) => d.ods.find((o) => o.a === a);
  const items: [string, { d: number; max: number } | undefined][] = [
    ['Front', get(0)], ['Right', get(90)], ['Back', get(180)], ['Left', get(270)], ['Up', get('up')],
    ['Down', d.rangefinder ? { d: d.rangefinder.d, max: d.rangefinder.max } : undefined],
  ];
  if (!items.some((x) => x[1])) return null;
  return (
    <div className="ods">
      <span className="muted">ODS</span>
      {items.map(([k, v]) => <span key={k} className={v && v.d < 2 ? 'crit' : v && v.d < 5 ? 'warn' : ''}>{k} <b className="num">{v ? (v.d >= v.max ? 'clear' : `${v.d.toFixed(1)} m`) : 'n/a'}</b></span>)}
    </div>
  );
}


/** Section C: the parameters an operator needs, each with its unit, N/A when not sent, and marked when stale or estimated. */
function FlightTelemetry({ d, rtt }: { d: DroneDetail; rtt: number | null }) {
  const cells = d.battery_cells || 0;
  const bw = d.batt_pct != null && d.batt_pct <= 15 ? 'c' : d.batt_pct != null && d.batt_pct <= 30 ? 'w' : '';
  const sig = d.rssi ?? d.link_pct;
  return (
    <div className="tgrid">
      <TVal d={d} grp="pos" label="Latitude" value={d.lat != null ? d.lat.toFixed(6) : null} unit="°" />
      <TVal d={d} grp="pos" label="Longitude" value={d.lon != null ? d.lon.toFixed(6) : null} unit="°" />
      <TVal d={d} grp="pos" label="Altitude AGL" value={fmt(d.alt, 1)} unit="m" title="Height above the home (take-off) point, from the autopilot" />
      <TVal d={d} grp="pos" label="Altitude AMSL" value={d.alt_msl != null ? fmt(d.alt_msl, 1) : null} unit="m" />
      <TVal d={d} grp="hud" label="Ground speed" value={fmt(d.gs, 1)} unit="m/s" />
      <TVal d={d} grp="pos" label="Heading" value={d.heading != null ? `${fmt(d.heading)}° ${compass(d.heading)}` : null}
        est={d.heading_src === 'yaw' ? 'from the attitude yaw: the autopilot sent no GPS heading' : false} />
      <TVal d={d} grp="att" label="Pitch" value={fmt(d.pitch, 1)} unit="°" />
      <TVal d={d} grp="att" label="Roll" value={fmt(d.roll, 1)} unit="°" />
      <TVal d={d} grp="att" label="Yaw" value={fmt(d.yaw, 1)} unit="°" />
      <TVal d={d} grp="hud" label="Vertical speed" value={fmt(d.climb, 1)} unit="m/s" />
      <TVal d={d} grp="batt" label="Battery" value={d.batt_pct != null ? <><Battery pct={d.batt_pct} /> {d.batt_pct}</> : null} unit="%" warn={bw} />
      <TVal d={d} grp="batt" label="Battery voltage" value={d.volt != null ? `${fmt(d.volt, 2)}${cells ? ` · ${(d.volt / cells).toFixed(2)}/cell` : ''}` : null} unit="V" />
      <TVal d={d} grp="gps" label="GPS satellites" value={d.sats} warn={d.sats != null && d.sats < 8 ? 'w' : ''} />
      <TVal d={d} grp="gps" label="GPS fix" value={d.fix != null ? `${FIX[d.fix] ?? d.fix}${d.hdop != null ? ` · HDOP ${fmt(d.hdop, 1)}` : ''}` : null} warn={d.fix != null && d.fix < 3 ? 'c' : ''} />
      <TVal d={d} grp="hb" label="Flight mode" value={d.mode || null} />
      <TVal d={d} label="Flight duration" value={d.flight ? dur(d.flight.time_s) : null} est="counted by the app from arming" />
      <TVal d={d} grp={d.ages?.radio != null ? 'radio' : 'rc'} label="Signal strength" value={sig != null ? <><SignalBars v={sig} /> {sig}</> : null} unit="%"
        title={d.rssi != null ? 'Radio RSSI reported by the telemetry radio / receiver' : 'Share of MAVLink packets received'} />
      <TVal d={d} label="Communication" value={<span className={`conn conn-${d.conn}`}>{CONN_LABEL[d.conn]}{rtt != null ? ` · ${rtt} ms` : ''}</span>} />
      <TVal d={d} label="Distance travelled" value={d.flight ? fmt(d.flight.distance_m) : null} unit="m" est="summed from received GPS positions" />
      <TVal d={d} label="Range from home" value={fmt(d.range)} unit="m" est="calculated from GPS position and home" />
      <TVal d={d} label="Last data received" value={d.last_rx ? `${timeOf(d.last_rx)} · ${ago(d.last_seen_s)}` : null} wide
        warn={d.conn === 'stale' || d.conn === 'link_lost' ? 'c' : ''} />
    </div>
  );
}

function Collapse({ id, title, extra, children, open: def = false }: { id: string; title: string; extra?: React.ReactNode; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(`cc.col.${id}`); return v == null ? def : v === '1'; } catch { return def; } });
  return (
    <div className={`col ${open ? 'open' : ''}`}>
      <button className="col-h" onClick={() => { setOpen(!open); try { localStorage.setItem(`cc.col.${id}`, open ? '0' : '1'); } catch { /* ignore */ } }} aria-expanded={open}>
        <span className="col-arrow">{open ? '▾' : '▸'}</span><b>{title}</b>{extra}
      </button>
      {open && <div className="col-b">{children}</div>}
    </div>
  );
}

export function DroneTwin({ droneKey }: { droneKey?: string }) {
  const drones = useLive((s) => s.drones);
  const key = droneKey && drones.some((x) => x.key === droneKey) ? droneKey : drones[0]?.key || null;
  const d = useDetail(key);
  const t = useLive((s) => s.t);
  const hist = useLive((s) => (key ? s.history[key] : undefined));
  const gcs = useLive((s) => s.gcs.find((g) => g.key === key));
  const alerts = useLive((s) => s.alerts);
  const paths = usePaths();
  const me = useMe();
  const [vs, setVs] = useState<VideoStats | null>(null);
  const [view, setView] = useState<'2d' | '3d'>(() => { try { return (localStorage.getItem('cc.pathview') as '2d' | '3d') || '3d'; } catch { return '3d'; } });
  const [cam, setCam] = useState<CamMode>('orbit');
  const [colorBy, setColorBy] = useState<'altitude' | 'drone'>('altitude');
  const [others, setOthers] = useState(true);
  const [fitK, setFitK] = useState(0);
  const [chase, setChase] = useState(false);
  const [past, setPast] = useState<{ ts: number; alt: number | null; batt_pct: number | null; volt: number | null; gs: number | null; link: number | null }[]>([]);
  const vbox = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem('cc.pathview', view); } catch { /* ignore */ } }, [view]);
  useEffect(() => {
    setPast([]);
    if (key) api<typeof past>(`/api/drones/${key}/telemetry?minutes=10`).then(setPast).catch(() => undefined);
  }, [key]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.fullscreenElement) go('overview'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const series = useMemo(() => {
    const live = hist || [];
    const cut = live.length ? live[0].t : Infinity;
    const p = past.filter((r) => r.ts < cut);
    const T = [...p.map((r) => r.ts), ...live.map((r) => r.t)];
    return {
      t: T,
      batt: [...p.map((r) => r.batt_pct), ...live.map((r) => r.batt)],
      volt: [...p.map((r) => r.volt), ...live.map((r) => r.volt)],
      alt: [...p.map((r) => r.alt), ...live.map((r) => r.alt)],
      gs: [...p.map((r) => r.gs), ...live.map((r) => r.gs)],
      link: [...p.map((r) => r.link), ...live.map((r) => r.link)],
      rssi: [...p.map(() => null), ...live.map((r) => r.rssi)],
    };
  }, [hist, past]);
  if (!key) return <div className="empty">No drones registered.</div>;
  if (!d) return <div className="empty">Loading {key}…</div>;
  const idx = drones.findIndex((x) => x.key === d.key);
  const prev = drones[(idx - 1 + drones.length) % drones.length], next = drones[(idx + 1) % drones.length];
  const mine = alerts.filter((a) => a.drone_key === d.key);
  const live = d.conn !== 'offline';
  const motorWarn = d.esc.length ? d.motors.map((_, i) => { const e = d.esc.find((x) => x.i === i); return !!e && (e.temp >= 60 || (d.airborne && e.rpm === 0)); }) : undefined;
  const full = () => { const el = vbox.current?.querySelector('.video') as HTMLElement | null; el?.requestFullscreen?.().catch(() => undefined); };
  const p = paths[d.key];
  const batt = d.health?.components.find((c) => c.name === 'Battery');
  const comm = d.health?.components.find((c) => c.name === 'Communication link');
  return (
    <div className="dt-page">
      <div className="dt-head">
        <button className="btn back" onClick={() => go('overview')} title="Back to the fleet dashboard (Esc)"><span aria-hidden>←</span> Fleet</button>
        <div className="dt-nav">
          <button className="btn ghost sm" onClick={() => go(`drone/${prev.key}`)} aria-label={`Previous: ${prev.drone_id}`}>‹</button>
          <select value={d.key} onChange={(e) => go(`drone/${e.target.value}`)} aria-label="Drone">
            {drones.map((x) => <option key={x.key} value={x.key}>{x.drone_id} · {x.gcs_id}</option>)}
          </select>
          <button className="btn ghost sm" onClick={() => go(`drone/${next.key}`)} aria-label={`Next: ${next.drone_id}`}>›</button>
        </div>
        <h1 className="dt-id">{d.drone_id}</h1>
        <span className="muted">{d.gcs_id}</span>
        <ToneChip d={d} />
        {d.simulated ? <span className="data-badge sim" title="Data comes from the simulator, not a real drone">SIMULATION</span>
          : d.conn === 'offline' ? <span className="data-badge none" title="Nothing is being received from this drone's GCS">NO LIVE DATA</span>
            : <span className="data-badge real" title="Telemetry received live from the drone's GCS">REAL-TIME</span>}
        <span className="bar-stat">{flightStatus(d)}</span>
        <span className="bar-stat"><span className="muted">Mode</span> <b>{d.mode || 'N/A'}</b></span>
        <span className="bar-stat"><span className="muted">Flight</span> <b className="num">{d.flight ? dur(d.flight.time_s) : '—'}</b></span>
        <span className="spacer" />
        <span className={`bar-stat last-rx ${d.conn === 'stale' || d.conn === 'link_lost' ? 'bad' : ''}`}><span className="muted">Last data</span> <b className="num">{d.last_rx ? timeOf(d.last_rx) : 'never'}</b></span>
        <button className="btn ghost" onClick={() => go(`history/${d.key}`)}><Icon name="history" /> History</button>
      </div>
      <div className="dt-grid">
        {/* A: live camera */}
        <section className="panel dt-a" ref={vbox}>
          <Video path={d.video.path} enabled={live && d.video.ready} pauseWhenHidden={false} onStats={setVs} simulated={d.simulated}
            offMessage={!live ? 'Drone offline' : !d.video.configured ? 'No video source configured for this GCS' : 'No stream from the camera'} className="main-video">
            <div className="vo vo-tl"><b>{d.drone_id}</b> <span className="muted">{d.gcs_id}</span></div>
            <div className="vo vo-tr num">{timeOf(t)} {vs?.latencyMs != null && <span className="muted">· {vs.latencyMs} ms</span>}{d.video.recording && <span className="rec">REC</span>}</div>
            <div className="vo vo-bl num">{d.alt != null ? `${fmt(d.alt, 0)} m` : 'alt N/A'} · {d.gs != null ? `${fmt(d.gs, 1)} m/s` : 'speed N/A'} · {d.heading != null ? `${fmt(d.heading)}° ${compass(d.heading)}` : 'hdg N/A'}</div>
          </Video>
          <div className="video-meta">
            <span>Video <b className={vs?.state === 'playing' ? 'ok' : 'bad'}>{vs?.state === 'playing' ? 'connected' : vs?.state === 'connecting' ? 'connecting' : 'offline'}</b></span>
            <span>Latency <b className="num">{vs?.latencyMs != null ? `~${vs.latencyMs} ms` : 'N/A'}</b></span>
            <span>Stream <b className="num">{vs?.height ? `${vs.width}×${vs.height}` : 'N/A'}{vs?.fps ? ` · ${vs.fps} fps` : ''}{vs?.kbps ? ` · ${vs.kbps} kbit/s` : ''}</b></span>
            <span>Recording <b>{d.video.recording ? 'on' : 'off'}</b></span>
            <button className="btn sm ghost" onClick={full}><Icon name="expand" size={15} /> Full screen</button>
          </div>
        </section>
        {/* B: flight path */}
        <section className="panel dt-b">
          <div className="panel-h">
            <h2>Flight path</h2>
            <div className="seg"><button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D</button><button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>2D map</button></div>
            {view === '3d' ? <div className="seg">{(['orbit', 'chase', 'top'] as const).map((c) => <button key={c} className={cam === c ? 'on' : ''} onClick={() => setCam(c)}>{c === 'orbit' ? 'Free' : c === 'chase' ? 'Chase' : 'Top'}</button>)}</div>
              : <div className="seg"><button className={colorBy === 'altitude' ? 'on' : ''} onClick={() => setColorBy('altitude')}>Altitude colours</button><button className={colorBy === 'drone' ? 'on' : ''} onClick={() => setColorBy('drone')}>Plain</button></div>}
            <label className="tgl"><input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} /> Other drones</label>
            {view === '2d' && <button className="btn sm ghost" onClick={() => setFitK(fitAll())}>Fit</button>}
          </div>
          <div className="dt-path">
            {view === '3d'
              ? <FlightView3D drones={drones} focusKey={d.key} cam={cam} showOthers={others} />
              : <FlightMap2D drones={drones} paths={paths} focusKey={d.key} colorBy={colorBy} showOthers={others} follow onSelect={(k) => k !== d.key && go(`drone/${k}`)} className="dt-map" fitKey={`${d.key}:${fitK}`} />}
            <AltLegend />
            {(d.lat == null || d.conn === 'offline') && <div className="path-nodata">{d.lat == null ? 'NO POSITION DATA FROM THIS DRONE' : `NO LIVE POSITION · last known ${d.last_seen_s != null ? ago(d.last_seen_s) : ''}`}</div>}
            {d.simulated && <div className="sim-badge path">SIMULATION</div>}
          </div>
          <div className="path-stats">
            <span>Altitude <b className="num">{d.alt != null ? `${fmt(d.alt, 1)} m` : 'N/A'}</b></span>
            <span>Speed <b className="num">{d.gs != null ? `${fmt(d.gs, 1)} m/s` : 'N/A'}</b></span>
            <span>Travelled <b className="num">{d.flight ? `${fmt(d.flight.distance_m)} m` : 'N/A'}</b> <em className="est">est.</em></span>
            <span>From home <b className="num">{d.range != null ? `${fmt(d.range)} m` : 'N/A'}</b></span>
            <span>Mission <b className="num">{d.mission_items?.length ? `${Math.max(0, d.mission_items.findIndex((i) => d.mission?.seq != null && i.seq >= d.mission.seq) + 1) || d.mission_items.length} / ${d.mission_items.length}` : 'not received'}</b></span>
            <span className="muted small">{p?.pts.length ? `${p.pts.length} track points from telemetry` : 'No track yet: the path starts when the drone arms'}</span>
          </div>
        </section>
        {/* C: flight telemetry */}
        <section className="panel dt-c">
          <div className="panel-h"><h2>Flight telemetry</h2><span className="muted small">N/A = not sent by this drone · <em className="est">est.</em> = calculated by the app · dimmed = stale</span></div>
          <FlightTelemetry d={d} rtt={gcs?.rtt_ms ?? null} />
          <Collapse id="tech" title="All technical values"><TechDetails d={d} rtt={gcs?.rtt_ms ?? null} /></Collapse>
        </section>
        {/* D: alerts & system health */}
        <section className="panel dt-d">
          <div className="panel-h"><h2>Alerts & system health</h2>{d.health?.score != null && <b className={`score s-${d.health.overall}`} title="Health score from the components this drone reports">{d.health.score}</b>}</div>
          <div className="mini-alerts">
            {mine.length ? mine.map((a) => (
              <div key={a.id} className={`ma sev-${a.severity}`}>
                <SevChip s={a.severity} /><b>{a.label}</b><span className="num muted">{timeOf(a.ts)}</span>
                <div className="ma-m">{a.message} <span className="muted">· {a.source}{a.param ? ` · ${a.param}` : ''}</span></div>
                {!a.ack_ts && can(me, 'operator') && <button className="btn sm" onClick={() => ackAlert(a)}>Acknowledge</button>}
                {a.ack_ts && <span className="muted">Acknowledged by {a.ack_by}</span>}
              </div>
            )) : <p className="ok-line">No active errors or warnings.</p>}
          </div>
          <div className="dt-health">
            <div className={`hc hc-${batt?.status ?? 'unavailable'}`}><i /><b>Battery</b><span>{batt?.detail ?? 'N/A'}</span></div>
            <div className={`hc hc-${comm?.status ?? 'unavailable'}`}><i /><b>Communication</b><span>{comm?.detail ?? CONN_LABEL[d.conn]}{gcs ? ` · GCS ${gcs.state}` : ''}</span></div>
          </div>
          <Collapse id="health" title="Component health" extra={d.health ? <span className="muted small">{d.health.available} of {d.health.total} reporting</span> : null}>
            {d.health ? d.health.components.map((c) => <div key={c.name} className={`hc hc-${c.status}`}><i /><b>{c.name}</b><span>{c.detail}</span></div>) : <p className="muted">Collecting…</p>}
            {d.prearm.length > 0 && !d.armed && <><h3 className="sub-h">Pre-arm checks</h3>{d.prearm.map((x, i) => <div key={i} className="ev warn">{x}</div>)}</>}
          </Collapse>
          <Collapse id="att" title="Attitude & motors (3D model)">
            <TavasModel pose={{ roll: d.roll, pitch: d.pitch, yaw: d.yaw, heading: d.heading, gs: d.gs, climb: d.climb, armed: d.armed, airborne: d.airborne, motors: d.motors, motorWarn }} chase={chase} />
            <label className="tgl"><input type="checkbox" checked={chase} onChange={(e) => setChase(e.target.checked)} /> Follow heading</label>
            <div className="hud">
              <span>Motors <b className={d.motors.some((m) => m >= 1900) && d.armed ? 'bad' : ''}>{d.motors.length ? (d.armed ? d.motors.join(' / ') : 'stopped') : 'N/A'}</b></span>
            </div>
            <Ods d={d} />
          </Collapse>
          <Collapse id="charts" title="Charts (last 10 minutes)">
            <div className="charts">
              <div><span className="ch-k">Battery <b className="num">{fmt(d.batt_pct)}%</b></span><LineChart t={series.t} series={[{ values: series.batt, color: '#3ddc84' }]} min={0} max={100} unit="%" /></div>
              <div><span className="ch-k">Altitude <b className="num">{fmt(d.alt, 1)} m</b></span><LineChart t={series.t} series={[{ values: series.alt, color: '#54c8e8' }]} min={0} /></div>
              <div><span className="ch-k">Ground speed <b className="num">{fmt(d.gs, 1)} m/s</b></span><LineChart t={series.t} series={[{ values: series.gs, color: '#3b8cff' }]} min={0} /></div>
              <div><span className="ch-k">Signal <b className="num">{fmt(d.rssi)}% RSSI · {fmt(d.link_pct)}% packets</b></span><LineChart t={series.t} series={[{ values: series.rssi, color: '#f5c242' }, { values: series.link, color: '#c9a6ff' }]} min={0} max={100} unit="%" /></div>
            </div>
          </Collapse>
          <Collapse id="msgs" title="Flight-controller messages" extra={<span className="muted small">{d.msgs.length}</span>}>
            <div className="msgs">
              {[...d.msgs].reverse().map((m, i) => <div key={i} className={`msg s${m.sev}`}><span className="num">{timeOf(m.ts)}</span><span>{m.text}</span></div>)}
              {!d.msgs.length && <p className="muted">No messages yet.</p>}
            </div>
          </Collapse>
          {d.flight && d.flight.events.length > 0 && (
            <Collapse id="events" title="Events this flight" extra={<span className="muted small">{d.flight.events.length}</span>}>
              {d.flight.events.slice(-12).map((e, i) => <div key={i} className="ev"><span className="num">{dur(e.t)}</span><span>{e.text}</span></div>)}
            </Collapse>
          )}
        </section>
      </div>
    </div>
  );
}
