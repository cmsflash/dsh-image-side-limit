import { rm } from 'node:fs/promises'
import { build } from 'esbuild'
import ts from 'typescript'

await rm('lib', { recursive: true, force: true })

const program = ts.createProgram({
  rootNames: ts.sys.readDirectory('src', ['.ts']),
  options: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ['lib.es2023.d.ts'],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
    declaration: true,
    emitDeclarationOnly: true,
    outDir: 'lib/types',
    rootDir: 'src',
  },
})
const emit = program.emit()
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics)
if (diagnostics.length > 0) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }))
  process.exit(1)
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  // Every DSH package and sharp stay external: the host supplies the exact
  // instances this plugin must extend, and a bundled copy would register a
  // second, unrelated class on the same service slot.
  external: ['@deepseek-ai/*', 'cordis', 'sharp'],
})
