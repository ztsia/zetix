import 'server-only';
import type { AnyCommand } from '@/lib/commands/define';
import { PARTY_COMMANDS } from './party';
import { SEAT_COMMANDS } from './seat';

/** Every command the Audience workspace owns (spec/v3.md §23.2), for `registry.ts`. */
export const AUDIENCE_COMMANDS: AnyCommand[] = [...PARTY_COMMANDS, ...SEAT_COMMANDS];
