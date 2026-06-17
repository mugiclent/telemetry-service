import amqplib from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { config } from '../config/index.js';
import { initTripsSubscriber } from '../subscribers/trips.subscriber.js';

const RETRY_DELAY_MS = 3_000;

let connection: ChannelModel;
let tripsChannel: Channel;
let isShuttingDown = false;
let isReconnecting = false;
let isReconnectingChannel = false;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Health state ──────────────────────────────────────────────────────────────

type RabbitHealth = { ok: boolean; error?: string };
let rabbitHealth: RabbitHealth = { ok: false, error: 'not yet connected' };

export const getRabbitMQHealth = (): RabbitHealth => rabbitHealth;

const QUEUE = 'trips-telemetry-svc';

// ── Channel setup ─────────────────────────────────────────────────────────────

/**
 * Consumes trip lifecycle events to maintain the device→trip mapping:
 *
 *  trips exchange (topic) — pre-defined in definitions.json, checked not asserted
 *    └── trips-telemetry-svc queue ←── routing key: trip.events  (DLX → trips.dlx)
 *
 * Single channel, prefetch(1): at most one unacked event in flight, so a Redis
 * outage holds the message (and back-pressures the queue) rather than losing it.
 */
const setupChannels = async (): Promise<void> => {
  tripsChannel = await connection.createChannel();
  await tripsChannel.prefetch(1);

  // Verify pre-defined exchanges exist — never re-declare a broker-owned exchange.
  await tripsChannel.checkExchange('trips');
  await tripsChannel.checkExchange('trips.dlx');

  await tripsChannel.assertQueue(QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': 'trips.dlx' },
  });
  await tripsChannel.bindQueue(QUEUE, 'trips', 'trip.events');

  await initTripsSubscriber(tripsChannel);

  rabbitHealth = { ok: true };
  console.warn('[rabbitmq] Connected — tripsChannel consuming');

  // Channel-level handlers — a broker-forced channel close kills the consumer without
  // closing the connection. Recreate the channel without a full reconnect.
  tripsChannel.on('error', (err: Error) => {
    console.warn('[rabbitmq] tripsChannel error:', err.message);
  });
  tripsChannel.on('close', () => {
    if (isShuttingDown || isReconnecting || isReconnectingChannel) return;
    isReconnectingChannel = true;
    rabbitHealth = { ok: false, error: 'tripsChannel closed — re-creating' };
    console.warn(`[rabbitmq] tripsChannel closed — re-creating in ${RETRY_DELAY_MS / 1000}s`);
    setTimeout(() => {
      void setupChannels()
        .catch((err: Error) => {
          console.warn('[rabbitmq] Failed to re-create channels:', err.message);
        })
        .finally(() => {
          isReconnectingChannel = false;
        });
    }, RETRY_DELAY_MS);
  });
};

// ── Connection setup ──────────────────────────────────────────────────────────

const setup = async (): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      connection = await amqplib.connect(config.rabbitmq.url);
      break;
    } catch {
      console.warn(`[rabbitmq] Broker not ready (attempt ${attempt}) — retrying in ${RETRY_DELAY_MS / 1000}s`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Register connection handlers immediately — before any channel work — so a throw in
  // setupChannels still leaves a close handler that triggers reconnect.
  connection.on('close', scheduleReconnect);
  connection.on('error', (err: Error) => {
    console.warn('[rabbitmq] Connection error:', err.message);
  });

  await setupChannels();
};

const scheduleReconnect = (): void => {
  if (isShuttingDown || isReconnecting) return;
  isReconnecting = true;
  rabbitHealth = { ok: false, error: 'connection lost — reconnecting' };
  console.warn('[rabbitmq] Connection lost — reconnecting...');

  void (async () => {
    for (;;) {
      await sleep(RETRY_DELAY_MS);
      try {
        await setup();
        isReconnecting = false;
        return;
      } catch (err) {
        console.warn('[rabbitmq] Reconnect attempt failed:', (err as Error).message);
        try { await connection?.close(); } catch { /* already closed */ }
      }
    }
  })();
};

// ── Public lifecycle ──────────────────────────────────────────────────────────

export const initRabbitMQ = async (): Promise<void> => {
  await setup();
};

export const closeRabbitMQ = async (): Promise<void> => {
  isShuttingDown = true;
  await tripsChannel?.close();
  await connection?.close();
};
