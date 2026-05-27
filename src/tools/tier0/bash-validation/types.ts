/**
 * Bash command validation — shared result type.
 *
 * The discriminated union returned by every submodule and the top-level
 * dispatcher. Consumers narrow on `kind`.
 */

export type ValidationResult =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: string; readonly submodule: string }
  | { readonly kind: "warn"; readonly message: string; readonly submodule: string };
