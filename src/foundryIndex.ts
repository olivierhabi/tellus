// Step 1: Load environment variables FIRST
import dotenv from 'dotenv';
dotenv.config();

// Step 2: Import foundry env config
import { foundryEnv } from './config/foundryEnv';

// Step 3: Import express and create app
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

// Step 4: Import middleware
import { correlationId } from './middleware/correlationId';
import { errorHandler } from './middleware/foundryErrorHandler';

// Step 5: Import routes
import healthRouter from './routes/foundryHealth';
import projectsRouter from './routes/projects';
import foldersRouter from './routes/folders';
import uploadsRouter from './routes/uploads';
import uploadProgressRouter from './routes/uploadProgress';
import { folderDatasetsRouter, datasetRouter } from './routes/foundryDatasets';
import searchRouter from './routes/search';
import breadcrumbRouter from './routes/breadcrumb';
import membersRouter from './routes/members';
import columnStatsRouter from './routes/columnStats';
import versionsRouter from './routes/versions';
import { projectDuplicatesRouter, datasetDeduplicateRouter } from './routes/duplicates';
import foundryPreferencesRouter from './routes/preferences';
import { initWebSocketServer } from './websocket/server';
import { setupSwagger } from './docs/openapi';
import { shutdown } from './utils/shutdown';
import foundryDb from './config/foundryDb';
import { getWss } from './websocket/server';

const app = express();

// Apply middleware in correct order
app.use(correlationId);
app.use(helmet());
app.use(
  cors({
    origin: foundryEnv.FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(foundryEnv.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Register routes
app.use('/health', healthRouter);
app.use('/api/v1/projects', projectsRouter);
app.use('/api/v1/projects/:projectId/folders', foldersRouter);
app.use('/api/v1/projects/:projectId/folders/:folderId', uploadsRouter);
app.use('/api/v1/uploads', uploadProgressRouter);
app.use('/api/v1/projects/:projectId/folders/:folderId/datasets', folderDatasetsRouter);
app.use('/api/v1/datasets', datasetRouter);
app.use('/api/v1/search', searchRouter);
app.use('/api/v1/breadcrumb', breadcrumbRouter);
app.use('/api/v1/projects/:projectId/members', membersRouter);
app.use('/api/v1/datasets', columnStatsRouter);
app.use('/api/v1/datasets', versionsRouter);
app.use('/api/v1/datasets', datasetDeduplicateRouter);
app.use('/api/v1/projects', projectDuplicatesRouter);
app.use('/api/users/me/preferences', foundryPreferencesRouter);

// OpenAPI/Swagger Documentation
setupSwagger(app);

// Global error handler LAST
app.use(errorHandler);

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket server
initWebSocketServer(server);

const PORT = foundryEnv.PORT;

server.listen(PORT, () => {
  console.log(
    `[foundry-backend] Server started on port ${PORT} in ${foundryEnv.NODE_ENV} mode`
  );
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.syscall !== 'listen') throw error;
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

function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  shutdown(server, foundryDb, getWss() ?? undefined)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { app, server };
