import { Response } from 'express';

interface SuccessResponse {
  status: 'ok';
  data: unknown;
  meta?: Record<string, unknown>;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function sendSuccess(
  res: Response,
  data: unknown,
  statusCode = 200,
  meta?: Record<string, unknown>
) {
  const response: SuccessResponse = {
    status: 'ok',
    data,
  };

  if (meta) {
    response.meta = meta;
  }

  res.status(statusCode).json(response);
}

export function sendCreated(
  res: Response,
  data: unknown,
  meta?: Record<string, unknown>
) {
  sendSuccess(res, data, 201, meta);
}

export function sendNoContent(res: Response) {
  res.status(204).send();
}

export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
) {
  const response: ErrorResponse = {
    error: {
      code,
      message,
    },
  };

  if (details !== undefined) {
    response.error.details = details;
  }

  res.status(statusCode).json(response);
}
