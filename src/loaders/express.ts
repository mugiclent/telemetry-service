import express from 'express';
import type { Application, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from '../config/index.js';
import { getRabbitMQHealth } from './rabbitmq.js';
import { getRedisHealth } from './redis.js';
import ingestRouter from '../api/ingest.routes.js';
import busesRouter from '../api/buses.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

export const buildApp = (): Application => {
  const app = express();

  // Behind nginx — trust the proxy for X-Forwarded-* (real client IP in logs).
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: config.cors.origins }));
  // The Traccar client posts JSON; OsmAnd mode posts urlencoded/query. Accept both.
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Health — unauthenticated, for nginx / load-balancer probes. 503 if any hard
  // dependency is down (per platform contract). No DB: this service is Redis-backed.
  app.get('/health', (_req: Request, res: Response) => {
    const rabbit = getRabbitMQHealth();
    const redis = getRedisHealth();
    const allOk = rabbit.ok && redis.ok;
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      service: 'telemetry-svc',
      timestamp: new Date().toISOString(),
      checks: {
        redis: redis.ok ? 'up' : { status: 'down', error: redis.error },
        rabbitmq: rabbit.ok ? 'up' : { status: 'down', error: rabbit.error },
      },
    });
  });

  // Ingest is mounted at root — the Traccar client always POSTs to the URL root.
  app.use('/', ingestRouter);
  app.use('/buses', busesRouter);

  app.use(errorHandler);

  return app;
};
