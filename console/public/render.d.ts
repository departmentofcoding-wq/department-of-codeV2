import type {
  DashboardDTO,
  TaskSummaryDTO,
  FlowSnapshotDTO,
  FindingDTO,
  JournalEntryDTO,
  WorkerDTO,
  AssetDTO,
  ProjectDTO,
  ApiErrorResponse,
  NtfySettingsDTO,
  GithubSettingsDTO
} from '../contract.ts';

export function escapeHtml(str: unknown): string;
export function safeHref(url: unknown): string;
export function renderDashboardTileGrid(dto: DashboardDTO): string;
export function renderTaskTable(tasks: TaskSummaryDTO[]): string;
export function renderArchivedTaskTable(tasks: TaskSummaryDTO[]): string;
export function renderCompletedTaskTable(tasks: TaskSummaryDTO[]): string;
export function renderFlowPipeline(snapshot: FlowSnapshotDTO | null): string;
export function renderFindingsList(findings: FindingDTO[]): string;
export function renderWorkers(workers: WorkerDTO[]): string;
export function renderAssetsTable(assets: AssetDTO[]): string;
export function renderProjectsTable(projects: ProjectDTO[]): string;
export function renderProvisioningChip(jobId: string, name: string, state: string): string;
export function renderJournalTimeline(journal: JournalEntryDTO[]): string;
export function renderGithubSettingsCard(status?: GithubSettingsDTO): string;
export function renderNtfySettingsCard(status?: NtfySettingsDTO): string;
export function renderSettings(settings?: { theme?: string; isPaused?: boolean; hasToken?: boolean; tokenPreview?: string; googleKeys?: any; ntfySettings?: NtfySettingsDTO; githubSettings?: GithubSettingsDTO }): string;
export function renderRelaunchState(reason?: string): string;
export function renderErrorToast(error: ApiErrorResponse | string): string;


