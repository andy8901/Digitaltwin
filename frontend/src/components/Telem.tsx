// Telemetry values shown honestly: units always, N/A when the drone hasn't sent it, "stale" when it stopped arriving,
// "est." when the app derived the value instead of receiving it.
import type { Drone } from '../lib/types';

export type Grp = keyof Drone['ages'];
export const STALE_S = 3;

export function freshness(d: Pick<Drone, 'ages' | 'conn'>, grp?: Grp): 'live' | 'stale' | 'none' {
  if (!grp) return 'live';
  const a = d.ages?.[grp];
  if (a == null) return 'none';
  return a > STALE_S ? 'stale' : 'live';
}

export function TVal({ d, label, value, unit, grp, est, warn, title, wide }: {
  d: Pick<Drone, 'ages' | 'conn'>; label: string; value: React.ReactNode | null | undefined; unit?: string; grp?: Grp; est?: string | false;
  warn?: 'w' | 'c' | '' | false | null; title?: string; wide?: boolean;
}) {
  const f = freshness(d, grp);
  const na = value === null || value === undefined || value === '' || value === '—' || f === 'none';
  const age = grp ? d.ages?.[grp] : undefined;
  return (
    <div className={`tv ${na ? 'tv-na' : ''} ${f === 'stale' && !na ? 'tv-stale' : ''} ${warn === 'c' ? 'tv-crit' : warn === 'w' ? 'tv-warn' : ''} ${wide ? 'wide' : ''}`}
      title={title || (f === 'stale' && age != null ? `Last received ${Math.round(age)} s ago` : est ? `Estimated: ${est}` : undefined)}>
      <span className="tv-k">{label}{est && !na ? <em className="est">est.</em> : null}</span>
      <b className="tv-v num">{na ? 'N/A' : value}{!na && unit ? <small>{unit}</small> : null}</b>
      {f === 'stale' && !na && <em className="tv-age">{Math.round(age!)} s old</em>}
    </div>
  );
}
