import { ElectronAPI } from "@electron-toolkit/preload";

interface ChatRequest {
  message: string;
  context: {
    url: string | null;
    content: string | null;
    text: string | null;
  };
  messageId: string;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
}

interface ChatReasoning {
  messageId: string;
  content: string;
  isComplete: boolean;
}

interface ChatNavigation {
  messageId: string;
  content: string;
  isComplete: boolean;
}

interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

interface SidebarAPI {
  // Sidebar layout
  getSidebarWidth: () => Promise<number>;
  setSidebarWidth: (width: number) => Promise<number>;

  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) => Promise<void>;
  abortChat: () => Promise<boolean>;
  onChatResponse: (callback: (data: ChatResponse) => void) => void;
  removeChatResponseListener: () => void;

  onChatReasoning: (callback: (data: ChatReasoning) => void) => void;
  removeChatReasoningListener: () => void;

  onChatNavigation: (callback: (data: ChatNavigation) => void) => void;
  removeChatNavigationListener: () => void;

  clearChat: () => Promise<void>;
  getMessages: () => Promise<any[]>;

  onMessagesUpdated: (callback: (messages: any[]) => void) => void;
  removeMessagesUpdatedListener: () => void;

  // Page content access
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;

  // Tab information
  getActiveTabInfo: () => Promise<TabInfo | null>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

