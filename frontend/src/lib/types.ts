export type Conn = 'flying' | 'online' | 'stale' | 'link_lost' | 'offline';
export type Level = 'critical' | 'warning' | null;
export type Severity = 'critical' | 'warning' | 'info';

export interface VideoInfo {
  path: string; sub_path: string | null; ready: boolean; configured: boolean; kbps: number | null; recording: boolean;
}

export interface Drone {
  key: string; drone_id: string; gcs_id: string | null; msn: string; model: string | null; slot: number | null; enabled: boolean;
  conn: Conn; armed: boolean; airborne: boolean; mode: string; last_seen_s: number | null;
  lat: number | null; lon: number | null; alt: number | null; alt_msl: number | null; heading: number | null; gs: number | null; climb: number | null;
  batt_pct: number | null; volt: number | null; curr: number | null; fix: number | null; sats: number | null; hdop: number | null;
  link_pct: number | null; rssi: number | null; home: [number, number] | null; takeoff: [number, number] | null; range: number | null;
  flight_s: number | null; flight_id: number | null;
  dist_m: number | null; roll: number | null; pitch: number | null; yaw: number | null; heading_src: 'gps' | 'yaw' | null; vz: number | null; track: number | null;
  ages: Partial<Record<'pos' | 'att' | 'gps' | 'batt' | 'hud' | 'radio' | 'rc' | 'hb', number>>; last_rx: number | null;
  simulated: boolean; mission_ver: number; mission_seq: number | null;
  level: Level; alerts: { critical: number; warning: number }; video: VideoInfo; gcs_state: string | null;
}

export interface MissionItem { seq: number; cmd: number; kind: string; lat: number; lon: number; alt: number; alt_ref: 'home' | 'amsl' }
export interface Msg { ts: number; sev: number; text: string; fc?: boolean }
export interface FlightEvent { type: string; t: number; text: string; dist_m: number | null; alt_m: number | null; voltage: number | null; lat: number | null; lon: number | null }
export interface HealthComp { name: string; status: 'healthy' | 'warning' | 'critical' | 'unavailable'; detail: string; value?: number | null }
export interface Health { key: string; drone_id: string; gcs_id: string; score: number | null; overall: string; alert_level: Level; components: HealthComp[]; available: number; total: number }

export interface DroneDetail extends Drone {
  h_acc?: number | null;
  airspeed: number | null; throttle: number | null; mah: number | null; load: number | null;
  ekf: { vel: number; pos_h: number; pos_v: number; compass: number; terrain: number; max: number; flags: number } | null;
  vibe: [number, number, number, number] | null; radio: { rssi: number; remrssi: number; noise: number } | null; rc_rssi: number | null;
  motors: number[]; esc: { i: number; rpm: number; temp: number; current: number; voltage: number }[]; temps: Record<string, number>;
  ods: { a: number | string; d: number; max: number }[]; rangefinder: { d: number; max: number } | null;
  system_status: number | null; vehicle_type: number | null; sysid: number | null;
  sensors: { name: string; ok: boolean }[] | null; mission: { seq: number | null; total: number | null; reached?: number };
  fence: { breach: boolean; count: number; type: number } | null; boot_s: number | null;
  flight: { id: number; time_s: number; distance_m: number; max_range: number; max_alt: number; max_speed: number; cold_start_s: number | null; events: FlightEvent[]; prearm: string[] } | null;
  prearm: string[]; msgs: Msg[]; health?: Health;
  mission_items: MissionItem[];
  battery_cells?: number; geofence?: { type: string; radius_m?: number; max_alt_m?: number | null; lat?: number; lon?: number } | null;
}

export interface Summary {
  total: number; airborne: number; ground: number; warnings: number; critical: number; disconnected: number;
  avg_battery: number | null; fleet_flight_s_today: number;
}

export interface GcsInfo {
  gcs_id: string; key: string; drone_id: string; adapter: string; adapter_label: string; state: string; detail: string; since: number | null;
  last_rx_s: number | null; rx_msgs: number; kbps: number; rtt_ms: number | null; peer: string | null; disconnects: number; enabled: boolean;
  disconnects_24h?: number; link_pct?: number | null; rssi?: number | null; last_hb_s?: number | null;
  video?: { type: string; ready: boolean; kbps: number | null; sub_ready: boolean; viewers: number; codec: string | null };
}

export interface Alert {
  id: number; drone_key: string; drone_id: string; gcs_id: string | null; severity: Severity; rule: string; label: string; message: string;
  source: string; param: string | null; value: string | number | null; threshold: string | null; lat: number | null; lon: number | null;
  flight_id: number | null; ts: number; resolved_ts: number | null; ack_by: string | null; ack_ts: number | null;
}

export interface Me {
  user: { username: string; role: 'admin' | 'operator' | 'viewer'; full_name: string };
  version: string; tz: string; fleet_size: number; periods: Record<string, string>; rule_labels: Record<string, string>;
  telemetry_types: Record<string, string>; video_types: Record<string, string>;
}
