import {
  DETERMINISTIC_ATTRIBUTION,
  type DbConnection,
  type IdeDriver,
  type IdeDriverAction,
  type IdeDriverActResult,
  type IdeDriverLaunchOptions,
  type IdeDriverReadResult,
  type IdeDriverSnapshotResult
} from '../contract/index.ts';
import { journal } from '../journal/writer.ts';

export class UncalibratedSelectorError extends Error {
  public readonly selectorKey: string;
  public readonly status: string | null;

  constructor(selectorKey: string, status: string | null) {
    super(
      `Selector "${selectorKey}" is not calibrated (current status: ${status ?? 'unregistered'}). Action refused by calibration gate.`
    );
    this.name = 'UncalibratedSelectorError';
    this.selectorKey = selectorKey;
    this.status = status;
  }
}

export class GatedIdeDriver implements IdeDriver {
  constructor(
    private readonly innerDriver: IdeDriver,
    private readonly db: DbConnection
  ) {}

  private checkGate(selectorKey: string, action: string): void {
    const row = this.db.get<{ status: string }>('SELECT status FROM bureau_selectors WHERE key = ?', selectorKey);
    const status = row?.status ?? null;

    if (status !== 'calibrated') {
      journal(this.db, {
        kind: 'guardrail',
        attribution: {
          actor_role: 'system',
          ...DETERMINISTIC_ATTRIBUTION
        },
        detail: {
          action: 'gate_refusal',
          selectorKey,
          requestedAction: action,
          status: status ?? 'unregistered'
        }
      });

      throw new UncalibratedSelectorError(selectorKey, status);
    }
  }

  async launch(opts?: IdeDriverLaunchOptions): Promise<void> {
    await this.innerDriver.launch(opts);
  }

  async navigate(url: string): Promise<void> {
    await this.innerDriver.navigate(url);
  }

  async read(selectorKey: string): Promise<IdeDriverReadResult> {
    this.checkGate(selectorKey, 'read');
    return await this.innerDriver.read(selectorKey);
  }

  async act(selectorKey: string, action: IdeDriverAction, value?: string): Promise<IdeDriverActResult> {
    this.checkGate(selectorKey, action);
    return await this.innerDriver.act(selectorKey, action, value);
  }

  async snapshot(): Promise<IdeDriverSnapshotResult> {
    return await this.innerDriver.snapshot();
  }

  async close(): Promise<void> {
    await this.innerDriver.close();
  }
}
