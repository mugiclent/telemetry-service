import { getRedisClient } from '../loaders/redis.js';
import { config } from '../config/index.js';
import { deviceKey, tripKey, latestKey, busChannel } from '../utils/keys.js';

// ── Public shapes ───────────────────────────────────────────────────────────

// What every reader (GET + SSE) receives. Deliberately minimal — just enough to
// plot a moving marker and judge its freshness.
export interface Fix {
  lat: number;
  lon: number;
  ts: string; // ISO-8601, the device's own timestamp
}

// The device→trip mapping, learned from the trips exchange.
export interface DeviceMapping {
  tripId: string;
  busId: string;
  orgId: string;
}

export type IngestResult =
  | { stored: true; busId: string }
  | { stored: false; reason: 'no_active_trip' | 'stale' | 'invalid' };

// ── Ingest (write path) ───────────────────────────────────────────────────────

// Accepts the raw Traccar/OsmAnd payload (JSON body or query/form params) and, if the
// device is on an active trip and the fix is newer than what we hold, stores it as the
// bus's latest and publishes it to live SSE subscribers.
export const ingestPosition = async (
  body: unknown,
  query: unknown,
): Promise<IngestResult> => {
  const parsed = extractFix(body, query);
  if (!parsed) return { stored: false, reason: 'invalid' };

  const redis = getRedisClient();

  // 1. Authorize + resolve: the device must currently be mapped to an active trip.
  const mappingRaw = await redis.get(deviceKey(parsed.deviceId));
  if (!mappingRaw) return { stored: false, reason: 'no_active_trip' };
  const mapping = JSON.parse(mappingRaw) as DeviceMapping;

  const key = latestKey(mapping.busId);

  // 2. Newest-wins guard. Offline buffering means the device can flood older points
  //    after a reconnect; never let a stale fix clobber a fresher stored one.
  const existingRaw = await redis.get(key);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as Fix;
    if (Date.parse(existing.ts) >= parsed.tsMs) {
      return { stored: false, reason: 'stale' };
    }
  }

  const fix: Fix = { lat: parsed.lat, lon: parsed.lon, ts: parsed.tsIso };
  const payload = JSON.stringify(fix);

  // 3. Store latest (with staleness TTL) and fan out to live viewers.
  await redis.set(key, payload, 'EX', config.telemetry.latestTtlSeconds);
  await redis.publish(busChannel(mapping.busId), payload);

  return { stored: true, busId: mapping.busId };
};

// ── Latest (read path) ────────────────────────────────────────────────────────

export const getLatestFix = async (busId: string): Promise<Fix | null> => {
  const raw = await getRedisClient().get(latestKey(busId));
  return raw ? (JSON.parse(raw) as Fix) : null;
};

// ── Mapping lifecycle (driven by the trips exchange) ──────────────────────────

export const setDeviceMapping = async (
  deviceId: string,
  mapping: DeviceMapping,
): Promise<void> => {
  const redis = getRedisClient();
  const ttl = config.telemetry.mappingTtlSeconds;
  await redis.set(deviceKey(deviceId), JSON.stringify(mapping), 'EX', ttl);
  // reverse index so trip end (trip_id only) can find the device.
  await redis.set(tripKey(mapping.tripId), deviceId, 'EX', ttl);
};

export const clearTripMapping = async (tripId: string): Promise<void> => {
  const redis = getRedisClient();
  const deviceId = await redis.get(tripKey(tripId));
  if (!deviceId) return;

  const mappingRaw = await redis.get(deviceKey(deviceId));
  const busId = mappingRaw ? (JSON.parse(mappingRaw) as DeviceMapping).busId : null;

  await redis.del(deviceKey(deviceId), tripKey(tripId), ...(busId ? [latestKey(busId)] : []));
};

// ── Parsing ───────────────────────────────────────────────────────────────────

interface ParsedFix {
  deviceId: string;
  lat: number;
  lon: number;
  tsMs: number;
  tsIso: string;
}

interface TraccarBody {
  device_id?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  timestamp?: unknown;
  location?: {
    timestamp?: unknown;
    coords?: { latitude?: unknown; longitude?: unknown };
  };
}

const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toStr = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);

// Accepts ISO-8601 strings as well as unix epoch seconds or milliseconds.
const toEpochMs = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n; // 10-digit → seconds, 13-digit → ms
  }
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : ms;
};

// Tolerates all three shapes we've observed from Traccar clients:
//   - background-geolocation JSON: { location: { coords, timestamp }, device_id }
//   - OsmAnd query string:         ?id=&lat=&lon=&timestamp=
//   - flat urlencoded body:        id=&lat=&lon=&timestamp=
const extractFix = (body: unknown, query: unknown): ParsedFix | null => {
  const b = (typeof body === 'object' && body !== null ? body : {}) as TraccarBody;
  const q = (typeof query === 'object' && query !== null ? query : {}) as TraccarBody;
  const coords = b.location?.coords;

  const deviceId = toStr(b.device_id ?? b.id ?? q.id);
  const lat = toNumber(coords?.latitude ?? b.lat ?? q.lat);
  const lon = toNumber(coords?.longitude ?? b.lon ?? q.lon);
  const tsMs = toEpochMs(b.location?.timestamp ?? b.timestamp ?? q.timestamp);

  if (!deviceId || lat === null || lon === null || tsMs === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { deviceId, lat, lon, tsMs, tsIso: new Date(tsMs).toISOString() };
};
