# TASK 29: Docker Compose File for One-Command Setup

## Objective
Create `/docker-compose.yml` that starts the entire system (PostgreSQL, OpenSearch, and the Node.js server) with a single `docker-compose up` command. Include health checks, volume mounts for data persistence, and environment variable configuration.

## Exact Specification

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: ontology
      POSTGRES_PASSWORD: ontology
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
  
  opensearch:
    image: opensearchproject/opensearch:2.17.0
    environment:
      - discovery.type=single-node
      - DISABLE_SECURITY_PLUGIN=true
      - "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m"
    ports:
      - "9200:9200"
    volumes:
      - osdata:/usr/share/opensearch/data
    healthcheck:
      test: ["CMD-SHELL", "curl -s http://localhost:9200 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
  
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      PG_HOST: postgres
      OPENSEARCH_URL: http://opensearch:9200
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
      opensearch:
        condition: service_healthy

volumes:
  pgdata:
  osdata:
```

Also create a `Dockerfile` for the Node.js application:
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
```

**Migration strategy:** The API service must run database migrations automatically on startup before accepting HTTP connections. Add a startup script or modify `server.js` to call the migration runner (Task 1) before starting the Express listener. The Dockerfile's `COPY src/ ./src/` captures everything under `/src`, which includes migrations, seeds, and schemas.

And create a `.dockerignore` file with the following exact content:
```
node_modules
src/tests
src/benchmarks
docs
.git
.env
*.md
.vscode
.idea
```

## Verification
1. `docker-compose up` → all 3 services start and become healthy
2. `curl http://localhost:3000/api/v1/health` → returns 200 with all services connected
3. Run the seed script against the Docker setup → all data loads correctly (requires Task 26 to be complete)
4. `docker-compose down && docker-compose up` → data persists (volumes)
5. The Docker image is less than 200MB
