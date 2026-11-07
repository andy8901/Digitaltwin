// Flight replay: the recorded flight rebuilt from its log, sample by sample. Moving the timeline puts the drone at the
// position recorded at that moment and every value in the panel is the value recorded then (held from the last sample,
// never interpolated).
import { useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../App';
import { AltLegend } from '../components/FlightMap2D';
import { FlightPanel, type PanelState } from '../components/Instruments';
import { LayerPanel, SatMap, type TrackPt } from '../components/SatMap';
import { api } from '../lib/api';
import { dateOf, dur, fmt, timeOf } from '../lib/format';
import { ViewControls, useMapPrefs } from './Monitor';

export interface Timeline {
  kind: string; t0: number; dt: number; n: number; duration_s: number;
  cols: Record<string, (number | string | boolean | null)[]>; motors: (number | null)[][]; motor_channels: number[];
  msgs: { ts: number; sev: number; text: string }[]; events: { ts: number; type: string; text: string }[];
  modes: { ts: number; mode: string }[]; home: [number, number, number] | null; position_source: string; position_rate_hz: number | null;
}
export interface Analysis {
  id: number; drone_key: string; drone_id: string; gcs_id: string | null; model: string | null; start_ts: number; end_ts: number | null; source: string;
  log_name: string | null; analysis_status: string | null; analysis_error: string | null; cells: number | null; conclusion: string | null;
  department: string; customer: string; location: string; uploaded_by: string | null; received_ts: number | null; reviewed_by: string | null; note: string | null;
  same_log?: number[]; queue_position: number | null;
  report: null | {
    level: 'critical' | 'warning' | 'normal'; headline: string; termination: string; termination_text: string; start_ts: number; end_ts: number;
    log_duration_s: number; armed_s: number; flight_time_s: number; max_alt_m: number | null; max_speed_ms: number | null; distance_m: number; max_range_m: number | null;
    volt_takeoff: number | null; volt_landing: number | null; volt_min: number | null; max_current_a: number | null; batt_start_pct: number | null; batt_end_pct: number | null;
    takeoff: [number, number] | null; landing: [number, number] | null; last_position: [number, number] | null; home: [number, number, number] | null;
    modes: string[]; counts: { critical: number; warning: number }; fc_messages: number; fc_errors: number; position_source: string;
    position_rate_hz: number | null; samples: number; sample_hz: number; kind: string;
    findings: { level: string; kind: string; title: string; detail: string; t: number | null; ts: number | null; lat: number | null; lon: number | null; alt: number | null }[];
  };
}

const hav = (a: number, b: number, c: number, d: number) => {
  const p = Math.PI / 180, x = Math.sin(((c - a) * p) / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(((d - b) * p) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
};
const num = (v: unknown) => (typeof v === 'number' ? v : null);

export function sampleAt(tl: Timeline, i: number, cells: number | null, home: [number, number] | null, armIdx: number | null): PanelState {
  const c = tl.cols;
  const lat = num(c.lat[i]), lon = num(c.lon[i]);
  return {
    lat, lon, alt: num(c.alt[i]), alt_msl: num(c.alt_msl[i]), fix: num(c.fix[i]), sats: num(c.sats[i]), hdop: num(c.hdop[i]), h_acc: num(c.h_acc[i]),
    heading: num(c.heading[i]), roll: num(c.roll[i]), pitch: num(c.pitch[i]), gs: num(c.gs[i]), vz: num(c.vz[i]),
    dist_home: home && lat != null && lon != null ? hav(home[0], home[1], lat, lon) : null,
    volt: num(c.volt[i]), cells, batt_pct: num(c.batt_pct[i]), curr: num(c.curr[i]),
    flight_s: armIdx != null && i >= armIdx ? (Number(c.ts[i]) - Number(c.ts[armIdx])) : null,
    vibe: [num(c.vibe_x[i]), num(c.vibe_y[i]), num(c.vibe_z[i])], clip: num(c.clip[i]),
    motors: tl.motors.length ? tl.motors.map((m) => m[i]) : null, motorChannels: tl.motor_channels, posSource: tl.position_source,
  };
}

export function Replay({ fid, at }: { fid: number; at?: number }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [tl, setTl] = useState<Timeline | null>(null);
  const [err, setErr] = useState('');
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const prefs = useMapPrefs('cc.replay');
  const clock = useRef({ t: 0, last: 0 });
  useEffect(() => {
    setTl(null); setErr('');
    api<Analysis>(`/api/flights/${fid}/analysis`).then(setA).catch((e) => setErr(e.message));
    api<Timeline>(`/api/flights/${fid}/timeline`).then((t) => {
      setTl(t);
      // start just before take-off when the log has a long ground segment
      const armed = t.cols.armed.findIndex((x) => x === true);
      const firstPos = Math.max(0, t.cols.lat.findIndex((x) => x != null));
      const s = at != null && !Number.isNaN(at) ? Math.min(t.n - 1, Math.round(at / t.dt)) : Math.max(firstPos, armed > 50 ? armed - 50 : 0);
      setI(s); clock.current.t = s * t.dt;
    }).catch((e) => setErr(e.message));
  }, [fid]);
  // playback clock: advances in real time × speed; the view refreshes at ~20 fps
  useEffect(() => {
    if (!playing || !tl) return;
    clock.current.last = performance.now();
    const h = setInterval(() => {
      const now = performance.now();
      clock.current.t += ((now - clock.current.last) / 1000) * speed;
      clock.current.last = now;
      const k = Math.min(tl.n - 1, Math.floor(clock.current.t / tl.dt));
      setI(k);
      if (k >= tl.n - 1) setPlaying(false);
    }, 50);
    return () => clearInterval(h);
  }, [playing, speed, tl]);
  const seek = (k: number) => { if (!tl) return; const v = Math.max(0, Math.min(tl.n - 1, k)); setI(v); clock.current.t = v * tl.dt; };
  // full track, thinned for the map (keeps ≤ 6000 vertices)
  const full = useMemo(() => {
    if (!tl) return { pts: [] as TrackPt[], idx: [] as number[] };
    const k = Math.max(1, Math.ceil(tl.n / 6000));
    const pts: TrackPt[] = [], idx: number[] = [];
    for (let j = 0; j < tl.n; j += k) {
      const la = num(tl.cols.lat[j]), lo = num(tl.cols.lon[j]);
      if (la != null && lo != null) { pts.push([lo, la, num(tl.cols.alt[j])]); idx.push(j); }
    }
    return { pts, idx };
  }, [tl]);
  const armIdx = useMemo(() => (tl ? (() => { const k = tl.cols.armed.findIndex((x) => x === true); return k >= 0 ? k : null; })() : null), [tl]);
  if (err) return <div className="empty">{err === 'this flight hasn\'t been analysed yet' ? 'This flight is still being analysed. Try again in a moment.' : err}</div>;
  if (!tl || !a) return <div className="empty">Loading the recorded flight…</div>;
  const rep = a.report;
  const home: [number, number] | null = rep?.home ? [rep.home[0], rep.home[1]] : rep?.takeoff ?? null;
  const s = sampleAt(tl, i, a.cells, home, armIdx);
  const ts = Number(tl.cols.ts[i]);
  const cut = full.idx.findIndex((x) => x > i);
  const done = cut < 0 ? full.pts : full.pts.slice(0, cut);
  const mode = (tl.cols.mode[i] as string) || null;
  const armed = tl.cols.armed[i];
  const marks = (rep?.findings ?? []).filter((f) => f.ts != null);
  return (
    <div className="mon-page replay">
      <div className="mon-head">
        <button className="btn back" onClick={() => go(`flight/${fid}`)}>← Report</button>
        <div>
          <div className="mon-kicker">FLIGHT REPLAY · {a.model || 'TAVAS'} · {a.drone_id} · {dateOf(tl.t0)}</div>
          <h1 className="mon-title">{a.log_name || `Flight ${fid}`}</h1>
        </div>
        <span className="spacer" />
        <span className="prec">Recorded track · {tl.position_source}{tl.position_rate_hz ? ` · ${tl.position_rate_hz} Hz` : ''} · {tl.n.toLocaleString()} samples</span>
        {rep && <span className={`chip ${rep.level === 'critical' ? 'sev-critical' : rep.level === 'warning' ? 'sev-warning' : 'tone-normal'}`}>{rep.level}</span>}
      </div>
      <div className="mon-body">
        <SatMap pose={{ lat: s.lat, lon: s.lon, alt: s.alt, heading: s.heading, roll: s.roll, pitch: s.pitch, yaw: num(tl.cols.yaw[i]) }}
          track={done} ghost={full.pts} home={home} takeoff={rep?.takeoff} landing={rep?.landing ?? rep?.last_position}
          view={prefs.view} layers={prefs.layers} cam={prefs.cam} focusKey={`replay-${fid}`}>
          <div className="sm-chips">
            <span className="sm-chip num">T+{dur(Number(tl.cols.ts[i]) - tl.t0)}</span>
            <span className="sm-chip">{mode || 'mode N/A'}</span>
            <span className={`sm-chip ${armed ? 'armed' : ''}`}>{armed === true ? 'ARMED' : armed === false ? 'DISARMED' : 'ARM STATE N/A'}</span>
            {s.lat != null && <span className="sm-chip num">{s.lat.toFixed(6)}, {s.lon!.toFixed(6)}</span>}
          </div>
          <LayerPanel layers={prefs.layers} onChange={prefs.setLayers} view={prefs.view} />
          <ViewControls view={prefs.view} setView={prefs.setView} cam={prefs.cam} setCam={prefs.setCam} />
          <AltLegend />
        </SatMap>
        <FlightPanel s={s} motorNote="Motor outputs are not in this log." />
      </div>
      <div className="rp-bar">
        <div className="rp-btns">
          <button className="btn sm" onClick={() => { setPlaying(false); seek(0); }} title="Jump to beginning">⏮</button>
          <button className="btn sm primary rp-play" onClick={() => { if (i >= tl.n - 1) seek(0); setPlaying(!playing); }} title={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
          <button className="btn sm" onClick={() => { setPlaying(false); seek(Math.max(Math.max(0, tl.cols.lat.findIndex((x) => x != null)), armIdx != null && armIdx > 50 ? armIdx - 50 : 0)); }} title="Stop">■</button>
          <button className="btn sm" onClick={() => { setPlaying(false); seek(tl.n - 1); }} title="Jump to end">⏭</button>
          <div className="seg">{[1, 2, 4, 8].map((x) => <button key={x} className={speed === x ? 'on' : ''} onClick={() => setSpeed(x)}>{x}×</button>)}</div>
          <label className="tgl"><input type="checkbox" checked={prefs.cam === 'follow' || prefs.cam === 'chase'} onChange={(e) => prefs.setCam(e.target.checked ? 'follow' : 'free')} /> Follow drone</label>
        </div>
        <div className="rp-time num"><b>{timeOf(ts)}</b> <span className="muted">T+{dur(ts - tl.t0)} / {dur(tl.duration_s)}</span></div>
        <div className="rp-track">
          <input type="range" min={0} max={tl.n - 1} value={i} onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }} aria-label="Replay timeline" />
          {marks.map((f, k) => (
            <button key={k} className={`rp-mark ${f.level}`} style={{ left: `${((f.ts! - tl.t0) / Math.max(1, tl.duration_s)) * 100}%` }}
              title={`T+${dur(f.ts! - tl.t0)} · ${f.title}: ${f.detail}`} onClick={() => { setPlaying(false); seek(Math.round((f.ts! - tl.t0) / tl.dt) - 20); }} />
          ))}
        </div>
        <div className="rp-read num">
          <span>Altitude <b>{s.alt != null ? `${fmt(s.alt, 1)} m` : 'N/A'}</b></span>
          <span>Speed <b>{s.gs != null ? `${fmt(s.gs, 1)} m/s` : 'N/A'}</b></span>
          <span>Battery <b>{s.batt_pct != null ? `${s.batt_pct}%` : 'N/A'}</b> <b>{s.volt != null ? `${fmt(s.volt, 2)} V` : ''}</b></span>
          <span>Heading <b>{s.heading != null ? `${fmt(s.heading)}°` : 'N/A'}</b></span>
          <span>Pitch / roll <b>{s.pitch != null ? `${fmt(s.pitch)}° / ${fmt(s.roll)}°` : 'N/A'}</b></span>
          <span>Mode <b>{mode || 'N/A'}</b></span>
        </div>
      </div>
      {marks.length > 0 && (
        <div className="rp-events">
          {marks.map((f, k) => (
            <button key={k} className={`rp-ev ${f.level}`} onClick={() => { setPlaying(false); seek(Math.round((f.ts! - tl.t0) / tl.dt) - 20); }}>
              <span className="num">T+{dur(f.ts! - tl.t0)}</span><b>{f.title}</b><span className="muted">{f.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
