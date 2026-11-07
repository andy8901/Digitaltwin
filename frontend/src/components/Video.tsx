// One camera stream: WebRTC (WHEP) through the app's video proxy, falling back to HLS.
// Each <Video> has its own connection, so one feed failing never affects the others.
import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';

export interface VideoStats { state: 'connecting' | 'playing' | 'waiting' | 'error' | 'off'; message: string; latencyMs: number | null; kbps: number | null; fps: number | null; width: number | null; height: number | null; mode: 'webrtc' | 'hls' }

interface Props {
  path: string | null;
  enabled?: boolean;            // false: don't connect (drone offline, no video configured)
  offMessage?: string;
  className?: string;
  onStats?: (s: VideoStats) => void;
  children?: React.ReactNode;   // overlays
  pauseWhenHidden?: boolean;
  simulated?: boolean;          // feed comes from the simulator: always labelled, never shown as a real camera
}

export function Video({ path, enabled = true, offMessage = 'No video', className = '', onStats, children, pauseWhenHidden = true, simulated = false }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(true);
  const [st, setSt] = useState<VideoStats>({ state: 'off', message: offMessage, latencyMs: null, kbps: null, fps: null, width: null, height: null, mode: 'webrtc' });
  const statsCb = useRef(onStats);
  statsCb.current = onStats;

  useEffect(() => {
    if (!pauseWhenHidden || !box.current) return;
    const io = new IntersectionObserver((es) => setVisible(es[0].isIntersecting), { threshold: 0.05 });
    io.observe(box.current);
    return () => io.disconnect();
  }, [pauseWhenHidden]);

  useEffect(() => {
    let alive = true;
    let pc: RTCPeerConnection | null = null;
    let hls: Hls | null = null;
    let retry: number | undefined;
    let statTimer: number | undefined;
    let mode: 'webrtc' | 'hls' = 'webrtc';
    let lastBytes = 0, lastT = 0, lastFrames = 0;
    const v = vid.current!;
    const update = (p: Partial<VideoStats>) => {
      if (!alive) return;
      setSt((s) => { const n = { ...s, ...p, mode }; statsCb.current?.(n); return n; });
    };
    const cleanup = () => {
      if (pc) { try { pc.close(); } catch { /* closed */ } pc = null; }
      if (hls) { hls.destroy(); hls = null; }
      v.srcObject = null;
      v.removeAttribute('src');
      window.clearTimeout(retry);
      window.clearInterval(statTimer);
    };
    if (!enabled || !path || !visible) {
      update({ state: 'off', message: !visible ? 'Paused (off screen)' : offMessage, latencyMs: null, kbps: null });
      return () => { alive = false; cleanup(); };
    }
    const again = (ms: number, msg: string, state: VideoStats['state'] = 'waiting') => {
      update({ state, message: msg });
      cleanup();
      retry = window.setTimeout(() => alive && start(), ms);
    };
    async function startWebrtc() {
      const conn = new RTCPeerConnection();
      pc = conn;
      conn.addTransceiver('video', { direction: 'recvonly' });
      const stream = new MediaStream();
      conn.ontrack = (e) => { stream.addTrack(e.track); if (v.srcObject !== stream) v.srcObject = stream; v.play().catch(() => undefined); };
      conn.onconnectionstatechange = () => {
        if (conn.connectionState === 'failed' || conn.connectionState === 'disconnected') again(3000, 'Video connection dropped, reconnecting…', 'error');
      };
      await conn.setLocalDescription(await conn.createOffer());
      await new Promise<void>((res) => {
        if (conn.iceGatheringState === 'complete') return res();
        const t = window.setTimeout(res, 1200);
        conn.addEventListener('icegatheringstatechange', () => { if (conn.iceGatheringState === 'complete') { window.clearTimeout(t); res(); } });
      });
      const r = await fetch(`/video/webrtc/${encodeURIComponent(path!)}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: conn.localDescription!.sdp });
      if (!alive) return;
      if (r.status === 404) return again(5000, 'No video stream from this drone');
      if (r.status === 502) return again(8000, 'Video server unreachable', 'error');
      if (r.status === 400) { mode = 'hls'; return start(); }
      if (!r.ok) return again(5000, `Video server answered ${r.status}`, 'error');
      await conn.setRemoteDescription({ type: 'answer', sdp: await r.text() });
      statTimer = window.setInterval(async () => {
        if (!pc) return;
        const rep = await pc.getStats();
        let lat: number | null = null, rtt = 0, kbps: number | null = null, fps: number | null = null;
        rep.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            if (s.jitterBufferEmittedCount) lat = (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000;
            const now = s.timestamp;
            if (lastT) kbps = Math.round(((s.bytesReceived - lastBytes) * 8) / (now - lastT));
            if (lastT && s.framesDecoded != null) fps = Math.round(((s.framesDecoded - lastFrames) * 1000) / (now - lastT));
            lastBytes = s.bytesReceived; lastT = now; lastFrames = s.framesDecoded || 0;
          }
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime != null) rtt = s.currentRoundTripTime * 1000;
        });
        update({ latencyMs: lat != null ? Math.round(lat + rtt / 2) : null, kbps, fps, width: v.videoWidth || null, height: v.videoHeight || null });
      }, 2000);
    }
    function startHls() {
      const url = `/video/hls/${encodeURIComponent(path!)}/index.m3u8`;
      if (Hls.isSupported()) {
        const h = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 });
        hls = h;
        h.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) again(5000, data.response?.code === 404 ? 'No video stream from this drone' : data.type === 'mediaError' ? 'This browser cannot decode the camera format' : 'HLS interrupted, reconnecting…');
        });
        h.loadSource(url);
        h.attachMedia(v);
      } else {
        v.src = url;
      }
    }
    function start() {
      update({ state: 'connecting', message: 'Connecting…' });
      (mode === 'webrtc' ? startWebrtc() : Promise.resolve(startHls())).catch((e) => again(5000, String(e.message || e), 'error'));
    }
    const onPlaying = () => update({ state: 'playing', message: '' });
    const onWaiting = () => update({ state: 'connecting', message: 'Buffering…' });
    v.addEventListener('playing', onPlaying);
    v.addEventListener('waiting', onWaiting);
    start();
    return () => { alive = false; v.removeEventListener('playing', onPlaying); v.removeEventListener('waiting', onWaiting); cleanup(); };
  }, [path, enabled, visible, offMessage]);

  return (
    <div ref={box} className={`video ${className} v-${st.state}`}>
      <video ref={vid} autoPlay muted playsInline />
      {st.state !== 'playing' && (
        <div className="video-msg">
          {st.state === 'connecting' || st.message.startsWith('Paused') ? <span>{st.message}</span>
            : <span><b className="vid-off">VIDEO OFFLINE</b><em>{st.message}</em></span>}
        </div>
      )}
      {simulated && <div className="sim-badge" title="Simulator feed: test or sample footage, not a live drone camera">SIMULATION</div>}
      {children}
    </div>
  );
}
