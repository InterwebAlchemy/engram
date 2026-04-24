import type { VoicePresetId } from './voice-presets.js';
import type { Placement } from './markers.js';

export type HarnessKey =
  | 'claudeCode'
  | 'claudeDesktop'
  | 'cursor'
  | 'vscode'
  | 'zed'
  | 'copilot'
  | 'windsurf'
  | 'opencode'
  | 'agentsSkills';

export interface HarnessOption {
  key: HarnessKey;
  label: string;
  envKey: string;
  description: string;
}

export interface ExistingConfig {
  source: 'config' | 'env' | 'default';
  configPath: string;
  vaultPath: string;
  engramRoot: string;
  snapshotDir: string;
  agentName: string;
  gitIdentity: string;
  gitName: string;
  gitEmail: string;
  harnesses: Record<HarnessKey, boolean>;
  claudeCodeScope: 'local' | 'user';
  voicePreset: VoicePresetId;
  shellProfilePath: string | null;
  cliBinDir: string | null;
}

export interface InitAnswers {
  agentName: string;
  gitName: string;
  gitEmail: string;
  vaultPath: string;
  engramRoot: string;
  snapshotDir: string;
  harnesses: Record<HarnessKey, boolean>;
  claudeCodeScope: 'local' | 'user';
  bootstrapPlacement: Placement;
  voicePreset: VoicePresetId;
  shellProfilePath: string | null;
  cliBinDir: string | null;
  runSetup: boolean;
  installObsidianPlugin: boolean;
}

export interface PersistedConfig {
  version: 1;
  vaultPath: string;
  engramRoot: string;
  snapshotDir: string;
  agentName: string;
  gitIdentity: string;
  harnesses: Record<HarnessKey, boolean>;
  claudeCodeScope: 'local' | 'user';
  voicePreset: VoicePresetId;
  shellProfilePath?: string;
  cliBinDir?: string;
}
