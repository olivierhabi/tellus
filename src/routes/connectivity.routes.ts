// ---------------------------------------------------------------------------
// Connectivity route module — canonical mount point per spec §55.
//
// The route handlers, contracts, repo, and outbox live under
// src/services/connectivity/. This file is the thin re-export that
// src/server.ts imports, matching the repo's existing pattern (other route
// modules under src/routes/ act as the same kind of mount wrapper).
//
// Mounted globally as:
//   import connectivityRouter from './routes/connectivity.routes';
//   app.use('/api/v2/connectivity', connectivityRouter);
// ---------------------------------------------------------------------------

import {
  createConnectivityRouter,
  initConnectivity,
  shutdownConnectivity,
} from "../services/connectivity";

const router = createConnectivityRouter();

export default router;
export { initConnectivity, shutdownConnectivity };
