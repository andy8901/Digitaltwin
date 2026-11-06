import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './lib/api';
import { applyAlertUpdate, connectLive, dismissToast, useLive } from './lib/live';
import { clockNow, dur, setTz, timeOf, tzLabel } from './lib/format';
import type { Alert, Me } from './lib/types';
import { Icon } from './components/Bits';
import { Overview } from './pages/Overview';
import { VideoWall } from './pages/VideoWall';
import { DroneTwin } from './pages/DroneTwin';
import { FleetMap } from './pages/FleetMap';
import { Alerts } from './pages/Alerts';
import { FleetHealth } from './pages/FleetHealth';
import { GcsPage } from './pages/Gcs';
import { History } from './pages/History';
import { Analytics } from './pages/Analytics';
import { Settings } from './pages/Settings';
import { Planner } from './pages/Planner';

export const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;
export const can = (me: Me, role: 'operator' | 'admin') => (role === 'admin' ? me.user.role === 'admin' : me.user.role !== 'viewer');

export function go(path: string) { location.hash = `#/${path}`; }
function useRoute() {
  const [h, setH] = useState(location.hash.replace(/^#\/?/, '') || 'overview');
  useEffect(() => {
    const f = () => setH(location.hash.replace(/^#\/?/, '') || 'overview');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h.split('/');
}

const NAV: [string, string, string][] = [
  ['overview', 'Fleet Overview', 'overview'], ['wall', 'Live Video Wall', 'wall'], ['drone', 'Drone Digital Twin', 'twin'],
  ['map', 'Fleet Map', 'map'], ['alerts', 'Alerts & Notifications', 'alerts'], ['health', 'Fleet Health', 'health'],
  ['gcs', 'GCS Connections', 'gcs'], ['history', 'Flight History', 'history'], ['analytics', 'Analytics & Reports', 'analytics'],
  ['planner', 'Demo Planner', 'planner'], ['settings', 'System Settings', 'settings'],
];

export function ackAlert(a: Alert) {
  return api<Alert>(`/api/alerts/${a.id}/ack`, { method: 'POST' }).then(applyAlertUpdate);
}

function Clock() {
  const [t, setT] = useState(clockNow());
  useEffect(() => { const i = setInterval(() => setT(clockNow()), 1000); return () => clearInterval(i); }, []);
  return <span className="clock num">{t}<small>{tzLabel()}</small></span>;
}

function SummaryBar() {
  const s = useLive((x) => x.summary);
  const connected = useLive((x) => x.connected);
  if (!s) return <div className="summary" />;
  const items: [string, string | number, string][] = [
    ['Total drones', s.total, ''], ['Airborne', s.airborne, 'airborne'], ['On ground', s.ground, 'normal'],
    ['Warnings', s.warnings, s.warnings ? 'warning' : ''], ['Critical', s.critical, s.critical ? 'critical' : ''],
    ['Disconnected', s.disconnected, s.disconnected ? 'offline' : ''],
    ['Avg battery', s.avg_battery == null ? '—' : `${s.avg_battery}%`, ''], ['Fleet flight time today', dur(s.fleet_flight_s_today), ''],
  ];
  return (
    <div className="summary" role="status">
      {items.map(([k, v, c]) => (
        <div className={`sum-item ${c ? `tone-txt-${c}` : ''}`} key={k}><b className="num">{v}</b><span>{k}</span></div>
      ))}
      <span className={`live-dot ${connected ? 'on' : ''}`} title={connected ? 'Live' : 'Reconnecting…'} />
    </div>
  );
}

function CriticalBanner() {
  const alerts = useLive((x) => x.alerts);
  const me = useMe();
  const crit = alerts.filter((a) => a.severity === 'critical' && !a.ack_ts);
  if (!crit.length) return null;
  const a = crit[0];
  return (
    <div className="crit-banner" role="alert">
      <Icon name="warn" />
      <b>{a.drone_id}</b><span className="muted">{a.gcs_id}</span>
      <span className="crit-msg">{a.label}: {a.message}</span>
      <span className="muted num">{timeOf(a.ts)}</span>
      {crit.length > 1 && <span className="crit-more">+{crit.length - 1} more unacknowledged</span>}
      <button className="btn sm" onClick={() => go(`drone/${a.drone_key}`)}>Open drone</button>
      {can(me, 'operator') && <button className="btn sm danger" onClick={() => ackAlert(a)}>Acknowledge</button>}
      <button className="btn sm ghost" onClick={() => go('alerts')}>All alerts</button>
    </div>
  );
}

function Toasts() {
  const toasts = useLive((x) => x.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((a) => (
        <div key={a.toastId} className={`toast sev-${a.severity}`} onClick={() => { go(`drone/${a.drone_key}`); dismissToast(a.toastId); }}>
          <div className="toast-h"><b>{a.drone_id}</b><span>{a.label}</span><span className="num muted">{timeOf(a.ts)}</span></div>
          <div className="toast-m">{a.message}</div>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const route = useRoute();
  const alerts = useLive((x) => x.alerts);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('cc.nav') === '1'; } catch { return false; } });
  useEffect(() => {
    api<Me>('/api/me').then((m) => { setTz(m.tz); setMe(m); });
    connectLive();
  }, []);
  if (!me) return <div className="boot">Connecting to the command centre…</div>;
  const page = route[0];
  const openCount = alerts.filter((a) => !a.ack_ts || !a.resolved_ts).length;
  const critCount = alerts.filter((a) => a.severity === 'critical' && !a.ack_ts).length;
  const toggleNav = () => { setCollapsed(!collapsed); try { localStorage.setItem('cc.nav', collapsed ? '0' : '1'); } catch { /* ignore */ } };
  let body: React.ReactNode;
  switch (page) {
    case 'wall': body = <VideoWall focus={route[1]} />; break;
    case 'drone': body = <DroneTwin droneKey={route[1]} />; break;
    case 'map': body = <FleetMap />; break;
    case 'alerts': body = <Alerts />; break;
    case 'health': body = <FleetHealth />; break;
    case 'gcs': body = <GcsPage />; break;
    case 'history': body = <History droneKey={route[1]} />; break;
    case 'analytics': body = <Analytics />; break;
    case 'settings': body = <Settings />; break;
    case 'planner': body = <Planner />; break;
    default: body = <Overview />;
  }
  return (
    <MeCtx.Provider value={me}>
      <div className={`shell ${collapsed ? 'nav-collapsed' : ''}`}>
        <nav className="nav" aria-label="Sections">
          <button className="brand" onClick={toggleNav} title={collapsed ? 'Expand menu' : 'Collapse menu'}>
            <img src="/static/neosky-emblem.png" alt="" />
            <span><b>TAVAS</b><small>Digital Twin Command Centre</small></span>
          </button>
          {NAV.map(([k, label, icon]) => (
            <a key={k} href={`#/${k === 'drone' ? 'drone' : k}`} className={`nav-i ${page === k || (page === '' && k === 'overview') ? 'on' : ''}`} title={label}>
              <Icon name={icon} size={19} />
              <span>{label}</span>
              {k === 'alerts' && openCount > 0 && <em className={critCount ? 'crit' : ''}>{openCount}</em>}
            </a>
          ))}
          <div className="nav-foot">
            <span>{me.user.full_name || me.user.username}<small>{me.user.role}</small></span>
            <a href="/logout">Sign out</a>
            <small className="ver">v{me.version} · monitoring only</small>
          </div>
        </nav>
        <div className="main">
          <header className="topbar">
            <SummaryBar />
            <Clock />
          </header>
          <CriticalBanner />
          <main className={`page page-${page || 'overview'}`}>{body}</main>
        </div>
        <Toasts />
      </div>
    </MeCtx.Provider>
  );
}
