'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// Types
interface Parameter {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date' | 'enum';
  required: boolean;
  description?: string;
  defaultValue?: string;
  enumValues?: string[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
  order: number;
}

interface ActionType {
  id: string;
  name: string;
  description: string;
  parameters: Parameter[];
  createdAt: string;
  updatedAt: string;
}

// API functions
const fetchActionType = async (id: string): Promise<ActionType> => {
  const response = await fetch(`/api/ontology/action-types/${id}`);
  if (!response.ok) throw new Error('Failed to fetch action type');
  return response.json();
};

const saveActionType = async (data: { id: string; parameters: Parameter[] }): Promise<ActionType> => {
  const response = await fetch(`/api/ontology/action-types/${data.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: data.parameters }),
  });
  if (!response.ok) throw new Error('Failed to save action type');
  return response.json();
};

// Utility to generate unique IDs
const generateId = () => `param_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Parameter Type Options
const PARAMETER_TYPES: Parameter['type'][] = ['string', 'number', 'boolean', 'object', 'array', 'date', 'enum'];

export default function FormContentPage() {
  const params = useParams();
  const actionTypeId = params?.actionTypeId as string;
  const queryClient = useQueryClient();

  // State
  const [parameters, setParameters] = useState<Parameter[]>([]);
  const [selectedParameterId, setSelectedParameterId] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<'form' | 'json'>('form');

  // Refs for drag and drop
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  // Fetch action type
  const { data: actionType, isLoading, error } = useQuery({
    queryKey: ['actionType', actionTypeId],
    queryFn: () => fetchActionType(actionTypeId),
    enabled: !!actionTypeId,
  });

  // Sync local state with fetched data
  useEffect(() => {
    if (actionType?.parameters) {
      setParameters(actionType.parameters.sort((a, b) => a.order - b.order));
      setHasChanges(false);
    }
  }, [actionType]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: saveActionType,
    onSuccess: (data) => {
      queryClient.setQueryData(['actionType', actionTypeId], data);
      setHasChanges(false);
    },
  });

  // Get selected parameter
  const selectedParameter = parameters.find(p => p.id === selectedParameterId);

  // Handlers
  const handleAddParameter = useCallback(() => {
    const newParam: Parameter = {
      id: generateId(),
      name: `parameter_${parameters.length + 1}`,
      type: 'string',
      required: false,
      description: '',
      order: parameters.length,
    };
    setParameters(prev => [...prev, newParam]);
    setSelectedParameterId(newParam.id);
    setHasChanges(true);
  }, [parameters.length]);

  const handleRemoveParameter = useCallback((id: string) => {
    setParameters(prev => {
      const filtered = prev.filter(p => p.id !== id);
      // Reorder remaining parameters
      return filtered.map((p, idx) => ({ ...p, order: idx }));
    });
    if (selectedParameterId === id) {
      setSelectedParameterId(null);
    }
    setHasChanges(true);
  }, [selectedParameterId]);

  const handleParameterClick = useCallback((id: string) => {
    setSelectedParameterId(prev => prev === id ? null : id);
  }, []);

  const handleParameterUpdate = useCallback((id: string, updates: Partial<Parameter>) => {
    setParameters(prev =>
      prev.map(p => (p.id === id ? { ...p, ...updates } : p))
    );
    setHasChanges(true);
  }, []);

  // Drag and Drop Handlers (HTML5 Native)
  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
    // Add dragging visual feedback
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>, dropIndex: number) => {
    e.preventDefault();

    if (draggedIndex === null || draggedIndex === dropIndex) return;

    const dragIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);

    setParameters(prev => {
      const newParams = [...prev];
      const [draggedItem] = newParams.splice(dragIndex, 1);
      newParams.splice(dropIndex, 0, draggedItem);
      // Update order property
      return newParams.map((p, idx) => ({ ...p, order: idx }));
    });

    setHasChanges(true);
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex]);

  const handleSave = useCallback(() => {
    if (!actionTypeId || !hasChanges) return;
    saveMutation.mutate({ id: actionTypeId, parameters });
  }, [actionTypeId, hasChanges, parameters, saveMutation]);

  const handleReset = useCallback(() => {
    if (actionType?.parameters) {
      setParameters(actionType.parameters.sort((a, b) => a.order - b.order));
      setSelectedParameterId(null);
      setHasChanges(false);
    }
  }, [actionType]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-red-500">Error loading action type</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="bg-white border-b px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">
                {actionType?.name || 'Action Type Editor'}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                Manage parameters for this action type
              </p>
            </div>

            {/* Save/Reset Buttons */}
            <div className="flex items-center gap-3">
              {hasChanges && (
                <span className="text-sm text-amber-600 flex items-center gap-1">
                  <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                  Unsaved changes
                </span>
              )}
              <button
                onClick={handleReset}
                disabled={!hasChanges}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges || saveMutation.isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {saveMutation.isPending ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Parameter List */}
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-2xl mx-auto">
              {/* Add Parameter Button */}
              <button
                onClick={handleAddParameter}
                className="w-full mb-4 py-3 px-4 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Parameter
              </button>

              {/* Parameter List */}
              <div className="space-y-2">
                {parameters.map((param, index) => (
                  <div
                    key={param.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, index)}
                    onClick={() => handleParameterClick(param.id)}
                    className={`
                      bg-white rounded-lg border-2 p-4 cursor-pointer transition-all
                      ${selectedParameterId === param.id
                        ? 'border-blue-500 shadow-md'
                        : 'border-gray-200 hover:border-gray-300'}
                      ${draggedIndex === index ? 'opacity-50' : ''}
                      ${dragOverIndex === index && draggedIndex !== index ? 'border-t-2 border-t-blue-400' : ''}
                    `}
                  >
                    <div className="flex items-center gap-3">
                      {/* Drag Handle */}
                      <div className="cursor-grab text-gray-400 hover:text-gray-600">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 6a2 2 0 11-4 0 2 2 0 014 0zm0 6a2 2 0 11-4 0 2 2 0 014 0zm0 6a2 2 0 11-4 0 2 2 0 014 0zm8-12a2 2 0 11-4 0 2 2 0 014 0zm0 6a2 2 0 11-4 0 2 2 0 014 0zm0 6a2 2 0 11-4 0 2 2 0 014 0z" />
                        </svg>
                      </div>

                      {/* Parameter Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 truncate">{param.name}</span>
                          {param.required && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                              Required
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-500 mt-0.5">
                          <span className="font-mono">{param.type}</span>
                          {param.description && (
                            <span className="mx-2">·</span>
                          )}
                          {param.description}
                        </div>
                      </div>

                      {/* Order Badge */}
                      <span className="text-xs text-gray-400 font-mono">#{param.order + 1}</span>

                      {/* Delete Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveParameter(param.id);
                        }}
                        className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}

                {parameters.length === 0 && (
                  <div className="text-center py-12 text-gray-500">
                    <svg className="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <p>No parameters yet</p>
                    <p className="text-sm mt-1">Click the button above to add your first parameter</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Preview Panel */}
          <div className="w-96 border-l bg-white flex flex-col">
            <div className="p-4 border-b bg-gray-50">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPreviewMode('form')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    previewMode === 'form'
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  Form Preview
                </button>
                <button
                  onClick={() => setPreviewMode('json')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    previewMode === 'json'
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  JSON Schema
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {previewMode === 'form' ? (
                <div className="space-y-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Form Preview</h3>
                  {parameters.map((param) => (
                    <div key={param.id} className="space-y-1">
                      <label className="block text-sm font-medium text-gray-700">
                        {param.name}
                        {param.required && <span className="text-red-500 ml-1">*</span>}
                      </label>
                      {param.type === 'boolean' ? (
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                            defaultChecked={param.defaultValue === 'true'}
                          />
                        </div>
                      ) : param.type === 'enum' && param.enumValues ? (
                        <select className="w-full px-3 py-2 border border-gray-300 rounded-md">
                          <option value="">Select...</option>
                          {param.enumValues.map((val) => (
                            <option key={val} value={val}>{val}</option>
                          ))}
                        </select>
                      ) : param.type === 'number' ? (
                        <input
                          type="number"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder={param.description || `Enter ${param.type}`}
                          min={param.validation?.min}
                          max={param.validation?.max}
                        />
                      ) : param.type === 'date' ? (
                        <input
                          type="date"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        />
                      ) : param.type === 'object' || param.type === 'array' ? (
                        <textarea
                          className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm"
                          rows={3}
                          placeholder={param.type === 'array' ? '[]' : '{}'}
                        />
                      ) : (
                        <input
                          type="text"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder={param.description || `Enter ${param.type}`}
                          pattern={param.validation?.pattern}
                        />
                      )}
                      {param.description && (
                        <p className="text-xs text-gray-500">{param.description}</p>
                      )}
                    </div>
                  ))}
                  {parameters.length === 0 && (
                    <p className="text-sm text-gray-500 text-center py-8">
                      Add parameters to see the form preview
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-3">JSON Schema</h3>
                  <pre className="text-xs font-mono bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
                    {JSON.stringify(
                      {
                        type: 'object',
                        properties: parameters.reduce((acc, p) => {
                          const prop: Record<string, unknown> = {
                            type: p.type,
                            description: p.description,
                          };
                          if (p.type === 'enum' && p.enumValues) {
                            prop.enum = p.enumValues;
                          }
                          if (p.validation) {
                            Object.assign(prop, p.validation);
                          }
                          if (p.defaultValue !== undefined) {
                            prop.default = p.defaultValue;
                          }
                          acc[p.name] = prop;
                          return acc;
                        }, {} as Record<string, unknown>),
                        required: parameters.filter(p => p.required).map(p => p.name),
                      },
                      null,
                      2
                    )}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right Sidebar - Parameter Properties Editor */}
      <div
        className={`
          w-80 bg-white border-l flex flex-col transition-all duration-300 overflow-hidden
          ${selectedParameter ? 'translate-x-0' : 'translate-x-full'}
        `}
      >
        {selectedParameter && (
          <>
            <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Edit Parameter</h2>
              <button
                onClick={() => setSelectedParameterId(null)}
                className="p-1 hover:bg-gray-200 rounded transition-colors"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    value={selectedParameter.name}
                    onChange={(e) =>
                      handleParameterUpdate(selectedParameter.id, { name: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="parameter_name"
                  />
                </div>

                {/* Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Type
                  </label>
                  <select
                    value={selectedParameter.type}
                    onChange={(e) =>
                      handleParameterUpdate(selectedParameter.id, {
                        type: e.target.value as Parameter['type'],
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {PARAMETER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Required */}
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="required"
                    checked={selectedParameter.required}
                    onChange={(e) =>
                      handleParameterUpdate(selectedParameter.id, { required: e.target.checked })
                    }
                    className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="required" className="ml-2 text-sm text-gray-700">
                    Required field
                  </label>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={selectedParameter.description || ''}
                    onChange={(e) =>
                      handleParameterUpdate(selectedParameter.id, { description: e.target.value })
                    }
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Describe this parameter..."
                  />
                </div>

                {/* Default Value */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Default Value
                  </label>
                  <input
                    type="text"
                    value={selectedParameter.defaultValue || ''}
                    onChange={(e) =>
                      handleParameterUpdate(selectedParameter.id, { defaultValue: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Optional default value"
                  />
                </div>

                {/* Enum Values (only for enum type) */}
                {selectedParameter.type === 'enum' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Enum Values
                    </label>
                    <textarea
                      value={(selectedParameter.enumValues || []).join('\n')}
                      onChange={(e) =>
                        handleParameterUpdate(selectedParameter.id, {
                          enumValues: e.target.value.split('\n').filter(Boolean),
                        })
                      }
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                      placeholder="value1&#10;value2&#10;value3"
                    />
                    <p className="text-xs text-gray-500 mt-1">One value per line</p>
                  </div>
                )}

                {/* Validation (for number type) */}
                {selectedParameter.type === 'number' && (
                  <div className="space-y-3">
                    <label className="block text-sm font-medium text-gray-700">
                      Validation
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Min</label>
                        <input
                          type="number"
                          value={selectedParameter.validation?.min || ''}
                          onChange={(e) =>
                            handleParameterUpdate(selectedParameter.id, {
                              validation: {
                                ...selectedParameter.validation,
                                min: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            })
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Max</label>
                        <input
                          type="number"
                          value={selectedParameter.validation?.max || ''}
                          onChange={(e) =>
                            handleParameterUpdate(selectedParameter.id, {
                              validation: {
                                ...selectedParameter.validation,
                                max: e.target.value ? parseFloat(e.target.value) : undefined,
                              },
                            })
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Pattern (for string type) */}
                {selectedParameter.type === 'string' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Regex Pattern
                    </label>
                    <input
                      type="text"
                      value={selectedParameter.validation?.pattern || ''}
                      onChange={(e) =>
                        handleParameterUpdate(selectedParameter.id, {
                          validation: {
                            ...selectedParameter.validation,
                            pattern: e.target.value || undefined,
                          },
                        })
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                      placeholder="^[a-z]+$"
                    />
                    <p className="text-xs text-gray-500 mt-1">Regular expression pattern</p>
                  </div>
                )}

                {/* Order */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Order Position
                  </label>
                  <select
                    value={selectedParameter.order}
                    onChange={(e) => {
                      const newOrder = parseInt(e.target.value, 10);
                      setParameters((prev) => {
                        const result = [...prev];
                        const currentIdx = result.findIndex((p) => p.id === selectedParameter.id);
                        const targetIdx = newOrder;

                        // Remove from current position
                        const [item] = result.splice(currentIdx, 1);
                        // Insert at new position
                        result.splice(targetIdx, 0, item);
                        // Update all order properties
                        return result.map((p, idx) => ({ ...p, order: idx }));
                      });
                      setHasChanges(true);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {parameters.map((_, idx) => (
                      <option key={idx} value={idx}>
                        Position {idx + 1}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Sidebar Footer */}
            <div className="p-4 border-t bg-gray-50">
              <button
                onClick={() => handleRemoveParameter(selectedParameter.id)}
                className="w-full px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors"
              >
                Delete Parameter
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
