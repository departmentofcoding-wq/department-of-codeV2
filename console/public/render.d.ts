import type {
  DashboardDTO,
  TaskSummaryDTO,
  FindingDTO,
  JournalEntryDTO,
  WorkerDTO,
  ApiErrorResponse
} from '../contract.ts';

export function escapeHtml(str: unknown): string;
export function renderDashboardTileGrid(dto: DashboardDTO): string;
export function renderTaskTable(tasks: TaskSummaryDTO[]): string;
export function renderFindingsList(findings: FindingDTO[]): string;
export function renderWorkers(workers: WorkerDTO[]): string;
export function renderJournalTimeline(journal: JournalEntryDTO[]): string;
export function renderRelaunchState(reason?: string): string;
export function renderErrorToast(error: ApiErrorResponse | string): string;
