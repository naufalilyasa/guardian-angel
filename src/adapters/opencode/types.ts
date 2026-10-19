export type IpcDecision = "allow" | "deny";

export type IpcRequest = {
  callID: string;
  sessionID: string;
  tool: string;
  command?: string;
  path?: string;
  reason: string;
  ruleId: string;
  createdAt: number;
  deadline: number;
  nonce?: string;
};

export type IpcResponse = {
  callID: string;
  decision: IpcDecision;
  answeredAt: number;
  nonce?: string;
};

export type IpcHeartbeat = {
  pid: number;
  updatedAt: number;
};

export type OpenCodeServerOptions = {
  pkgRoot?: string;
  confirmTimeoutMs?: number;
  ipcDir?: string;
};
