export const FINDING_CLASS_VERIFYING_NO_VERIFY_RUN = 'verifying_no_verify_run';
export const FINDING_CLASS_EXPIRED_LEASE_UNREAPED = 'expired_lease_unreaped';
export const FINDING_CLASS_DEADLETTER_RETRIES_REMAINING = 'deadletter_retries_remaining';
export const FINDING_CLASS_DISPATCH_NO_LIVE_LEASE = 'dispatch_no_live_lease';

export const WATCHDOG_FINDING_CLASSES = [
  FINDING_CLASS_VERIFYING_NO_VERIFY_RUN,
  FINDING_CLASS_EXPIRED_LEASE_UNREAPED,
  FINDING_CLASS_DEADLETTER_RETRIES_REMAINING,
  FINDING_CLASS_DISPATCH_NO_LIVE_LEASE
] as const;

export type WatchdogFindingClass = (typeof WATCHDOG_FINDING_CLASSES)[number];
