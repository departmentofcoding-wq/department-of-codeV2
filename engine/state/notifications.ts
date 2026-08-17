export interface OperatorNotifier {
  notifyOperator(targetId: string, reason: string): void;
}

export function notifyOperator(targetId: string, reason: string): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'WARN',
      msg: 'operator_notified',
      targetId,
      reason
    })
  );
}

export const defaultNotifier: OperatorNotifier = {
  notifyOperator(targetId: string, reason: string): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'WARN',
        msg: 'operator_notified',
        targetId,
        reason
      })
    );
  }
};
