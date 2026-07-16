/**
 * LINE auth/session logout runtime.
 */

/**
 * Clear stored credentials while preserving the phone number and region, so
 * a later re-login can prefill both (and, on a client without MCP
 * elicitation, run fully argument-free via `login`). Neither is auth
 * material; this matches invalidateSession, which already keeps them.
 *
 * @param service - LineProtocolService instance
 */
async function clearCredentialsKeepingPhone(service: any): Promise<void> {
  const savedPhone = await service.credentialStore?.get?.('line_phone')
  const savedRegion = await service.credentialStore?.get?.('line_region')
  await service.credentialStore.clearAll()
  if (savedPhone) {
    await service.credentialStore?.set?.('line_phone', savedPhone)
  }
  if (savedRegion) {
    await service.credentialStore?.set?.('line_region', savedRegion)
  }
}

/**
 * Log out from LINE by attempting a server-side logout first, then clearing the
 * local session snapshot regardless of server acknowledgement.
 *
 * @param service - LineProtocolService instance
 * @param disconnectedState - DISCONNECTED state constant from service
 */
export async function performLogout(
  service: any,
  disconnectedState: string,
): Promise<void> {
  try {
    service.client?.stopPolling?.()
  } catch {
    // Polling may already be stopped
  }

  try {
    await service.client?.logoutZ?.()
  } catch (error: any) {
    service.logger?.warn?.('line.logout.remote_failed', {
      error: error?.message || String(error),
    })
  }

  await clearCredentialsKeepingPhone(service)

  service.client = null
  service.profile = null
  service.e2eeWarning = false
  service.loginRequired = false
  service.loginReason = null
  service.nameCache.clear()
  service.chatCache.clear()
  service.setState(disconnectedState)
  service.emit('line:loginRequired')
}
