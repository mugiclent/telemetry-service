import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getLatestFix } from '../services/telemetry.service.js';
import { streamBusLocation } from '../services/sse.service.js';

const router = Router();

// GET /buses/:busId/location — most recent fix, or 204 when none yet.
router.get('/:busId/location', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const fix = await getLatestFix(String(req.params.busId));
      if (!fix) {
        res.status(204).end();
        return;
      }
      res.status(200).json(fix);
    } catch (err) {
      next(err);
    }
  })();
});

// GET /buses/:busId/stream — live SSE stream of fixes (the map view).
router.get('/:busId/stream', (req: Request, res: Response, next: NextFunction) => {
  void streamBusLocation(req, res, String(req.params.busId)).catch(next);
});

export default router;
