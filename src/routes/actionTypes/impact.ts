// ---------------------------------------------------------------------------
// Action Type Routes — Impact
//
// GET /:actionApiName/impact — action type impact analysis.
// Extracted from the former god-file routes/actionTypes.ts (behavior-preserving
// move; route registration order is unchanged — see ./index.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../../db";
import { getActionType } from "../../models/actionType";
import { sendError, sendSuccess } from "../../utils/responseFormatter";
import { OntologyError } from "../../utils/queryErrors";
import {
  KNOWN_CODES,
} from "./shared";

export function registerImpactRoutes(router: Router): void {
// ---------------------------------------------------------------------------
// Endpoint 6: GET /:actionApiName/impact (Action Type Impact Analysis) — Task 24
//
// Analyses an action type's impact by inspecting its rules to determine
// which object types, properties, and link types it touches. Also returns
// execution statistics from the audit log and warnings for any missing
// references (e.g. a rule references a deleted object type).
// ---------------------------------------------------------------------------

router.get(
  "/:actionApiName/impact",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;

      // 1. Load the action type
      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }

      const rules = (row.rules ?? []) as Array<Record<string, unknown>>;
      const warnings: string[] = [];

      // 2. Parse rules to extract object types, properties, and link types
      // Map: objectTypeApiName -> { operations: Set, properties: Set }
      const objectTypeMap = new Map<
        string,
        { operations: Set<string>; properties: Set<string> }
      >();
      const linkTypeSet = new Map<string, Set<string>>(); // apiName -> Set<operation>

      for (const rule of rules) {
        const ruleType = rule.type as string;

        if (
          ruleType === "createObject" ||
          ruleType === "modifyObject" ||
          ruleType === "deleteObject"
        ) {
          const objType = rule.objectType as string;
          if (!objType) continue;

          if (!objectTypeMap.has(objType)) {
            objectTypeMap.set(objType, {
              operations: new Set(),
              properties: new Set(),
            });
          }
          const entry = objectTypeMap.get(objType)!;

          // Map rule type to operation verb
          if (ruleType === "createObject") entry.operations.add("create");
          else if (ruleType === "modifyObject") entry.operations.add("modify");
          else if (ruleType === "deleteObject") entry.operations.add("delete");

          // Extract property names from create/modify rules
          if (
            (ruleType === "createObject" || ruleType === "modifyObject") &&
            rule.properties &&
            typeof rule.properties === "object"
          ) {
            for (const propName of Object.keys(
              rule.properties as Record<string, unknown>
            )) {
              entry.properties.add(propName);
            }
          }
        }

        if (ruleType === "addLink" || ruleType === "removeLink") {
          const linkApiName =
            (rule.linkTypeApiName as string) || (rule.linkType as string);
          if (!linkApiName) continue;

          if (!linkTypeSet.has(linkApiName)) {
            linkTypeSet.set(linkApiName, new Set());
          }
          linkTypeSet
            .get(linkApiName)!
            .add(ruleType === "addLink" ? "add" : "remove");
        }
      }

      // 3. Verify each referenced object type exists and check properties
      const affectedObjectTypes: Array<Record<string, unknown>> = [];

      for (const [objApiName, info] of objectTypeMap) {
        const otResult = await query(
          "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
          [ontologyId, objApiName]
        );
        const exists = otResult.rows.length > 0;

        if (!exists) {
          warnings.push(
            `Object type '${objApiName}' referenced in rules does not exist in ontology.`
          );
        }

        // Check properties exist on the object type
        const propertiesModified = Array.from(info.properties);
        if (exists && propertiesModified.length > 0) {
          const objectTypeId = otResult.rows[0].object_type_id as string;
          const propResult = await query(
            "SELECT api_name FROM property WHERE object_type_id = $1",
            [objectTypeId]
          );
          const existingProps = new Set<string>(
            propResult.rows.map(
              (r: Record<string, unknown>) => r.api_name as string
            )
          );
          for (const propName of propertiesModified) {
            if (!existingProps.has(propName)) {
              warnings.push(
                `Property '${propName}' on object type '${objApiName}' referenced in rules does not exist.`
              );
            }
          }
        }

        affectedObjectTypes.push({
          apiName: objApiName,
          exists,
          operations: Array.from(info.operations),
          propertiesModified,
        });
      }

      // 4. Verify each referenced link type exists
      const affectedLinkTypes: Array<Record<string, unknown>> = [];

      for (const [linkApiName, ops] of linkTypeSet) {
        const ltResult = await query(
          "SELECT link_type_id FROM link_type WHERE ontology_id = $1 AND api_name = $2",
          [ontologyId, linkApiName]
        );
        const exists = ltResult.rows.length > 0;

        if (!exists) {
          warnings.push(
            `Link type '${linkApiName}' referenced in rules does not exist in ontology.`
          );
        }

        affectedLinkTypes.push({
          apiName: linkApiName,
          exists,
          operations: Array.from(ops),
        });
      }

      // 5. Query execution statistics from audit log
      const statsResult = await query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE result = 'success') AS success_count,
                MAX(executed_at) AS last_executed_at
         FROM action_audit_log
         WHERE action_type_api_name = $1`,
        [actionApiName]
      );

      const last30Result = await query(
        `SELECT COUNT(*) AS count
         FROM action_audit_log
         WHERE action_type_api_name = $1
           AND executed_at > NOW() - INTERVAL '30 days'`,
        [actionApiName]
      );

      const totalExecutions = parseInt(statsResult.rows[0].total, 10);
      const successCount = parseInt(statsResult.rows[0].success_count, 10);
      const last30DayExecutions = parseInt(last30Result.rows[0].count, 10);
      const successRate =
        totalExecutions > 0
          ? Math.round((successCount / totalExecutions) * 100) / 100
          : 0;
      const lastExecutedAt = statsResult.rows[0].last_executed_at ?? null;

      // 6. Build response
      sendSuccess(res, {
        actionTypeApiName: actionApiName,
        affectedObjectTypes,
        affectedLinkTypes,
        executionStats: {
          totalExecutions,
          last30DayExecutions,
          successRate,
          lastExecutedAt,
        },
        warnings,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);
}
