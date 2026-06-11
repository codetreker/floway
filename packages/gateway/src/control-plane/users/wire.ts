import type { User } from '../../repo/types.ts';

export const userToEffectiveWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.isAdmin || user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
});

export const userToRawWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
  createdAt: user.createdAt,
});
