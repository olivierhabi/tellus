# TASK 20: 404 Handler and API Documentation Endpoint

This task has two sub-tasks.

## Objective
Create a catch-all handler that returns a structured 404 response for any request to an undefined API route. Without this, Express returns its default HTML 404 page, which is unhelpful for API consumers and reveals that the server is running Express.

## Exact Specification

Add a catch-all route in `server.js` AFTER all defined routes but BEFORE the error handler middleware:

## Sub-task 20A: 404 Catch-All Handlers

```javascript
// All defined routes
app.use('/api/v2', ontologyRoutes);
app.use('/api/v2', objectTypeRoutes);
// ... etc

// Catch-all for undefined routes (AFTER all routes, BEFORE error handler)
app.use('/api/v2/*', (req, res) => {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No endpoint found for ${req.method} ${req.originalUrl}`,
      details: {
        method: req.method,
        path: req.originalUrl,
        suggestion: 'Check the API documentation at GET /api/v2/docs for available endpoints'
      }
    }
  });
});

// Also catch requests outside /api/v2 prefix
app.use('*', (req, res) => {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `This server only handles requests under /api/v2/. You requested: ${req.originalUrl}`,
      details: {
        requestedPath: req.originalUrl,
        apiPrefix: '/api/v2'
      }
    }
  });
});

// Error handler (LAST)
app.use(errorHandler);
```

---

## Sub-task 20B: API Documentation Endpoint

Additionally, create a basic API documentation endpoint:

**Endpoint:** `GET /api/v2/docs`

This returns a machine-readable list of all available API endpoints with their methods, paths, and brief descriptions. This helps API consumers discover endpoints and is referenced in the 404 error message.

**Response (HTTP 200):**
```json
{
  "data": {
    "name": "Ontology System Engine API",
    "version": "1.0.0",
    "baseUrl": "/api/v2",
    "endpoints": [
      {
        "method": "POST",
        "path": "/ontology",
        "description": "Create a new Ontology"
      },
      {
        "method": "GET",
        "path": "/ontology/:ontologyId/objectTypes",
        "description": "List all Object Types in an Ontology"
      },
      {
        "method": "POST",
        "path": "/ontology/:ontologyId/objectTypes",
        "description": "Create a new Object Type"
      },
      {
        "method": "GET",
        "path": "/objects/:objectType",
        "description": "List objects of a type with pagination"
      },
      {
        "method": "POST",
        "path": "/objects/:objectType/search",
        "description": "Search objects with filters and aggregations"
      },
      {
        "method": "GET",
        "path": "/objects/:objectType/:primaryKey/view",
        "description": "Get complete Object View with links, actions, and interfaces"
      },
      {
        "method": "POST",
        "path": "/actions/:actionType/apply",
        "description": "Execute an Action"
      }
    ]
  }
}
```

Build this endpoint list programmatically by inspecting the Express router stack, NOT by maintaining a static list that can go stale. Express stores registered routes in `app._router.stack`. Walk the stack to extract all routes:

```javascript
function getRegisteredRoutes(app) {
  const routes = [];
  
  function processStack(stack, prefix = '') {
    stack.forEach(layer => {
      if (layer.route) {
        // This is a route
        const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
        methods.forEach(method => {
          routes.push({
            method,
            path: prefix + layer.route.path,
          });
        });
      } else if (layer.name === 'router' && layer.handle.stack) {
        // This is a nested router
        const routerPrefix = layer.regexp.source
          .replace('\\/?', '')
          .replace('(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/^\^/, '');
        processStack(layer.handle.stack, prefix + routerPrefix);
      }
    });
  }
  
  processStack(app._router.stack);
  return routes;
}
```

Note: This approach has caveats — Express's internal stack structure is not a public API and may change between versions. For week 1, this is acceptable. For production, maintain the endpoint list explicitly.

**Note:** `app._router.stack` is an Express internal API, not a public contract. Add a code comment in the implementation acknowledging this caveat.

## Verification
1. GET /api/v2/nonexistent → verify 404 with ROUTE_NOT_FOUND and helpful suggestion
2. POST /api/v2/nonexistent → verify same 404 (method doesn't matter for undefined routes)
3. GET /random/path → verify 404 with message about /api/v2 prefix
4. GET /api/v2/docs → verify endpoint list is populated and matches actual routes
5. Verify no HTML is returned for any 404 (all responses are JSON)
6. Add a new route to a route file → GET /api/v2/docs → verify the new route appears in the list
