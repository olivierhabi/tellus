
"use client";

import * as React from "react";
import {
  Switch,
  InputGroup,
  TextArea,
  Collapse,
  Button,
  Icon,
  Divider,
  Menu,
  MenuItem,
  Popover,
} from "@blueprintjs/core";
import { Select, type ItemRenderer } from "@blueprintjs/select";
import {
  ConditionalFormattingRuleDialog,
  type PropertyOption,
} from "@/components/ontology/ConditionalFormattingRuleDialog";
import {
  defaultRule,
  newRuleId,
  ruleColor,
  summarizeRule,
  type ConditionalFormattingRule,
} from "@/lib/conditionalFormatting";

export interface FunctionColumnEditorValue {
  columnName: string;
  numericFormattingEnabled: boolean;
  baseType: BaseTypeValue;
  description: string;
  conditionalFormatting?: ConditionalFormattingRule[];
}

export type BaseTypeValue = "standard" | "currency" | "percent" | "unit";

type BaseTypeOption = { value: BaseTypeValue; label: string };

const BASE_TYPE_OPTIONS: BaseTypeOption[] = [
  { value: "standard", label: "Standard" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
  { value: "unit", label: "Unit" },
];

const ADDITIONAL_OPTIONS = [
  "Use grouping",
  "Notation",
  "Minimum integer digits",
  "Minimum fraction digits",
  "Maximum fraction digits",
  "Minimum significant digits",
  "Maximum significant digits",
];

const renderBaseType: ItemRenderer<BaseTypeOption> = (
  option,
  { handleClick, handleFocus, modifiers }
) => {
  if (!modifiers.matchesPredicate) return null;
  return (
    <Button
      key={option.value}
      small
      minimal
      onClick={handleClick}
      onFocus={handleFocus}
      active={modifiers.active}
      className="!justify-start !w-full !rounded-none"
    >
      <span className="text-[13px] text-[#182026]">{option.label}</span>
    </Button>
  );
};

function FieldLabel({
  children,
  noMargin,
}: {
  children: React.ReactNode;
  noMargin?: boolean;
}) {
  return (
    <div
      className={`text-[11px] font-semibold tracking-widest uppercase text-[#8a9ba8] ${noMargin ? "" : "mb-[6px]"}`}
    >
      {children}
    </div>
  );
}

export interface FunctionColumnEditorProps {
  value: FunctionColumnEditorValue;
  onChange: (value: FunctionColumnEditorValue) => void;
  functionDisplayName?: string;
  onBack?: () => void;
  testIdPrefix?: string;
}

export function FunctionColumnEditor({
  value,
  onChange,
  functionDisplayName,
  onBack,
  testIdPrefix = "function-column-editor",
}: FunctionColumnEditorProps) {
  const [additionalOptionsOpen, setAdditionalOptionsOpen] = React.useState(true);
  const [ruleDialogOpen, setRuleDialogOpen] = React.useState(false);
  const [editingRule, setEditingRule] = React.useState<ConditionalFormattingRule | null>(null);

  const selectedBaseType =
    BASE_TYPE_OPTIONS.find((o) => o.value === value.baseType) ?? BASE_TYPE_OPTIONS[0];

  const updateField = <K extends keyof FunctionColumnEditorValue>(
    field: K,
    fieldValue: FunctionColumnEditorValue[K]
  ) => {
    onChange({ ...value, [field]: fieldValue });
  };

  // ── Conditional formatting rule management ───────────────────────────────
  const rules = value.conditionalFormatting ?? [];

  const resolveName = (apiName: string) =>
    apiName === "this" ? value.columnName || "Function Column" : apiName;

  const updateRules = (next: ConditionalFormattingRule[]) => {
    onChange({ ...value, conditionalFormatting: next });
  };

  const openAddRule = () => {
    const fresh = defaultRule("this", "double");
    updateRules([...rules, fresh]);
    setEditingRule(fresh);
    setRuleDialogOpen(true);
  };

  const openEditRule = (rule: ConditionalFormattingRule) => {
    setEditingRule(rule);
    setRuleDialogOpen(true);
  };

  const upsertRule = (rule: ConditionalFormattingRule) => {
    const i = rules.findIndex((r) => r.id === rule.id);
    if (i === -1) {
      updateRules([...rules, rule]);
    } else {
      const next = rules.slice();
      next[i] = rule;
      updateRules(next);
    }
  };

  const deleteRule = (id: string) => updateRules(rules.filter((r) => r.id !== id));

  const duplicateRule = (rule: ConditionalFormattingRule) => {
    const i = rules.findIndex((r) => r.id === rule.id);
    const copy = { ...rule, id: newRuleId() };
    const next = rules.slice();
    next.splice(i === -1 ? next.length : i + 1, 0, copy);
    updateRules(next);
  };

  const moveRule = (id: string, dir: "up" | "down") => {
    const i = rules.findIndex((r) => r.id === id);
    if (i < 0) return;
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= rules.length) return;
    const next = rules.slice();
    [next[i], next[j]] = [next[j], next[i]];
    updateRules(next);
  };

  // Property options for the rule editor dialog (minimal set for function columns)
  const propertyOptions: PropertyOption[] = [
    {
      apiName: "this",
      displayName: value.columnName || "Function Column",
      baseType: "double",
    },
  ];

  return (
…872 tokens truncated…       <Icon icon="plus" size={13} color="#8a9ba8" />
                    <span className="text-[13px] text-[#182026]">{opt}</span>
                  </div>
                ))}
              </div>
            </Collapse>
          </>
        )}

        <div className="py-3 w-full">
          <FieldLabel>Conditional Formatting</FieldLabel>

          {rules.length > 0 && (
            <div className="flex flex-col gap-1 mb-2">
              {rules.map((rule, idx) => (
                <div
                  key={rule.id}
                  role="button"
                  tabIndex={0}
                  data-testid={`${testIdPrefix}-cf-rule`}
                  data-cf-rule-id={rule.id}
                  onClick={() => openEditRule(rule)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openEditRule(rule);
                    }
                  }}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded border border-[#d3dce6] hover:border-[#2d72d2] hover:bg-[#f5f8fa] cursor-pointer transition-colors"
                >
                  <Icon
                    icon="drag-handle-vertical"
                    size={14}
                    color="#a7b6c2"
                    className="flex-shrink-0"
                  />
                  <span
                    className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                    style={{
                      background: ruleColor(rule) || "transparent",
                      boxShadow: ruleColor(rule)
                        ? undefined
                        : "inset 0 0 0 1px #ced9e0",
                    }}
                  />
                  <span className="text-xs text-[#394b59] truncate flex-1">
                    {summarizeRule(rule, resolveName)}
                  </span>
                  <Popover
                    minimal
                    placement="bottom-end"
                    content={
                      <Menu>
                        <MenuItem
                          icon="edit"
                          text="Edit"
                          onClick={() => openEditRule(rule)}
                        />
                        <MenuItem
                          icon="duplicate"
                          text="Duplicate"
                          onClick={() => duplicateRule(rule)}
                        />
                        <MenuItem
                          icon="arrow-up"
                          text="Move up"
                          disabled={idx === 0}
                          onClick={() => moveRule(rule.id, "up")}
                        />
                        <MenuItem
                          icon="arrow-down"
                          text="Move down"
                          disabled={idx === rules.length - 1}
                          onClick={() => moveRule(rule.id, "down")}
                        />
                        <MenuItem
                          icon="trash"
                          text="Delete"
                          intent="danger"
                          onClick={() => deleteRule(rule.id)}
                        />
                      </Menu>
                    }
                  >
                    <Button
                      minimal
                      small
                      aria-label="Rule options"
                      data-testid={`${testIdPrefix}-cf-rule-menu`}
                      icon={<Icon icon="more" size={14} color="#5c7080" />}
                      className="!min-h-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popover>
                </div>
              ))}
            </div>
          )}

          <Button
            fill
            icon={<Icon icon="plus" size={14} color="#1c2127" />}
            onClick={openAddRule}
            data-testid={`${testIdPrefix}-cf-add-rule`}
          >
            Add rule
          </Button>
        </div>

        <ConditionalFormattingRuleDialog
          isOpen={ruleDialogOpen}
          onClose={() => setRuleDialogOpen(false)}
          selfProperty={propertyOptions[0]}
          properties={propertyOptions}
          initialRule={editingRule}
          onSubmit={upsertRule}
        />

        <FieldLabel>Description</FieldLabel>
        <TextArea
          fill
          value={value.description}
          onChange={(e) => updateField("description", e.target.value)}
          placeholder="Enter a description..."
          rows={3}
          className="!text-[14px] resize-y"
          data-testid={`${testIdPrefix}-description`}
        />
      </div>
    </div>
  );
}

export const DEFAULT_FUNCTION_COLUMN_VALUE: FunctionColumnEditorValue = {
  columnName: "",
  numericFormattingEnabled: true,
  baseType: "standard",
  description: "",
  conditionalFormatting: [],
};
