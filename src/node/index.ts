import { isAbsolute, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import process from 'node:process'
import { parse as parseErrorStacks } from 'error-stack-parser-es'
import fs from 'fs-extra'
import _debug from 'debug'
import type { Connect, Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import type { ObjectHook, ResolveIdResult, TransformResult } from 'rollup'
import sirv from 'sirv'
import type { FilterPattern } from '@rollup/pluginutils'
import { createFilter } from '@rollup/pluginutils'
import { createRPCServer } from 'vite-dev-rpc'
import { hash } from 'ohash'
import c from 'picocolors'
import type { HMRData, ModuleInfo, ModuleTransformInfo, ParsedError, PluginMetricInfo, RPCFunctions, ResolveIdInfo, TransformInfo } from '../types'
import { DIR_CLIENT } from '../dir'
import { Recorder } from './recorder'
import { DUMMY_LOAD_PLUGIN_NAME } from './constants'

const debug = _debug('vite-plugin-inspect')
const NAME = 'vite-plugin-inspect'
const isCI = !!process.env.CI

export interface Options {
  /**
   * Enable the inspect plugin in dev mode (could be some performance overhead)
   *
   * @default true
   */
  dev?: boolean

  /**
   * Enable the inspect plugin in build mode, and output the report to `.vite-inspect`
   *
   * @default false
   */
  build?: boolean

  /**
   * @deprecated use `dev` or `build` option instead.
   */
  enabled?: boolean

  /**
   * Directory for build inspector UI output
   * Only work in build mode
   *
   * @default '.vite-inspect'
   */
  outputDir?: string

  /**
   * Filter for modules to be inspected
   */
  include?: FilterPattern

  /**
   * Filter for modules to not be inspected
   */
  exclude?: FilterPattern

  /**
   * Base URL for inspector UI
   *
   * @default read from Vite's config
   */
  base?: string

  /**
   * Print URL output silently in the terminal
   *
   * @default false
   */
  silent?: boolean
  /**
   * Automatically open inspect page
   *
   * @default false
   */
  open?: boolean
}

type HookHandler<T> = T extends ObjectHook<infer F> ? F : T
type HookWrapper<K extends keyof Plugin> = (
  fn: NonNullable<HookHandler<Plugin[K]>>,
  context: ThisParameterType<NonNullable<HookHandler<Plugin[K]>>>,
  args: NonNullable<Parameters<HookHandler<Plugin[K]>>>,
  order: string
) => ReturnType<HookHandler<Plugin[K]>>

export interface ViteInspectAPI {
  rpc: RPCFunctions
}

export default function PluginInspect(options: Options = {}): Plugin {
  const {
    dev = true,
    build = false,
    outputDir = '.vite-inspect',
    silent = false,
    open: _open = false,
  } = options

  if (!dev && !build) {
    return {
      name: NAME,
    }
  }

  const filter = createFilter(options.include, options.exclude)
  const timestampRE = /\bt=\d{13}&?\b/
  const trailingSeparatorRE = /[?&]$/

  let config: ResolvedConfig
  const serverPerf: {
    middleware?: Record<string, { name: string; total: number; self: number }[]>
  } = {
    middleware: {},
  }

  const recorder = new Recorder()
  const recorderSSR = new Recorder()

  // type TransformMap = Record<string, TransformInfo[]>
  // type ResolveIdMap = Record<string, ResolveIdInfo[]>

  // const transformMap: TransformMap = {}
  // const transformMapSSR: TransformMap = {}
  // const transformCounter: Record<string, number> = {}
  // const transformCounterSSR: Record<string, number> = {}
  // const idMap: ResolveIdMap = {}
  // const idMapSSR: ResolveIdMap = {}

  function stringifyError(err: any) {
    return String(err.stack ? err.stack : err)
  }

  // a hack for wrapping connect server stack
  // see https://github.com/senchalabs/connect/blob/0a71c6b139b4c0b7d34c0f3fca32490595ecfd60/index.js#L50-L55
  function setupMiddlewarePerf(middlewares: Connect.Server['stack']) {
    let firstMiddlewareIndex = -1
    middlewares.forEach((middleware, index) => {
      const { handle: originalHandle } = middleware
      if (typeof originalHandle !== 'function' || !originalHandle.name)
        return middleware

      middleware.handle = (...middlewareArgs: any[]) => {
        let req: any
        if (middlewareArgs.length === 4)
          [, req] = middlewareArgs
        else
          [req] = middlewareArgs

        const start = Date.now()
        const url = req.url?.replace(timestampRE, '').replace(trailingSeparatorRE, '')
        serverPerf.middleware![url] ??= []

        if (firstMiddlewareIndex < 0)
          firstMiddlewareIndex = index

        // clear middleware timing
        if (index === firstMiddlewareIndex)
          serverPerf.middleware![url] = []

        // @ts-expect-error handle needs 3 or 4 arguments
        const result = originalHandle(...middlewareArgs)

        Promise.resolve(result)
          .then(() => {
            const total = Date.now() - start
            const metrics = serverPerf.middleware![url]

            // middleware selfTime = totalTime - next.totalTime
            serverPerf.middleware![url].push({
              self: metrics.length ? Math.max(total - metrics[metrics.length - 1].total, 0) : total,
              total,
              name: originalHandle.name,
            })
          })

        return result
      }

      Object.defineProperty(middleware.handle, 'name', {
        value: originalHandle.name,
        configurable: true,
        enumerable: true,
      })

      return middleware
    })
  }

  function transformIdMap(recorder: Recorder) {
    return Object.values(recorder.resolveId).reduce((map, ids) => {
      ids.forEach((id) => {
        map[id.result] ??= []
        map[id.result].push(id)
      })

      return map
    }, {} as Record<string, ResolveIdInfo[]>)
  }

  function getModulesInfo(
    recorder: Recorder,
    getDeps: ((id: string) => string[]) | null,
    isVirtual: (pluginName: string, transformName: string) => boolean,
  ) {
    const transformedIdMap = transformIdMap(recorder)
    const ids = new Set(Object.keys(recorder.transform).concat(Object.keys(transformedIdMap)))

    return Array.from(ids).sort()
      .map((id): ModuleInfo => {
        let totalTime = 0
        const plugins = (recorder.transform[id] || [])
          .filter(tr => tr.result)
          .map((transItem) => {
            const delta = transItem.end - transItem.start
            totalTime += delta
            return { name: transItem.name, transform: delta }
          })
          .concat(
            // @ts-expect-error transform is optional
            (transformedIdMap[id] || []).map((idItem) => {
              return { name: idItem.name, resolveId: idItem.end - idItem.start }
            }),
          )

        return {
          id,
          deps: getDeps ? getDeps(id) : [],
          plugins,
          virtual: isVirtual(plugins[0]?.name || '', recorder.transform[id]?.[0].name || ''),
          totalTime,
          invokeCount: recorder.transformCounter?.[id] || 0,
        }
      })
  }

  function hijackHook<K extends keyof Plugin>(plugin: Plugin, name: K, wrapper: HookWrapper<K>) {
    if (!plugin[name])
      return

    debug(`hijack plugin "${name}"`, plugin.name)

    // @ts-expect-error future
    let order = plugin.order || plugin.enforce || 'normal'

    const hook = plugin[name] as any
    if ('handler' in hook) {
      // rollup hook
      const oldFn = hook.handler
      order += `-${hook.order || hook.enforce || 'normal'}`
      hook.handler = function (this: any, ...args: any) {
        return wrapper(oldFn, this, args, order)
      }
    }
    else if ('transform' in hook) {
      // transformIndexHTML
      const oldFn = hook.transform
      order += `-${hook.order || hook.enforce || 'normal'}`
      hook.transform = function (this: any, ...args: any) {
        return wrapper(oldFn, this, args, order)
      }
    }
    else {
      // vite hook
      const oldFn = hook
      plugin[name] = function (this: any, ...args: any) {
        return wrapper(oldFn, this, args, order)
      }
    }
  }

  function hijackPlugin(plugin: Plugin) {
    hijackHook(plugin, 'transform', async (fn, context, args, order) => {
      const code = args[0]
      const id = args[1]
      const ssr = args[2]?.ssr

      let _result: TransformResult
      let error: any

      const start = Date.now()
      try {
        _result = await fn.apply(context, args)
      }
      catch (_err) {
        error = _err
      }
      const end = Date.now()

      const result = error ? '[Error]' : (typeof _result === 'string' ? _result : _result?.code)
      if (filter(id)) {
        const sourcemaps = typeof _result === 'string' ? null : _result?.map
        const rec = ssr ? recorderSSR : recorder
        rec.recordTransform(id, {
          name: plugin.name,
          result,
          start,
          end,
          order,
          sourcemaps,
          error: error ? parseError(error) : undefined,
        }, code)
      }

      if (error)
        throw error

      return _result
    })

    hijackHook(plugin, 'load', async (fn, context, args) => {
      const id = args[0]
      const ssr = args[1]?.ssr

      let _result: TransformResult
      let error: any

      const start = Date.now()
      try {
        _result = await fn.apply(context, args)
      }
      catch (err) {
        error = err
      }
      const end = Date.now()

      const result = error ? '[Error]' : (typeof _result === 'string' ? _result : _result?.code)
      const sourcemaps = typeof _result === 'string' ? null : _result?.map

      const rec = ssr ? recorderSSR : recorder
      if (filter(id) && result) {
        rec.recordLoad(id, {
          name: plugin.name,
          result,
          start,
          end,
          sourcemaps,
          error: error ? parseError(error) : undefined,
        })
      }

      if (error)
        throw error

      return _result
    })

    hijackHook(plugin, 'resolveId', async (fn, context, args) => {
      const id = args[0]
      const ssr = args[2]?.ssr

      let _result: ResolveIdResult
      let error: any

      const start = Date.now()
      try {
        _result = await fn.apply(context, args)
      }
      catch (err) {
        error = err
      }
      const end = Date.now()

      const result = error ? stringifyError(error) : (typeof _result === 'object' ? _result?.id : _result)

      const rec = ssr ? recorderSSR : recorder
      if (result && result !== id) {
        rec.recordResolveId(id, {
          name: plugin.name,
          result,
          start,
          end,
          error,
        })
      }

      if (error)
        throw error

      return _result
    })
  }

  function resolveId(id = '', ssr = false): string {
    if (id.startsWith('./'))
      id = resolve(config.root, id).replace(/\\/g, '/')
    return resolveIdRecursive(id, ssr)
  }

  function resolveIdRecursive(id: string, ssr = false): string {
    const rec = ssr ? recorderSSR : recorder
    const resolved = rec.resolveId[id]?.[0]?.result
    return resolved
      ? resolveIdRecursive(resolved, ssr)
      : id
  }

  function getPluginMetrics(ssr = false) {
    const map: Record<string, PluginMetricInfo> = {}
    const defaultMetricInfo = (): Pick<PluginMetricInfo, 'transform' | 'resolveId'> => ({
      transform: { invokeCount: 0, totalTime: 0 },
      resolveId: { invokeCount: 0, totalTime: 0 },
    })

    config.plugins.forEach((i) => {
      map[i.name] = {
        ...defaultMetricInfo(),
        name: i.name,
        enforce: i.enforce,
      }
    })

    const rec = ssr ? recorderSSR : recorder

    Object.values(rec.transform)
      .forEach((transformInfos) => {
        transformInfos.forEach(({ name, start, end }) => {
          if (name === DUMMY_LOAD_PLUGIN_NAME)
            return
          if (!map[name])
            map[name] = { ...defaultMetricInfo(), name }
          map[name].transform.totalTime += end - start
          map[name].transform.invokeCount += 1
        })
      })

    Object.values(rec.resolveId)
      .forEach((resolveIdInfos) => {
        resolveIdInfos.forEach(({ name, start, end }) => {
          if (!map[name])
            map[name] = { ...defaultMetricInfo(), name }
          map[name].resolveId.totalTime += end - start
          map[name].resolveId.invokeCount += 1
        })
      })

    const metrics = Object.values(map).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))

    return metrics
  }

  function configureServer(server: ViteDevServer): RPCFunctions {
    const _invalidateModule = server.moduleGraph.invalidateModule
    server.moduleGraph.invalidateModule = function (...args) {
      const mod = args[0]
      if (mod?.id) {
        recorder.invalidate(mod.id)
        recorderSSR.invalidate(mod.id)
      }
      return _invalidateModule.apply(this, args)
    }

    const base = (options.base ?? server.config.base) || '/'

    server.middlewares.use(`${base}__inspect`, sirv(DIR_CLIENT, {
      single: true,
      dev: true,
    }))

    const rpcFunctions = {
      list,
      getIdInfo,
      getPluginMetrics,
      getServerMetrics,
      resolveId,
      clear: clearId,
    }

    createRPCServer<RPCFunctions>('vite-plugin-inspect', server.ws, rpcFunctions)

    function getServerMetrics() {
      return serverPerf || {}
    }

    async function getIdInfo(id: string, ssr = false, clear = false) {
      if (clear) {
        clearId(id, ssr)
        try {
          await server.transformRequest(id, { ssr })
        }
        catch {}
      }
      const resolvedId = resolveId(id, ssr)
      const rec = ssr ? recorderSSR : recorder
      return {
        resolvedId,
        transforms: rec.transform[resolvedId] || [],
      }
    }

    const isVirtual = (pluginName: string) => pluginName !== DUMMY_LOAD_PLUGIN_NAME
    const getDeps = (id: string) => Array.from(server.moduleGraph.getModuleById(id)?.importedModules || [])
      .map(i => i.id || '')
      .filter(Boolean)
    function list() {
      return {
        root: config.root,
        modules: getModulesInfo(recorder, getDeps, isVirtual),
        ssrModules: getModulesInfo(recorderSSR, getDeps, isVirtual),
      }
    }

    function clearId(_id: string, ssr = false) {
      const id = resolveId(_id)
      if (id) {
        const mod = server.moduleGraph.getModuleById(id)
        if (mod)
          server.moduleGraph.invalidateModule(mod)
        const rec = ssr ? recorderSSR : recorder
        rec.invalidate(id)
      }
    }

    const _print = server.printUrls
    server.printUrls = () => {
      let host = `${config.server.https ? 'https' : 'http'}://localhost:${config.server.port || '80'}`

      const url = server.resolvedUrls?.local[0]

      if (url) {
        try {
          const u = new URL(url)
          host = `${u.protocol}//${u.host}`
        }
        catch (error) {
          console.warn('Parse resolved url failed:', error)
        }
      }

      _print()

      if (!silent) {
        const colorUrl = (url: string) => c.green(url.replace(/:(\d+)\//, (_, port) => `:${c.bold(port)}/`))
        // eslint-disable-next-line no-console
        console.log(`  ${c.green('➜')}  ${c.bold('Inspect')}: ${colorUrl(`${host}${base}__inspect/`)}`)
      }

      if (_open && !isCI) {
        // a delay is added to ensure the app page is opened first
        setTimeout(() => {
          openBrowser(`${host}${base}__inspect/`)
        }, 500)
      }
    }

    return rpcFunctions
  }

  async function generateBuild() {
    // outputs data to `node_modules/.vite/inspect folder
    const targetDir = isAbsolute(outputDir)
      ? outputDir
      : resolve(config.root, outputDir)
    const reportsDir = join(targetDir, 'reports')

    await fs.emptyDir(targetDir)
    await fs.ensureDir(reportsDir)
    await fs.copy(DIR_CLIENT, targetDir)

    const isVirtual = (pluginName: string, transformName: string) => pluginName !== DUMMY_LOAD_PLUGIN_NAME && transformName !== 'vite:load-fallback'

    function list() {
      return {
        root: config.root,
        modules: getModulesInfo(recorder, null, isVirtual),
        ssrModules: getModulesInfo(recorderSSR, null, isVirtual),
      }
    }

    async function dumpModuleInfo(dir: string, recorder: Recorder, ssr = false) {
      await fs.ensureDir(dir)
      return Promise.all(Object.entries(recorder.transform)
        .map(([id, info]) => fs.writeJSON(
          join(dir, `${hash(id)}.json`),
          <ModuleTransformInfo>{
            resolvedId: resolveId(id, ssr),
            transforms: info,
          },
          { spaces: 2 },
        ),
        ),
      )
    }

    await Promise.all([
      fs.writeFile(
        join(targetDir, 'index.html'),
        (await fs.readFile(join(targetDir, 'index.html'), 'utf-8'))
          .replace(
            'data-vite-inspect-mode="DEV"',
            'data-vite-inspect-mode="BUILD"',
          ),
      ),
      fs.writeJSON(
        join(reportsDir, 'list.json'),
        list(),
        { spaces: 2 },
      ),
      fs.writeJSON(
        join(reportsDir, 'metrics.json'),
        getPluginMetrics(false),
        { spaces: 2 },
      ),
      fs.writeJSON(
        join(reportsDir, 'metrics-ssr.json'),
        getPluginMetrics(true),
        { spaces: 2 },
      ),
      dumpModuleInfo(join(reportsDir, 'transform'), recorder),
      dumpModuleInfo(join(reportsDir, 'transform-ssr'), recorderSSR, true),
    ])

    return targetDir
  }

  function createPreviewServer(staticPath: string) {
    const server = createServer()

    const statics = sirv(staticPath)
    server.on('request', (req, res) => {
      statics(req, res, () => {
        res.statusCode = 404
        res.end('File not found')
      })
    })

    server.listen(0, () => {
      const { port } = server.address() as AddressInfo
      const url = `http://localhost:${port}`
      // eslint-disable-next-line no-console
      console.log(`  ${c.green('➜')}  ${c.bold('Inspect Preview Started')}: ${url}`)
      openBrowser(url)
    })
  }

  async function openBrowser(address: string) {
    await import('open')
      .then(r => r.default(address, { newInstance: true }))
      .catch(() => {})
  }

  const plugin = <Plugin>{
    name: NAME,
    enforce: 'pre',
    apply(_, { command }) {
      if (command === 'serve' && dev)
        return true
      if (command === 'build' && build)
        return true
      return false
    },
    configResolved(_config) {
      config = _config
      config.plugins.forEach(hijackPlugin)
      const _createResolver = config.createResolver
      // @ts-expect-error mutate readonly
      config.createResolver = function (this: any, ...args: any) {
        const _resolver = _createResolver.apply(this, args)

        return async function (this: any, ...args: any) {
          const id = args[0]
          const aliasOnly = args[2]
          const ssr = args[3]

          const start = Date.now()
          const result = await _resolver.apply(this, args)
          const end = Date.now()

          const rec = ssr ? recorderSSR : recorder
          if (result && result !== id) {
            const pluginName = aliasOnly ? 'alias' : 'vite:resolve (+alias)'
            rec.recordResolveId(id, { name: pluginName, result, start, end })
          }

          return result
        }
      }
    },
    configureServer(server) {
      const rpc = configureServer(server)
      plugin.api = {
        rpc,
      }

      return () => {
        setupMiddlewarePerf(server.middlewares.stack)
      }
    },
    load: {
      order: 'pre',
      handler(id, { ssr } = {}) {
        const rec = ssr ? recorderSSR : recorder
        rec.invalidate(id)
        return null
      },
    },
    handleHotUpdate({ modules, server }) {
      const ids = modules.map(module => module.id)
      server.ws.send({
        type: 'custom',
        event: 'vite-plugin-inspect:update',
        data: { ids } as HMRData,
      })
    },
    async buildEnd() {
      if (!build)
        return
      const dir = await generateBuild()
      // eslint-disable-next-line no-console
      console.log(c.green('Inspect report generated at'), c.dim(`${dir}`))
      if (_open && !isCI)
        createPreviewServer(dir)
    },
  }
  return plugin
}

PluginInspect.getViteInspectAPI = function (plugins: Plugin[]): ViteInspectAPI | undefined {
  return plugins.find(p => p.name === NAME)?.api
}

function parseError(error: any): ParsedError {
  const stack = parseErrorStacks(error)
  const message = error.message || String(error)
  return {
    message,
    stack,
    raw: error,
  }
}
