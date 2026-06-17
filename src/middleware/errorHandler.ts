import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError.js';

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // express.json() rejects malformed bodies with this shape.
  if (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as Record<string, unknown>)['type'] === 'entity.parse.failed'
  ) {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON' },
    });
    return;
  }

  console.error('[errorHandler] Unhandled error', err);
  res.status(500).json({
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' },
  });
};
