import test from 'node:test';
import assert from 'node:assert/strict';
import { vpnAction } from './desktop/vpn-action.js';

/** Match explicit action labels to profile connectivity, not the selected environment's display name. */
test('VPN pill selects connect, disconnect and switch from confirmed status', () => {
  const state = { selectedProfile: 'DEV', known: true };
  assert.deepEqual(vpnAction(state), { action: 'connect', label: 'Connect', disabled: false });
  assert.deepEqual(vpnAction({ ...state, connectedProfiles: ['DEV'] }), { action: 'disconnect', label: 'Disconnect', disabled: false });
  assert.deepEqual(vpnAction({ ...state, connectedProfiles: ['STAGE'] }), { action: 'switch', label: 'Switch', disabled: false });
  assert.equal(vpnAction({ ...state, connectedProfiles: ['STAGE', 'DEV'] }).action, 'disconnect');
  assert.equal(vpnAction({ ...state, busy: true }).disabled, true);
  assert.equal(vpnAction({ ...state, known: false }).disabled, true);
  assert.equal(vpnAction({ known: true }).disabled, true);
});
