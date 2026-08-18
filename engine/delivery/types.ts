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
