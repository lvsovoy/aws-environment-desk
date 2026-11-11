/** Derive an explicit VPN action from profile identity, including shared DEV/INT mappings. */
export function vpnAction({ selectedProfile, connectedProfiles = [], busy = false, known = false }) {
  if (busy) return { action: 'busy', label: 'Working...', disabled: true };
  if (!known || !selectedProfile) return { action: 'unknown', label: 'Checking...', disabled: true };
  if (connectedProfiles.includes(selectedProfile)) return { action: 'disconnect', label: 'Disconnect', disabled: false };
  if (connectedProfiles.length) return { action: 'switch', label: 'Switch', disabled: false };
  return { action: 'connect', label: 'Connect', disabled: false };
}
