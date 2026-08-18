import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SPEC_PATTERN = /\.(spec|perf)\.ts$/;
const CANONICAL_TEST_HELPER = "../helpers/test";
const exempt = new Set(["agents-everywhere.live.spec.ts"]);

function namedImport(declaration, name) {
  return declaration.importClause?.namedBindings?.elements.some(
    (element) =>
      element.name.text === name && element.propertyName === undefined,
  );
}

function callbackOf(call) {
  const candidate = call.arguments.at(-1);
  return candidate &&
    (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
    ? candidate
    : undefined;
}

function testMember(call) {
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "test"
    ? call.expression.name.text
    : undefined;
}

function isTestRegistration(call) {
  if (ts.isIdentifier(call.expression)) return call.expression.text === "test";
  const member = testMember(call);
  return (
    member !== undefined &&
    ![
      "beforeEach",
      "afterEach",
      "beforeAll",
      "afterAll",
      "describe",
      "use",
      "setTimeout",
      "slow",
      "step",
      "skip",
      "fixme",
      "fail",
    ].includes(member)
  );
}

function collectFunctionDeclarations(file) {
  const functions = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name)
      functions.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return functions;
}

function callbackBootstraps(callback, functions) {
  const visitedFunctions = new Set();
  const inspect = (node) => {
    let found = false;
    const visit = (child) => {
      if (
        ts.isAwaitExpression(child) &&
        ts.isCallExpression(child.expression) &&
        ts.isIdentifier(child.expression.expression) &&
        child.expression.expression.text === "bootstrapE2ePage"
      ) {
        found = true;
        return;
      }
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        const declaration = functions.get(child.expression.text);
        if (declaration && !visitedFunctions.has(child.expression.text)) {
          visitedFunctions.add(child.expression.text);
          if (inspect(declaration.body)) found = true;
        }
      }
      if (!found) ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  };
  return inspect(callback.body);
}

function scanFile(file, functions) {
  const hooks = [];
  const tests = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callback = callbackOf(node);
      const member = testMember(node);
      if (member === "beforeEach" && callback)
        hooks.push(callbackBootstraps(callback, functions));
      else if (isTestRegistration(node) && callback)
        tests.push(callbackBootstraps(callback, functions));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { hooks, tests };
}

export function checkSource(source, filename = "fixture.spec.ts") {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const helperImports = file.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === CANONICAL_TEST_HELPER,
  );
  if (
    !helperImports.some((declaration) => namedImport(declaration, "test")) ||
    !helperImports.some((declaration) =>
      namedImport(declaration, "bootstrapE2ePage"),
    )
  ) {
    return "must directly import unaliased test and bootstrapE2ePage from ../helpers/test";
  }

  const { hooks, tests } = scanFile(file, collectFunctionDeclarations(file));
  if (!tests.length) return "does not register a browser test";
  if (!hooks.some(Boolean) && !tests.some(Boolean)) {
    return "must await bootstrapE2ePage on every test path, directly or through a registered test.beforeEach";
  }
}

export function runCheck(projectRoot) {
  const violations = [];
  for (const name of fs
    .readdirSync(path.join(projectRoot, "tests/e2e"))
    .filter((name) => SPEC_PATTERN.test(name))) {
    if (exempt.has(name)) continue;
    const violation = checkSource(
      fs.readFileSync(path.join(projectRoot, "tests/e2e", name), "utf8"),
      name,
    );
    if (violation) violations.push(`${name}: ${violation}`);
  }
  return violations;
}

if (process.argv[1] === import.meta.filename) {
  const violations = runCheck(path.resolve(import.meta.dirname, ".."));
  if (violations.length) {
    console.error(
      `E2E specs must register bootstrapE2ePage after their setup:\n${violations.join("\n")}`,
    );
    process.exit(1);
  }
}
