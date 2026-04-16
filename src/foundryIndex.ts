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
import { folderDatasetsRouter, datasetRouter } from './routes/foundryDatasets';
import searchRouter from './routes/search';
import breadcrumbRouter from './routes/breadcrumb';
import authRouter from './routes/auth';
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
