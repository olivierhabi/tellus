// Quiver B9 — Tool registry + authorization filter.

import type {
  AuthPort,
  ToolManifestEntry,
  ToolName,
  UserSubject,
} from "./types.js";

const FULL_MANIFEST: ReadonlyArray<ToolManifestEntry> = [
  {
    name: "object_query",
    description: "Filter / aggregate / inspect / traverse for any object type.",
    inputSchema: { type: "object" },
  },
  {
    name: "function_call",
    description: "Invoke any allowed Tellus Function or AIP Logic function.",
    inputSchema: { type: "object" },
  },
  {
    name: "apply_action",
    description:
      "Invoke a deterministic action (bypasses LLM for the apply itself).",
    inputSchema: { type: "object" },
  },
  {
    name: "update_application_variable",
    description: "Set a Parameter card's value.",
    inputSchema: { type: "object" },
  },
  {
    name: "command",
    description: "Quiver-specific: add a card, delete a card, bind input.",
    inputSchema: { type: "object" },
  },
  {
    name: "ontology_context",
    description: "Ontology look-up replacing legacy semantic-search tool.",
    inputSchema: { type: "object" },
  },
];

export function fullToolManifest(): ReadonlyArray<ToolManifestEntry> {
  return FULL_MANIFEST;
}

/**
 * B9 C-07: pre-filter manifest. Any tool the user is not permitted to invoke
 * is dropped from the manifest sent to the LLM, so the LLM cannot propose a
 * call we'd subsequently have to refuse.
 */
export async function buildAuthorizedManifest(args: {
  user: UserSubject;
  branch: string;
  /** When apply_action is in scope, the candidate actionTypeRid for the analysis. Optional. */
  candidateActionTypeRid?: string;
  auth: AuthPort;
}): Promise<{
  manifest: ReadonlyArray<ToolManifestEntry>;
  removed: ReadonlyArray<ToolName>;
}> {
  const removed: ToolName[] = [];
  const out: ToolManifestEntry[] = [];

  for (const entry of FULL_MANIFEST) {
    if (entry.name === "apply_action") {
      // Only retain apply_action if the user can actually apply at least one
      // configured action on the analysis (B9 C-07).
      if (!args.candidateActionTypeRid) {
        removed.push("apply_action");
        continue;
      }
      const ok = await args.auth.canApplyAction({
        userRid: args.user.userRid,
        actionTypeRid: args.candidateActionTypeRid,
        branch: args.branch,
      });
      if (!ok) {
        removed.push("apply_action");
        continue;
      }
    }
    out.push(entry);
  }

  return { manifest: out, removed };
}
