/**
 * Where the builder leaves the schema it is currently showing, for the preview
 * tab to pick up.
 *
 * **One name, stated once**, because the two sides of this handoff are in
 * different route groups and a key typed twice is a key that will eventually
 * be typed differently — a preview that silently shows the saved form while the
 * admin believes they are looking at their edits.
 *
 * Keyed per form so two builders open in two tabs cannot show each other's
 * questions.
 */
export const PREVIEW_DRAFT_KEY = (formId: number) => `zetix:form-preview:${formId}`;

/** Where the preview opens, for whoever is linking to it. */
export const PREVIEW_PATH = (formId: number) => `/preview/${formId}`;
