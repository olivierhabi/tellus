export interface RuntimeUserState {
  enabled: boolean;
}

export function isExecutableOwner(
  owner: RuntimeUserState | null | undefined,
): owner is RuntimeUserState {
  return owner?.enabled === true;
}

export function hasRuntimeMarkingBypass(roles: readonly string[]): boolean {
  return roles.some((role) => role.toLowerCase() === "tellus-superadmin");
}
