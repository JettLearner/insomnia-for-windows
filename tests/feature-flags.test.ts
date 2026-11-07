import { describe, expect, it } from 'vitest';
import { AUTOPILOT_ENV_VAR, isAutopilotEnabled } from '../electron/core/feature-flags';

describe('autopilot feature flag', () => {
  it('stays off unless the launch opted in', () => {
    expect(isAutopilotEnabled({})).toBe(false);
    expect(isAutopilotEnabled({ [AUTOPILOT_ENV_VAR]: '0' })).toBe(false);
    expect(isAutopilotEnabled({ [AUTOPILOT_ENV_VAR]: 'true' })).toBe(false);
    expect(isAutopilotEnabled({ [AUTOPILOT_ENV_VAR]: '' })).toBe(false);
  });

  it('turns on for the explicit opt-in value', () => {
    expect(isAutopilotEnabled({ [AUTOPILOT_ENV_VAR]: '1' })).toBe(true);
  });
});
