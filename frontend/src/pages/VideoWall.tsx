import { useRef, useState } from 'react';
import { go } from '../App';
import { Battery, Icon, ToneChip } from '../components/Bits';
import { Video, type VideoStats } from '../components/Video';
import { ago, CONN_LABEL, flightStatus, fmt, timeOf, tone } from '../lib/format';
import { useLive } from '../lib/live';
import type { Drone } from '../lib/types';

function offMessage(d: Drone) {
  if (!d.enabled) return 'Slot disabled';
  if (d.conn === 'offline') return d.last_seen_s == null ? 'GCS never connected' : `Drone offline · ${ago(d.last_seen_s)}`;
  if (!d.video.configured) return 'No video source configured';
  return 'Video unavailable';
}

function WallCell({ d, big = false, onPick }: { d: Drone; big?: boolean; onPick: () => void }) {
  const [vs, setVs] = useState<VideoStats | null>(null);
  const live = d.conn !== 'offline' && d.enabled;
  const path = big ? d.video.path : d.video.sub_path || d.video.path;
  const unavailable = !live || !d.video.ready;
  return (
    <div className={`wall-cell tone-${tone(d)} ${unavailable ? 'unavail' : ''} ${big ? 'big' : ''}`} onClick={onPick} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onPick()} aria-label={`${d.drone_id} video`}>
      <Video path={path} enabled={live && d.video.ready} offMessage={offMessage(d)} onStats={setVs} className="wall-video" simulated={d.simulated && live}>
        <div className="vo vo-tl"><b>{d.drone_id}</b> <span className="muted">{d.gcs_id}</span></div>
        <div className="vo vo-tr"><ToneChip d={d} /></div>
        <div className="vo vo-bl">
          <span>{flightStatus(d)}</span>
          <span className="num"><Battery pct={d.batt_pct} /> {fmt(d.batt_pct)}%</span>
          <span className="num">{fmt(d.alt, 0)} m</span>
          {(big || (d.conn !== 'flying' && d.conn !== 'online')) && <span className={`conn conn-${d.conn}`}>{CONN_LABEL[d.conn]}</span>}
        </div>
        <div className="vo vo-br num">
          {vs?.state === 'playing' ? `${vs.height ?? ''}p${vs.latencyMs != null ? ` · ~${vs.latencyMs} ms` : ''}` : unavailable ? <span className="unavail-tag">NO VIDEO</span> : vs?.message}
          {d.video.recording && d.video.ready && <span className="rec">REC</span>}
        </div>
      </Video>
    </div>
  );
}

export function VideoWall({ focus }: { focus?: string }) {
  const drones = useLive((s) => s.drones);
  const byKey = useLive((s) => s.byKey);
  const wrap = useRef<HTMLDivElement>(null);
  const f = focus && byKey[focus] ? byKey[focus] : null;
  const unavailable = drones.filter((d) => d.enabled && (d.conn === 'offline' || !d.video.ready)).length;
  const full = () => { const el = wrap.current; if (el) (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(() => undefined); };
  return (
    <div className="wall-page" ref={wrap}>
      <div className="page-bar">
        {f ? <button className="btn ghost" onClick={() => go('wall')}><Icon name="back" /> All 15 feeds</button> : <h1>Live video wall</h1>}
        <span className="muted">{drones.length - unavailable} of {drones.length} feeds live{unavailable ? ` · ${unavailable} unavailable` : ''} · wall uses each camera's low-bitrate stream when one is set up; off-screen feeds pause</span>
        <span className="spacer" />
        {f && <button className="btn" onClick={() => go(`drone/${f.key}`)}><Icon name="twin" /> Open digital twin</button>}
        <button className="btn" onClick={full}><Icon name="expand" /> Full screen</button>
        <span className="muted num">{timeOf(Date.now() / 1000)}</span>
      </div>
      {f ? (
        <div className="wall-focus">
          <WallCell d={f} big onPick={() => go(`drone/${f.key}`)} />
          <div className="wall-strip">
            {drones.filter((d) => d.key !== f.key).map((d) => <WallCell key={d.key} d={d} onPick={() => go(`wall/${d.key}`)} />)}
          </div>
        </div>
      ) : (
        <div className="wall-grid">
          {drones.map((d) => <WallCell key={d.key} d={d} onPick={() => go(`wall/${d.key}`)} />)}
        </div>
      )}
    </div>
  );
}
