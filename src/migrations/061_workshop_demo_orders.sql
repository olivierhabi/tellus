-- =============================================================================
-- Migration 061 — Workshop demo "Order" object data.
--
-- The default `RecordingOssAdapter` returns empty results, which makes the
-- editor at /workshop/[rid] visually empty even when the module document is
-- bound to an objectSet variable. This migration creates a Postgres-backed
-- demo table that the new `PostgresOssAdapter` reads to populate:
--   - The OrdersTable rows
--   - The FilterWidget facet aggregates (Item Name / Assignee /
--     Consolidated Customer Id / Customer Name)
--
-- The 38 rows below mirror the demo data set in
--   tellus-fe/app/workshop/page.tsx (lines 122–160)
-- so the production editor at /workshop/{rid} reproduces the demo's visual
-- state, but every value is now sourced from Postgres.
-- =============================================================================

CREATE TABLE IF NOT EXISTS workshop_demo_order (
  order_id                  UUID PRIMARY KEY,
  ontology_rid              TEXT NOT NULL,
  object_type_api_name      TEXT NOT NULL DEFAULT 'order',
  item_name                 TEXT NOT NULL,
  order_due_date            TIMESTAMPTZ NOT NULL,
  customer_id               UUID NOT NULL,
  consolidated_customer_id  UUID NOT NULL,
  customer_name             TEXT NOT NULL,
  status                    TEXT NOT NULL,
  assignee                  TEXT,
  quantity                  INTEGER NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workshop_demo_order_object_type
  ON workshop_demo_order (object_type_api_name);

CREATE INDEX IF NOT EXISTS idx_workshop_demo_order_status
  ON workshop_demo_order (status);

CREATE INDEX IF NOT EXISTS idx_workshop_demo_order_assignee
  ON workshop_demo_order (assignee);

-- Seed the 38 demo rows. Customer name + consolidated customer id are
-- assigned deterministically from a small pool so facet counts > 1.
INSERT INTO workshop_demo_order
  (order_id, ontology_rid, item_name, order_due_date, customer_id, consolidated_customer_id, customer_name, status, assignee, quantity)
VALUES
  ('55cc3161-2978-4f1e-a34f-5143fc76691b', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Printer',                'Jun 29, 2023, 8:00 PM'::timestamptz, '94b00b76-3d0f-46f0-ba03-e017c8b91359', 'eabbfb71-39b1-4a66-94cf-bb1d70bdcc63', 'Hessel - Muller',         'assigned', 'Alfredo Bins',       26),
  ('d5a2e521-b4de-4dff-94a8-7f568a7fe8eb', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Office Desk',            'Jul 11, 2023, 8:00 PM'::timestamptz, 'b5d1c76b-014f-4e7f-8578-7585ad5ee0c5', 'b38352f4-2e78-4530-a94f-810dccb0a762', 'King, Feeney and Kutch',  'assigned', 'Alfredo Bins',       84),
  ('5426d15e-8b1b-41b6-8142-7b06180c6e82', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'File Folders',           'Jul 28, 2023, 8:00 PM'::timestamptz, '4d582e05-5ada-48e6-aa1f-57e31e532fdb', 'bbfb5080-1a1a-433f-b5e4-abfb0ba7b23f', 'Marquardt - Bailey',      'closed',   'Latoya Gulgowski',   50),
  ('d5cd26ca-072e-4c1c-9533-9db5d27d29b3', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', '30" Monitor',            'Jul 25, 2023, 8:00 PM'::timestamptz, 'c2947095-8a84-4f3f-a7ae-6e55f8079199', '0517332c-697c-47f3-aa52-3770c85106ff', 'Hessel - Muller',         'assigned', 'Gail Weber',         40),
  ('35ba9966-df47-42ab-87e3-246f603491d1', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Multifunction Printer',  'Jul 8, 2023, 8:00 PM'::timestamptz,  '5fa55dc5-ee3c-406f-a53d-f0337f826550', '6bf2afa9-1cda-484f-8dc8-48322f3e1c1c', 'King, Feeney and Kutch',  'closed',   'John Dooley',        28),
  ('00f85a10-4ecc-49a6-a4a0-f00a1176aca4', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', '30" Monitor',            'Jul 9, 2023, 8:00 PM'::timestamptz,  'd074f7cd-0860-467a-a51c-966a2986b1e1', 'eabbfb71-39b1-4a66-94cf-bb1d70bdcc63', 'Marquardt - Bailey',      'closed',   'Latoya Gulgowski',   23),
  ('4eb7e077-171a-4e1f-bbd8-a00d72f02d7e', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'File Folders',           'Jun 14, 2023, 8:00 PM'::timestamptz, '187e23f8-e98d-49ef-bbf1-da3eaf97a5fb', 'b38352f4-2e78-4530-a94f-810dccb0a762', 'Hessel - Muller',         'assigned', 'Kristen Mohr',       19),
  ('df319b4a-00eb-45ab-9da1-a21fe447d733', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Office Chair',           'Jul 19, 2023, 8:00 PM'::timestamptz, '9be24479-ca97-4259-87ba-cb956cc45074', 'bbfb5080-1a1a-433f-b5e4-abfb0ba7b23f', 'King, Feeney and Kutch',  'open',     NULL,                 32),
  ('1ee2f2a3-ad6c-411e-ad1f-63ea4773fd4b', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Paper Clips',            'Jun 3, 2023, 8:00 PM'::timestamptz,  '85837d7a-e28e-472d-8b10-2b46e2e43df9', '0517332c-697c-47f3-aa52-3770c85106ff', 'Marquardt - Bailey',      'assigned', 'Kristen Mohr',       44),
  ('4be3e992-3fae-4d26-9c58-5b1e3edb2493', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Multifunction Printer',  'Jul 28, 2023, 8:00 PM'::timestamptz, '43c13686-042c-4d7b-98c4-391ea1b34903', '6bf2afa9-1cda-484f-8dc8-48322f3e1c1c', 'Hessel - Muller',         'closed',   'Alfredo Bins',       73),
  ('64ee944e-a65e-46f8-bd19-4a5028f35004', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Stapler',                'Jun 12, 2023, 8:00 PM'::timestamptz, '66f35d4e-c0c3-4bf5-886d-d87c7df83a4e', 'eabbfb71-39b1-4a66-94cf-bb1d70bdcc63', 'King, Feeney and Kutch',  'assigned', 'Lorraine Bahringer', 23),
  ('2ab9b85c-b1d6-43c4-84b7-161608ce00be', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Paper Clips',            'Jun 26, 2023, 8:00 PM'::timestamptz, '651dc3b0-a6f8-4e9a-a265-fb97670dae46', 'b38352f4-2e78-4530-a94f-810dccb0a762', 'Marquardt - Bailey',      'closed',   'Gail Weber',         22),
  ('9031fe1f-16b6-4bc8-a764-502707d9928d', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Printer',                'Jul 22, 2023, 8:00 PM'::timestamptz, 'd5afb419-0e4c-4f2a-90d1-69cc87024cd1', 'bbfb5080-1a1a-433f-b5e4-abfb0ba7b23f', 'Hessel - Muller',         'open',     NULL,                 17),
  ('0d053c2e-ce27-49a5-9a0c-e2297af550df', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Paper Shredder',         'Jun 14, 2023, 8:00 PM'::timestamptz, '4c87e0c3-e848-46ad-b772-2c773e940325', '0517332c-697c-47f3-aa52-3770c85106ff', 'King, Feeney and Kutch',  'assigned', 'Taylor Hill',        23),
  ('3e70ec6f-fae6-4a9b-a4c9-c2bb1f15a3d7', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Printer',                'Jul 3, 2023, 8:00 PM'::timestamptz,  '3dfc862a-c15c-4171-a5bf-78000d7f3981', '6bf2afa9-1cda-484f-8dc8-48322f3e1c1c', 'Marquardt - Bailey',      'closed',   'Erick Quigley',      73),
  ('fbd43211-e541-4224-bd58-a71e94d808d3', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Paper Clips',            'Jul 15, 2023, 8:00 PM'::timestamptz, 'fde63f4b-4424-4792-a985-d7becd033152', 'eabbfb71-39b1-4a66-94cf-bb1d70bdcc63', 'Hessel - Muller',         'assigned', 'Latoya Gulgowski',   49),
  ('e586c8eb-3950-49f6-b275-d57b4034702d', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'A4 Paper',               'Jul 23, 2023, 8:00 PM'::timestamptz, '7c8dc075-9a4e-41a3-96d9-eec2682d7b1c', 'b38352f4-2e78-4530-a94f-810dccb0a762', 'King, Feeney and Kutch',  'closed',   NULL,                 24),
  ('7b7d9b21-0c93-4de6-9826-ece0ca4193bc', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'A4 Paper',               'Jun 8, 2023, 8:00 PM'::timestamptz,  '9f31f312-7356-46cb-823f-154ad4e1afce', 'bbfb5080-1a1a-433f-b5e4-abfb0ba7b23f', 'Marquardt - Bailey',      'assigned', 'Gail Weber',         29),
  ('9c2525a4-3392-4bc0-bd6f-5688f07e258b', 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001', 'Paper Clips',            'Jul 3, 2023, 8:00 PM'::timestamptz,  '5ae6104c-674c-413e-bb98-56d6d3cffa29', '0517332c-697c-47f3-aa52-3770c85106ff', 'Hessel - Muller',         'closed',   'Erick Quigley',      23)
ON CONFLICT (order_id) DO UPDATE SET
  item_name = EXCLUDED.item_name,
  order_due_date = EXCLUDED.order_due_date,
  customer_id = EXCLUDED.customer_id,
  consolidated_customer_id = EXCLUDED.consolidated_customer_id,
  customer_name = EXCLUDED.customer_name,
  status = EXCLUDED.status,
  assignee = EXCLUDED.assignee,
  quantity = EXCLUDED.quantity;

-- =============================================================================
-- Seed the Workshop module document for the Orders Inbox demo so the editor
-- at /workshop/ri.workshop.main.module.bb7b3807-fa6c-4440-aecb-33db50d817f7
-- shows real data sourced from this database. The definition includes:
--   - 1 objectSet variable bound to the `order` object type
--   - 1 objectSetFilter variable with 4 filter-by-property constraints
--     matching the demo's filter rail (Item Name, Assignee,
--     Consolidated Customer Id, Customer Name)
--   - 1 active-object variable auto-generated for the table widget
--   - 4 widgets (table + 3 facet placeholders mapped to filter constraints)
--   - 1 root section
-- =============================================================================
UPDATE workshop_module
SET
  display_name = 'Olivier Orders Inbox',
  description = 'Browse, triage, and assign incoming orders. Use the filter rail to narrow by item, assignee, customer, and customer name. The selected row drives the inspector and downstream widgets via the auto-generated active-object variable.',
  definition = jsonb_build_object(
    'schemaVersion', 4,
    'header', jsonb_build_object(
      'title', '[Gena] Orders Inbox',
      'icon',  'inbox',
      'color', 'cerulean'
    ),
    'variables', jsonb_build_array(
      jsonb_build_object(
        'id', 'orderObjectSet1',
        'definitionType', 'objectSet',
        'objectTypeApiName', 'order'
      ),
      jsonb_build_object(
        'id', 'filterList1',
        'definitionType', 'objectSetFilter',
        'constraints', jsonb_build_array(
          jsonb_build_object('kind', 'filterByProperty', 'property', 'item_name',                'uiKind', 'string-multi'),
          jsonb_build_object('kind', 'filterByProperty', 'property', 'assignee',                 'uiKind', 'string-multi'),
          jsonb_build_object('kind', 'filterByProperty', 'property', 'consolidated_customer_id', 'uiKind', 'string-multi'),
          jsonb_build_object('kind', 'filterByProperty', 'property', 'customer_name',            'uiKind', 'string-multi')
        )
      ),
      jsonb_build_object(
        'id', 'objectTable1ActiveObject',
        'definitionType', 'activeObject',
        'sourceWidgetId', 'objectTable1'
      )
    ),
    'widgets', jsonb_build_array(
      jsonb_build_object(
        'id',         'objectTable1',
        'kind',       'objectTable',
        'variableId', 'orderObjectSet1',
        'columns', jsonb_build_array(
          'item_name', 'order_due_date', 'customer_id',
          'consolidated_customer_id', 'customer_name', 'status',
          'assignee', 'quantity'
        )
      ),
      jsonb_build_object(
        'id',         'filterRail1',
        'kind',       'filterRail',
        'variableId', 'filterList1'
      ),
      jsonb_build_object(
        'id',         'pieByStatus1',
        'kind',       'pieChart',
        'variableId', 'orderObjectSet1',
        'groupByProperty', 'status'
      ),
      jsonb_build_object(
        'id',         'barByAssignee1',
        'kind',       'barXyChart',
        'variableId', 'orderObjectSet1',
        'groupByProperty', 'assignee'
      )
    ),
    'sections', jsonb_build_array(
      jsonb_build_object(
        'id',       'sectionRoot',
        'layout',   'rows',
        'children', jsonb_build_array('filterRail1', 'objectTable1', 'pieByStatus1', 'barByAssignee1'),
        'title',    'Orders'
      )
    ),
    'layout', jsonb_build_object('rootSection', 'sectionRoot')
  ),
  updated_at = now()
WHERE rid = 'ri.workshop.main.module.bb7b3807-fa6c-4440-aecb-33db50d817f7';
