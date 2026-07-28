// ---------------------------------------------------------------------------
// OMS v2 mappers (Phase 11) — adapters over the EXISTING
// metadata model. No renames in storage; v2 shape is computed.
//
// Verified shapes (from @osdk/foundry.ontologies@2.70.0):
//   ObjectTypeV2 { apiName, displayName, status, description?,
//                  pluralDisplayName, icon, primaryKey, properties,
//                  rid, titleProperty, visibility?, aliases,
//                  datasources }
//   PropertyV2   { description?, displayName?, dataType, rid,
//                  status?, visibility?, typeClasses }
//   LinkTypeSideV2 { apiName, displayName, status,
//                    objectTypeApiName, cardinality,
//                    foreignKeyPropertyApiName?, linkTypeRid }
//   ActionTypeV2 { apiName, description?, displayName?, status,
//                  parameters: Record<ParameterId, ActionParameterV2>,
//                  rid, operations: Array<LogicRule> }
//   ReleaseStatus = ACTIVE | ENDORSED | EXPERIMENTAL | DEPRECATED
//
// RIDs use the row's stable UUID — they survive renames.
// ---------------------------------------------------------------------------

import { query } from "../../db";

export const OBJECT_TYPE_RID_PREFIX = "ri.ontology.main.object-type.";
export const LINK_TYPE_RID_PREFIX = "ri.ontology.main.link-type.";
export const ACTION_TYPE_RID_PREFIX = "ri.ontology.main.action-type.";
export const INTERFACE_RID_PREFIX = "ri.ontology.main.interface.";
export const PROPERTY_TYPE_RID_PREFIX = "ri.ontology.main.property-type.";

type ReleaseStatus = "ACTIVE" | "ENDORSED" | "EXPERIMENTAL" | "DEPRECATED";

const ARRAY_TYPES: Record<string, string> = {
  string_array: "string",
  integer_array: "integer",
  long_array: "long",
  double_array: "double",
  boolean_array: "boolean",
  timestamp_array: "timestamp",
};

/** Internal property storage type -> public ObjectPropertyType. */
export function toObjectPropertyType(baseType: string): Record<string, unknown> {
  const element = ARRAY_TYPES[baseType];
  if (element) {
    return {
      type: "array",
      subType: { type: element },
      reducers: [],
    };
  }
  if (baseType === "media_reference") return { type: "mediaReference" };
  if (baseType === "struct") {
    return { type: "struct", structFieldTypes: [] };
  }
  return { type: baseType };
}

/** Internal lowercase status → verified ReleaseStatus. */
export function toReleaseStatus(status: string | null | undefined): ReleaseStatus {
  switch ((status ?? "active").toLowerCase()) {
    case "experimental": return "EXPERIMENTAL";
    case "deprecated": return "DEPRECATED";
    case "endorsed": return "ENDORSED";
    default: return "ACTIVE";
  }
}

// ---------------------------------------------------------------------------
// Object types
// ---------------------------------------------------------------------------

export async function listObjectTypesV2(ontologyId: string) {
  const { rows } = await query(
    `SELECT object_type_id, api_name, display_name, description,
            icon, icon_color, status, primary_key_property_id,
            title_property_id
       FROM object_type
      WHERE ontology_id = $1
      ORDER BY api_name`,
    [ontologyId],
  );
  const out = [];
  for (const r of rows) {
    out.push(await mapObjectTypeV2(r));
  }
  return out;
}

export async function getObjectTypeV2(
  ontologyId: string,
  apiName: string,
) {
  const { rows } = await query(
    `SELECT object_type_id, api_name, display_name, description,
            icon, icon_color, status, primary_key_property_id,
            title_property_id
       FROM object_type
      WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, apiName],
  );
  if (rows.length === 0) return null;
  return mapObjectTypeV2(rows[0]);
}

async function mapObjectTypeV2(r: Record<string, unknown>) {
  const props = await query(
    `SELECT property_id, api_name, display_name, description, base_type
       FROM property
      WHERE object_type_id = $1
      ORDER BY api_name`,
    [r.object_type_id],
  );
  const propApiName = (pid: unknown): string | null => {
    const row = props.rows.find((p) => p.property_id === pid);
    return row ? (row.api_name as string) : null;
  };
  const properties: Record<string, unknown> = {};
  for (const p of props.rows) {
    properties[p.api_name as string] = {
      rid: `${PROPERTY_TYPE_RID_PREFIX}${p.property_id}`,
      displayName: p.display_name ?? undefined,
      description: p.description ?? undefined,
      dataType: toObjectPropertyType(p.base_type as string),
      typeClasses: [],
    };
  }
  const displayName = r.display_name as string;
  return {
    apiName: r.api_name,
    displayName,
    pluralDisplayName: `${displayName}s`,
    description: r.description ?? undefined,
    status: toReleaseStatus(r.status as string),
    icon: { name: r.icon ?? "cube", color: r.icon_color ?? "#1565C0" },
    primaryKey: requiredPropertyApiName(
      propApiName(r.primary_key_property_id),
      r.api_name,
      "primaryKey",
    ),
    titleProperty: requiredPropertyApiName(
      propApiName(r.title_property_id),
      r.api_name,
      "titleProperty",
    ),
    properties,
    rid: `${OBJECT_TYPE_RID_PREFIX}${r.object_type_id}`,
    aliases: [],
    datasources: [],
  };
}

function requiredPropertyApiName(
  apiName: string | null,
  objectType: unknown,
  field: "primaryKey" | "titleProperty",
): string {
  if (apiName) return apiName;
  throw Object.assign(
    new Error(`Object type ${String(objectType)} has no ${field} property.`),
    {
      errorName: "InvalidObjectTypeMetadata",
      parameters: { objectType, field },
    },
  );
}

// ---------------------------------------------------------------------------
// Link types
// ---------------------------------------------------------------------------

export async function listLinkTypesV2(ontologyId: string) {
  const { rows } = await query(
    `SELECT link_type_id, api_name, display_name, cardinality,
            reverse_api_name, reverse_display_name, reverse_visible,
            source_object_type, target_object_type,
            source_property_id, target_property_id
       FROM link_type
      WHERE ontology_id = $1
      ORDER BY api_name`,
    [ontologyId],
  );
  const out = [];
  for (const r of rows) out.push(await mapLinkTypeV2(r));
  return out;
}

export async function getLinkTypeV2(ontologyId: string, apiName: string) {
  const { rows } = await query(
    `SELECT link_type_id, api_name, display_name, cardinality,
            reverse_api_name, reverse_display_name, reverse_visible,
            source_object_type, target_object_type,
            source_property_id, target_property_id
       FROM link_type
      WHERE ontology_id = $1
        AND (api_name = $2 OR (reverse_visible = true AND reverse_api_name = $2))`,
    [ontologyId, apiName],
  );
  if (rows.length === 0) return null;
  return mapLinkTypeV2(rows[0]);
}

async function mapLinkTypeV2(r: Record<string, unknown>) {
  const apiOf = async (id: unknown) => {
    const res = await query(
      `SELECT api_name FROM object_type WHERE object_type_id = $1`,
      [id],
    );
    return res.rows[0]?.api_name ?? null;
  };
  const propOf = async (id: unknown) => {
    if (!id) return undefined;
    const res = await query(
      `SELECT api_name FROM property WHERE property_id = $1`,
      [id],
    );
    return res.rows[0]?.api_name ?? undefined;
  };
  const rid = `${LINK_TYPE_RID_PREFIX}${r.link_type_id}`;
  const cardinality = String(r.cardinality);
  const aCardinality =
    cardinality === "MANY_TO_ONE" || cardinality === "MANY_TO_MANY"
      ? "MANY"
      : "ONE";
  const bCardinality =
    cardinality === "ONE_TO_MANY" || cardinality === "MANY_TO_MANY"
      ? "MANY"
      : "ONE";
  const reverseApiName =
    r.reverse_visible === false
      ? r.api_name
      : r.reverse_api_name ?? `${String(r.api_name)}_reverse`;
  const reverseDisplayName =
    r.reverse_visible === false
      ? r.display_name
      : r.reverse_display_name ?? `${String(r.display_name)} (reverse)`;
  return {
    rid,
    apiName: r.api_name,
    displayName: r.display_name,
    status: "ACTIVE",
    objectTypeApiNameA: await apiOf(r.source_object_type),
    objectTypeApiNameB: await apiOf(r.target_object_type),
    cardinality: r.cardinality,
    aSide: {
      apiName: r.api_name,
      displayName: r.display_name,
      status: "ACTIVE" as const,
      linkTypeRid: rid,
      objectTypeApiName: await apiOf(r.source_object_type),
      cardinality: aCardinality,
      foreignKeyPropertyApiName: await propOf(r.source_property_id),
    },
    bSide: {
      apiName: reverseApiName,
      displayName: reverseDisplayName,
      status: "ACTIVE" as const,
      linkTypeRid: rid,
      objectTypeApiName: await apiOf(r.target_object_type),
      cardinality: bCardinality,
      foreignKeyPropertyApiName: await propOf(r.target_property_id),
    },
  };
}

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export async function listActionTypesV2(ontologyId: string) {
  const { rows } = await query(
    `SELECT action_type_id, api_name, display_name, description,
            parameters, rules, definition_version
       FROM action_type
      WHERE ontology_id = $1
      ORDER BY api_name`,
    [ontologyId],
  );
  const linkEndpointTypes = rows.some(hasLinkRule)
    ? await loadLinkEndpointTypes(ontologyId)
    : new Map<string, LinkEndpointTypes>();
  return rows.map((row) => mapActionTypeV2(row, linkEndpointTypes));
}

export async function getActionTypeV2(ontologyId: string, apiName: string) {
  const { rows } = await query(
    `SELECT action_type_id, api_name, display_name, description,
            parameters, rules, definition_version
       FROM action_type
      WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, apiName],
  );
  if (rows.length === 0) return null;
  const linkEndpointTypes = hasLinkRule(rows[0])
    ? await loadLinkEndpointTypes(ontologyId)
    : new Map<string, LinkEndpointTypes>();
  return mapActionTypeV2(rows[0], linkEndpointTypes);
}

interface LinkEndpointTypes {
  source: string;
  target: string;
}

function hasLinkRule(row: Record<string, unknown>): boolean {
  return (
    Array.isArray(row.rules) &&
    (row.rules as Array<Record<string, unknown>>).some((rule) =>
      [
        "addLink",
        "removeLink",
        "createInterfaceLink",
        "deleteInterfaceLink",
      ].includes(String(rule.type)),
    )
  );
}

async function loadLinkEndpointTypes(
  ontologyId: string,
): Promise<Map<string, LinkEndpointTypes>> {
  const { rows } = await query(
    `SELECT lt.api_name,
            source.api_name AS source_object_type,
            target.api_name AS target_object_type
       FROM link_type lt
       JOIN object_type source
         ON source.object_type_id = lt.source_object_type
       JOIN object_type target
         ON target.object_type_id = lt.target_object_type
      WHERE lt.ontology_id = $1`,
    [ontologyId],
  );
  return new Map(
    rows.map((row) => [
      String(row.api_name),
      {
        source: String(row.source_object_type),
        target: String(row.target_object_type),
      },
    ]),
  );
}

function mapActionTypeV2(
  r: Record<string, unknown>,
  linkEndpointTypes: ReadonlyMap<string, LinkEndpointTypes>,
) {
  const params = Array.isArray(r.parameters) ? r.parameters : [];
  const parameters: Record<string, unknown> = {};
  const parameterObjectTypes = new Map<string, string>();
  for (const p of params as Array<Record<string, unknown>>) {
    const id = String(p.apiName ?? p.id ?? "");
    if (!id) continue;
    if (typeof p.objectType === "string") {
      parameterObjectTypes.set(id, p.objectType);
    }
    parameters[id] = {
      displayName: p.displayName ?? id,
      description: p.description ?? undefined,
      dataType: toActionParameterType(
        String(p.type ?? "string"),
        typeof p.objectType === "string" ? p.objectType : undefined,
      ),
      required: p.required === true,
      typeClasses: [],
    };
  }
  const rules = Array.isArray(r.rules) ? r.rules : [];
  return {
    apiName: r.api_name,
    displayName: r.display_name ?? undefined,
    description: r.description ?? undefined,
    status: "ACTIVE",
    rid: `${ACTION_TYPE_RID_PREFIX}${r.action_type_id}`,
    parameters,
    // ActionTypeV2.operations is the public, high-level LogicRule summary
    // (object/link types affected), not the executable LogicRuleOperation
    // representation with parameter/property arguments. Keep execution
    // details in Tellus storage and expose only the SDK's verified union.
    operations: (rules as Array<Record<string, unknown>>).flatMap(
      (rule) =>
        mapLogicRulesV2(rule, parameterObjectTypes, linkEndpointTypes),
    ),
  };
}

function objectTypeFrom(
  source: unknown,
  fallback: unknown,
  parameterObjectTypes: ReadonlyMap<string, string>,
): string | undefined {
  const value = source as Record<string, unknown> | null;
  if (typeof value?.objectType === "string") return value.objectType;
  if (typeof value?.param === "string") {
    const fromParameter = parameterObjectTypes.get(value.param);
    if (fromParameter) return fromParameter;
  }
  return typeof fallback === "string" ? fallback : undefined;
}

function requireRuleName(
  value: unknown,
  field: string,
  ruleType: unknown,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw Object.assign(
    new Error(`Action rule '${String(ruleType)}' is missing ${field}.`),
    {
      errorName: "InvalidActionTypeMetadata",
      parameters: { ruleType, field },
    },
  );
}

function mapLogicRulesV2(
  rule: Record<string, unknown>,
  parameterObjectTypes: ReadonlyMap<string, string>,
  linkEndpointTypes: ReadonlyMap<string, LinkEndpointTypes>,
): Array<Record<string, unknown>> {
  switch (rule.type) {
    case "createObject":
      return [{
        type: "createObject",
        objectTypeApiName: requireRuleName(
          rule.objectType,
          "objectType",
          rule.type,
        ),
      }];
    case "modifyObject":
      return [{
        type: "modifyObject",
        objectTypeApiName: requireRuleName(
          rule.objectType,
          "objectType",
          rule.type,
        ),
      }];
    case "modifyOrCreateObject":
      {
        const objectTypeApiName = requireRuleName(
          rule.objectType,
          "objectType",
          rule.type,
        );
        // The public LogicRule union has no create-or-modify discriminator.
        // Expose both possible effects rather than inventing a wire type.
        return [
          { type: "createObject", objectTypeApiName },
          { type: "modifyObject", objectTypeApiName },
        ];
      }
    case "deleteObject":
      return [{
        type: "deleteObject",
        objectTypeApiName: requireRuleName(
          rule.objectType ??
            objectTypeFrom(
              rule.objectReference,
              undefined,
              parameterObjectTypes,
            ),
          "objectType",
          rule.type,
        ),
      }];
    case "addLink":
    case "removeLink": {
      const linkTypeApiName = requireRuleName(
        rule.linkTypeApiName ?? rule.linkType,
        "linkType",
        rule.type,
      );
      const storedEndpoints = linkEndpointTypes.get(linkTypeApiName);
      const aSideObjectTypeApiName = requireRuleName(
        storedEndpoints?.source ??
          objectTypeFrom(
            rule.sourceObject,
            rule.sourceObjectType,
            parameterObjectTypes,
          ),
        "sourceObject.objectType",
        rule.type,
      );
      const bSideObjectTypeApiName = requireRuleName(
        storedEndpoints?.target ??
          objectTypeFrom(
            rule.targetObject,
            rule.targetObjectType,
            parameterObjectTypes,
          ),
        "targetObject.objectType",
        rule.type,
      );
      return [{
        type: rule.type === "addLink" ? "createLink" : "deleteLink",
        // Tellus stores one canonical link API name. Until reverse-side API
        // names are modelled separately, both verified directional fields
        // carry that stable canonical name.
        linkTypeApiNameAtoB: linkTypeApiName,
        linkTypeApiNameBtoA: linkTypeApiName,
        aSideObjectTypeApiName,
        bSideObjectTypeApiName,
      }];
    }
    case "createInterfaceLink":
    case "deleteInterfaceLink":
      // SDK 2.70 LogicRule has concrete createLink/deleteLink members but no
      // interface-link member. An interface constraint is not a concrete
      // link type API name, so emitting one here would fabricate metadata.
      return [];
    default:
      throw Object.assign(
        new Error(`Unsupported action logic rule: ${String(rule.type)}`),
        {
          errorName: "InvalidActionTypeMetadata",
          parameters: { ruleType: rule.type },
        },
      );
  }
}

function toActionParameterType(
  baseType: string,
  objectType?: string,
): Record<string, unknown> {
  const element = ARRAY_TYPES[baseType];
  if (element) {
    return {
      type: "array",
      subType: toActionParameterType(element),
    };
  }
  if (baseType === "object_reference") {
    return objectType
      ? {
          type: "object",
          objectApiName: objectType,
          objectTypeApiName: objectType,
        }
      : { type: "objectType" };
  }
  if (baseType === "object_set") {
    return {
      type: "objectSet",
      ...(objectType ? { objectTypeApiName: objectType } : {}),
    };
  }
  if (baseType === "media_reference") return { type: "mediaReference" };
  if (baseType === "float" || baseType === "decimal") {
    return { type: "double" };
  }
  if (baseType === "byte" || baseType === "short") {
    return { type: "integer" };
  }
  if (baseType === "struct") return { type: "struct", fields: [] };
  return { type: baseType };
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export async function listInterfacesV2(ontologyId: string) {
  const { rows } = await query(
    `SELECT interface_id, api_name, display_name, description,
            parent_interface_id
       FROM interface
      WHERE ontology_id = $1
      ORDER BY api_name`,
    [ontologyId],
  );
  const out = [];
  for (const row of rows) out.push(await mapInterfaceV2(row));
  return out;
}

export async function getInterfaceV2(ontologyId: string, apiName: string) {
  const { rows } = await query(
    `SELECT interface_id, api_name, display_name, description,
            parent_interface_id
       FROM interface
      WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, apiName],
  );
  if (rows.length === 0) return null;
  return mapInterfaceV2(rows[0]);
}

async function mapInterfaceV2(r: Record<string, unknown>) {
  const directProps = await query(
    `SELECT interface_property_id, api_name, display_name, base_type,
            is_required
       FROM interface_property
      WHERE interface_id = $1
      ORDER BY ordinal, api_name`,
    [r.interface_id],
  );
  const ancestry = await query(
    `WITH RECURSIVE parents AS (
       SELECT interface_id, api_name, parent_interface_id, 1 AS depth
         FROM interface
        WHERE interface_id = $1
       UNION ALL
       SELECT i.interface_id, i.api_name, i.parent_interface_id,
              parents.depth + 1
         FROM interface i
         JOIN parents ON i.interface_id = parents.parent_interface_id
     )
     SELECT interface_id, api_name, depth
       FROM parents
      WHERE depth > 1
      ORDER BY depth`,
    [r.interface_id],
  );
  const allProps = await query(
    `WITH RECURSIVE family AS (
       SELECT interface_id, parent_interface_id
         FROM interface
        WHERE interface_id = $1
       UNION ALL
       SELECT i.interface_id, i.parent_interface_id
         FROM interface i
         JOIN family ON i.interface_id = family.parent_interface_id
     )
     SELECT ip.interface_property_id, ip.api_name, ip.display_name,
            ip.base_type, ip.is_required
       FROM interface_property ip
       JOIN family ON family.interface_id = ip.interface_id
      ORDER BY ip.ordinal, ip.api_name`,
    [r.interface_id],
  );
  const implementations = await query(
    `SELECT ot.api_name
       FROM object_type_interface oti
       JOIN object_type ot ON ot.object_type_id = oti.object_type_id
      WHERE oti.interface_id = $1
      ORDER BY ot.api_name`,
    [r.interface_id],
  );
  const links = await query(
    `SELECT ilc.interface_link_constraint_id, ilc.api_name,
            ilc.display_name, ilc.description, ilc.cardinality,
            ti.api_name AS target_interface_api_name,
            tot.api_name AS target_object_type_api_name
       FROM interface_link_constraint ilc
       LEFT JOIN interface ti
         ON ti.interface_id = ilc.target_interface_id
       LEFT JOIN object_type tot
         ON tot.object_type_id = ilc.target_object_type_id
      WHERE ilc.interface_id = $1
        AND ilc.status = 'active'
      ORDER BY ilc.api_name`,
    [r.interface_id],
  );

  const propertyV2 = (
    p: Record<string, unknown>,
  ): Record<string, unknown> => ({
    type: "interfaceDefinedPropertyType",
    rid: `${PROPERTY_TYPE_RID_PREFIX}${p.interface_property_id}`,
    apiName: p.api_name,
    displayName: p.display_name,
    dataType: toObjectPropertyType(String(p.base_type)),
    requireImplementation: p.is_required === true,
    typeClasses: [],
  });
  const resolvedProperty = (
    p: Record<string, unknown>,
  ): Record<string, unknown> => {
    const { type: _type, typeClasses: _typeClasses, ...resolved } =
      propertyV2(p);
    return resolved;
  };
  const directPropertiesV2 = Object.fromEntries(
    directProps.rows.map((p) => [p.api_name, propertyV2(p)]),
  );
  const allPropertiesV2 = Object.fromEntries(
    allProps.rows.map((p) => [p.api_name, resolvedProperty(p)]),
  );
  const interfaceLinks = Object.fromEntries(
    links.rows.map((link) => [
      link.api_name,
      {
        rid: `${INTERFACE_RID_PREFIX}link.${link.interface_link_constraint_id}`,
        apiName: link.api_name,
        displayName: link.display_name,
        description: link.description ?? undefined,
        linkedEntityApiName: link.target_interface_api_name
          ? {
              type: "interfaceTypeApiName",
              apiName: link.target_interface_api_name,
            }
          : {
              type: "objectTypeApiName",
              apiName: link.target_object_type_api_name,
            },
        cardinality:
          link.cardinality === "ONE_TO_ONE" ||
          link.cardinality === "MANY_TO_ONE"
            ? "ONE"
            : "MANY",
        required: false,
      },
    ]),
  );
  const parentNames = ancestry.rows.map((row) => row.api_name as string);
  return {
    apiName: r.api_name,
    displayName: r.display_name,
    description: r.description ?? undefined,
    rid: `${INTERFACE_RID_PREFIX}${r.interface_id}`,
    properties: {},
    allProperties: {},
    propertiesV2: directPropertiesV2,
    allPropertiesV2,
    extendsInterfaces: parentNames.slice(0, 1),
    allExtendsInterfaces: parentNames,
    implementedByObjectTypes: implementations.rows.map(
      (row) => row.api_name,
    ),
    links: interfaceLinks,
    allLinks: interfaceLinks,
  };
}
