// Small shared pieces: status chip, signal bars, battery, icons.
import type { Drone, Severity } from '../lib/types';
import { tone, TONE_LABEL } from '../lib/format';

export function ToneChip({ d }: { d: Drone }) {
  const t = tone(d);
  return <span className={`chip tone-${t}`}>{TONE_LABEL[t]}</span>;
}

export function SevChip({ s }: { s: Severity }) {
  return <span className={`chip sev-${s}`}>{s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Info'}</span>;
}

export function SignalBars({ v }: { v: number | null }) {
  const n = v == null ? 0 : v >= 80 ? 4 : v >= 60 ? 3 : v >= 35 ? 2 : v > 0 ? 1 : 0;
  return (
    <span className={`sig ${v == null ? 'sig-na' : n <= 1 ? 'sig-bad' : n === 2 ? 'sig-warn' : ''}`} title={v == null ? 'No signal data' : `${v}%`}>
      {[1, 2, 3, 4].map((k) => <i key={k} className={k <= n ? 'on' : ''} style={{ height: 3 + k * 2.5 }} />)}
    </span>
  );
}

export function Battery({ pct }: { pct: number | null }) {
  const cls = pct == null ? 'na' : pct <= 15 ? 'bad' : pct <= 30 ? 'warn' : '';
  return (
    <span className={`batt ${cls}`} title={pct == null ? 'No battery data' : `${pct}%`}>
      <span className="batt-body"><i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} /></span>
    </span>
  );
}

const P: Record<string, string> = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  wall: 'M2 5h20v14H2zM2 12h20M12 5v14M8.5 5v14M15.5 5v14',
  twin: 'M12 2l9 5v10l-9 5-9-5V7zM12 2v20M3 7l9 5 9-5',
  map: 'M9 3L3 5v16l6-2 6 2 6-2V3l-6 2zM9 3v16M15 5v16',
  alerts: 'M12 3a6 6 0 016 6v4l2 3H4l2-3V9a6 6 0 016-6zM10 19a2 2 0 004 0',
  health: 'M3 12h4l2-5 4 10 2-5h6',
  gcs: 'M4 18h16M6 18V9l6-5 6 5v9M9 18v-5h6v5',
  history: 'M12 7v5l3 2M3 12a9 9 0 109-9 9 9 0 00-7 3.3M3 4v3h3',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 14.2H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 7a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 009.8 3V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  planner: 'M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7zM12 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  org: 'M3 21h18M5 21V7l7-4 7 4v14M9 10h1M14 10h1M9 14h1M14 14h1M10 21v-3h4v3',
  monitor: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 12m-7 0a7 7 0 1014 0 7 7 0 10-14 0M12 12m-2 0a2 2 0 104 0 2 2 0 10-4 0',
  replay: 'M12 12m-9 0a9 9 0 1018 0 9 9 0 10-18 0M10 8.5l6 3.5-6 3.5z',
  report: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8M9 9h3',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  back: 'M15 18l-6-6 6-6',
  warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  check: 'M5 12l5 5L20 7',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  rec: 'M12 12m-5 0a5 5 0 1010 0 5 5 0 10-10 0',
};

export function Icon({ name, size = 18, className = '' }: { name: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || ''} />
    </svg>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
