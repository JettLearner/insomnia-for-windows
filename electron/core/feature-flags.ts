/**
 * Autopilot is not part of the published build. The code stays in the repository, but its entry
 * points are hidden and its scheduler stays idle unless the app is started with
 * INSOMNIAZ_AUTOPILOT=1.
 *
 * Autopilot 不随发布版提供。代码保留在仓库中，但入口默认隐藏、调度器默认不启动，
 * 只有以 INSOMNIAZ_AUTOPILOT=1 启动应用时才会启用。
 */
export const AUTOPILOT_ENV_VAR = 'INSOMNIAZ_AUTOPILOT';

export function isAutopilotEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[AUTOPILOT_ENV_VAR] === '1';
}
