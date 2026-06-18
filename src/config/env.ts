import Joi from 'joi';

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().default(8093),

  REDIS_PASSWORD: Joi.string().required(),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().default(6379),

  RABBITMQ_USER: Joi.string().required(),
  RABBITMQ_PASSWORD: Joi.string().required(),
  RABBITMQ_HOST: Joi.string().default('rabbitmq'),
  RABBITMQ_PORT: Joi.number().default(5672),

  // How long a bus's latest fix lives before it's considered stale and disappears.
  // A bus that stops posting (parked, dead device) should not look "live" forever.
  LATEST_TTL_SECONDS: Joi.number().default(300),

  // Safety net for the device→trip mapping in case a trip.completed/cancelled event is
  // never delivered — the mapping self-expires so a device can't stream indefinitely.
  MAPPING_TTL_SECONDS: Joi.number().default(86_400),

  // Comma-separated list of allowed CORS origins (browser map/SSE clients).
  CORS_ORIGINS: Joi.string().default(
    'https://katisha.online,https://www.katisha.online,https://app.katisha.online',
  ),
});

const { error, value } = schema.validate(process.env, { allowUnknown: true });

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

export const env = value as {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  REDIS_PASSWORD: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  RABBITMQ_USER: string;
  RABBITMQ_PASSWORD: string;
  RABBITMQ_HOST: string;
  RABBITMQ_PORT: number;
  LATEST_TTL_SECONDS: number;
  MAPPING_TTL_SECONDS: number;
  CORS_ORIGINS: string;
};
