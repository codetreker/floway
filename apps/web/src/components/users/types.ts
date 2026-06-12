export interface WireUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
  canViewGlobalTelemetry: boolean;
  createdAt: string;
}
