export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    isOperational = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    // Ensure the name of this error is the same as the class name
    this.name = this.constructor.name;

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
  }
}

// Common error factory functions
export const NotFoundError = (message: string) =>
  new AppError(message, 404, 'NOT_FOUND');

export const ValidationError = (message: string) =>
  new AppError(message, 400, 'VALIDATION_ERROR');

export const ConflictError = (message: string) =>
  new AppError(message, 409, 'CONFLICT');

export const UnauthorizedError = (message: string) =>
  new AppError(message, 401, 'UNAUTHORIZED');

export const ForbiddenError = (message: string) =>
  new AppError(message, 403, 'FORBIDDEN');

export const InternalError = (message: string) =>
  new AppError(message, 500, 'INTERNAL_ERROR', false);
