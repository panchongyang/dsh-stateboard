export class BoardError extends Error {
  constructor(code, message, { status = 409, details = null } = {}) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
