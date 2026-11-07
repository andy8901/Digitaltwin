// Interactive 3D model of the TAVAS quadcopter, built to the layout in the TAVAS spec sheet photo:
// blue upper shell with GPS dome and twin rear antennas, black lower battery bay, four tapered folding arms,
// motor pods with two-blade props, splayed landing legs and a gimbal camera under the nose.
// Orientation, heading and motor outputs come only from the drone's telemetry. Drag to rotate, scroll to zoom.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface TwinPose {
  roll: number | null; pitch: number | null; yaw: number | null; heading: number | null;
  gs: number | null; climb: number | null; armed: boolean; airborne: boolean; motors: number[];
  motorWarn?: boolean[];
}

const BLUE = 0x2448c9;
const BLACK = 0x15181c;
const CARBON = 0x1d2126;

export function buildTavas() {
  const g = new THREE.Group();
  const mat = (color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, ...o });
  // upper blue shell (nose towards -Z)
  const shell = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.065, 0.3, 4, 0.02), mat(BLUE, { roughness: 0.35, metalness: 0.25 }));
  shell.position.y = 0.035;
  g.add(shell);
  // side flanges where the arms attach
  for (const z of [-0.1, 0.1]) {
    const fl = new THREE.Mesh(new RoundedBoxGeometry(0.25, 0.018, 0.06, 2, 0.008), mat(BLUE, { roughness: 0.35 }));
    fl.position.set(0, 0.012, z);
    g.add(fl);
  }
  // lower black battery bay with vent fins
  const bay = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.075, 0.27, 3, 0.012), mat(BLACK));
  bay.position.y = -0.035;
  g.add(bay);
  for (let i = 0; i < 6; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.152, 0.006, 0.01), mat(0x0c0e10));
    fin.position.set(0, -0.06 + i * 0.008, 0.09);
    g.add(fin);
  }
  // GPS dome
  const gps = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.045, 0.022, 40), mat(BLUE, { roughness: 0.3 }));
  gps.position.set(0, 0.078, 0.02);
  g.add(gps);
  const gpsTop = new THREE.Mesh(new THREE.SphereGeometry(0.042, 32, 8, 0, Math.PI * 2, 0, Math.PI / 6), mat(BLUE, { roughness: 0.3 }));
  gpsTop.position.set(0, 0.07, 0.02);
  g.add(gpsTop);
  // twin antennas at the rear, swept back
  for (const x of [-0.045, 0.02]) {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.16, 12), mat(0x0b0c0e));
    ant.position.set(x, 0.14, 0.11);
    ant.rotation.x = 0.12;
    g.add(ant);
  }
  // emblem plate
  const emb = new THREE.Mesh(new THREE.CircleGeometry(0.018, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  emb.position.set(0.0861, 0.035, -0.04);
  emb.rotation.y = Math.PI / 2;
  g.add(emb);
  // gimbal camera under the nose
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.008, 0.07), mat(0x22262b, { metalness: 0.5 }));
  plate.position.set(0, -0.075, -0.14);
  g.add(plate);
  const yoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.012), mat(0x111315));
  yoke.position.set(0, -0.1, -0.145);
  g.add(yoke);
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.03, 24, 18), mat(0x0e1012, { roughness: 0.4 }));
  cam.position.set(0, -0.13, -0.15);
  g.add(cam);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.02, 24), mat(0x1a2a3a, { roughness: 0.1, metalness: 0.8 }));
  lens.rotation.x = Math.PI / 2 - 0.5;
  lens.position.set(0, -0.135, -0.177);
  g.add(lens);
  // landing legs, splayed
  for (const x of [-0.07, 0.07]) {
    for (const z of [-0.08, 0.1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.005, 0.22, 10), mat(0x101215));
      leg.position.set(x * 1.45, -0.15, z);
      leg.rotation.z = x > 0 ? -0.35 : 0.35;
      g.add(leg);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.022, 10), mat(0x050505));
      foot.position.set(x * 2.05, -0.255, z);
      g.add(foot);
    }
  }
  // arms + motors + props. ArduPilot quad-X numbering: 1 front-right, 2 rear-left, 3 front-left, 4 rear-right.
  const layout: [number, number][] = [[1, -1], [-1, 1], [-1, -1], [1, 1]];
  const motors: { pod: THREE.Mesh; ring: THREE.Mesh; blades: THREE.Group; disc: THREE.Mesh; dir: number }[] = [];
  layout.forEach(([sx, sz], i) => {
    const root = new THREE.Vector3(sx * 0.1, 0.012, sz * 0.1);
    const tip = new THREE.Vector3(sx * 0.215, 0.03, sz * 0.205);
    const len = root.distanceTo(tip) + 0.02;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.016, len, 14), mat(CARBON, { roughness: 0.45 }));
    arm.position.copy(root.clone().add(tip).multiplyScalar(0.5));
    arm.lookAt(tip);
    arm.rotateX(Math.PI / 2);
    g.add(arm);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.035, 32), mat(0x121417));
    pod.position.copy(tip).add(new THREE.Vector3(0, 0.01, 0));
    g.add(pod);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.003, 8, 40), new THREE.MeshBasicMaterial({ color: 0x54c8e8 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(pod.position).add(new THREE.Vector3(0, 0.018, 0));
    g.add(ring);
    const blades = new THREE.Group();
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.003, 0.018), mat(0x0d0f11, { roughness: 0.6 }));
      b.position.x = s * 0.085;
      b.rotation.x = s * 0.12;
      blades.add(b);
    }
    blades.position.copy(pod.position).add(new THREE.Vector3(0, 0.025, 0));
    g.add(blades);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.17, 48), new THREE.MeshBasicMaterial({ color: 0xa8e6f7, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(blades.position);
    g.add(disc);
    motors.push({ pod, ring, blades, disc, dir: i === 0 || i === 1 ? -1 : 1 });
    // navigation lights: red left, green right
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 10), new THREE.MeshBasicMaterial({ color: sx < 0 ? 0xff4b4b : 0x3ddc84 }));
    lamp.position.copy(pod.position).add(new THREE.Vector3(sx * 0.032, -0.005, 0));
    g.add(lamp);
  });
  return { g, motors };
}

export function TavasModel({ pose, chase = false }: { pose: TwinPose; chase?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const chaseRef = useRef(chase);
  chaseRef.current = chase;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(35, 1, 0.02, 50);
    cam.position.set(0.75, 0.55, 0.95);
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 0.4;
    controls.maxDistance = 4;
    controls.target.set(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xd6f2ff, 0x0b0d10, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 3, 1.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x54c8e8, 0.7);
    rim.position.set(-2, 1, -2);
    scene.add(rim);
    // ground: compass rose (north is -Z)
    const ground = new THREE.Group();
    ground.position.y = -0.32;
    scene.add(ground);
    const polar = new THREE.PolarGridHelper(1.2, 16, 4, 64, 0x24313b, 0x161e25);
    ground.add(polar);
    const nArrow = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.1, 3), new THREE.MeshBasicMaterial({ color: 0xff4b4b }));
    nArrow.rotation.x = -Math.PI / 2;
    nArrow.position.set(0, 0.001, -1.28);
    ground.add(nArrow);
    const { g: drone, motors } = buildTavas();
    drone.rotation.order = 'YXZ';
    scene.add(drone);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.3, 40), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.319;
    scene.add(shadow);
    // movement direction arrow (world frame)
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0), 0.5, 0x3ddc84, 0.08, 0.05);
    scene.add(arrow);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height, false);
      cam.aspect = r.width / r.height;
      cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    let raf = 0;
    let last = performance.now();
    const target = new THREE.Euler(0, 0, 0, 'YXZ');
    const q = new THREE.Quaternion();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = poseRef.current;
      const hd = THREE.MathUtils.degToRad(p.heading ?? p.yaw ?? 0);
      target.set(THREE.MathUtils.degToRad(p.pitch ?? 0), -hd, THREE.MathUtils.degToRad(-(p.roll ?? 0)), 'YXZ');
      q.setFromEuler(target);
      drone.quaternion.slerp(q, 1 - Math.exp(-dt * 10));
      const lift = p.airborne ? 0.05 : 0;
      drone.position.y += (lift - drone.position.y) * (1 - Math.exp(-dt * 4));
      motors.forEach((m, i) => {
        const pwm = p.motors[i] ?? 1000;
        const spin = p.armed ? Math.max(0, (pwm - 1000) / 1000) : 0;
        if (!reduce) m.blades.rotation.y += m.dir * spin * dt * 60;
        (m.disc.material as THREE.MeshBasicMaterial).opacity = spin > 0.15 ? 0.16 : 0;
        m.blades.visible = spin <= 0.15 || reduce;
        const warn = p.motorWarn?.[i] || (p.armed && pwm >= 1900);
        (m.ring.material as THREE.MeshBasicMaterial).color.setHex(warn ? 0xff4b4b : p.armed ? 0x54c8e8 : 0x3a4652);
      });
      const gs = p.gs ?? 0, climb = p.climb ?? 0;
      const sp = Math.hypot(gs, climb);
      arrow.visible = sp > 0.3;
      if (arrow.visible) {
        const dir = new THREE.Vector3(Math.sin(hd) * gs, climb, -Math.cos(hd) * gs).normalize();
        arrow.setDirection(dir);
        arrow.setLength(0.25 + Math.min(0.5, sp / 20), 0.08, 0.05);
      }
      if (chaseRef.current) {
        const back = new THREE.Vector3(-Math.sin(hd), 0, Math.cos(hd)).multiplyScalar(1.1);
        cam.position.lerp(new THREE.Vector3(back.x, 0.45, back.z), 1 - Math.exp(-dt * 3));
        controls.target.set(0, 0, 0);
      }
      controls.update();
      renderer.render(scene, cam);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={host} className="tavas-3d" aria-label="3D model of the drone; drag to rotate, scroll to zoom" />;
}
