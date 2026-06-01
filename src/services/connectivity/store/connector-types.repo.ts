// ---------------------------------------------------------------------------
// connector_types repository — reads the master registry for the source
// picker UI (/data-connection/new-source).
// ---------------------------------------------------------------------------

import { pool } from "../../../db";
import type { ConnectorTypeEntry } from "../contracts";

interface ConnectorTypeRow {
  id: string;
  title: string;
  icon: string;
  icon_color: string;
  icon_src: string | null;
  badge: string | null;
  tags: string[];
  href: string | null;
  connector_type: string;
  capabilities: ConnectorTypeEntry["capabilities"];
  sort_order: number;
}

function toContract(row: ConnectorTypeRow): ConnectorTypeEntry {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    iconColor: row.icon_color,
    iconSrc: row.icon_src ?? null,
    badge: (row.badge ?? null) as ConnectorTypeEntry["badge"],
    tags: row.tags,
    href: row.href ?? null,
    connectorType: row.connector_type as ConnectorTypeEntry["connectorType"],
    capabilities: row.capabilities,
    sortOrder: row.sort_order,
  };
}

/**
 * Returns all enabled connector types sorted by sort_order.
 */
export async function listEnabled(): Promise<ConnectorTypeEntry[]> {
  const result = await pool.query<ConnectorTypeRow>(
    `SELECT id, title, icon, icon_color, icon_src, badge, tags,
            href, connector_type, capabilities, sort_order
       FROM connector_types
      WHERE enabled = TRUE
      ORDER BY sort_order ASC, title ASC`,
  );
  return result.rows.map(toContract);
}
