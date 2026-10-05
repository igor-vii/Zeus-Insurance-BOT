/**
 * Custom Jest resolver: under native ESM every relative specifier must carry
 * an extension. Tests import source files without ".ts"/".js" extensions, so
 * we try the plain path first and then fall back to appending ".ts" (or an
 * "index.ts" inside the referenced directory).
 */
const fs = require('fs');
const path = require('path');

module.exports = (request, options) => {
  const defaultResolver = options.defaultResolver;

  if (request.startsWith('.')) {
    try {
      return defaultResolver(request, options);
    } catch (err) {
      const basedir = options.basedir || process.cwd();
      // NodeNext-style ".js" specifiers that actually point at TypeScript
      // sources (src/ uses "import ... from './foo.js'" everywhere).
      if (/\.(?:js|mjs)$/.test(request)) {
        const tsEquivalent = path.resolve(
          basedir,
          request.replace(/\.m?js$/, '.ts'),
        );
        if (fs.existsSync(tsEquivalent)) {
          return tsEquivalent;
        }
      }
      // Extensionless relative imports (used by tests into src/).
      const candidate = path.resolve(basedir, request + '.ts');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const jsCandidate = path.resolve(basedir, request + '.js');
      if (fs.existsSync(jsCandidate)) {
        return jsCandidate;
      }
      const indexCandidate = path.resolve(basedir, request, 'index.ts');
      if (fs.existsSync(indexCandidate)) {
        return indexCandidate;
      }
      throw err;
    }
  }
  return defaultResolver(request, options);
};
