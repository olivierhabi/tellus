export function sanitizeK8sResourceName(rid: string, branch: string): string {
  const cleanRid = rid.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const cleanBranch = branch.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `ws-${cleanRid}-${cleanBranch}`.substring(0, 63).replace(/-+$/, '');
}
