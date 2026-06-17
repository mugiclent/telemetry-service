// Redis key + channel naming. One place so ingest, the SSE stream, and the trips
// subscriber can never drift apart.

// device → active trip mapping: { tripId, busId, orgId }. Written on trip.activated,
// deleted on trip.completed/cancelled. This is what authorizes an incoming ping.
export const deviceKey = (deviceId: string): string => `telemetry:device:${deviceId}`;

// trip → deviceId reverse lookup, so a trip.completed/cancelled (which only carries
// trip_id) can find and tear down the device mapping.
export const tripKey = (tripId: string): string => `telemetry:trip:${tripId}`;

// the one stored value the read endpoint serves: the bus's most recent fix.
export const latestKey = (busId: string): string => `telemetry:bus:${busId}:latest`;

// pub/sub channel the SSE stream subscribes to for live updates.
export const busChannel = (busId: string): string => `telemetry:bus:${busId}`;
