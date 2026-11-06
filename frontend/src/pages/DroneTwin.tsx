import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ackAlert, can, go, useMe } from '../App';
import { Battery, Icon, SevChip, SignalBars, ToneChip } from '../components/Bits';
import { LineChart } from '../components/Chart';
import { droneIcon, homeIcon, MapBox, TONE_COLOR } from '../components/MapView';
import { TavasModel } from '../components/TavasModel';
import { Video, type VideoStats } from '../components/Video';
import { api } from '../lib/api';
import { ago, compass, CONN_LABEL, dur, FIX, flightStatus, fmt, timeOf, tone } from '../lib/format';
import { useDetail, useLive } from '../lib/live';
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

function Telemetry({ d, rtt }: { d: DroneDetail; rtt: number | null }) {
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

function TwinMap({ d }: { d: DroneDetail }) {
  const drones = useLive((s) => s.drones);
  const refs = useRef<{ map?: L.Map; me?: L.Marker; home?: L.Marker; tko?: L.Marker; trail?: L.Polyline; fence?: L.Circle; others: Record<string, L.Marker>; fid?: number | null; fitted?: boolean }>({ others: {} });
  const onMap = (m: L.Map) => { refs.current.map = m; };
  useEffect(() => {
    const r = refs.current;
    const m = r.map;
    if (!m || d.lat == null || d.lon == null) return;
    const ll: L.LatLngExpression = [d.lat, d.lon];
    if (!r.me) r.me = L.marker(ll, { icon: droneIcon(d, { selected: true }), zIndexOffset: 1000 }).addTo(m);
    else { r.me.setLatLng(ll); r.me.setIcon(droneIcon(d, { selected: true })); }
    if (!r.trail) r.trail = L.polyline([], { color: '#54c8e8', weight: 3 }).addTo(m);
    if (r.fid !== d.flight_id) {
      r.fid = d.flight_id;
      api<{ points: number[][] }>(`/api/drones/${d.key}/trail`).then((t) => r.trail?.setLatLngs(t.points.map((p) => [p[1], p[2]] as [number, number])));
    } else if (d.airborne) {
      const pts = r.trail.getLatLngs() as L.LatLng[];
      const last = pts[pts.length - 1];
      if (!last || m.distance(last, ll) > 2) r.trail.addLatLng(ll);
    }
    if (d.home) { if (!r.home) r.home = L.marker(d.home, { icon: homeIcon('H') }).bindTooltip('Home').addTo(m); else r.home.setLatLng(d.home); }
    if (d.takeoff) { if (!r.tko) r.tko = L.marker(d.takeoff, { icon: homeIcon('T') }).bindTooltip('Take-off').addTo(m); else r.tko.setLatLng(d.takeoff); }
    const gf = d.geofence;
    if (gf && gf.type === 'circle' && gf.radius_m && d.home) {
      if (!r.fence) r.fence = L.circle(d.home, { radius: gf.radius_m, color: '#f5c242', weight: 1.5, dashArray: '6 6', fill: false }).bindTooltip(`Geofence ${gf.radius_m} m${gf.max_alt_m ? `, ceiling ${gf.max_alt_m} m` : ''}`).addTo(m);
      else r.fence.setLatLng(d.home).setRadius(gf.radius_m);
    }
    if (!r.fitted) { m.setView(ll, 16); r.fitted = true; } else if (!m.getBounds().pad(-0.2).contains(ll)) m.panTo(ll);
  }, [d]);
  useEffect(() => {
    const r = refs.current;
    if (!r.map) return;
    for (const o of drones) {
      if (o.key === d.key || o.lat == null || o.lon == null || o.conn === 'offline') { r.others[o.key]?.remove(); delete r.others[o.key]; continue; }
      if (!r.others[o.key]) r.others[o.key] = L.marker([o.lat, o.lon], { icon: droneIcon(o, { small: true }), opacity: 0.8 }).on('click', () => go(`drone/${o.key}`)).addTo(r.map);
      else { r.others[o.key].setLatLng([o.lat, o.lon]); r.others[o.key].setIcon(droneIcon(o, { small: true })); }
    }
  }, [drones, d.key]);
  return <MapBox className="twin-map" onMap={onMap} />;
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

export function DroneTwin({ droneKey }: { droneKey?: string }) {
  const drones = useLive((s) => s.drones);
  const key = droneKey && drones.some((x) => x.key === droneKey) ? droneKey : drones[0]?.key || null;
  const d = useDetail(key);
  const t = useLive((s) => s.t);
  const hist = useLive((s) => (key ? s.history[key] : undefined));
  const gcs = useLive((s) => s.gcs.find((g) => g.key === key));
  const alerts = useLive((s) => s.alerts);
  const me = useMe();
  const [vs, setVs] = useState<VideoStats | null>(null);
  const [chase, setChase] = useState(false);
  const [past, setPast] = useState<{ ts: number; alt: number | null; batt_pct: number | null; volt: number | null; gs: number | null; link: number | null }[]>([]);
  const vbox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPast([]);
    if (key) api<typeof past>(`/api/drones/${key}/telemetry?minutes=10`).then(setPast).catch(() => undefined);
  }, [key]);
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
  const mine = alerts.filter((a) => a.drone_key === d.key);
  const live = d.conn !== 'offline';
  const motorWarn = d.esc.length ? d.motors.map((_, i) => { const e = d.esc.find((x) => x.i === i); return !!e && (e.temp >= 60 || (d.airborne && e.rpm === 0)); }) : undefined;
  const full = () => { const el = vbox.current?.querySelector('.video') as HTMLElement | null; el?.requestFullscreen?.().catch(() => undefined); };
  return (
    <div className="twin-page">
      <div className="page-bar twin-bar">
        <select value={d.key} onChange={(e) => go(`drone/${e.target.value}`)} aria-label="Drone">
          {drones.map((x) => <option key={x.key} value={x.key}>{x.drone_id} · {x.gcs_id}</option>)}
        </select>
        <h1>{d.drone_id}</h1>
        <span className="muted">{d.gcs_id} · {d.model}{d.msn && d.msn !== d.drone_id ? ` · MSN ${d.msn}` : ''}</span>
        <ToneChip d={d} />
        <span className="bar-stat">{flightStatus(d)}</span>
        <span className="bar-stat"><span className="muted">Mode</span> <b>{d.mode || '—'}</b></span>
        <span className="bar-stat"><span className="muted">Flight</span> <b className="num">{d.flight ? dur(d.flight.time_s) : '—'}</b></span>
        <span className="bar-stat"><Battery pct={d.batt_pct} /> <b className="num">{fmt(d.batt_pct)}%</b></span>
        <span className="bar-stat"><SignalBars v={live ? d.rssi ?? d.link_pct : null} /> <span className={`conn conn-${d.conn}`}>{CONN_LABEL[d.conn]}</span></span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => go(`wall/${d.key}`)}><Icon name="wall" /> Video wall</button>
        <button className="btn ghost" onClick={() => go(`history/${d.key}`)}><Icon name="history" /> Flight history</button>
      </div>
      <div className="twin-grid">
        <section className="panel p-video" ref={vbox}>
          <Video path={d.video.path} enabled={live && d.video.ready} pauseWhenHidden={false} onStats={setVs}
            offMessage={!live ? 'Drone offline' : !d.video.configured ? 'No video source configured' : 'No video stream'} className="main-video">
            <div className="vo vo-tl"><b>{d.drone_id}</b> <span className="muted">{d.gcs_id}</span></div>
            <div className="vo vo-tr num">{timeOf(t)}{d.video.recording && <span className="rec">REC</span>}</div>
            <div className="vo vo-bl num">{fmt(d.alt, 0)} m · {fmt(d.gs, 1)} m/s · {d.heading != null ? `${fmt(d.heading)}° ${compass(d.heading)}` : '—'}</div>
          </Video>
          <div className="video-meta">
            <span>Video <b className={vs?.state === 'playing' ? 'ok' : 'bad'}>{vs?.state === 'playing' ? 'connected' : vs?.state === 'off' ? 'off' : vs?.message || 'connecting'}</b></span>
            <span>Latency <b className="num">{vs?.latencyMs != null ? `~${vs.latencyMs} ms` : 'n/a'}</b></span>
            <span>Stream <b className="num">{vs?.height ? `${vs.width}×${vs.height}` : 'n/a'}{vs?.fps ? ` · ${vs.fps} fps` : ''}{vs?.kbps ? ` · ${vs.kbps} kbit/s` : ''}</b></span>
            <span>Recording <b>{d.video.recording ? 'on' : 'off'}</b></span>
            <span>Telemetry <b className="num">{timeOf(t)}</b></span>
            <button className="btn sm ghost" onClick={full}><Icon name="expand" size={15} /> Full screen</button>
          </div>
        </section>
        <section className="panel p-3d">
          <div className="panel-h"><h2>3D digital twin</h2><span className="muted">drag to rotate · scroll to zoom</span>
            <span className="spacer" /><label className="tgl"><input type="checkbox" checked={chase} onChange={(e) => setChase(e.target.checked)} /> Follow heading</label></div>
          <TavasModel pose={{ roll: d.roll, pitch: d.pitch, yaw: d.yaw, heading: d.heading, gs: d.gs, climb: d.climb, armed: d.armed, airborne: d.airborne, motors: d.motors, motorWarn }} chase={chase} />
          <div className="hud">
            <span>Pitch <b className="num">{fmt(d.pitch, 1)}°</b></span>
            <span>Roll <b className="num">{fmt(d.roll, 1)}°</b></span>
            <span>Yaw <b className="num">{fmt(d.yaw, 0)}°</b></span>
            <span>Heading <b className="num">{fmt(d.heading)}° {compass(d.heading)}</b></span>
            <span>Altitude <b className="num">{fmt(d.alt, 1)} m</b></span>
            <span>Moving <b className="num">{d.gs != null && d.gs > 0.3 ? `${fmt(d.gs, 1)} m/s` : 'hovering'}{d.climb != null && Math.abs(d.climb) > 0.3 ? `, ${d.climb > 0 ? 'climbing' : 'descending'} ${fmt(Math.abs(d.climb), 1)}` : ''}</b></span>
            <span>Status <b>{flightStatus(d)}</b></span>
            <span>Motors <b className={d.motors.some((m) => m >= 1900) && d.armed ? 'bad' : ''}>{d.motors.length ? (d.armed ? d.motors.join(' / ') : 'stopped') : 'n/a'}</b></span>
          </div>
          <Ods d={d} />
        </section>
        <section className="panel p-tele"><div className="panel-h"><h2>Telemetry</h2><span className="muted">n/a: not sent by this drone</span></div><Telemetry d={d} rtt={gcs?.rtt_ms ?? null} /></section>
        <section className="panel p-map"><div className="panel-h"><h2>Map</h2><span className="muted">current · home H · take-off T · trajectory · geofence · other drones</span></div><TwinMap d={d} /></section>
        <section className="panel p-charts">
          <div className="panel-h"><h2>Last 10 minutes</h2></div>
          <div className="charts">
            <div><span className="ch-k">Battery <b className="num">{fmt(d.batt_pct)}%</b></span><LineChart t={series.t} series={[{ values: series.batt, color: '#3ddc84' }]} min={0} max={100} unit="%" /></div>
            <div><span className="ch-k">Voltage <b className="num">{fmt(d.volt, 2)} V</b></span><LineChart t={series.t} series={[{ values: series.volt, color: '#7be0b0' }]} /></div>
            <div><span className="ch-k">Altitude <b className="num">{fmt(d.alt, 1)} m</b></span><LineChart t={series.t} series={[{ values: series.alt, color: '#54c8e8' }]} min={0} /></div>
            <div><span className="ch-k">Ground speed <b className="num">{fmt(d.gs, 1)} m/s</b></span><LineChart t={series.t} series={[{ values: series.gs, color: '#3b8cff' }]} min={0} /></div>
            <div><span className="ch-k">Signal <b className="num">{fmt(d.rssi)}% RSSI · {fmt(d.link_pct)}% packets</b></span><LineChart t={series.t} series={[{ values: series.rssi, color: '#f5c242' }, { values: series.link, color: '#c9a6ff' }]} min={0} max={100} unit="%" /></div>
          </div>
        </section>
        <section className="panel p-alerts">
          <div className="panel-h"><h2>Alerts</h2><span className="muted">{mine.length} open</span></div>
          <div className="mini-alerts">
            {mine.length ? mine.map((a) => (
              <div key={a.id} className={`ma sev-${a.severity}`}>
                <SevChip s={a.severity} /><b>{a.label}</b><span className="num muted">{timeOf(a.ts)}</span>
                <div className="ma-m">{a.message} <span className="muted">· {a.source}</span></div>
                {!a.ack_ts && can(me, 'operator') && <button className="btn sm" onClick={() => ackAlert(a)}>Acknowledge</button>}
                {a.ack_ts && <span className="muted">Acknowledged by {a.ack_by}</span>}
              </div>
            )) : <p className="muted">No open alerts for this drone.</p>}
          </div>
          <h3 className="sub-h">Flight controller messages</h3>
          <div className="msgs">
            {[...d.msgs].reverse().map((m, i) => <div key={i} className={`msg s${m.sev}`}><span className="num">{timeOf(m.ts)}</span><span>{m.text}</span></div>)}
            {!d.msgs.length && <p className="muted">No messages yet.</p>}
          </div>
        </section>
        <section className="panel p-health">
          <div className="panel-h"><h2>Health</h2>{d.health?.score != null && <b className={`score s-${d.health.overall}`}>{d.health.score}</b>}</div>
          {d.health ? d.health.components.map((c) => (
            <div key={c.name} className={`hc hc-${c.status}`}><i /><b>{c.name}</b><span>{c.detail}</span></div>
          )) : <p className="muted">Collecting…</p>}
          {d.flight && d.flight.events.length > 0 && <>
            <h3 className="sub-h">This flight</h3>
            {d.flight.events.slice(-8).map((e, i) => <div key={i} className="ev"><span className="num">{dur(e.t)}</span><span>{e.text}</span></div>)}
          </>}
          {d.prearm.length > 0 && !d.armed && <><h3 className="sub-h">Pre-arm checks</h3>{d.prearm.map((p, i) => <div key={i} className="ev warn">{p}</div>)}</>}
        </section>
      </div>
      <p className="tone-key muted"><i style={{ background: TONE_COLOR[tone(d)] }} /> Status colours: green normal, blue airborne, yellow warning, red critical, grey offline.</p>
    </div>
  );
}
