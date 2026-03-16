export interface HintsAction {
  action: string;
  label: string;
  description?: string;
}

export interface HintsResponse {
  actions?: HintsAction[];
  suggestions?: string[];
  message?: string;
}

export const PROJECT_EMPTY_HINTS: HintsResponse = {
  message: 'Create your first project to get started with Foundry.',
  actions: [{ action: 'create_project', label: 'Create Project', description: 'Projects organize your folders and datasets.' }],
};

export const FOLDER_EMPTY_HINTS: HintsResponse = {
  message: 'This folder is empty.',
  actions: [
    { action: 'upload_files', label: 'Upload Files', description: 'Upload CSV or Excel files to create datasets.' },
    { action: 'create_subfolder', label: 'Create Folder', description: 'Organize your data with subfolders.' },
  ],
};

export const SEARCH_EMPTY_HINTS: HintsResponse = {
  message: 'No results found for your search.',
  suggestions: ['Check your spelling', 'Try broader keywords', 'Remove filters to expand results', 'Search by file name or dataset content'],
};
