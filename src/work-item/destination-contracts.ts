import type {
  ProviderDeliveryResult,
  ProviderValidation,
  WorkItemProvider,
} from './provider.js'
import type { WorkItemDraft } from './types.js'

/**
 * Contracts only: no Discord or issue-tracker implementation is registered
 * until the corresponding credential/connector is explicitly configured.
 */
export interface DiscordWorkItemProvider extends WorkItemProvider {
  readonly id: 'discord'
  readonly config: DiscordProviderConfig
  validate(draft: WorkItemDraft): ProviderValidation
  deliver(draft: WorkItemDraft): Promise<ProviderDeliveryResult>
}

export interface DiscordProviderConfig {
  serverId: string
  channelId: string
}

export interface IssueWorkItemProvider extends WorkItemProvider {
  readonly id: 'issue'
  readonly config: IssueProviderConfig
  validate(draft: WorkItemDraft): ProviderValidation
  deliver(draft: WorkItemDraft): Promise<ProviderDeliveryResult>
}

export interface IssueProviderConfig {
  projectId: string
  issueType: 'bug' | 'task' | 'feature'
}
