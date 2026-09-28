/**
 * The player form's picker (spec/v3.md §25.2), shared by the page and the
 * submit action.
 *
 * The error key the picker reads — outside every block's namespace, since the
 * picker is not a question in the schema.
 */
export const PLAYER_PICKER = '__player';

/** One player as the picker offers them: a name, and the base seats left. */
export type PickerPlayer = { id: number; name: string; remaining: number | null };
