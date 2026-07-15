import { useUIStore } from '../../stores/ui-store';
import { useTabStore } from '../../stores/tab-store';
import { ResizeHandle } from '../shared/ResizeHandle';
import Sidebar from '../sidebar/Sidebar';
import ChatView from '../chat/ChatView';
import FileEditor from '../editor/FileEditor';
import ContextPanel from '../context/ContextPanel';
import { TaskBoardView } from '../tasks/TaskBoardView';
import { DocsViewer } from '../docs/DocsViewer';
import { WebView } from '../web/WebView';
import DesktopTabView from '../desktop/DesktopTabView';
import { EEditor } from '../editor/EEditor';
import { ChatExporter } from '../exporter/ChatExporter';
import ArtifactPanel from '../artifacts/ArtifactPanel';

export default function MainLayout() {
  const { sidebarVisible, contextPanelVisible, setSidebarWidth, setContextPanelWidth } = useUIStore();
  const activeTab = useTabStore(s => s.tabs.find(t => t.id === s.activeTabId));

  const handleSidebarResize = (delta: number) => {
    const currentWidth = useUIStore.getState().sidebarWidth;
    setSidebarWidth(currentWidth + delta);
  };

  const handleContextPanelResize = (delta: number) => {
    const currentWidth = useUIStore.getState().contextPanelWidth;
    setContextPanelWidth(currentWidth + delta);
  };

  const renderMainContent = () => {
    switch (activeTab?.type) {
      case 'file':
        return <FileEditor />;
      case 'tasks':
        return <TaskBoardView />;
      case 'docs':
        return <DocsViewer />;
      case 'web':
        return <WebView />;
      case 'desktop':
        return <DesktopTabView />;
      case 'editor':
        return <EEditor />;
      case 'exporter':
        return <ChatExporter />;
      default:
        return <ChatView />;
    }
  };

  // The e-Editor and Chat Exporter are self-contained full-width surfaces —
  // the project context panel (Files/Git/Changes/…) only crowds them.
  const fullWidthTab = activeTab?.type === 'editor' || activeTab?.type === 'exporter';

  return (
    <div className="flex-1 flex overflow-hidden">
      <Sidebar />
      {sidebarVisible && (
        <ResizeHandle side="right" onResize={handleSidebarResize} />
      )}
      {renderMainContent()}
      {!fullWidthTab && <ArtifactPanel />}
      {!fullWidthTab && contextPanelVisible && (
        <ResizeHandle side="left" onResize={handleContextPanelResize} />
      )}
      {!fullWidthTab && <ContextPanel />}
    </div>
  );
}
