export const WS_EVENTS = {
  UPLOAD_STARTED: 'upload.started',
  UPLOAD_COMPLETED: 'upload.completed',
  DATASET_STATUS_CHANGED: 'dataset.statusChanged',
  DATASET_PARSED: 'dataset.parsed',
  DATASET_PARSE_ERROR: 'dataset.parseError',
  FOLDER_CREATED: 'folder.created',
  FOLDER_DELETED: 'folder.deleted',
  DATASET_DELETED: 'dataset.deleted',
} as const;

export type WSEventName = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];
