// One-off introspection: import the Express app (route table is built
// synchronously by the top-level app.use calls in server.ts), dump every
// registered method+path via the clean extractor, then exit before the async
// start() boot does anything meaningful.
process.env.PORT = process.env.DUMP_PORT || "3099";

import app from "../src/server";
import { extractLiveRoutes } from "../src/docs/routeIntrospection";

setImmediate(() => {
  try {
    const routes = extractLiveRoutes(app as never);
    process.stdout.write("ROUTES_JSON_START\n");
    process.stdout.write(JSON.stringify(routes));
    process.stdout.write("\nROUTES_JSON_END\n");
  } catch (e) {
    process.stdout.write("DUMP_ERROR " + (e instanceof Error ? e.message : String(e)) + "\n");
  }
  process.exit(0);
});
