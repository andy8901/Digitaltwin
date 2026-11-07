// Right-hand flight panel shared by the live monitor and the flight replay: position, artificial horizon,
// flight parameters, vibration and motor outputs. Every value is what was received or recorded; missing data shows N/A.
import { useState } from 'react';
import { compass, dur, FIX, fmt } from '../lib/format';

export interface PanelState {
  lat: number | null; lon: number | null; alt: number | null; alt_msl: number | null; fix: number | null; sats: number | null;
  hdop: number | null; h_acc: number | null; heading: number | null; roll: number | null; pitch: number | null; gs: number | null;
  vz: number | null; dist_home: number | null; volt: number | null; cells: number | null; batt_pct: number | null; curr: number | null;
  flight_s: number | null; vibe: [number | null, number | null, number | null] | null; clip: number | null;
  motors: (number | null)[] | null; motorChannels?: number[]; posSource: string; stale?: boolean;
}

const dms = (v: number, pos: string, neg: string) => {
  const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(2).padStart(5, '0')}"${v >= 0 ? pos : neg}`;
};

/** Circular artificial horizon: the horizon rolls with roll and moves with pitch; heading on the rim. */
export function Attitude({ roll, pitch, heading, size = 180 }: { roll: number | null; pitch: number | null; heading: number | null; size?: number }) {
  const r = roll ?? 0, p = Math.max(-60, Math.min(60, pitch ?? 0));
  const k = 2.2;    // px per degree of pitch (in a 200 px instrument)
  const na = roll == null || pitch == null;
  return (
    <div className="attitude">
      <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={`Roll ${fmt(roll)} degrees, pitch ${fmt(pitch)} degrees`}>
        <defs><clipPath id="adi"><circle cx="100" cy="100" r="88" /></clipPath></defs>
        <g clipPath="url(#adi)" opacity={na ? 0.35 : 1}>
          <g transform={`rotate(${-r} 100 100) translate(0 ${p * k})`}>
            <rect x="-200" y="-400" width="600" height="500" fill="#3f86d6" />
            <rect x="-200" y="100" width="600" height="500" fill="#8a5a2c" />
            <line x1="-200" y1="100" x2="400" y2="100" stroke="#fff" strokeWidth="2" />
            {[-30, -20, -10, 10, 20, 30].map((d) => (
              <g key={d}>
                <line x1={100 - (d % 20 === 0 ? 30 : 18)} y1={100 - d * k} x2={100 + (d % 20 === 0 ? 30 : 18)} y2={100 - d * k} stroke="#fff" strokeWidth="1.5" />
                {d % 20 === 0 && <text x={100 + 36} y={100 - d * k + 4} fill="#fff" fontSize="10">{Math.abs(d)}</text>}
              </g>
            ))}
          </g>
        </g>
        {/* roll scale */}
        {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((a) => {
          const rad = ((a - 90) * Math.PI) / 180, r1 = 88, r2 = a % 30 === 0 ? 76 : 81;
          return <line key={a} x1={100 + r1 * Math.cos(rad)} y1={100 + r1 * Math.sin(rad)} x2={100 + r2 * Math.cos(rad)} y2={100 + r2 * Math.sin(rad)} stroke="#e6edf2" strokeWidth={a === 0 ? 3 : 1.5} />;
        })}
        <g transform={`rotate(${-r} 100 100)`}><path d="M100 14 l-6 10 h12 z" fill="#f5c242" /></g>
        <circle cx="100" cy="100" r="88" fill="none" stroke="#273340" strokeWidth="3" />
        {/* fixed aircraft symbol */}
        <path d="M52 100 h30 l8 8 M148 100 h-30 l-8 8" stroke="#f5c242" strokeWidth="4" fill="none" strokeLinecap="round" />
        <circle cx="100" cy="100" r="3.5" fill="#f5c242" />
        {na && <text x="100" y="104" textAnchor="middle" fill="#e6edf2" fontSize="14" fontWeight="700">NO ATTITUDE DATA</text>}
      </svg>
      <div className="att-read">
        <span>Roll <b className="num">{roll != null ? `${roll.toFixed(0)}°` : 'N/A'}</b></span>
        <span>Pitch <b className="num">{pitch != null ? `${pitch.toFixed(0)}°` : 'N/A'}</b></span>
        <span>Heading <b className="num">{heading != null ? `${heading.toFixed(0)}° ${compass(heading)}` : 'N/A'}</b></span>
      </div>
    </div>
  );
}

function Bar({ label, v, warn = 30, bad = 60, max = 90 }: { label: string; v: number | null; warn?: number; bad?: number; max?: number }) {
  const cls = v == null ? 'na' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok';
  return (
    <div className={`vbar ${cls}`}>
      <span>{label}</span>
      <i><em style={{ width: `${v == null ? 0 : Math.min(100, (v / max) * 100)}%` }} /><s style={{ left: `${(warn / max) * 100}%` }} /><s className="b" style={{ left: `${(bad / max) * 100}%` }} /></i>
      <b className="num">{v == null ? 'N/A' : v.toFixed(0)}</b>
    </div>
  );
}

function Cell({ k, v, unit, sub }: { k: string; v: string | null; unit?: string; sub?: React.ReactNode }) {
  return (
    <div className={`fp-cell ${v == null ? 'na' : ''}`}>
      <span>{k}</span>
      <b className="num">{v ?? 'N/A'}{v != null && unit ? <small>{unit}</small> : null}</b>
      {sub && <em>{sub}</em>}
    </div>
  );
}

export function FlightPanel({ s, motorNote }: { s: PanelState; motorNote?: string }) {
  const [copied, setCopied] = useState(false);
  const has = s.lat != null && s.lon != null;
  const copy = () => {
    if (!has) return;
    const t = `${s.lat!.toFixed(7)}, ${s.lon!.toFixed(7)}`;
    navigator.clipboard?.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };
  const motors = s.motors && s.motors.some((m) => m != null && m > 0) ? s.motors : null;
  return (
    <div className={`fpanel ${s.stale ? 'stale' : ''}`}>
      <section className="fp-sec">
        <h3>Position · {s.posSource}</h3>
        <div className="fp-pos">
          <div><span>LAT</span><b className="num">{has ? `${s.lat!.toFixed(7)}° ${s.lat! >= 0 ? 'N' : 'S'}` : 'N/A'}</b></div>
          <div><span>LON</span><b className="num">{has ? `${s.lon!.toFixed(7)}° ${s.lon! >= 0 ? 'E' : 'W'}` : 'N/A'}</b></div>
          {has && <div className="muted small num">{dms(s.lat!, 'N', 'S')} {dms(s.lon!, 'E', 'W')}</div>}
          <div className="small">Above sea level <b className="num">{s.alt_msl != null ? `${fmt(s.alt_msl, 1)} m` : 'N/A'}</b> · above home <b className="num">{s.alt != null ? `${fmt(s.alt, 1)} m` : 'N/A'}</b></div>
          <div className="small">GPS <b className="num">{s.sats != null ? `${s.sats} sats` : 'sats N/A'}</b> · <b className="num">{s.hdop != null ? `HDOP ${fmt(s.hdop, 2)}` : 'HDOP N/A'}</b> · <b>{s.fix != null ? (FIX[s.fix] ?? `fix ${s.fix}`) : 'fix N/A'}</b>
            {s.h_acc != null && <> · accuracy <b className="num">±{fmt(s.h_acc, 1)} m</b></>}</div>
        </div>
        <div className="row">
          <button className="btn sm" disabled={!has} onClick={copy}>{copied ? 'Copied' : 'Copy coordinates'}</button>
          <a className={`btn sm ${has ? '' : 'disabled'}`} href={has ? `https://www.google.com/maps?q=${s.lat},${s.lon}` : undefined} target="_blank" rel="noopener">Open in Google Maps</a>
        </div>
      </section>
      <section className="fp-sec"><h3>Attitude</h3><Attitude roll={s.roll} pitch={s.pitch} heading={s.heading} /></section>
      <section className="fp-grid">
        <Cell k="Height" v={s.alt != null ? fmt(s.alt, 1) : null} unit="m" sub={s.vz != null ? `${s.vz >= 0 ? '↑' : '↓'} ${Math.abs(s.vz).toFixed(1)} m/s` : undefined} />
        <Cell k="Ground speed" v={s.gs != null ? fmt(s.gs, 1) : null} unit="m/s" sub={s.dist_home != null ? `${fmt(s.dist_home)} m from home` : 'distance from home N/A'} />
        <Cell k="Battery" v={s.volt != null ? fmt(s.volt, 2) : null} unit="V"
          sub={<>{s.volt != null && s.cells ? `${(s.volt / s.cells).toFixed(2)} V/cell (${s.cells}S)` : ''}{s.batt_pct != null ? ` · ${s.batt_pct}%` : ' · % N/A'}</>} />
        <Cell k="Current" v={s.curr != null ? fmt(s.curr, 1) : null} unit="A" sub={s.flight_s != null ? `flight ${dur(s.flight_s)}` : undefined} />
      </section>
      <section className="fp-sec">
        <h3>Vibration (m/s²) · <span className="warn">warn 30</span> · <span className="bad">bad 60</span>{s.clip ? <span className="muted"> · clipping {s.clip}</span> : null}</h3>
        <Bar label="X" v={s.vibe?.[0] ?? null} /><Bar label="Y" v={s.vibe?.[1] ?? null} /><Bar label="Z" v={s.vibe?.[2] ?? null} />
      </section>
      <section className="fp-sec">
        <h3>Motor outputs (% of range)</h3>
        {motors ? (
          <div className="motors">
            {motors.map((m, i) => {
              const pct = m == null ? null : Math.max(0, Math.min(100, ((m - 1000) / 1000) * 100));
              return <div key={i} className={`mot ${pct != null && pct >= 95 ? 'bad' : ''}`}><i><em style={{ height: `${pct ?? 0}%` }} /></i><span>M{s.motorChannels?.[i] ?? i + 1}</span><b className="num">{pct == null ? 'N/A' : `${pct.toFixed(0)}%`}</b></div>;
            })}
          </div>
        ) : <p className="muted small">{motorNote || 'Not reported by this drone.'}</p>}
      </section>
    </div>
  );
}
