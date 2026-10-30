/** A failed call; `cancelled` when it was stopped on purpose, `code` a program's exit code, `status` an SFTP status. */
export class SessionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SessionError';
    Object.assign(this, extra);
  }
}
