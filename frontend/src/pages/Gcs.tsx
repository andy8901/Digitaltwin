import { Fragment, useEffect, useState } from 'react';
import { can, go, useMe } from '../App';
import { api } from '../lib/api';
import { ago, dateTimeOf, fmt } from '../lib/format';
import type { GcsInfo } from '../lib/types';

const STATE: Record<string, string> = {
  connected: 'Connected', stale: 'No data', disconnected: 'Disconnected', never: 'Never connected', error: 'Error',
  awaiting_verification: 'Awaiting protocol verification', disabled: 'Disabled',
};

export function GcsPage() {
  const me = useMe();
  const [links, setLinks] = useState<GcsInfo[]>([]);
  const [videoApi, setVideoApi] = useState<{ ok: boolean | null; error: string }>({ ok: null, error: '' });
  const [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<{ ts: number; kind: string; detail: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ links: GcsInfo[]; video_api: { ok: boolean; error: string } }>('/api/gcs').then((r) => { if (alive) { setLinks(r.links); setVideoApi(r.video_api); } }).catch(() => undefined);
    load();
    const i = setInterval(load, 2000);
    return () => { alive = false; clearInterval(i); };
  }, []);
  useEffect(() => { if (open) api<typeof events>(`/api/gcs/${open}/events`).then(setEvents); }, [open]);
  const up = links.filter((l) => l.state === 'connected').length;
  return (
    <div className="gcs-page">
      <div className="page-bar">
        <h1>GCS connections</h1>
        <span className="muted">{up} of {links.length} ground stations connected · each GCS is an independent data source: one dropping out never affects the others</span>
        <span className="spacer" />
        {videoApi.ok === false && <span className="bad">Video server not reachable: {videoApi.error}</span>}
      </div>
      <div className="table-wrap">
        <table className="tbl gcs-tbl">
          <thead><tr><th>GCS</th><th>Drone</th><th>Adapter</th><th>Connection</th><th>Last data</th><th>Telemetry latency</th><th>Data rate</th><th>Communication quality</th><th>Video</th><th>Disconnects (24 h)</th><th /></tr></thead>
          <tbody>
            {links.map((l) => (
              <Fragment key={l.key}>
                <tr className={`gcs-${l.state}`} onClick={() => setOpen(open === l.key ? null : l.key)}>
                  <td><b>{l.gcs_id}</b></td>
                  <td><a href={`#/drone/${l.key}`} onClick={(e) => e.stopPropagation()}>{l.drone_id}</a></td>
                  <td>{l.adapter_label}</td>
                  <td><span className={`state st-${l.state}`}>{STATE[l.state] ?? l.state}</span>{l.since && <div className="muted small">since {dateTimeOf(l.since)}</div>}</td>
                  <td className="num">{l.last_rx_s != null ? ago(l.last_rx_s) : '—'}</td>
                  <td className="num">{l.rtt_ms != null ? `${l.rtt_ms} ms round trip` : l.last_hb_s != null && l.state === 'connected' ? 'n/a for this adapter' : '—'}</td>
                  <td className="num">{l.state === 'connected' ? `${fmt(l.kbps, 1)} kbit/s` : '—'}</td>
                  <td className="num">{l.link_pct != null ? `${l.link_pct}% packets` : '—'}{l.rssi != null ? ` · RSSI ${l.rssi}%` : ''}</td>
                  <td className="num">{l.video?.type === 'none' ? 'not configured' : l.video?.ready ? `${l.video.kbps ?? '…'} kbit/s${l.video.codec ? ` · ${l.video.codec}` : ''}${l.video.sub_ready ? ' · sub stream' : ''}` : <span className="bad">no stream</span>}
                    <div className="muted small">latency measured in the viewer</div></td>
                  <td className="num">{l.disconnects_24h ?? 0}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {can(me, 'operator') && l.adapter !== 'relay' && <button className="btn sm" onClick={() => api(`/api/gcs/${l.key}/reconnect`, { method: 'POST' })}>Reconnect</button>}
                    <button className="btn sm ghost" onClick={() => go(`drone/${l.key}`)}>Twin</button>
                  </td>
                </tr>
                {open === l.key && (
                  <tr className="gcs-detail"><td colSpan={11}>
                    <div className="gcs-detail-box">
                      <div>
                        <b>{l.gcs_id} → {l.drone_id}</b>
                        <p className="muted">{l.detail || '—'}{l.peer ? ` · from ${l.peer}` : ''} · {l.rx_msgs} MAVLink messages since the server started</p>
                        {l.state === 'awaiting_verification' && <p className="warn">This adapter can't be used until the GCS manufacturer's protocol is documented and tested. Use the field relay or MAVLink over UDP/TCP until then.</p>}
                      </div>
                      <div>
                        <b>Disconnection history</b>
                        <div className="events">
                          {events.length ? events.map((e, i) => <div key={i} className={`ev st-${e.kind}`}><span className="num">{dateTimeOf(e.ts)}</span><span>{STATE[e.kind] ?? e.kind}</span><span className="muted">{e.detail}</span></div>)
                            : <span className="muted">No connection changes recorded.</span>}
                        </div>
                      </div>
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted note">Telemetry latency is the round trip between the server and the field relay (measured every 5 s); adapters without a relay show data age instead. Video latency is measured by the browser while a stream is open (shown on the drone and video-wall screens). Adapters are set per GCS in System settings.</p>
    </div>
  );
}
