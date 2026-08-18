export class HarnessError extends Error {
  public readonly target?: string;
  public readonly command?: string;

  constructor(message: string, target?: string, command?: string) {
    super(message);
    this.name = 'HarnessError';
    this.target = target;
    this.command = command;
  }
}

export class LeaseError extends Error {
  public readonly windowTarget: string;
  public readonly dispatchId?: string;

  constructor(message: string, windowTarget: string, dispatchId?: string) {
    super(message);
    this.name = 'LeaseError';
    this.windowTarget = windowTarget;
    this.dispatchId = dispatchId;
  }
}
