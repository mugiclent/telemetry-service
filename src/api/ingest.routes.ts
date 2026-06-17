import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ingestPosition } from '../services/telemetry.service.js';

const router = Router();

// POST /  — the bus device (Traccar client) posts here. Mounted at the root because
// the Traccar/OsmAnd client always POSTs to the server URL's root path.
//
// Always answers 2xx for anything we can handle: a non-2xx makes the client's offline
// buffer retry forever, so "ignored" (unmapped device / stale fix) is still a 200.
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const result = await ingestPosition(req.body, req.query);
      if (result.stored) {
        res.status(200).json({ ok: true });
      } else {
        res.status(200).json({ ok: false, ignored: result.reason });
      }
    } catch (err) {
      next(err);
    }
  })();
});

export default router;
