// P2-006-008 — synchronous ModuleWrap: custom binding implementation of Node's
// ModuleWrap contract (src/module_wrap.cc JS-facing surface) that enables
// SYNCHRONOUS evaluation of ESM graphs in a host whose engine cannot run
// v8::Module::Evaluate synchronously (browser Worker: dynamic import() of a
// Blob settles on the microtask queue).
//
// Strategy (ADR-0013): acorn parse → transform to a factory function:
//   - dependencies evaluated depth-first post-order through __c_req(i)
//     (ESM evaluation order); cycles return the partially-initialized
//     namespace whose getters are already installed (live bindings);
//   - imports resolved through a `with`-scope Proxy over the dependency
//     namespaces (live bindings; assignment → TypeError);
//   - exports installed as getters on the namespace object BEFORE dependency
//     evaluation begins (TDZ-faithful for let/const/class, hoisted for
//     function declarations);
//   - top-level function declarations emitted before dependency evaluation
//     (ESM instantiation-time function binding initialization);
//   - top-level `this` → (void 0); import.meta → host-built meta object;
//     dynamic import() → host dynamic-import lane;
//   - top-level await detected at parse time → hasTopLevelAwait; the factory
//     is compiled ASYNC for such modules (upstream ModuleJobSync throws
//     ERR_REQUIRE_ASYNC_MODULE before evaluateSync via hasAsyncGraph).
//
// The upstream Node loader JS (cjs/loader.js → esm/loader.js →
// module_job.js → translators.js) drives this class untouched; only the
// binding surface is custom, exactly like Node's own C++ binding is the
// custom surface under the same JS.
//
// Documented divergences from native V8 module evaluation (none observed in
// the npm 12.2.2 / expo dependency trees; see ADR-0013):
//   D1 module top-level `arguments` references (SyntaxError natively via
//      post-parse check, mirroring V8);
//   D2 module-scope direct `eval(...)` executes in sloppy mode;
//   D3 `export default <expr>` reads as `undefined` instead of throwing
//      ReferenceError when accessed before the statement executes (cyclic
//      corner);
//   D4 function declarations nested in blocks follow Annex B sloppy-mode
//      hoisting rather than strict block scoping;
//   D5 namespace properties are configurable (native: non-configurable).
//
// License: MIT (this file). acorn is vendored separately (MIT).

'use strict';

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function walkPattern(p, out) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern':
      for (const pr of p.properties) {
        if (pr.type === 'RestElement') walkPattern(pr.argument, out);
        else walkPattern(pr.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of p.elements) walkPattern(el, out);
      break;
    case 'AssignmentPattern': walkPattern(p.left, out); break;
    case 'RestElement': walkPattern(p.argument, out); break;
    default: break;
  }
}

function collectDeclaredNames(decl, out) {
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) walkPattern(d.id, out);
  } else if (decl.id && decl.id.type === 'Identifier') {
    out.push(decl.id.name);
  }
}

// Generic recursive AST walk with scope-depth tracking.
// fn(node, st) is called on entry of every node.
function walkScopeAware(node, fn, st) {
  fn(node, st);
  const t = node.type;
  const isArrow = t === 'ArrowFunctionExpression';
  const isFnLike = /Function/.test(t) || isArrow;
  const isClassLike = t === 'ClassDeclaration' || t === 'ClassExpression' || t === 'StaticBlock';
  if (isArrow) { st.fnDepth++; }
  else if (isFnLike) { st.fnDepth++; st.thisDepth++; }
  else if (isClassLike) { st.thisDepth++; }
  for (const key in node) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'sourceFile') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && typeof item.type === 'string') walkScopeAware(item, fn, st);
      }
    } else if (v && typeof v === 'object' && typeof v.type === 'string') {
      walkScopeAware(v, fn, st);
    }
  }
  if (isArrow) { st.fnDepth--; }
  else if (isFnLike) { st.fnDepth--; st.thisDepth--; }
  else if (isClassLike) { st.thisDepth--; }
}

function exportedName(node) {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

// ---------------------------------------------------------------------------
// The transform: ESM source → factory function source + static descriptors
// ---------------------------------------------------------------------------

function transformModuleSource(acorn, source, url) {
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
    });
  } catch (e) {
    const err = new SyntaxError(e.message);
    if (e.loc) err.message = e.message; // acorn messages carry "line/column"
    err.nodineUrl = url;
    throw err;
  }

  const requests = [];                  // {specifier, attributes, phase}
  const importBindings = new Map();     // localName -> {reqIdx, importName|null}
  const exportLocal = new Map();        // exportedName -> localName
  const exportReexport = new Map();     // exportedName -> {reqIdx, importName|null}
  const exportStarIdx = [];             // request indices of `export * from`
  let defaultLocal = null;              // local name bound to the default export
  let defaultIsDeclName = false;        // default exports a named fn/class decl
  const hoistedFns = [];                // top-level FunctionDeclaration sources
  const bodyParts = [];                 // remaining statement sources (order preserved)
  const allNames = new Set();           // every locally-bound or imported name
  let hasTLA = false;
  let hasTopLevelArguments = false;
  let hasDirectEval = false;
  let hasTopLevelThis = false;

  const st = {
    fnDepth: 0, thisDepth: 0,
    reps: [],
    onNode(node, s) {
      if (node.type === 'AwaitExpression' && s.fnDepth === 0) hasTLA = true;
      else if (node.type === 'ForOfStatement' && node.await && s.fnDepth === 0) hasTLA = true;
      else if (node.type === 'ThisExpression' && s.thisDepth === 0) { hasTopLevelThis = true; s.reps.push({ start: node.start, end: node.end, text: '(void 0)' }); }
      else if (node.type === 'MetaProperty' && node.meta && node.meta.name === 'import' && node.property && node.property.name === 'meta') {
        s.reps.push({ start: node.start, end: node.end, text: '\u0000NODINE_META' });
      } else if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Import') {
        s.reps.push({ start: node.callee.start, end: node.callee.end, text: '\u0000NODINE_DYN' });
      } else if (node.type === 'Identifier' && node.name === 'arguments' && s.fnDepth === 0 && !s.inShorthandKey) {
        hasTopLevelArguments = true;
      } else if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'eval' && s.fnDepth === 0) {
        hasDirectEval = true;
      }
    },
    inShorthandKey: false,
  };

  // slice a node's source with all replacements applied
  const slice = (node) => {
    st.reps.length = 0;
    walkScopeAware(node, st.onNode, st);
    const reps = st.reps.slice().sort((a, b) => a.start - b.start);
    let out = '';
    let pos = node.start;
    for (const r of reps) {
      if (r.start < pos) continue; // overlapping (should not happen)
      out += source.slice(pos, r.start) + r.text;
      pos = r.end;
    }
    out += source.slice(pos, node.end);
    return out;
  };

  for (const stmt of ast.body) {
    switch (stmt.type) {
      case 'ImportDeclaration': {
        const idx = requests.length;
        requests.push({ __proto__: null, specifier: stmt.source.value, phase: 3, attributes: { __proto__: null } });
        for (const sp of stmt.specifiers) {
          if (sp.type === 'ImportNamespaceSpecifier') importBindings.set(sp.local.name, { reqIdx: idx, importName: null });
          else if (sp.type === 'ImportDefaultSpecifier') importBindings.set(sp.local.name, { reqIdx: idx, importName: 'default' });
          else importBindings.set(sp.local.name, { reqIdx: idx, importName: exportedName(sp.imported) });
          allNames.add(sp.local.name);
        }
        break; // dropped from the emitted body
      }
      case 'ExportAllDeclaration': {
        const idx = requests.length;
        requests.push({ __proto__: null, specifier: stmt.source.value, phase: 3, attributes: { __proto__: null } });
        if (stmt.exported) exportReexport.set(exportedName(stmt.exported), { reqIdx: idx, importName: null });
        else exportStarIdx.push(idx);
        break;
      }
      case 'ExportNamedDeclaration': {
        if (stmt.source) {
          const idx = requests.length;
          requests.push({ __proto__: null, specifier: stmt.source.value, phase: 3, attributes: { __proto__: null } });
          for (const sp of stmt.specifiers) {
            exportReexport.set(exportedName(sp.exported), { reqIdx: idx, importName: exportedName(sp.local) });
          }
        } else if (stmt.declaration) {
          const names = [];
          collectDeclaredNames(stmt.declaration, names);
          for (const n of names) { exportLocal.set(n, n); allNames.add(n); }
          if (stmt.declaration.type === 'FunctionDeclaration' && stmt.declaration.id) {
            hoistedFns.push(slice(stmt.declaration));
          } else {
            bodyParts.push(slice(stmt.declaration)); // `export` keyword stripped
          }
        } else {
          for (const sp of stmt.specifiers) {
            exportLocal.set(exportedName(sp.exported), sp.local.name);
          }
        }
        break;
      }
      case 'ExportDefaultDeclaration': {
        const d = stmt.declaration;
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
          defaultLocal = d.id.name;
          defaultIsDeclName = true;
          allNames.add(d.id.name);
          if (d.type === 'FunctionDeclaration') hoistedFns.push(slice(d));
          else bodyParts.push(slice(d));
        } else if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
          // anonymous default declaration: not hoisted as a binding
          defaultLocal = '__nodine_default__';
          defaultIsDeclName = false;
          bodyParts.push('__nodine_default__ = ' + slice(d));
        } else {
          defaultLocal = '__nodine_default__';
          defaultIsDeclName = false;
          bodyParts.push('__nodine_default__ = (' + slice(d) + ')');
        }
        break;
      }
      default: {
        if (stmt.type === 'FunctionDeclaration' && stmt.id) hoistedFns.push(slice(stmt));
        else bodyParts.push(slice(stmt));
        break;
      }
    }
  }

  // Static export names of this module (star re-exports resolved at link).
  const staticExportNames = new Set();
  for (const k of exportLocal.keys()) staticExportNames.add(k);
  for (const k of exportReexport.keys()) staticExportNames.add(k);
  if (defaultLocal) staticExportNames.add('default');

  // Validate import/local collisions (module SyntaxError upstream).
  const declared = [];
  for (const stmt of ast.body) {
    if (stmt.type === 'VariableDeclaration') for (const d of stmt.declarations) walkPattern(d.id, declared);
    else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) declared.push(stmt.id.name);
    else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) collectDeclaredNames(stmt.declaration, declared);
    else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration.id) declared.push(stmt.declaration.id.name);
  }
  const declaredSet = new Set(declared);
  for (const imp of importBindings.keys()) {
    if (declaredSet.has(imp)) {
      throw new SyntaxError(`Identifier '${imp}' has already been declared`);
    }
  }

  return {
    requests,
    importBindings,
    exportLocal,
    exportReexport,
    exportStarIdx,
    defaultLocal,
    defaultIsDeclName,
    staticExportNames,
    allBoundNames: new Set([...declared, ...importBindings.keys()]),
    hasTLA,
    hasTopLevelArguments,
    hasDirectEval,
    hasTopLevelThis,
    hoistedFns,
    bodyParts,
  };
}

// ---------------------------------------------------------------------------
// Factory codegen from the transform descriptor
// ---------------------------------------------------------------------------

function pickMachineryNames(desc) {
  const taken = desc.allBoundNames ? new Set(desc.allBoundNames) : new Set();
  const base = { req: '__c_req', fn: '__c_fn', dn: '__c_dn', meta: '__c_meta', ns: '__c_ns', mv: '__c_mv', ip: '__c_ip', dyn: '__c_dyn' };
  // Avoid collisions with module-bound names (pathological `import {x as __c_req}`).
  for (const k of Object.keys(base)) {
    let name = base[k];
    let n = 2;
    while (taken.has(name)) name = base[k] + n++;
    base[k] = name;
    taken.add(name);
  }
  return base;
}

function buildFactorySource(desc) {
  const M = pickMachineryNames(desc);
  const R = M.req, FN = M.fn, DN = M.dn, META = M.meta, NS = M.ns, MV = M.mv, IP = M.ip, DYN = M.dyn;
  const DEF = '__nodine_default__';
  const async = desc.hasTLA ? 'async ' : '';
  const awaitOf = desc.hasTLA ? 'await ' : '';

  let src = '';
  src += `${desc.hasTLA ? '// TLA module: async factory (import() path only; require() is rejected upstream)\n' : ''}`;
  src += `var ${DYN} = null; // installed below when dynamic import() is present\n`;

  // with-scope proxy over dependency namespaces
  const hasNames = [...desc.importBindings.keys()];
  src += `var ${IP} = new Proxy(Object.create(null), {\n`;
  src += `  has: function (t, k) { return ${JSON.stringify(hasNames)}.indexOf(k) !== -1; },\n`;
  src += `  get: function (t, k) { switch (k) {\n`;
  for (const [name, { reqIdx, importName }] of desc.importBindings) {
    src += importName === null
      ? `    case ${JSON.stringify(name)}: return ${MV}[${reqIdx}];\n`
      : `    case ${JSON.stringify(name)}: return ${MV}[${reqIdx}]${importName === 'default' ? '.default' : `[${JSON.stringify(importName)}]`};\n`;
  }
  src += `    default: return undefined; } },\n`;
  src += `  set: function () { throw new TypeError('Assignment to constant variable.'); },\n`;
  src += `  deleteProperty: function () { throw new TypeError('Cannot delete a module import binding.'); },\n`;
  src += `  defineProperty: function () { return false; },\n`;
  src += `  setPrototypeOf: function () { throw new TypeError('Immutable prototype'); },\n`;
  src += `});\n`;

  src += `with (${IP}) {\n`;

  // 1. local export getters FIRST (cyclic partners must see live bindings
  //    before any dependency evaluation begins). TDZ semantics preserved:
  //    reading a let/const export before initialization throws.
  if (desc.exportLocal.size > 0 || desc.defaultLocal) {
    src += `Object.defineProperties(${NS}, {\n`;
    for (const [exp, local] of desc.exportLocal) {
      src += `  ${JSON.stringify(exp)}: { enumerable: true, configurable: true, get: function () { return ${local}; } },\n`;
    }
    if (desc.defaultLocal) {
      src += `  "default": { enumerable: true, configurable: true, get: function () { return ${desc.defaultIsDeclName ? desc.defaultLocal : DEF}; } },\n`;
    }
    src += `});\n`;
  }

  // 2. hoisted top-level function declarations (ESM initializes function
  //    bindings at instantiation, before any statement runs — and crucially
  //    for cycles, before dependencies are evaluated).
  for (const fn of desc.hoistedFns) src += fn + '\n';

  // 3. default-export storage (TDZ-ish: declared before use, assigned at the
  //    original statement position).
  if (desc.defaultLocal && !desc.defaultIsDeclName) src += `let ${DEF};\n`;

  // 4. dependency evaluation (post-order DFS in textual request order).
  src += `var ${MV} = [\n`;
  for (let i = 0; i < desc.requests.length; i++) {
    src += `  ${awaitOf}${R}(${i}),\n`;
  }
  src += `];\n`;

  // 5. re-export getters + star re-exports (need the dependency namespaces).
  if (desc.exportReexport.size > 0) {
    src += `Object.defineProperties(${NS}, {\n`;
    for (const [exp, { reqIdx, importName }] of desc.exportReexport) {
      src += `  ${JSON.stringify(exp)}: { enumerable: true, configurable: true, get: function () { return ${MV}[${reqIdx}]${importName === null ? '' : (importName === 'default' ? '.default' : `[${JSON.stringify(importName)}]`)}; } },\n`;
    }
    src += `});\n`;
  }
  if (desc.exportStarIdx.length > 0) {
    src += `${R}.star(${JSON.stringify(desc.exportStarIdx)});\n`;
  }

  // 6. dynamic import bridge (installed late: closes over the module path)
  src += `${DYN} = function (s) { return ${R}.dyn(s); };\n`;

  // 7. the remaining module body, in original order.
  for (const part of desc.bodyParts) src += part + '\n';

  src += `}\n`;
  // Rewrite the placeholder tokens produced by the AST walker.
  src = src.split('\u0000NODINE_META').join(META);
  src = src.split('\u0000NODINE_DYN').join(DYN);
  return { source: src, names: M };
}

// ---------------------------------------------------------------------------
// The ModuleWrap class + binding surface
// ---------------------------------------------------------------------------

export function createModuleWrapBinding(acorn, host) {
  // host: {
  //   dynamicImport(spec, modulePath) -> Promise,
  //   importMetaResolveInit(moduleURL) -> fn | null,
  //   importMetaCallback(hdoSymbol, meta, wrap),
  //   isDefaultHdo(symbol) -> bool,
  //   report(evt),
  //   trace(msg),
  // }

  const kUninstantiated = 0, kInstantiating = 1, kInstantiated = 2;
  const kEvaluating = 3, kEvaluated = 4, kErrored = 5;

  function makeNotInstantiatedError() {
    const e = new Error('Module has not been instantiated');
    e.code = 'ERR_MODULE_NOT_INSTANTIATED';
    return e;
  }

  class ModuleWrap {
    constructor(url, _context, sourceOrNames, lineOffset, columnOffset, cachedDataOrId) {
      this.url = String(url);
      this._status = kUninstantiated;
      this._error = undefined;
      this._deps = null;
      this._namespace = undefined;
      this._evalPromise = undefined;
      this._exportNamesCache = undefined;
      this._hasAsyncGraph = undefined;
      this.synthetic = false;
      this.isMain = false;   // written by utils.js after construction
      this.isCommonJS = undefined; // assigned by loader.js:443-445
      this.sourceURL = undefined;
      this.sourceMapURL = undefined;
      if (typeof sourceOrNames === 'string') {
        this._isSourceText = true;
        this._source = sourceOrNames;
        this._hdo = typeof cachedDataOrId === 'symbol' ? cachedDataOrId : null;
        this._desc = transformModuleSource(acorn, sourceOrNames, this.url);
        this.hasTopLevelAwait = this._desc.hasTLA;
        this._factory = null;   // compiled lazily (constructor parses only)
      } else {
        this._isSourceText = false;
        this.synthetic = true;
        this._exportNames = Array.isArray(sourceOrNames) ? sourceOrNames.slice() : [];
        this._evalCallback = lineOffset;   // 4th positional arg for synthetic form
        this._cjsModule = columnOffset;    // 5th positional arg for synthetic form
        this._exportsMap = new Map();
        this.hasTopLevelAwait = false;
      }
      if (host.trace) host.trace('wrap ' + this.url);
    }

    // ---- link / instantiate / evaluate -----------------------------------

    link(modules) {
      // Native ModuleWrap::Link (module_wrap.cc:651-729) has NO status check —
      // it records the dep vector and sets linked_=true, idempotently. The
      // upstream loader re-links builtin facades on every import.
      const reqs = this.getModuleRequests();
      if (!Array.isArray(modules) || modules.length !== reqs.length) {
        const e = new Error('Unable to link dependencies array');
        e.code = 'ERR_MODULE_LINK_MISMATCH';
        throw e;
      }
      for (let i = 0; i < modules.length; i++) {
        if (!(modules[i] instanceof ModuleWrap)) {
          const e = new Error('Unable to link dependencies array');
          e.code = 'ERR_MODULE_LINK_MISMATCH';
          throw e;
        }
      }
      this._deps = modules.slice();
    }

    getModuleRequests() {
      if (this._isSourceText) {
        return Object.freeze(this._desc.requests.slice());
      }
      return Object.freeze([]);
    }

    instantiate() {
      if (this._status >= kInstantiated) return;
      if (this._status === kInstantiating) return; // cycle
      this._status = kInstantiating;
      // V8 instantiate() instantiates the whole graph: deps first.
      if (this._deps) for (const d of this._deps) d.instantiate();
      if (this._isSourceText) {
        // Validate that every imported binding exists on its dependency.
        for (const [name, { reqIdx, importName }] of this._desc.importBindings) {
          if (importName === null) continue; // namespace import always valid
          const dep = this._deps[reqIdx];
          const names = dep.getExportNames();
          if (!names.has(importName)) {
            this._status = kUninstantiated;
            const spec = this._desc.requests[reqIdx].specifier;
            throw new SyntaxError(`The requested module '${spec}' does not provide an export named '${importName}'.`);
          }
        }
        this._namespace = Object.create(null);
        Object.defineProperty(this._namespace, Symbol.toStringTag, { value: 'Module' });
      } else {
        this._namespace = Object.create(null);
        Object.defineProperty(this._namespace, Symbol.toStringTag, { value: 'Module' });
        for (const name of this._exportNames) {
          Object.defineProperty(this._namespace, name, {
            enumerable: true, configurable: true,
            get: () => this._exportsMap.get(name),
          });
        }
      }
      this._status = kInstantiated;
    }

    _buildMeta() {
      const meta = { __proto__: null, url: this.url };
      if (this.isMain) meta.main = true;
      const u = this.url;
      if (u.startsWith('file:')) {
        let filePath;
        try { filePath = decodeURIComponent(u.slice('file://'.length)); } catch { filePath = u; }
        Object.defineProperty(meta, 'dirname', { enumerable: true, get: () => filePath.slice(0, filePath.lastIndexOf('/')) });
        Object.defineProperty(meta, 'filename', { enumerable: true, get: () => filePath });
        this._path = filePath;
      } else {
        this._path = u;
      }
      if (this._hdo && host.importMetaCallback && !host.isDefaultHdo(this._hdo)) {
        try { host.importMetaCallback(this._hdo, meta, this); } catch {}
      } else {
        const init = host.importMetaResolveInit ? host.importMetaResolveInit(this.url) : null;
        if (typeof init === 'function') meta.resolve = init;
      }
      return meta;
    }

    _makeReq() {
      const self = this;
      const req = function (i) {
        const dep = self._deps[i];
        const ns = dep.evaluateSync();
        return ns;
      };
      req.star = function (idxs) {
        const ns = self._namespace;
        const owner = new Map(); // name -> [idx, count]
        for (const i of idxs) {
          for (const name of self._deps[i].getExportNames()) {
            if (name === 'default') continue;
            const e = owner.get(name);
            if (e) e[1]++;
            else owner.set(name, [i, 1]);
          }
        }
        for (const [name, [idx, count]] of owner) {
          if (count > 1) continue; // ambiguous star export: excluded (spec)
          if (Object.prototype.hasOwnProperty.call(ns, name)) continue; // explicit export wins
          Object.defineProperty(ns, name, {
            enumerable: true, configurable: true,
            get: function () { return self._deps[idx].getNamespace()[name]; },
          });
        }
      };
      req.dyn = function (spec) {
        return host.dynamicImport(spec, self._path || self.url);
      };
      return req;
    }

    _getFactory() {
      if (this._factory) return this._factory;
      const built = buildFactorySource(this._desc);
      this._machinery = built.names;
      // M1.7A fix: TLA modules generate `await` at the top of the factory
      // body — `new Function` bodies are never async, so the compile threw
      // "Unexpected identifier '__c_req'" at the first await of a
      // dependency (any module combining a static import with top-level
      // await — e.g. @pnpm/wasm dist/pnpm.mjs line 8 — never loaded; the
      // failure surfaced only as a silent entry exit). Wrap the body in an
      // async IIFE: the factory returns a promise for TLA modules (the
      // async evaluate path at line ~637 already awaits it) and the plain
      // value otherwise (the sync path is guarded upstream by
      // ERR_REQUIRE_ASYNC_MODULE).
      const body = this._desc.hasTLA
        ? 'return (async () => {\n' + built.source + '\n})();'
        : built.source;
      const fn = new Function(built.names.req, built.names.fn, built.names.dn, built.names.meta, built.names.ns, body);
      this._factory = fn;
      return fn;
    }

    evaluateSync() {
      if (this._status === kEvaluated) return this._namespace;
      if (this._status === kErrored) throw this._error;
      if (this._status === kEvaluating) return this._namespace; // cycle: partial ns with live getters
      if (this._status !== kInstantiated) throw makeNotInstantiatedError();
      if (this.hasTopLevelAwait) {
        // Upstream throwIfAsyncGraph guards require(); reaching here means an
        // internal caller asked for sync evaluation of a TLA graph.
        const e = new Error('require() cannot be used on an ESM graph with top-level await. Use import() instead.');
        e.code = 'ERR_REQUIRE_ASYNC_MODULE';
        throw e;
      }
      this._status = kEvaluating;
      if (host.trace) host.trace('evaluateSync ' + this.url);
      try {
        if (this._isSourceText) {
          this._getFactory();
          const meta = this._buildMeta();
          const req = this._makeReq();
          const filePath = this._path;
          let dirname;
          try { dirname = filePath.slice(0, filePath.lastIndexOf('/')); } catch { dirname = filePath; }
          this._factory(req, filePath, dirname, meta, this._namespace);
        } else {
          const cb = this._evalCallback;
          if (typeof cb === 'function') cb.call(this);
        }
        this._status = kEvaluated;
        return this._namespace;
      } catch (e) {
        this._status = kErrored;
        this._error = e;
        throw e;
      }
    }

    evaluate(_timeout, _breakOnSigint) {
      if (this._status === kEvaluated) return Promise.resolve(this._namespace);
      if (this._status === kErrored) return Promise.reject(this._error);
      if (this._status === kEvaluating && this._evalPromise) return this._evalPromise;
      if (this._status === kEvaluating) return Promise.resolve(this._namespace);
      if (host.onEvalStart) host.onEvalStart();
      if (!this._isSourceText) {
        try { const ns = this.evaluateSync(); if (host.onEvalEnd) host.onEvalEnd(); return Promise.resolve(ns); }
        catch (e) { if (host.onEvalEnd) host.onEvalEnd(); return Promise.reject(e); }
      }
      if (!this.hasTopLevelAwait) {
        try { const ns = this.evaluateSync(); if (host.onEvalEnd) host.onEvalEnd(); return Promise.resolve(ns); }
        catch (e) { if (host.onEvalEnd) host.onEvalEnd(); return Promise.reject(e); }
      }
      // TLA module: async factory evaluation.
      this._status = kEvaluating;
      if (host.trace) host.trace('evaluateAsync ' + this.url);
      const self = this;
      this._evalPromise = (async () => {
        try {
          this._getFactory();
          const meta = this._buildMeta();
          const req = this._makeReqAsync();
          const filePath = this._path;
          let dirname;
          try { dirname = filePath.slice(0, filePath.lastIndexOf('/')); } catch { dirname = filePath; }
          await this._factory(req, filePath, dirname, meta, this._namespace);
          self._status = kEvaluated;
          self._evalPromise = undefined;
          return self._namespace;
        } catch (e) {
          self._status = kErrored;
          self._error = e;
          self._evalPromise = undefined;
          throw e;
        } finally {
          if (host.onEvalEnd) host.onEvalEnd();
        }
      })();
      return this._evalPromise;
    }

    _makeReqAsync() {
      const self = this;
      const syncStar = this._makeReq().star;
      const req = async function (i) {
        const dep = self._deps[i];
        return await dep.evaluate();
      };
      req.star = syncStar;
      req.dyn = function (spec) { return host.dynamicImport(spec, self._path || self.url); };
      return req;
    }

    getNamespace() {
      if (this._status < kInstantiated) throw makeNotInstantiatedError();
      return this._namespace;
    }
    getStatus() { return this._status; }
    getError() { return this._error; }

    setExport(name, value) {
      if (!this.synthetic) {
        throw new TypeError('setExport is only supported for synthetic modules');
      }
      this._exportsMap.set(name, value);
      if (this._namespace) {
        Object.defineProperty(this._namespace, name, {
          enumerable: true, configurable: true,
          get: () => this._exportsMap.get(name),
        });
      }
    }

    setModuleSourceObject(obj) { this._moduleSourceObject = obj; }
    getModuleSourceObject() { return this._moduleSourceObject; }

    getExportNames() {
      if (this._exportNamesCache) return this._exportNamesCache;
      const names = new Set();
      if (this._isSourceText) {
        for (const n of this._desc.staticExportNames) names.add(n);
        // resolve star re-exports through linked deps (cycle-safe)
        const seen = new Set();
        const visit = (wrap) => {
          if (seen.has(wrap)) return;
          seen.add(wrap);
          if (wrap === this) {
            // own stars
            if (this._deps) {
              for (const idx of this._desc.exportStarIdx) {
                for (const n of this._deps[idx].getExportNames()) {
                  if (n !== 'default' && !this._desc.staticExportNames.has(n)) names.add(n);
                }
              }
            }
            return;
          }
          for (const n of wrap.getExportNames()) names.add(n);
        };
        if (this._deps) for (const idx of this._desc.exportStarIdx) visit(this._deps[idx]);
      } else {
        for (const n of this._exportNames) names.add(n);
        for (const n of this._exportsMap.keys()) names.add(n);
      }
      this._exportNamesCache = names;
      return names;
    }

    get hasAsyncGraph() {
      if (this._status < kInstantiated) throw makeNotInstantiatedError();
      if (this._hasAsyncGraph === undefined) {
        const seen = new Set();
        const compute = (wrap) => {
          if (seen.has(wrap)) return false;
          seen.add(wrap);
          if (wrap.hasTopLevelAwait) return true;
          if (wrap._deps) {
            for (const d of wrap._deps) {
              if (compute(d)) return true;
            }
          }
          return false;
        };
        this._hasAsyncGraph = compute(this);
      }
      return this._hasAsyncGraph;
    }
  }

  function createRequiredModuleFacade(wrap) {
    // module_wrap.cc:1554-1601 — the fixed facade source, evaluated through
    // the same synchronous machinery against the passed wrap.
    const source = "export * from 'original';\nexport { default } from 'original';\nexport const __esModule = true;\n";
    const facade = new ModuleWrap(`${wrap.url} (nodine facade)`, undefined, source, 0, 0, null);
    facade.link(facade.getModuleRequests().map(() => wrap));
    facade.instantiate();
    return facade.evaluateSync();
  }

  return {
    ModuleWrap,
    setImportModuleDynamicallyCallback(fn) { host.onImportDynamicCallback = fn; },
    setInitializeImportMetaObjectCallback(fn) { host.onImportMetaCallback = fn; },
    setImportMetaResolveInitializer(fn) { host.importMetaResolveInit = fn; },
    createRequiredModuleFacade,
    throwIfPromiseRejected(promise) {
      if (promise && typeof promise.then === 'function') {
        promise.then(() => {}, () => {});
      }
    },
    kUninstantiated, kInstantiating, kInstantiated,
    kEvaluating, kEvaluated, kErrored,
    kSourcePhase: 1, kDeferPhase: 2, kEvaluationPhase: 3,
  };
}
