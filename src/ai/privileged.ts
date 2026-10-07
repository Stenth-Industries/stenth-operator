/**
 * privileged() — the side of the boundary that holds credentials (SPEC.md §8).
 *
 * §8: "Its signature does not accept a string. Passing raw text is a compile
 * error, and a test asserts it throws at runtime too."
 *
 * Day 4 builds the boundary, not the callers: assessment and drafting arrive on
 * Day 6 and Day 8 (§25). What exists now is the type that makes the rule real,
 * and the runtime guard behind it — because a compile error only stops the code
 * that is compiled, and `as unknown as` is one keystroke away.
 */

/**
 * A fact object that came through the isolated boundary.
 *
 * The brand is not decoration. Without it, any object literal would satisfy a
 * `privileged(facts: SomeShape)` signature, and the one thing this boundary
 * must prevent is page content arriving in the privileged zone wearing the
 * right shape. Only `attestValidated` applies it, and it is called in exactly
 * one place: after a strict parse and the sanitiser.
 */
declare const validated: unique symbol;

export type Validated<T> = T & { readonly [validated]: true };

/** Applied once, by the extract handler, to output that passed §8's parse. */
export function attestValidated<T extends object>(value: T): Validated<T> {
  return value as Validated<T>;
}

/**
 * Throws unless the argument is a validated fact object.
 *
 * Every privileged entry point calls this first. The list of rejections is
 * explicit because the interesting failure is not "someone passed a number" —
 * it is "someone passed the page".
 */
export function assertPrivilegedInput(facts: unknown): void {
  if (typeof facts === 'string') {
    throw new TypeError(
      'privileged() was handed a string. Raw text never crosses the trust ' +
        'boundary: it is processed only in the tool-less isolated call and ' +
        'reaches the privileged zone as schema-validated facts (SPEC.md §8).',
    );
  }
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new TypeError(
      'privileged() takes a validated fact object, not a ' +
        `${facts === null ? 'null' : Array.isArray(facts) ? 'array' : typeof facts}.`,
    );
  }
}
