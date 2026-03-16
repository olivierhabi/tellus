export const DEFAULT_PREFERENCES: Record<string, any> = {
  keyboard_shortcuts: {
    search: 'mod+k', upload: 'mod+u', new_project: 'mod+shift+p',
    new_folder: 'mod+shift+f', delete: 'del', rename: 'f2',
    navigate_up: 'alt+ArrowUp', select_all: 'mod+a', help: 'shift+?',
  },
  theme: 'system',
  sidebar_collapsed: false,
  default_sort: { field: 'updated_at', order: 'desc' },
};
