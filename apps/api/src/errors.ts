/** An error that maps to an HTTP response with a stable, machine-readable code. */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Sign in first') => new HttpError(401, 'unauthenticated', message);
export const forbidden = (code: string, message: string, details?: unknown) => new HttpError(403, code, message, details);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new HttpError(422, code, message, details);
