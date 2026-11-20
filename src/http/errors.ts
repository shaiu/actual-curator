/** Request-level failure; app.ts maps it to `{error:{code,message}}`. */
export class ApiError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  readonly code: string;
  constructor(status: 400 | 404 | 409 | 503, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
