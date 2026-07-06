import type { DumpMetadata } from './types.ts';
import type { ChannelBroker } from '../runtime/channel-broker-contract.ts';

export type DumpBroker = ChannelBroker<DumpMetadata>;

export const DUMP_DISABLED_REASON = 'dump retention disabled';
