// Step 1: Load environment variables FIRST — must be the very first operation
import dotenv from 'dotenv';
dotenv.config();

// Step 2: Validate environment — fail fast if misconfigured
import { env } from '@/config/environment';

// Step 3: Import express and create app
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

// Step 4: Import middleware
import { correlationId } from '@/middleware/correlationId';
import { errorHandler } from '@/middleware/errorHandler';

// Step 5: Import routes
import healthRouter from '@/routes/health';
import projectsRouter from '@/routes/projects';
import foldersRouter from '@/routes/folders';
import uploadsRouter from '@/routes/uploads';
import { folderDatasetsRouter, datasetRouter } from '@/routes/datasets';
import searchRouter from '@/routes/search';
import breadcrumbRouter from '@/routes/breadcrumb';
import authRouter from '@/routes/auth';
import membersRouter from '@/routes/members';
import columnStatsRouter from '@/routes/columnStats';
import versionsRouter from '@/routes/versions';
import { projectDuplicatesRouter, datasetDeduplicateRouter } from '@/routes/duplicates';
import { initWebSocketServer } from '@/websocket/server';
import { setupSwagger } from '@/docs/openapi';
import { shutdown } from '@/utils/shutdown';
import db from '@/config/database';
import { getWss } from '@/websocket/server';

const app = express();

// Apply middleware in correct order (Express processes sequentially)
// 1. Correlation ID — attach unique request ID before anything else
app.use(correlationId);

// 2. Helmet — security headers before any response
app.use(helmet());

// 3. CORS — headers for preflight requests
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  })
);

// 4. JSON body parsing
app.use(express.json({ limit: '10mb' }));

// 5. URL-encoded body parsing
app.use(express.urlencoded({ extended: true }));

// 6. Request logging
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Register routes
app.use('/health', healthRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/projects/:projectId/folders', foldersRouter);
app.use('/api/projects/:projectId/folders/:folderId', uploadsRouter);
app.use('/api/projects/:projectId/folders/:folderId/datasets', folderDatasetsRouter);
app.use('/api/datasets', datasetRouter);
app.use('/api/search', searchRouter);
app.use('/api/breadcrumb', breadcrumbRouter);
app.use('/api/auth', authRouter);
app.use('/api/projects/:projectId/members', membersRouter);
app.use('/api/datasets', columnStatsRouter);
app.use('/api/datasets', versionsRouter);
app.use('/api/datasets', datasetDeduplicateRouter);
app.use('/api/projects', projectDuplicatesRouter);

// OpenAPI/Swagger Documentation (BE-029)
setupSwagger(app);

// Global error handler LAST (Express identifies error handlers by 4-parameter signature)
app.use(errorHandler);

// Create HTTP server explicitly — required for future WebSocket attachment (BE-012)
const server = http.createServer(app);

// Attach WebSocket server (BE-012)
initWebSocketServer(server);

const PORT = env.PORT;

server.listen(PORT, () => {
  console.log(
    `[foundry-backend] Server started on port ${PORT} in ${env.NODE_ENV} mode`
  );
});

// Handle server errors
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.syscall !== 'listen') {
    throw error;
  }

  switch (error.code) {
    case 'EACCES':
      console.error(`Port ${PORT} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(`Port ${PORT} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
});

// Graceful shutdown (BE-030)
function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  shutdown(server, db, getWss() ?? undefined)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { app, server };
