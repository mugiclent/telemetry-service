import type { Channel, ConsumeMessage } from 'amqplib';
import { setDeviceMapping, clearTripMapping } from '../services/telemetry.service.js';

const QUEUE = 'trips-telemetry-svc';

// Events arrive as untyped JSON off the `trips` exchange (routing key `trip.events`).
//
// NOTE: trip.activated must carry `bus_id` and the tracker's `device_id` for telemetry
// to resolve incoming pings. trip-service is being updated to include these and to emit
// a trip.completed event — until then activations without them are dead-lettered.
type TripEvent = Record<string, unknown> & { type?: string };

// Thrown for events we can never process (missing required fields) → dead-letter, no requeue.
class BadEventError extends Error {}

// Reads a required string field off the raw event or throws BadEventError.
const reqStr = (event: TripEvent, field: string): string => {
  const v = event[field];
  if (typeof v !== 'string' || v === '') {
    throw new BadEventError(`${String(event.type)} missing ${field}`);
  }
  return v;
};

// ioredis surfaces connection problems as errors whose message names the transport.
// These are transient — requeue with a small delay rather than dead-lettering a valid event.
const isInfrastructureError = (err: unknown): boolean => {
  const msg = (err as Error)?.message ?? '';
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection is closed|max retries|stream isn't writeable/i.test(msg);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const handle = async (event: TripEvent): Promise<void> => {
  switch (event.type) {
    case 'trip.activated': {
      const tripId = reqStr(event, 'trip_id');
      const busId = reqStr(event, 'bus_id');
      const deviceId = reqStr(event, 'device_id');
      const orgId = reqStr(event, 'org_id');
      await setDeviceMapping(deviceId, { tripId, busId, orgId });
      console.warn(`[trips.subscriber] bus ${busId} tracking via device ${deviceId} (trip ${tripId})`);
      break;
    }
    case 'trip.completed':
    case 'trip.cancelled': {
      const tripId = reqStr(event, 'trip_id');
      await clearTripMapping(tripId);
      console.warn(`[trips.subscriber] stopped tracking trip ${tripId} (${event.type})`);
      break;
    }
    default:
      break; // other trip/ticket events on this exchange are not ours
  }
};

export const initTripsSubscriber = async (ch: Channel): Promise<void> => {
  await ch.consume(QUEUE, (msg: ConsumeMessage | null) => {
    void (async () => {
      if (!msg) return;
      try {
        const event = JSON.parse(msg.content.toString()) as TripEvent;
        await handle(event);
        try { ch.ack(msg); } catch { /* channel closed — broker requeues */ }
      } catch (err) {
        if (err instanceof BadEventError) {
          console.error('[trips.subscriber] Dropping bad event:', err.message);
          try { ch.nack(msg, false, false); } catch { /* channel closed — broker requeues */ }
          return;
        }
        if (isInfrastructureError(err)) {
          // Redis down — hold off, then requeue so the mapping isn't lost. prefetch(1)
          // means nothing new is delivered while we wait.
          console.warn('[trips.subscriber] Infra error, requeueing:', (err as Error).message);
          await sleep(5_000);
          try { ch.nack(msg, false, true); } catch { /* channel closed — broker requeues */ }
          return;
        }
        console.error('[trips.subscriber] Unexpected error, dead-lettering', err);
        try { ch.nack(msg, false, false); } catch { /* channel closed — broker requeues */ }
      }
    })();
  });

  console.warn(`[trips.subscriber] Listening on ${QUEUE}`);
};
