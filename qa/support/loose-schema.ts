/**
 * A form schema as a QA probe handles it: shaped like one, but not promised to
 * be valid.
 *
 * The probes in `qa/backend/` and `qa/e2e/` do two things the application code
 * never does — they build schemas the contract must **refuse**, and they read a
 * `jsonb` column back with no guarantee about what a past version wrote into
 * it. Neither is a `FormSchema`, so neither can be typed as one.
 *
 * `any` would say that much and is what these files first reached for, but the
 * repo's lint forbids it and it says too little besides. This says the shape is
 * a schema's, the values are open, and every mutation reaching for `blocks` or
 * `fields` really is reaching for a key that exists.
 */

export type LooseField = {
  key: string;
  label?: string;
  type?: string;
  system?: boolean;
  required?: boolean;
  condition?: unknown;
  [more: string]: unknown;
};

export type LooseBlock = {
  id: string;
  type: string;
  title?: string;
  fields?: LooseField[];
  guest_fields?: LooseField[];
  [more: string]: unknown;
};

export type LooseSchema = {
  kind: string;
  blocks: LooseBlock[];
  [more: string]: unknown;
};

/**
 * `find` that throws rather than returning `undefined`.
 *
 * A probe whose lookup silently missed would mutate nothing, submit a perfectly
 * valid schema, and pass — reporting that the boundary held when it was never
 * tested. That is the one failure mode these files must not have.
 */
export function blockOfType(schema: LooseSchema, type: string): LooseBlock {
  const block = schema.blocks.find((candidate) => candidate.type === type);
  if (!block) throw new Error(`fixture has no ${type} block`);
  return block;
}

export function blockWithId(schema: LooseSchema, id: string): LooseBlock {
  const block = schema.blocks.find((candidate) => candidate.id === id);
  if (!block) throw new Error(`fixture has no "${id}" block`);
  return block;
}

/** A block's fields under whichever key holds them, never undefined. */
export function fieldsOf(block: LooseBlock): LooseField[] {
  const fields = block.guest_fields ?? block.fields;
  if (!fields) throw new Error(`the "${block.id}" block carries no fields`);
  return fields;
}

export function fieldWithKey(fields: LooseField[] | undefined, key: string): LooseField {
  const field = fields?.find((candidate) => candidate.key === key);
  if (!field) throw new Error(`fixture has no "${key}" field`);
  return field;
}
