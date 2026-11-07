// SITL/GCS-style 3D flight view. Positions come from received GPS latitude/longitude and altitude above home,
// orientation from the autopilot's ATTITUDE (pitch, roll, yaw). Units are metres: x east, y up, z south.
// The flight path is the received track (altitude-coloured, with drop lines to the ground); the planned mission is
// dashed. Other drones are shown at their true relative positions. Drone models are enlarged so they stay visible.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { altColor, droneColor, getPaths, pathsVersion, type DronePath } from '../lib/paths';
import type { Drone } from '../lib/types';
import { buildTavas } from './TavasModel';

export type CamMode = 'orbit' | 'chase' | 'top';
const MODEL_SCALE = 14;   // minimum: a 0.5 m drone drawn ~7 m wide; grows with camera distance so it stays visible

interface Ref { lat: number; lon: number }
const toLocal = (ref: Ref, lat: number, lon: number, alt: number) => new THREE.Vector3(
  (lon - ref.lon) * 111320 * Math.cos((ref.lat * Math.PI) / 180), alt, -(lat - ref.lat) * 110540);

function label(text: string, color = '#e6edf2') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  const draw = (t: string, col: string) => {
    g.clearRect(0, 0, 512, 96);
    g.font = '600 44px Barlow, "Segoe UI", sans-serif';
    const w = Math.min(500, g.measureText(t).width + 28);
    g.fillStyle = 'rgba(5,7,10,0.72)';
    g.beginPath(); g.roundRect((512 - w) / 2, 14, w, 64, 10); g.fill();
    g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t, 256, 47);
  };
  draw(text, color);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  s.renderOrder = 10;
  let last = text;
  return { s, set: (t: string, col = color) => { if (t !== last) { last = t; draw(t, col); tex.needsUpdate = true; } } };
}

/** Satellite tiles under the scene when the tile server is reachable (otherwise only the grid shows). */
function addImagery(scene: THREE.Group, ref: Ref, radiusM: number) {
  const z = 16;
  const n = 2 ** z;
  const tx = (lon: number) => ((lon + 180) / 360) * n;
  const ty = (lat: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const lonOf = (x: number) => (x / n) * 360 - 180;
  const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const dLat = radiusM / 110540, dLon = radiusM / (111320 * Math.cos((ref.lat * Math.PI) / 180));
  const x0 = Math.floor(tx(ref.lon - dLon)), x1 = Math.floor(tx(ref.lon + dLon));
  const y0 = Math.floor(ty(ref.lat + dLat)), y1 = Math.floor(ty(ref.lat - dLat));
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const nw = toLocal(ref, latOf(y), lonOf(x), 0), se = toLocal(ref, latOf(y + 1), lonOf(x + 1), 0);
    loader.load(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(se.x - nw.x, se.z - nw.z), new THREE.MeshBasicMaterial({ map: tex, color: 0xb0b0b0 }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set((nw.x + se.x) / 2, -0.05, (nw.z + se.z) / 2);
      scene.add(plane);
    }, undefined, () => undefined);
  }
}

interface Obj {
  model: THREE.Group; lab: ReturnType<typeof label>; path: LineSegments2; drops: THREE.LineSegments; shadow: THREE.Line;
  vec: THREE.ArrowHelper; home: THREE.Group | null; pathN: number; pathFid: number | null; plan: THREE.Group | null; planVer: number; planSeq: number | null;
  pos: THREE.Vector3 | null; q: THREE.Quaternion;
}

export function FlightView3D({ drones, focusKey, cam = 'orbit', showOthers = true, imagery = true }: {
  drones: Drone[]; focusKey: string | null; cam?: CamMode; showOthers?: boolean; imagery?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ drones, focusKey, cam, showOthers });
  live.current = { drones, focusKey, cam, showOthers };
  const refKey = drones.find((d) => d.key === focusKey)?.home?.join(',') ?? drones.find((d) => d.home)?.home?.join(',') ?? '';

  useEffect(() => {
    const el = host.current!;
    const [rl, ro] = refKey ? refKey.split(',').map(Number) : [NaN, NaN];
    const first = live.current.drones.find((d) => d.lat != null);
    const ref: Ref = !Number.isNaN(rl) ? { lat: rl, lon: ro } : first ? { lat: first.lat!, lon: first.lon! } : { lat: 0, lon: 0 };

    const renderer = new THREE.WebGLRenderer({ antialias: !/SwiftShader/i.test(navigator.userAgent), powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    // software rendering (no GPU): keep frames cheap
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const soft = /swiftshader|llvmpipe|software/i.test(String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ''));
    if (soft) renderer.setPixelRatio(0.6);
    renderer.setClearColor(0x070b0f);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const fleetMode = !focusKey;
    if (!fleetMode) scene.fog = new THREE.Fog(0x070b0f, 2500, 9000);
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 200000);
    camera.position.set(-260, 220, 320);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.minDistance = 10;
    controls.maxDistance = fleetMode ? 120000 : 8000;
    scene.add(new THREE.HemisphereLight(0xd6f2ff, 0x101418, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(300, 600, 200);
    scene.add(sun);

    // ground: imagery (when reachable), 50 m grid, 100 m rings around the reference and a north arrow
    const ground = new THREE.Group();
    scene.add(ground);
    const base = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000), new THREE.MeshBasicMaterial({ color: 0x0b1116 }));
    base.rotation.x = -Math.PI / 2; base.position.y = -0.2;
    ground.add(base);
    if (imagery && ref.lat) addImagery(ground, ref, 1600);
    const grid = new THREE.GridHelper(4000, 80, 0x2a3946, 0x16222b);
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.55;
    ground.add(grid);
    const wide = new THREE.GridHelper(60000, 60, 0x24323d, 0x24323d);   // 1 km squares for a fleet spread over a city
    (wide.material as THREE.Material).transparent = true; (wide.material as THREE.Material).opacity = 0.5;
    wide.position.y = -0.1;
    ground.add(wide);
    for (const r of [500, 1000, 1500]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 1.2, r + 1.2, 128), new THREE.MeshBasicMaterial({ color: 0x54c8e8, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1;
      ground.add(ring);
      const l = label(`${r} m`, '#9fd8ee'); l.s.scale.set(0.16, 0.03, 1); l.s.position.set(r * 0.707, 2, -r * 0.707); ground.add(l.s);
    }
    const nl = label('N', '#ff6b6b'); nl.s.scale.set(0.16, 0.03, 1); nl.s.position.set(0, 3, -1700); ground.add(nl.s);

    const objs: Record<string, Obj> = {};
    const fatMats: LineMaterial[] = [];
    const make = (d: Drone): Obj => {
      const { g } = buildTavas();
      const model = new THREE.Group();
      g.scale.setScalar(MODEL_SCALE);
      model.add(g);
      model.rotation.order = 'YXZ';
      scene.add(model);
      const lab = label(d.drone_id, droneColor(d));
      lab.s.scale.set(0.093, 0.0175, 1);
      scene.add(lab.s);
      const pm = new LineMaterial({ vertexColors: true, linewidth: 2.5, transparent: true, opacity: 0.95, worldUnits: false });
      fatMats.push(pm);
      { const r = el.getBoundingClientRect(); pm.resolution.set(r.width || 1, r.height || 1); }
      const path = new LineSegments2(new LineSegmentsGeometry(), pm);
      const drops = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9fd8ee, transparent: true, opacity: 0.18 }));
      const shadow = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }));
      const vec = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 20, 0xffffff, 6, 4);
      scene.add(path, drops, shadow, vec);
      return { model, lab, path, drops, shadow, vec, home: null, pathN: -1, pathFid: null, plan: null, planVer: -1, planSeq: null, pos: null, q: new THREE.Quaternion() };
    };

    const buildPath = (o: Obj, d: Drone, p: DronePath | undefined, focus: boolean) => {
      const pts = p?.pts ?? [];
      if (o.pathN === pts.length && o.pathFid === (p?.flightId ?? null)) return;
      o.pathN = pts.length; o.pathFid = p?.flightId ?? null;
      const pos: number[] = [], col: number[] = [], drop: number[] = [], sh: number[] = [];
      const c = new THREE.Color(), dc = new THREE.Color(droneColor(d));
      let prev: THREE.Vector3 | null = null;
      pts.forEach((pt, i) => {
        const v = toLocal(ref, pt.lat, pt.lon, Math.max(0, pt.alt ?? 0));
        if (prev && !pt.gap) {
          pos.push(prev.x, prev.y, prev.z, v.x, v.y, v.z);
          if (focus) { c.set(altColor(pts[i - 1].alt)); col.push(c.r, c.g, c.b); c.set(altColor(pt.alt)); col.push(c.r, c.g, c.b); }
          else col.push(dc.r, dc.g, dc.b, dc.r, dc.g, dc.b);
        }
        if (focus && i % 4 === 0) drop.push(v.x, v.y, v.z, v.x, 0.3, v.z);
        sh.push(v.x, 0.25, v.z);
        prev = v;
      });
      o.path.geometry.dispose();
      const lg = new LineSegmentsGeometry();
      if (pos.length) { lg.setPositions(pos); lg.setColors(col); }
      o.path.geometry = lg;
      o.path.visible = pos.length > 0;
      o.path.material.linewidth = focus ? 4 : 2.5;
      o.path.material.opacity = focus ? 1 : 0.8;
      o.drops.geometry.dispose();
      o.drops.geometry = new THREE.BufferGeometry();
      o.drops.geometry.setAttribute('position', new THREE.Float32BufferAttribute(drop, 3));
      o.shadow.geometry.dispose();
      o.shadow.geometry = new THREE.BufferGeometry();
      o.shadow.geometry.setAttribute('position', new THREE.Float32BufferAttribute(focus ? sh : [], 3));
    };

    const buildPlan = (o: Obj, d: Drone, p: DronePath | undefined, focus: boolean) => {
      const ver = p?.missionVer ?? 0;
      if (o.planVer === ver && o.planSeq === d.mission_seq) return;
      o.planVer = ver; o.planSeq = d.mission_seq;
      if (o.plan) { scene.remove(o.plan); o.plan = null; }
      const items = p?.mission ?? [];
      if (!items.length) return;
      const homeMsl = d.alt_msl != null && d.alt != null ? d.alt_msl - d.alt : null;
      const g = new THREE.Group();
      const vs = items.map((it) => toLocal(ref, it.lat, it.lon, it.alt_ref === 'amsl' ? (homeMsl != null ? it.alt - homeMsl : it.alt) : it.alt));
      const k = d.mission_seq == null ? 0 : Math.max(0, items.findIndex((it) => it.seq >= d.mission_seq!));
      if (k > 0) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs.slice(0, k + 1)), new THREE.LineBasicMaterial({ color: 0x8796a3, transparent: true, opacity: 0.6 })));
      const rest = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs.slice(k)), new THREE.LineDashedMaterial({ color: focus ? 0xe6edf2 : new THREE.Color(droneColor(d)).getHex(), dashSize: 8, gapSize: 6, transparent: true, opacity: 0.85 }));
      rest.computeLineDistances();
      g.add(rest);
      if (focus) vs.forEach((v, i) => {
        const done = i < k;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), new THREE.MeshBasicMaterial({ color: done ? 0x8796a3 : 0xe6edf2 }));
        ball.position.copy(v); g.add(ball);
        const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v, new THREE.Vector3(v.x, 0.3, v.z)]), new THREE.LineDashedMaterial({ color: 0xe6edf2, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.35 }));
        pole.computeLineDistances(); g.add(pole);
        const l = label(String(i + 1)); l.s.scale.set(0.12, 0.0225, 1); l.s.position.set(v.x, v.y + 7, v.z); g.add(l.s);
      });
      scene.add(g);
      o.plan = g;
    };

    const homeMark = (letter: string, color: number) => {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(4, 5.5, 40), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3; g.add(ring);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 14, 8), new THREE.MeshBasicMaterial({ color }));
      pole.position.y = 7; g.add(pole);
      const l = label(letter, '#' + new THREE.Color(color).getHexString()); l.s.scale.set(0.14, 0.026, 1); l.s.position.y = 18; g.add(l.s);
      scene.add(g);
      return g;
    };
    let toMark: THREE.Group | null = null;

    const resize = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height, false);
      fatMats.forEach((m) => m.resolution.set(r.width, r.height));
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    };
    const ro2 = new ResizeObserver(resize);
    ro2.observe(el);
    resize();

    let raf = 0, last = performance.now(), lastVer = -1, framed = false, lastCam: CamMode | null = null;
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { drones: ds, focusKey: fk, cam: cm, showOthers: so } = live.current;
      const paths = getPaths();
      const ver = pathsVersion();
      let focusObj: Obj | null = null, focusD: Drone | null = null;
      for (const d of ds) {
        const focus = d.key === fk;
        const show = d.lat != null && d.lon != null && (focus || so || !fk);
        let o = objs[d.key];
        if (!o && show) o = objs[d.key] = make(d);
        if (!o) continue;
        o.model.visible = o.lab.s.visible = o.drops.visible = o.shadow.visible = show;
        o.path.visible = show && o.pathN > 1;
        if (o.plan) o.plan.visible = show && (focus || !fk);
        if (!show) { o.vec.visible = false; continue; }
        if (ver !== lastVer || o.pathN < 0) { buildPath(o, d, paths[d.key], focus); buildPlan(o, d, paths[d.key], focus); }
        const target = toLocal(ref, d.lat!, d.lon!, Math.max(0, d.alt ?? 0));
        if (!o.pos) o.pos = target.clone();
        // ease over the 250 ms between updates so the model doesn't jump; it always ends at the reported position
        o.pos.lerp(target, 1 - Math.exp(-dt * 8));
        const sc = Math.max(MODEL_SCALE, camera.position.distanceTo(o.pos) * (focus ? 0.11 : fk ? 0.05 : 0.022));
        o.model.scale.setScalar(sc / MODEL_SCALE);
        o.model.position.copy(o.pos).add(new THREE.Vector3(0, 0.26 * sc, 0));
        const hd = THREE.MathUtils.degToRad(d.yaw ?? d.heading ?? 0);
        e.set(THREE.MathUtils.degToRad(d.pitch ?? 0), -hd, THREE.MathUtils.degToRad(-(d.roll ?? 0)), 'YXZ');
        o.q.setFromEuler(e);
        o.model.quaternion.slerp(o.q, 1 - Math.exp(-dt * 10));
        const stale = d.ages?.pos == null || d.ages.pos > 3;
        o.model.traverse((x) => { const m = (x as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m && 'opacity' in m) { m.transparent = stale; m.opacity = stale ? 0.4 : 1; } });
        o.lab.s.position.copy(o.pos).add(new THREE.Vector3(0, 0.9 * sc, 0));
        o.lab.set(`${d.drone_id} · ${d.alt != null ? `${Math.round(d.alt)} m` : 'alt N/A'}${stale ? ' · no data' : ''}`, droneColor(d));
        o.lab.s.scale.set(focus ? 0.3 : 0.22, focus ? 0.056 : 0.041, 1);
        // direction of movement (course + vertical speed)
        const gs = d.gs ?? 0, vz = d.vz ?? d.climb ?? 0;
        o.vec.visible = d.track != null && gs > 0.5 && !stale;
        if (o.vec.visible) {
          const a = THREE.MathUtils.degToRad(d.track!);
          o.vec.position.copy(o.model.position);
          o.vec.setDirection(new THREE.Vector3(Math.sin(a) * gs, vz, -Math.cos(a) * gs).normalize());
          o.vec.setLength(Math.min(80, 12 + Math.hypot(gs, vz) * 4), 6, 4);
        }
        if (focus) {
          focusObj = o; focusD = d;
          if (d.home && !o.home) o.home = homeMark('H', 0x54c8e8);
          if (o.home && d.home) o.home.position.copy(toLocal(ref, d.home[0], d.home[1], 0));
          if (d.takeoff) {
            if (!toMark) toMark = homeMark('T', 0x3ddc84);
            toMark.position.copy(toLocal(ref, d.takeoff[0], d.takeoff[1], 0));
          }
        } else if (o.home) { scene.remove(o.home); o.home = null; }
      }
      if (ver !== lastVer) lastVer = ver;
      // camera
      const fp = focusObj?.model.position;
      if (!framed && fp) {
        controls.target.copy(fp);
        camera.position.copy(fp).add(new THREE.Vector3(-120, 85, 150));
        framed = true;
      } else if (!framed && !fk) {
        const ps = Object.values(objs).filter((o) => o.pos).map((o) => o.pos!);
        if (ps.length) {
          const box = new THREE.Box3().setFromPoints(ps);
          const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
          controls.target.copy(c);
          camera.position.copy(c).add(new THREE.Vector3(-0.5, 0.55, 0.7).multiplyScalar(Math.max(500, s)));
          framed = true;
        }
      }
      if (fp && focusD) {
        if (cm === 'chase') {
          const hd = THREE.MathUtils.degToRad(focusD.heading ?? focusD.yaw ?? 0);
          const want = fp.clone().add(new THREE.Vector3(-Math.sin(hd) * 90, 45, Math.cos(hd) * 90));
          camera.position.lerp(want, 1 - Math.exp(-dt * 2.5));
          controls.target.lerp(fp, 1 - Math.exp(-dt * 6));
        } else if (cm === 'top') {
          const want = fp.clone().add(new THREE.Vector3(0, 650, 1));
          if (lastCam !== 'top') camera.position.copy(want);
          camera.position.x += (fp.x - camera.position.x) * (1 - Math.exp(-dt * 3));
          camera.position.z += (fp.z + 1 - camera.position.z) * (1 - Math.exp(-dt * 3));
          controls.target.lerp(fp, 1 - Math.exp(-dt * 6));
        } else {
          // orbit: keep looking at the drone, but leave rotation and zoom to the operator
          const delta = fp.clone().sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 4));
          controls.target.add(delta);
          camera.position.add(delta);
        }
      }
      lastCam = cm;
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro2.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [refKey, imagery, focusKey]);

  return <div ref={host} className="fv3d" aria-label="3D flight view: drag to rotate, scroll to zoom, right-drag to pan" />;
}
