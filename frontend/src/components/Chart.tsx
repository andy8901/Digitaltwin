// Small real-time line chart on a canvas (no chart library: 15 drones x several series must stay light).
import { useEffect, useRef } from 'react';

export interface Series { values: (number | null)[]; color: string; label?: string }

export function LineChart({ t, series, height = 90, min, max, unit = '', windowS = 600 }: {
  t: number[]; series: Series[]; height?: number; min?: number; max?: number; unit?: string; windowS?: number;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current!;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, height);
    const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
    const now = t.length ? t[t.length - 1] : Date.now() / 1000;
    const t0 = now - windowS;
    let lo = min ?? (all.length ? Math.min(...all) : 0);
    let hi = max ?? (all.length ? Math.max(...all) : 1);
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    if (min === undefined || max === undefined) { const pad = (hi - lo) * 0.12; if (min === undefined) lo -= pad; if (max === undefined) hi += pad; }
    const padL = 34, padB = 4, w = r.width - padL - 4, h = height - padB - 6;
    const X = (tt: number) => padL + ((tt - t0) / windowS) * w;
    const Y = (v: number) => 6 + h - ((v - lo) / (hi - lo)) * h;
    g.font = '10px "Barlow Semi Condensed", sans-serif';
    g.fillStyle = '#5c6874';
    g.strokeStyle = 'rgba(138,152,165,0.14)';
    g.lineWidth = 1;
    for (let k = 0; k <= 2; k++) {
      const v = lo + ((hi - lo) * k) / 2;
      const y = Y(v);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + w, y); g.stroke();
      g.fillText(`${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}${unit}`, 2, y + 3);
    }
    for (const s of series) {
      g.beginPath();
      let started = false;
      s.values.forEach((v, i) => {
        if (v == null || t[i] < t0) { started = false; return; }
        const x = X(t[i]), y = Y(v);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      });
      g.strokeStyle = s.color;
      g.lineWidth = 1.8;
      g.stroke();
    }
  });
  return <canvas ref={cv} className="chart" style={{ height }} />;
}

export function Bars({ rows, unit = '', color = '#54c8e8', height = 18 }: { rows: [string, number][]; unit?: string; color?: string; height?: number }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="bars">
      {rows.map(([k, v]) => (
        <div className="bar-row" key={k}>
          <span className="bar-k">{k}</span>
          <span className="bar-track" style={{ height }}><i style={{ width: `${(v / max) * 100}%`, background: color }} /></span>
          <span className="bar-v num">{Number.isInteger(v) ? v : v.toFixed(1)}{unit}</span>
        </div>
      ))}
    </div>
  );
}
