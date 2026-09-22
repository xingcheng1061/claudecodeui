import { Folder, PanelLeftClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';

import type { DirectoryRevealRequest, Project } from '@/shared/types';
import FileTree from '@/modules/file-tree/FileTree';

type FilesSidebarProps = {
  selectedProject: Project;
  onFileOpen: (filePath: string) => void;
  revealDirectory: DirectoryRevealRequest | null;
  width: number;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onClose: () => void;
  /** Mobile: a full-height overlay drawer instead of a docked, resizable column. */
  overlay?: boolean;
};

const HEADER_CLASSES = 'flex flex-shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2';
const CLOSE_BUTTON_CLASSES = 'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

/**
 * The file tree as a permanent sidebar beside Chat/Shell, modelled on
 * `EditorSidebar`'s docked layout: a content column plus a right-edge resize
 * handle using the same divider styling. On mobile it becomes an overlay
 * drawer with a backdrop instead — no resize handle, closing on backdrop tap.
 *
 * Mounted for as long as the sidebar is open, so the tree's own state
 * (expanded directories, search) survives switching between Chat and Shell.
 */
export default function FilesSidebar({
  selectedProject,
  onFileOpen,
  revealDirectory,
  width,
  resizeHandleRef,
  onResizeStart,
  onClose,
  overlay = false,
}: FilesSidebarProps) {
  const { t } = useTranslation();

  const header = (
    <div className={HEADER_CLASSES}>
      <Folder className="h-4 w-4 text-muted-foreground" />
      <span className="flex-1 truncate text-sm font-medium text-foreground">{t('tabs.files')}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('actions.close')}
        title={t('actions.close')}
        className={CLOSE_BUTTON_CLASSES}
      >
        <PanelLeftClose className="h-4 w-4" />
      </button>
    </div>
  );

  const tree = (
    <div className="min-h-0 flex-1 overflow-hidden">
      <FileTree
        selectedProject={selectedProject}
        onFileOpen={onFileOpen}
        revealDirectory={revealDirectory}
      />
    </div>
  );

  if (overlay) {
    return (
      <>
        <div className="fixed inset-0 z-30 bg-black/50" onClick={onClose} aria-hidden="true" />
        <div className="fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-sm flex-col border-r border-border bg-background shadow-xl">
          {header}
          {tree}
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full flex-shrink-0" style={{ width: `${width}px`, minWidth: '200px' }}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {header}
        {tree}
      </div>
      <div
        ref={resizeHandleRef}
        onMouseDown={onResizeStart}
        className="group relative w-1 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-blue-500 dark:bg-gray-700 dark:hover:bg-blue-600"
        title="Drag to resize"
      >
        <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-blue-600" />
      </div>
    </div>
  );
}
