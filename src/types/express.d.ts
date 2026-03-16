import 'express';
import 'express-serve-static-core';

declare module 'express' {
  interface Request {
    correlationId: string;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}
