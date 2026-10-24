export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    rdcliDesktop?: {
      openPath: (filePath: string) => Promise<{ ok: boolean; error: string | null }>;
    };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
