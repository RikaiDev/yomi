import type { WorkItemProvider } from './provider.js'

export class WorkItemProviderRegistry {
  private readonly providers = new Map<string, WorkItemProvider>()

  register(provider: WorkItemProvider): this {
    if (this.providers.has(provider.id)) {
      throw new Error(`Work item provider already registered: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
    return this
  }

  resolve(id: string): WorkItemProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new Error(`Unknown work item provider: ${id}`)
    return provider
  }

  list(): WorkItemProvider[] {
    return [...this.providers.values()]
  }
}
