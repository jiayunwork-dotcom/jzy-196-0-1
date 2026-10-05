/**
 * Domain errors surfaced by the API layer as structured 4xx responses.
 * Every validation error carries the offending field name.
 */

export interface FieldError {
  field: string;
  message: string;
}

export class DomainValidationError extends Error {
  readonly errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    this.name = 'DomainValidationError';
    this.errors = errors;
  }
}

export class StaleVersionError extends Error {
  readonly currentVersion: number;
  constructor(baseVersion: number, currentVersion: number) {
    super(`base version ${baseVersion} is stale; current version is ${currentVersion}`);
    this.name = 'StaleVersionError';
    this.currentVersion = currentVersion;
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'ConflictError';
  }
}
