import { vi } from "vitest";

const listeners: Record<string, ((event: any) => void)[]> = {};

// Mock @tauri-apps/api/event with an in-memory event bus
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation(async (eventName: string, callback: (event: any) => void) => {
    if (!listeners[eventName]) {
      listeners[eventName] = [];
    }
    listeners[eventName].push(callback);
    
    // Return unlisten function
    return () => {
      listeners[eventName] = listeners[eventName].filter((cb) => cb !== callback);
    };
  }),
  emit: vi.fn().mockImplementation(async (eventName: string, payload: any) => {
    if (listeners[eventName]) {
      // In Tauri, the listen callback receives an event object where the data is in `event.payload`
      for (const callback of listeners[eventName]) {
        callback({ payload });
      }
    }
    return Promise.resolve();
  }),
}));

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: vi.fn((path) => `convertFileSrc(${path})`),
}));

// Mock @tauri-apps/api/window
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  })),
}));

// Mock @tauri-apps/api/webviewWindow
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: vi.fn(),
}));
