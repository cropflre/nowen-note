export const CLOUD_REPO: string;
export const BUILD_WORKFLOW: string;
export const PUBLISH_WORKFLOW: string;
export const BUILD_TARGETS: readonly ['windows', 'macos', 'linux', 'android', 'ios', 'store', 'docker', 'fpk', 'upk', 'clipper'];
export const PUBLISH_CHANNELS: readonly ['github', 'docker', 'testflight'];
export type BuildTarget = typeof BUILD_TARGETS[number];
export type PublishChannel = typeof PUBLISH_CHANNELS[number];
export interface BuildRequest { version: string; request_id: string; commit_sha: string; notes: string; targets: BuildTarget[] }
export interface PublishRequest { version: string; request_id: string; source_run_id: number; source_attempt: number; channels: PublishChannel[]; confirmation: string }
export function version(value: unknown): string;
export function branch(value: unknown): string;
export function normalizeBuild(input: unknown): BuildRequest;
export function normalizePublish(input: unknown): PublishRequest;
export function expectedArtifacts(request: BuildRequest): string[];
export function assertBuildRun(run: any, id: number, attempt: number): void;

export function compareVersions(left: string, right: string): number;
