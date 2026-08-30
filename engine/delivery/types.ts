export class DeliveryError extends Error {
  public readonly code: string;
  public readonly taskId?: string;

  constructor(message: string, code = 'DELIVERY_ERROR', taskId?: string) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.taskId = taskId;
  }
}

/**
 * A precondition REFUSAL (wrong task state, missing approval, reviewed_commit
 * mismatch) — deterministic, so the runner marks the job dead on the first
 * failure instead of retrying a refusal that can never change (the 2026-08-28
 * zombie pr.create retried "task is done" twice after the work had shipped).
 */
export class PrRefusalError extends DeliveryError {
  public readonly nonRetryable = true;
  constructor(message: string, code = 'PR_CREATE_REFUSED', taskId?: string) {
    super(message, code, taskId);
    this.name = 'PrRefusalError';
  }
}
