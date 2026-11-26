export type StudioErrorCode = 'invalid_request' | 'not_found' | 'conflict' | 'busy';

/** An expected error with a message that is safe to show to the user. */
export class StudioError extends Error {
  readonly code: StudioErrorCode;

  constructor(code: StudioErrorCode, message: string) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
  }
}

export const HTTP_STATUS: Record<StudioErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  busy: 409,
};
