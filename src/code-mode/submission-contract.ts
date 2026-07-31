/**
 * Code Mode submission shape classification.
 *
 * Both Code Mode tools evaluate the submitted string as a single expression
 * and call the result. A submission of bare top-level statements therefore
 * fails at compile time with a message about whatever token happened to come
 * first ("Unexpected token 'const'"), which describes the wrapper rather than
 * the mistake. These helpers tell the two apart so the caller can be told the
 * actual contract instead.
 *
 * Classification (verified against node:vm over the shapes in
 * src/code-mode/__tests__): a submission that parses as an expression is
 * well-formed and only its runtime `typeof` matters; one that fails as an
 * expression but parses as a function body is bare statements; one that fails
 * both has a genuine syntax error inside it and must keep its own message.
 */

import * as vm from "node:vm";

function parses(source: string): boolean {
  try {
    // Compiling is the entire test; the Script itself is never run.
    return Boolean(new vm.Script(source));
  } catch {
    return false;
  }
}

/**
 * True when `code` is a sequence of statements rather than a single
 * expression — the shape that produces a misleading parse error. The newlines
 * matter: they keep a trailing line comment in the submission from commenting
 * out the closing delimiter.
 */
export function isBareStatementSubmission(code: string): boolean {
  return !parses(`(\n${code}\n)`) && parses(`(async function () {\n${code}\n})`);
}
