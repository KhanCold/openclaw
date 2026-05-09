import type { AccessFacts } from "../turn/types.js";

/** @deprecated Compatibility fallback for older plugins that still set command authorizers. */
export function resolveAccessFactsCommandAuthorized(
  access: AccessFacts | undefined,
): boolean | undefined {
  const commands = access?.commands;
  if (!commands) {
    return undefined;
  }
  if (typeof commands.authorized === "boolean") {
    return commands.authorized;
  }
  return commands.authorizers?.some((entry) => entry.allowed);
}
