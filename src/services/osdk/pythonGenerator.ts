// ---------------------------------------------------------------------------
// OSDK — Python flavor (FOUNDRY-GAPS §5).
//
// Parallel to generator.ts (the TypeScript flavor): given the SAME
// OntologySnapshot it emits a deterministic, dependency-free Python SDK:
//
//   models.py  — one TypedDict per object type (keys = exact apiNames, so JSON
//                maps directly), primary-key aliases, action-parameter
//                TypedDicts, and the LINK_TYPES descriptor table.
//   client.py  — OsdkClient (stdlib urllib only) with `.objects.<type>`
//                (ObjectSet: fetch_page/get/search/aggregate), `.actions.<name>`
//                (apply), and `.links.<name>` (traverse) — hitting the SAME REST
//                routes as the TS client.
//   __init__.py — package exports + a usage docstring.
//
// Determinism: inputs are sorted by apiName and the caller supplies
// `ontology.generatedAt`, so two runs over the same snapshot are byte-identical.
// ---------------------------------------------------------------------------

import {
  sanitizeIdentifier,
  pascalCase,
  type GeneratedFile,
  type OntologySnapshot,
  type SnapshotActionParameter,
  type SnapshotActionType,
  type SnapshotLinkType,
  type SnapshotObjectType,
} from "./generator";

// ---------------------------------------------------------------------------
// Python identifier helpers (snake_case for fields/methods/accessors)
// ---------------------------------------------------------------------------

const PY_RESERVED = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  // soft collisions we also dodge to keep generated code tidy
  "self", "type", "id", "list", "dict", "str", "int", "float", "bool",
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** snake_case Python-safe identifier (`isInternational` → `is_international`). */
export function snakeCase(name: string): string {
  let out = words(name).map((w) => w.toLowerCase()).join("_");
  if (out.length === 0) out = "unnamed";
  if (/^[0-9]/.test(out)) out = `_${out}`;
  if (PY_RESERVED.has(out)) out = `${out}_`;
  return out;
}

/** PascalCase type name reused from the TS flavor for parity. */
function objectClassName(ot: SnapshotObjectType): string {
  return pascalCase(ot.apiName);
}

// ---------------------------------------------------------------------------
// Type mapping (ontology base type → Python annotation)
// ---------------------------------------------------------------------------

export function mapPythonType(baseType: string): string {
  switch (baseType) {
    case "string":
    case "decimal":
    case "marking":
    case "attachment":
    case "media_reference":
    case "date":
    case "timestamp":
      return "str";
    case "integer":
    case "long":
    case "byte":
    case "short":
      return "int";
    case "double":
    case "float":
      return "float";
    case "boolean":
      return "bool";
    case "geopoint":
      return "Union[Dict[str, float], str]";
    case "string_array":
      return "List[str]";
    case "integer_array":
      return "List[int]";
    case "double_array":
      return "List[float]";
    case "boolean_array":
      return "List[bool]";
    case "timestamp_array":
      return "List[str]";
    case "geoshape":
    case "struct":
    case "timeseries":
      return "Dict[str, Any]";
    default:
      return "Any";
  }
}

function mapPythonActionParamType(p: SnapshotActionParameter): string {
  switch (p.type) {
    case "object_reference":
      return "Union[str, int]";
    case "object_set":
      return "Dict[str, Any]";
    default:
      return mapPythonType(p.type);
  }
}

function primaryKeyPyType(ot: SnapshotObjectType): string {
  const pk = ot.properties.find((p) => p.apiName === ot.primaryKey);
  return pk ? mapPythonType(pk.type) : "str";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortByApiName<T extends { apiName: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.apiName.localeCompare(b.apiName));
}

function pyStr(s: string): string {
  return JSON.stringify(s); // JSON strings are valid Python string literals
}

function header(snapshot: OntologySnapshot): string {
  const o = snapshot.ontology;
  const name = o.displayName ?? o.apiName ?? o.id;
  return [
    `# =====================================================================`,
    `# AUTO-GENERATED OSDK (Python) — do not edit by hand.`,
    `# Ontology: ${name} (${o.id})`,
    `# Version: ${o.version ?? "unversioned"}`,
    `# Generated: ${o.generatedAt ?? "unknown"}`,
    `# =====================================================================`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// models.py
// ---------------------------------------------------------------------------

function genModels(snapshot: OntologySnapshot): string {
  const objectTypes = sortByApiName(snapshot.objectTypes);
  const actionTypes = sortByApiName(snapshot.actionTypes);
  const linkTypes = sortByApiName(snapshot.linkTypes);

  const lines: string[] = [header(snapshot), ""];
  lines.push(`from __future__ import annotations`);
  lines.push(`from typing import Any, Dict, List, TypedDict, Union  # noqa: F401`);
  lines.push("");
  lines.push(`DEFAULT_ONTOLOGY_ID = ${pyStr(snapshot.ontology.id)}`);
  lines.push("");

  for (const ot of objectTypes) {
    const cls = objectClassName(ot);
    const props = [...ot.properties].sort((a, b) => a.apiName.localeCompare(b.apiName));
    if (props.length === 0) {
      lines.push(`${cls} = TypedDict(${pyStr(cls)}, {}, total=False)`);
    } else {
      lines.push(`${cls} = TypedDict(${pyStr(cls)}, {`);
      for (const p of props) {
        lines.push(`    ${pyStr(p.apiName)}: ${mapPythonType(p.type)},`);
      }
      lines.push(`}, total=False)`);
    }
    lines.push(`${cls}PrimaryKey = ${primaryKeyPyType(ot)}`);
    lines.push("");
  }

  for (const at of actionTypes) {
    const cls = `${pascalCase(at.apiName)}Parameters`;
    const params = [...at.parameters].sort((a, b) => a.apiName.localeCompare(b.apiName));
    if (params.length === 0) {
      lines.push(`${cls} = TypedDict(${pyStr(cls)}, {}, total=False)`);
    } else {
      lines.push(`${cls} = TypedDict(${pyStr(cls)}, {`);
      for (const p of params) {
        lines.push(`    ${pyStr(p.apiName)}: ${mapPythonActionParamType(p)},`);
      }
      lines.push(`}, total=False)`);
    }
    lines.push("");
  }

  lines.push(`LINK_TYPES: Dict[str, Dict[str, str]] = {`);
  for (const lt of linkTypes) {
    lines.push(
      `    ${pyStr(lt.apiName)}: {"apiName": ${pyStr(lt.apiName)}, "cardinality": ${pyStr(lt.cardinality)}, ` +
        `"source": ${pyStr(lt.sourceObjectType)}, "target": ${pyStr(lt.targetObjectType)}},`,
    );
  }
  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// client.py
// ---------------------------------------------------------------------------

const CLIENT_RUNTIME = `
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Union  # noqa: F401


class OsdkError(Exception):
    """Raised on a non-2xx response. Carries the HTTP status and parsed body."""

    def __init__(self, message: str, status: int, body: Any) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class _HttpCore:
    def __init__(self, base_url: str, headers: Optional[Dict[str, str]] = None,
                 token: Optional[str] = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = dict(headers or {})
        if token:
            self.headers["authorization"] = "Bearer " + token

    def request(self, method: str, path: str, body: Any = None) -> Any:
        url = self.base_url + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        hdrs = {"content-type": "application/json", **self.headers}
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req) as resp:
                text = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            try:
                parsed = json.loads(raw) if raw else None
            except ValueError:
                parsed = raw
            raise OsdkError(method + " " + path + " -> " + str(exc.code), exc.code, parsed)
        return json.loads(text) if text else None


def _as_page(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, list):
        return {"data": raw}
    return raw


def _qs(page_size: Optional[int], page_token: Optional[str]) -> str:
    q: Dict[str, str] = {}
    if page_size is not None:
        q["pageSize"] = str(page_size)
    if page_token:
        q["pageToken"] = page_token
    return ("?" + urllib.parse.urlencode(q)) if q else ""


class ObjectSet:
    """Typed accessor over /v1/objects/:apiName."""

    def __init__(self, core: "_HttpCore", api_name: str) -> None:
        self._core = core
        self.api_name = api_name

    def fetch_page(self, page_size: Optional[int] = None, page_token: Optional[str] = None,
                   where: Any = None, order_by: Any = None, select: Any = None) -> Dict[str, Any]:
        ap = urllib.parse.quote(self.api_name)
        if where or order_by or select:
            body: Dict[str, Any] = {}
            if where:
                body["where"] = where
            if order_by:
                body["$orderBy"] = order_by
            if page_size is not None:
                body["$pageSize"] = page_size
            if page_token:
                body["$pageToken"] = page_token
            if select:
                body["$select"] = select
            return _as_page(self._core.request("POST", "/v1/objects/" + ap + "/search", body))
        return _as_page(self._core.request("GET", "/v1/objects/" + ap + _qs(page_size, page_token)))

    def get(self, primary_key: Union[str, int]) -> Any:
        ap = urllib.parse.quote(self.api_name)
        pk = urllib.parse.quote(str(primary_key))
        raw = self._core.request("GET", "/v1/objects/" + ap + "/" + pk)
        if isinstance(raw, dict) and "data" in raw:
            return raw["data"]
        return raw

    def search(self, where: Any = None, filter: Any = None, order_by: Any = None,
               page_size: Optional[int] = None, page_token: Optional[str] = None,
               select: Any = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if where:
            body["where"] = where
        if filter:
            body["filter"] = filter
        if order_by:
            body["$orderBy"] = order_by
        if page_size is not None:
            body["$pageSize"] = page_size
        if page_token:
            body["$pageToken"] = page_token
        if select:
            body["$select"] = select
        ap = urllib.parse.quote(self.api_name)
        return _as_page(self._core.request("POST", "/v1/objects/" + ap + "/search", body))

    def aggregate(self, body: Dict[str, Any]) -> Any:
        ap = urllib.parse.quote(self.api_name)
        return self._core.request("POST", "/v1/objects/" + ap + "/aggregate", body)


def _traverse_link(core: "_HttpCore", source_api_name: str, link_api_name: str,
                   source_primary_key: Union[str, int], page_size: Optional[int] = None,
                   page_token: Optional[str] = None) -> Dict[str, Any]:
    src = urllib.parse.quote(source_api_name)
    pk = urllib.parse.quote(str(source_primary_key))
    link = urllib.parse.quote(link_api_name)
    path = "/v1/objects/" + src + "/" + pk + "/links/" + link + _qs(page_size, page_token)
    return _as_page(core.request("GET", path))
`;

function genClient(snapshot: OntologySnapshot): string {
  const objectTypes = sortByApiName(snapshot.objectTypes);
  const linkTypes = sortByApiName(snapshot.linkTypes);
  const actionTypes = sortByApiName(snapshot.actionTypes);

  const lines: string[] = [header(snapshot), ""];
  lines.push(CLIENT_RUNTIME.trimEnd());
  lines.push("");
  lines.push(`DEFAULT_ONTOLOGY_ID = ${pyStr(snapshot.ontology.id)}`);
  lines.push("");

  // _Objects container — one ObjectSet attribute per object type.
  lines.push(`class _Objects:`);
  lines.push(`    def __init__(self, core: "_HttpCore") -> None:`);
  if (objectTypes.length === 0) {
    lines.push(`        pass`);
  } else {
    for (const ot of objectTypes) {
      lines.push(`        self.${snakeCase(ot.apiName)} = ObjectSet(core, ${pyStr(ot.apiName)})`);
    }
  }
  lines.push("");

  // _Actions container — one apply method per action type.
  lines.push(`class _Actions:`);
  lines.push(`    def __init__(self, client: "OsdkClient") -> None:`);
  lines.push(`        self._client = client`);
  if (actionTypes.length === 0) {
    lines.push("");
  } else {
    lines.push("");
    for (const at of actionTypes) {
      lines.push(`    def ${snakeCase(at.apiName)}(self, params: Dict[str, Any]) -> Any:`);
      lines.push(`        return self._client.apply_action(${pyStr(at.apiName)}, params)`);
      lines.push("");
    }
  }
  if (actionTypes.length === 0) lines.push("");

  // _Links container — one traverse method per link type.
  lines.push(`class _Links:`);
  lines.push(`    def __init__(self, core: "_HttpCore") -> None:`);
  lines.push(`        self._core = core`);
  if (linkTypes.length === 0) {
    lines.push("");
  } else {
    lines.push("");
    for (const lt of linkTypes) {
      lines.push(
        `    def ${snakeCase(lt.apiName)}(self, source_primary_key: Union[str, int], ` +
          `page_size: Optional[int] = None, page_token: Optional[str] = None) -> Dict[str, Any]:`,
      );
      lines.push(
        `        return _traverse_link(self._core, ${pyStr(lt.sourceObjectType)}, ` +
          `${pyStr(lt.apiName)}, source_primary_key, page_size, page_token)`,
      );
      lines.push("");
    }
  }
  if (linkTypes.length === 0) lines.push("");

  // OsdkClient.
  lines.push(`class OsdkClient:`);
  lines.push(`    """Generated typed client. \`objects\`, \`actions\`, \`links\` mirror the REST API."""`);
  lines.push("");
  lines.push(`    def __init__(self, base_url: str, ontology_id: str = DEFAULT_ONTOLOGY_ID,`);
  lines.push(`                 headers: Optional[Dict[str, str]] = None, token: Optional[str] = None) -> None:`);
  lines.push(`        self._core = _HttpCore(base_url, headers, token)`);
  lines.push(`        self.ontology_id = ontology_id`);
  lines.push(`        self.objects = _Objects(self._core)`);
  lines.push(`        self.actions = _Actions(self)`);
  lines.push(`        self.links = _Links(self._core)`);
  lines.push("");
  lines.push(`    def apply_action(self, api_name: str, params: Dict[str, Any]) -> Any:`);
  lines.push(`        path = "/v1/ontology/" + urllib.parse.quote(self.ontology_id) + "/actions/" + urllib.parse.quote(api_name) + "/apply"`);
  lines.push(`        return self._core.request("POST", path, {"parameters": params})`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// __init__.py
// ---------------------------------------------------------------------------

function genInit(snapshot: OntologySnapshot): string {
  const objectTypes = sortByApiName(snapshot.objectTypes);
  const lines: string[] = [header(snapshot), ""];
  lines.push(`"""`);
  lines.push(`Generated Python OSDK for ontology ${snapshot.ontology.displayName ?? snapshot.ontology.id}.`);
  lines.push("");
  lines.push(`Usage:`);
  lines.push(`    from ${snapshot.ontology.apiName ?? sanitizeIdentifier(snapshot.ontology.id)} import OsdkClient`);
  lines.push(`    client = OsdkClient("https://tellus.example.com/api", token="...")`);
  if (objectTypes.length > 0) {
    lines.push(`    page = client.objects.${snakeCase(objectTypes[0].apiName)}.fetch_page(page_size=50)`);
  }
  lines.push(`"""`);
  lines.push(`from .client import OsdkClient, OsdkError, ObjectSet, DEFAULT_ONTOLOGY_ID  # noqa: F401`);
  lines.push(`from . import models  # noqa: F401`);
  lines.push("");
  return lines.join("\n");
}

/** Generate the Python OSDK file set for an ontology snapshot. */
export function generateOsdkPython(snapshot: OntologySnapshot): GeneratedFile[] {
  return [
    { path: "models.py", content: genModels(snapshot) },
    { path: "client.py", content: genClient(snapshot) },
    { path: "__init__.py", content: genInit(snapshot) },
  ];
}
