import 'dotenv/config';
import { config } from './config/index.js';
import { buildApp } from './loaders/express.js';
import { initRedis, closeRedis } from './loaders/redis.js';
import { initRabbitMQ, closeRabbitMQ } from './loaders/rabbitmq.js';

const start = async (): Promise<void> => {
  initRedis();
  // The trips subscriber is attached inside the RabbitMQ loader's setupChannels, so it
  // survives reconnects — no separate init needed here.
  await initRabbitMQ();

  const app = buildApp();
  const server = app.listen(config.port, () => {
    console.warn(`[server] telemetry-svc listening on port ${config.port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.warn(`[server] ${signal} — shutting down`);
    server.close(async () => {
      await closeRabbitMQ();
      await closeRedis();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
};

start().catch((err) => {
  console.error('[server] Failed to start', err);
  process.exit(1);
});
