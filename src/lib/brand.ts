/**
 * The product's name, and whether it carries the Zetix mark (spec/v3.md §31).
 *
 * The publish script's rename rules rewrite the name below in the public repository, where it
 * reads `Zetix` and the mark, favicon and app icon appear. Under any other name the console keeps
 * its plain music glyph and the default favicon. `string`, not the literal type, so the
 * comparison stays legal in both copies.
 */
export const PRODUCT_NAME: string = 'Zetix';

export const HAS_MARK = PRODUCT_NAME === 'Zetix';
