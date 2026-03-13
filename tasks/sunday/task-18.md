# TASK 18: Input Sanitization and Security Hardening

This task has three sub-tasks.

**Depends on:** Task 15 (for `ValidationError` class)

## Objective
Add security-focused input sanitization to prevent injection attacks, prototype pollution, and other common vulnerabilities in the API. While the Ontology Engine is initially single-user, these protections must be in place from day one because adding security retroactively is error-prone and often incomplete.

## Exact Specification

Create a file at `/src/middleware/security.js` that exports security middleware functions.

## Sub-task 18A: Prototype Pollution Prevention and Field Size Limits

**1. Prototype Pollution Prevention**

JavaScript's prototype pollution vulnerability allows attackers to inject properties into `Object.prototype` via crafted JSON payloads containing `__proto__`, `constructor`, or `prototype` keys. Express's `express.json()` middleware parses JSON into plain objects, which can be exploited.

Create a middleware that recursively scans all parsed request bodies and rejects any that contain dangerous keys:

```javascript
function preventPrototypePollution(req, res, next) {
  if (req.body) {
    if (containsDangerousKeys(req.body)) {
      throw new ValidationError(
        'Request body contains forbidden keys (__proto__, constructor, prototype)',
        { code: 'FORBIDDEN_KEY' }
      );
    }
  }
  next();
}

function containsDangerousKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  
  const dangerousKeys = ['__proto__', 'prototype'];
  // Note: 'constructor' is NOT blocked because it is a legitimate English word that
  // could appear as a field name in business data (e.g., a 'constructor' field on a
  // Building object type). Only '__proto__' and 'prototype' are blocked.
  
  for (const key of Object.keys(obj)) {
    if (dangerousKeys.includes(key)) return true;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (containsDangerousKeys(obj[key])) return true;
    }
  }
  
  return false;
}
```

---

## Sub-task 18B: SQL Injection Static Analysis Scanner

Create this as a standalone script at `/src/security/sqlInjectionCheck.js` (NOT in the middleware directory — this is a CLI tool, not middleware).

**2. SQL Injection Prevention Verification**

While the codebase already uses parameterized queries (`$1`, `$2`), add a safety check: create a function that scans all `.js` files in `/src/routes/` and `/src/services/` for patterns that suggest string concatenation in SQL queries. This is a static analysis tool, not middleware:

```javascript
// Run as: node src/security/sqlInjectionCheck.js
const fs = require('fs');
const path = require('path');

const dangerousPatterns = [
  /pool\.query\s*\(\s*`[^`]*\$\{/,           // Template literal in query
  /pool\.query\s*\(\s*['"][^'"]*\+/,          // String concatenation in query
  /pool\.query\s*\(\s*[^'"`\s,]+\s*\+/,       // Variable concatenation
  /\.query\s*\(\s*['"].*\bWHERE\b.*['"].*\+/, // WHERE with concatenation
];

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const issues = [];
  
  lines.forEach((line, index) => {
    for (const pattern of dangerousPatterns) {
      if (pattern.test(line)) {
        issues.push({ file: filePath, line: index + 1, content: line.trim() });
      }
    }
  });
  
  return issues;
}

// Scan all source files
function scanDirectory(dir) {
  let allIssues = [];
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory() && file.name !== 'node_modules') {
      allIssues = allIssues.concat(scanDirectory(fullPath));
    } else if (file.name.endsWith('.js')) {
      allIssues = allIssues.concat(scanFile(fullPath));
    }
  }
  
  return allIssues;
}

const issues = scanDirectory(path.join(__dirname, '..'));
if (issues.length > 0) {
  console.error('POTENTIAL SQL INJECTION VULNERABILITIES FOUND:');
  issues.forEach(i => console.error(`  ${i.file}:${i.line} → ${i.content}`));
  process.exit(1);
} else {
  console.log('No SQL injection patterns detected.');
}
```

**IMPORTANT EXCEPTION:** There is ONE legitimate use of string concatenation in SQL — the Action type lookup query from Task 5 (Day 5) that does `AND rules::text LIKE '%"objectType":"' || $2 || '"%'`. This specific pattern uses `$2` (parameterized), but the concatenation is inside PostgreSQL, not in JavaScript. The scanner should flag it for manual review but it's actually safe because the `||` operator is in the SQL string, not in JavaScript. Add a comment in the source code explaining why this is safe:

```javascript
// SAFE: The || concatenation happens inside PostgreSQL, not JavaScript.
// $2 is a parameterized value, so it's properly escaped by the pg driver.
// This pattern is flagged by our SQL injection scanner — reviewed and confirmed safe.
```

**3. Request Size Limits**

Configure Express to reject oversized request bodies. Set the JSON body limit to 10MB (sufficient for CSV uploads but prevents abuse):

```javascript
app.use(express.json({ limit: '10mb' }));
```

Also add a middleware that rejects individual field values that exceed reasonable limits:

```javascript
function enforceFieldLimits(req, res, next) {
  if (req.body) {
    const issues = checkFieldLimits(req.body, '', 0);
    if (issues.length > 0) {
      throw new ValidationError('Request contains oversized fields', { fields: issues });
    }
  }
  next();
}

function checkFieldLimits(obj, path, depth) {
  const issues = [];
  const MAX_STRING_LENGTH = 1_000_000;  // 1MB per string field
  const MAX_ARRAY_LENGTH = 10_000;       // 10K items per array
  const MAX_DEPTH = 20;                  // 20 levels of nesting
  
  if (depth > MAX_DEPTH) {
    issues.push({ path, message: `Nesting depth exceeds maximum of ${MAX_DEPTH}` });
    return issues;
  }
  
  if (typeof obj === 'string' && obj.length > MAX_STRING_LENGTH) {
    issues.push({ path, message: `String length ${obj.length} exceeds maximum of ${MAX_STRING_LENGTH}` });
  }
  
  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_LENGTH) {
      issues.push({ path, message: `Array length ${obj.length} exceeds maximum of ${MAX_ARRAY_LENGTH}` });
    } else {
      obj.forEach((item, i) => {
        issues.push(...checkFieldLimits(item, `${path}[${i}]`, depth + 1));
      });
    }
  }
  
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      issues.push(...checkFieldLimits(value, path ? `${path}.${key}` : key, depth + 1));
    }
  }
  
  return issues;
}
```

---

## Sub-task 18C: CORS Configuration and Security Response Headers

**4. CORS Configuration**

For week 1, allow all origins (the UI will come in week 2). But set this up with a configuration variable so it's easy to restrict later:

```javascript
const cors = require('cors');

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'X-Total-Count'],
  maxAge: 86400, // Cache preflight for 24 hours
}));
```

Install the `cors` package: `npm install cors`

**5. Security Headers**

Add standard security headers to all responses:

```javascript
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Disable XSS auditor (deprecated, can cause issues)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store'); // API responses should not be cached
  res.setHeader('Pragma', 'no-cache');
  next();
}
```

**Register all middleware in server.js in this exact order (incorporating Task 16's `requestLogger` placement):**
```javascript
app.use(securityHeaders);
app.use(cors({...}));
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(preventPrototypePollution);
app.use(enforceFieldLimits);
// ... routes ...
app.use(errorHandler);
```

## Verification
1. Send `{"__proto__": {"isAdmin": true}}` in request body → verify 400 rejection
2. Send a 50MB request body → verify 413 rejection
3. Send a string field with 2MB of text → verify field limit rejection
4. Send deeply nested JSON (25 levels) → verify depth limit rejection
5. Run the SQL injection scanner → verify 0 issues (or only the known-safe pattern)
6. Verify CORS headers are present on all responses
7. Verify security headers (X-Content-Type-Options, etc.) are present on all responses
8. Verify no response includes Cache-Control: public or any caching directive
9. Send a normal valid request → verify it passes all security checks and reaches the handler
