import type { Request, Response } from 'express';
import { createRedisConnection, getRedisClient } from '../loaders/redis.js';
import { busChannel, latestKey } from '../utils/keys.js';

// Keep-alive comment every 25s. Long-lived SSE streams sit idle whenever a bus is
// parked; without periodic bytes, proxies/load-balancers eventually drop the socket.
const HEARTBEAT_MS = 25_000;

// Live position stream for one bus. Mirrors trip-service's sse.service pattern:
// a dedicated subscriber connection per client, normal SUBSCRIBE to the one channel,
// torn down on disconnect.
export const streamBusLocation = async (
  req: Request,
  res: Response,
  busId: string,
): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // belt-and-braces with nginx proxy_buffering off
  res.flushHeaders();

  const writeFix = (data: string): void => {
    res.write(`data: ${data}\n\n`);
  };

  const subscriber = createRedisConnection();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    subscriber.unsubscribe().catch(() => {});
    subscriber.quit().catch(() => {});
  };

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  // Forward every published fix straight through (already in {lat,lon,ts} shape).
  subscriber.on('message', (_channel: string, message: string) => {
    writeFix(message);
  });

  // Subscribe BEFORE reading latest so a fix landing in the gap isn't missed.
  await subscriber.subscribe(busChannel(busId));

  // Prime the stream with the current position so a freshly-opened map isn't blank.
  const latest = await getRedisClient().get(latestKey(busId));
  if (latest) writeFix(latest);

  req.on('close', cleanup);
};
