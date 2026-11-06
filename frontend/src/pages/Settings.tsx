import { Fragment, useEffect, useState } from 'react';
import { can, useMe } from '../App';
import { api } from '../lib/api';
import { dateTimeOf } from '../lib/format';

interface Slot {
  slot: number; key: string; drone_id: string; gcs_id: string; msn: string; model: string; enabled: boolean; notes: string; battery_cells: number | null;
  telemetry: { type: string; port?: number; host?: string; tcp_port?: number };
  video: { type: string; main_url?: string; sub_url?: string; record?: boolean };
  geofence: { type: string; radius_m?: number; max_alt_m?: number };
}

function SlotEditor({ s, types, vtypes, onSaved }: { s: Slot; types: Record<string, string>; vtypes: Record<string, string>; onSaved: (s: Slot) => void }) {
  const [x, setX] = useState<Slot>(s);
  const [msg, setMsg] = useState('');
  const set = (patch: Partial<Slot>) => setX({ ...x, ...patch });
  const save = async () => {
    try { const r = await api<Slot>(`/api/fleet/config/${s.slot}`, { method: 'PUT', json: x }); onSaved(r); setMsg('Saved. The connection was restarted.'); }
    catch (e) { setMsg((e as Error).message); }
  };
  const t = x.telemetry, v = x.video;
  return (
    <div className="slot-ed">
      <div className="form-grid">
        <label>Drone ID<input value={x.drone_id} onChange={(e) => set({ drone_id: e.target.value })} /></label>
        <label>GCS ID<input value={x.gcs_id} onChange={(e) => set({ gcs_id: e.target.value })} /></label>
        <label>MSN (serial)<input value={x.msn || ''} onChange={(e) => set({ msn: e.target.value })} /></label>
        <label>Battery cells<input type="number" min={0} max={14} value={x.battery_cells ?? ''} onChange={(e) => set({ battery_cells: Number(e.target.value) || null })} /></label>
        <label className="chk"><input type="checkbox" checked={x.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Slot in use</label>
        <label className="wide">Telemetry adapter
          <select value={t.type} onChange={(e) => set({ telemetry: { ...t, type: e.target.value } })}>{Object.entries(types).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {t.type === 'udp_listen' && <label>UDP port on the server<input type="number" value={t.port ?? ''} onChange={(e) => set({ telemetry: { ...t, port: Number(e.target.value) } })} /></label>}
        {t.type === 'tcp_client' && <><label>GCS address<input value={t.host ?? ''} placeholder="10.8.0.21" onChange={(e) => set({ telemetry: { ...t, host: e.target.value } })} /></label>
          <label>GCS TCP port<input type="number" value={t.tcp_port ?? 5760} onChange={(e) => set({ telemetry: { ...t, tcp_port: Number(e.target.value) } })} /></label></>}
        {t.type === 'relay' && <p className="hint wide">Run the field relay on this GCS with <code>--gcs "{x.gcs_id}"</code>.</p>}
        {(t.type === 'rest' || t.type === 'custom') && <p className="hint warn wide">Not usable yet: this needs the GCS manufacturer's protocol specification so the adapter can be built and verified.</p>}
        <label className="wide">Video
          <select value={v.type} onChange={(e) => set({ video: { ...v, type: e.target.value } })}>{Object.entries(vtypes).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {v.type === 'rtsp_pull' && <><label className="wide">Main stream RTSP URL<input value={v.main_url ?? ''} placeholder="rtsp://10.8.0.21:8554/main.264" onChange={(e) => set({ video: { ...v, main_url: e.target.value } })} /></label>
          <label className="wide">Sub stream (low bitrate, for the wall)<input value={v.sub_url ?? ''} placeholder="rtsp://10.8.0.21:8554/sub.264" onChange={(e) => set({ video: { ...v, sub_url: e.target.value } })} /></label></>}
        {v.type === 'relay_push' && <p className="hint wide">The relay pushes the camera with <code>--rtsp</code> (and optionally <code>--rtsp-sub</code>).</p>}
        <label className="chk"><input type="checkbox" checked={!!v.record} onChange={(e) => set({ video: { ...v, record: e.target.checked } })} /> Record video</label>
        <label>Geofence radius (m)<input type="number" value={x.geofence?.radius_m ?? ''} onChange={(e) => set({ geofence: { ...x.geofence, type: 'circle', radius_m: Number(e.target.value) || undefined } })} /></label>
        <label>Geofence ceiling (m AGL)<input type="number" value={x.geofence?.max_alt_m ?? ''} onChange={(e) => set({ geofence: { ...x.geofence, type: 'circle', max_alt_m: Number(e.target.value) || undefined } })} /></label>
        <label className="wide">Notes<input value={x.notes || ''} onChange={(e) => set({ notes: e.target.value })} /></label>
      </div>
      <div className="row"><button className="btn primary" onClick={save}>Save {x.drone_id}</button><span className="muted">{msg}</span></div>
    </div>
  );
}

function FleetTab() {
  const [cfg, setCfg] = useState<{ slots: Slot[]; telemetry_types: Record<string, string>; video_types: Record<string, string> } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { api<typeof cfg>('/api/fleet/config').then(setCfg); }, []);
  if (!cfg) return <p className="muted">Loading…</p>;
  return (
    <div>
      <p className="muted note">Each drone has its own GCS and its own connection settings. Changing a slot restarts only that GCS's connection.</p>
      <table className="tbl">
        <thead><tr><th>Slot</th><th>Drone</th><th>GCS</th><th>MSN</th><th>Telemetry</th><th>Video</th><th>Geofence</th><th /></tr></thead>
        <tbody>{cfg.slots.map((s) => (
          <Fragment key={s.slot}>
            <tr className={!s.enabled ? 'dim' : ''}>
              <td className="num">{s.slot}</td><td><b>{s.drone_id}</b></td><td>{s.gcs_id}</td><td>{s.msn || '—'}</td>
              <td>{cfg.telemetry_types[s.telemetry.type]}{s.telemetry.type === 'udp_listen' ? ` :${s.telemetry.port}` : s.telemetry.type === 'tcp_client' ? ` ${s.telemetry.host}:${s.telemetry.tcp_port}` : ''}</td>
              <td>{cfg.video_types[s.video.type]}{s.video.record ? ' · recording' : ''}</td>
              <td className="num">{s.geofence?.radius_m ? `${s.geofence.radius_m} m / ${s.geofence.max_alt_m ?? '—'} m` : '—'}</td>
              <td><button className="btn sm" onClick={() => setOpen(open === s.slot ? null : s.slot)}>{open === s.slot ? 'Close' : 'Edit'}</button></td>
            </tr>
            {open === s.slot && <tr><td colSpan={8}><SlotEditor s={s} types={cfg.telemetry_types} vtypes={cfg.video_types}
              onSaved={(n) => setCfg({ ...cfg, slots: cfg.slots.map((y) => (y.slot === n.slot ? n : y)) })} /></td></tr>}
          </Fragment>
        ))}</tbody>
      </table>
    </div>
  );
}

function ThresholdTab({ admin }: { admin: boolean }) {
  const [s, setS] = useState<{ thresholds: Record<string, number>; defaults: Record<string, number>; help: Record<string, { label: string; unit: string; severity: string }> } | null>(null);
  const [vals, setVals] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState('');
  useEffect(() => { api<typeof s>('/api/settings').then((r) => { setS(r); setVals(r!.thresholds); }); }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const save = async () => { try { await api('/api/settings/thresholds', { method: 'PUT', json: vals }); setMsg('Saved. New limits apply from the next second.'); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div>
      <p className="muted note">Threshold rules raise alerts from measured values. Messages from the flight controller are always passed on as sent and don't depend on these settings.</p>
      <table className="tbl thr">
        <thead><tr><th>Rule</th><th>Raises</th><th>Limit</th><th>Default</th></tr></thead>
        <tbody>{Object.entries(s.help).map(([k, h]) => (
          <tr key={k}><td>{h.label}</td><td><span className={`chip sev-${h.severity}`}>{h.severity}</span></td>
            <td><input type="number" step="any" value={vals[k] ?? ''} disabled={!admin} onChange={(e) => setVals({ ...vals, [k]: Number(e.target.value) })} /> {h.unit}</td>
            <td className="muted num">{s.defaults[k]} {h.unit}</td></tr>))}</tbody>
      </table>
      {admin && <div className="row"><button className="btn primary" onClick={save}>Save limits</button><button className="btn ghost" onClick={() => setVals(s.defaults)}>Reset to defaults</button><span className="muted">{msg}</span></div>}
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<{ username: string; role: string; full_name: string; last_login: number | null }[]>([]);
  const [form, setForm] = useState({ username: '', full_name: '', role: 'operator', password: '' });
  const [msg, setMsg] = useState('');
  const load = () => api<typeof users>('/api/users').then(setUsers);
  useEffect(() => { load(); }, []);
  const save = async () => { try { await api('/api/users', { json: form }); setMsg(`Saved ${form.username}.`); setForm({ username: '', full_name: '', role: 'operator', password: '' }); load(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div>
      <p className="muted note">Admin: everything including settings. Operator: monitor, acknowledge alerts, tag flights, run the demo planner. Viewer: monitor only.</p>
      <table className="tbl"><thead><tr><th>User</th><th>Name</th><th>Role</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>{users.map((u) => <tr key={u.username}><td><b>{u.username}</b></td><td>{u.full_name}</td><td>{u.role}</td><td className="num">{u.last_login ? dateTimeOf(u.last_login) : '—'}</td>
          <td><button className="btn sm ghost" onClick={() => setForm({ username: u.username, full_name: u.full_name, role: u.role, password: '' })}>Edit</button>{' '}
            <button className="btn sm ghost" onClick={() => api(`/api/users/${u.username}`, { method: 'DELETE' }).then(load).catch((e) => setMsg(e.message))}>Delete</button></td></tr>)}</tbody></table>
      <h3 className="sub-h">Add or change a user</h3>
      <div className="form-grid">
        <label>User name<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>Full name<input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></label>
        <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="admin">Admin</option><option value="operator">Operator</option><option value="viewer">Viewer</option></select></label>
        <label>Password<input type="password" value={form.password} placeholder="leave empty to keep" onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
      </div>
      <div className="row"><button className="btn primary" onClick={save} disabled={!form.username}>Save user</button><span className="muted">{msg}</span></div>
    </div>
  );
}

function AccountTab() {
  const [f, setF] = useState({ current: '', new: '' });
  const [msg, setMsg] = useState('');
  return (
    <div className="form-grid narrow">
      <label>Current password<input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
      <label>New password (8+ characters)<input type="password" value={f.new} onChange={(e) => setF({ ...f, new: e.target.value })} /></label>
      <div className="row"><button className="btn primary" onClick={() => api('/api/me/password', { json: f }).then(() => setMsg('Password changed.')).catch((e) => setMsg(e.message))}>Change password</button><span className="muted">{msg}</span></div>
    </div>
  );
}

export function Settings() {
  const me = useMe();
  const admin = can(me, 'admin');
  const tabs: [string, string][] = admin ? [['fleet', 'Fleet & GCS adapters'], ['thr', 'Alert thresholds'], ['users', 'Users & roles'], ['me', 'My account']] : [['thr', 'Alert thresholds'], ['me', 'My account']];
  const [tab, setTab] = useState(tabs[0][0]);
  return (
    <div className="settings-page">
      <div className="page-bar"><h1>System settings</h1>
        <div className="seg">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        <span className="spacer" /><span className="muted">The command centre only monitors: it never sends commands to a drone or a GCS.</span></div>
      <section className="panel">
        {tab === 'fleet' && <FleetTab />}
        {tab === 'thr' && <ThresholdTab admin={admin} />}
        {tab === 'users' && <UsersTab />}
        {tab === 'me' && <AccountTab />}
      </section>
    </div>
  );
}
