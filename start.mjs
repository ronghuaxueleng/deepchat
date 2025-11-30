#!/usr/bin/env node

/**
 * DeepChat 开发环境启动脚本
 * 自动检查并安装依赖，配置国内镜像，启动开发服务器
 */

import { execSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 平台信息
const PLATFORM = platform()
const ARCH = arch()
const IS_WINDOWS = PLATFORM === 'win32'
const IS_MAC = PLATFORM === 'darwin'
const IS_LINUX = PLATFORM === 'linux'

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
}

const log = {
  info: (msg) => console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  step: (msg) => console.log(`${colors.blue}${colors.bright}==>${colors.reset} ${msg}`)
}

// 国内镜像配置
const CHINA_MIRRORS = {
  // npm/pnpm 镜像
  registry: 'https://registry.npmmirror.com',
  // Electron 镜像
  electron_mirror: 'https://npmmirror.com/mirrors/electron/',
  electron_builder_binaries_mirror: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  // Node.js 相关镜像
  node_mirror: 'https://npmmirror.com/mirrors/node/',
  // 其他二进制包镜像
  sass_binary_site: 'https://npmmirror.com/mirrors/node-sass/',
  sharp_binary_host: 'https://npmmirror.com/mirrors/sharp',
  sharp_libvips_binary_host: 'https://npmmirror.com/mirrors/sharp-libvips',
  python_mirror: 'https://npmmirror.com/mirrors/python/',
  // SQLite 镜像
  better_sqlite3_binary_host: 'https://npmmirror.com/mirrors/better-sqlite3',
  // Canvas 镜像
  canvas_binary_host_mirror: 'https://npmmirror.com/mirrors/canvas',
  // Playwright 镜像
  playwright_download_host: 'https://npmmirror.com/mirrors/playwright',
  // Puppeteer 镜像
  puppeteer_download_host: 'https://npmmirror.com/mirrors/chromium-browser-snapshots',
  // SentencePiece 镜像
  sentencepiece_binary_host: 'https://npmmirror.com/mirrors/sentencepiece',
  // GitHub 代理 (用于下载 uv 等 GitHub releases)
  github_proxy: 'https://gh-proxy.com/'
}

/**
 * 执行命令并返回输出
 */
function execCommand(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : 'inherit',
      cwd: __dirname,
      env: { ...process.env, ...options.env },
      ...options
    })
  } catch (error) {
    if (options.ignoreError) {
      return null
    }
    throw error
  }
}

/**
 * 获取 Node.js 版本
 */
function getNodeVersion() {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim()
    return version.replace('v', '')
  } catch {
    return null
  }
}

/**
 * 获取 pnpm 版本
 */
function getPnpmVersion() {
  try {
    const version = execSync('pnpm --version', { encoding: 'utf-8', stdio: 'pipe' }).trim()
    return version
  } catch {
    return null
  }
}

/**
 * 比较版本号
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 > p2) return 1
    if (p1 < p2) return -1
  }
  return 0
}

/**
 * 创建或更新 .npmrc 文件，配置国内镜像
 */
function setupNpmrc() {
  log.step('配置国内镜像...')

  const npmrcPath = join(__dirname, '.npmrc')
  const npmrcContent = `# 国内镜像配置 (由 start.mjs 自动生成)
registry=${CHINA_MIRRORS.registry}

# Electron 相关镜像
electron_mirror=${CHINA_MIRRORS.electron_mirror}
electron_builder_binaries_mirror=${CHINA_MIRRORS.electron_builder_binaries_mirror}

# Node.js 镜像
node_mirror=${CHINA_MIRRORS.node_mirror}

# Sharp 镜像
sharp_binary_host=${CHINA_MIRRORS.sharp_binary_host}
sharp_libvips_binary_host=${CHINA_MIRRORS.sharp_libvips_binary_host}

# SQLite 镜像
better_sqlite3_binary_host=${CHINA_MIRRORS.better_sqlite3_binary_host}

# 其他二进制包镜像
sass_binary_site=${CHINA_MIRRORS.sass_binary_site}
canvas_binary_host_mirror=${CHINA_MIRRORS.canvas_binary_host_mirror}
sentencepiece_binary_host=${CHINA_MIRRORS.sentencepiece_binary_host}

# 禁用 strict-peer-dependencies 以避免某些依赖冲突
strict-peer-dependencies=false
`

  // 检查是否需要更新
  if (existsSync(npmrcPath)) {
    const existingContent = readFileSync(npmrcPath, 'utf-8')
    if (existingContent.includes(CHINA_MIRRORS.registry)) {
      log.info('.npmrc 已配置国内镜像，跳过')
      return
    }
    // 备份现有配置
    writeFileSync(`${npmrcPath}.backup`, existingContent)
    log.warn('已备份原有 .npmrc 到 .npmrc.backup')
  }

  writeFileSync(npmrcPath, npmrcContent)
  log.success('.npmrc 国内镜像配置完成')
}

/**
 * 设置环境变量
 */
function setupEnvironment() {
  log.step('配置环境变量...')

  // 设置 npm 相关环境变量
  process.env.npm_config_registry = CHINA_MIRRORS.registry
  process.env.ELECTRON_MIRROR = CHINA_MIRRORS.electron_mirror
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = CHINA_MIRRORS.electron_builder_binaries_mirror
  process.env.SHARP_BINARY_HOST = CHINA_MIRRORS.sharp_binary_host
  process.env.SHARP_LIBVIPS_BINARY_HOST = CHINA_MIRRORS.sharp_libvips_binary_host
  process.env.BETTER_SQLITE3_BINARY_HOST = CHINA_MIRRORS.better_sqlite3_binary_host

  log.success('环境变量配置完成')
}

/**
 * 检查并安装 pnpm
 */
async function ensurePnpm() {
  log.step('检查 pnpm...')

  const requiredVersion = '10.11.0'
  const currentVersion = getPnpmVersion()

  if (currentVersion) {
    if (compareVersions(currentVersion, requiredVersion) >= 0) {
      log.success(`pnpm ${currentVersion} 已安装且版本满足要求 (>=${requiredVersion})`)
      return
    }
    log.warn(`pnpm ${currentVersion} 版本过低，需要 >=${requiredVersion}，正在升级...`)
  } else {
    log.info('pnpm 未安装，正在安装...')
  }

  try {
    // 使用 npm 安装 pnpm，使用国内镜像
    execCommand(`npm install -g pnpm --registry=${CHINA_MIRRORS.registry}`)
    log.success('pnpm 安装/升级完成')
  } catch (error) {
    log.error('pnpm 安装失败，请手动安装: npm install -g pnpm')
    process.exit(1)
  }
}

/**
 * 检查 Node.js 版本
 */
function checkNodeVersion() {
  log.step('检查 Node.js 版本...')

  const requiredVersion = '20.19.0'
  const currentVersion = getNodeVersion()

  if (!currentVersion) {
    log.error('未检测到 Node.js，请先安装 Node.js >= 20.19.0')
    log.info('推荐使用 nvm 或 fnm 管理 Node.js 版本')
    log.info('  nvm: https://github.com/nvm-sh/nvm')
    log.info('  fnm: https://github.com/Schniz/fnm')
    process.exit(1)
  }

  if (compareVersions(currentVersion, requiredVersion) < 0) {
    log.error(`Node.js 版本 ${currentVersion} 过低，需要 >= ${requiredVersion}`)
    log.info('请升级 Node.js 版本')
    process.exit(1)
  }

  log.success(`Node.js ${currentVersion} 版本满足要求 (>=${requiredVersion})`)
}

/**
 * 检查依赖是否已安装
 */
function isDependenciesInstalled() {
  const nodeModulesPath = join(__dirname, 'node_modules')

  if (!existsSync(nodeModulesPath)) {
    return false
  }

  // 检查关键依赖是否存在
  const criticalDeps = ['electron', 'vue', 'vite', 'electron-vite']
  for (const dep of criticalDeps) {
    if (!existsSync(join(nodeModulesPath, dep))) {
      return false
    }
  }

  return true
}

/**
 * 检查原生模块是否已编译
 */
function isNativeModulesBuilt() {
  // 检查 better-sqlite3 是否编译
  const sqlite3Paths = [
    'node_modules/.pnpm/better-sqlite3-multiple-ciphers@12.4.1/node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node'
  ]

  for (const p of sqlite3Paths) {
    if (existsSync(join(__dirname, p))) {
      return true
    }
  }
  return false
}

/**
 * 安装依赖
 */
function installDependencies(skipNativeRebuild = false) {
  log.step('安装项目依赖...')

  const alreadyInstalled = isDependenciesInstalled()
  const nativeBuilt = isNativeModulesBuilt()

  if (alreadyInstalled && nativeBuilt) {
    log.info('依赖已安装且原生模块已编译')
    return true
  }

  if (skipNativeRebuild) {
    log.info('跳过原生模块编译 (--skip-native)...')
    try {
      execCommand('pnpm install --ignore-scripts')
      log.success('依赖安装完成 (跳过了原生模块编译)')
      log.warn('注意: 应用无法正常启动，因为原生模块未编译')
      return true
    } catch (error) {
      log.error('依赖安装失败')
      return false
    }
  }

  // 使用两步安装策略
  return installWithTwoSteps()
}

/**
 * 两步安装策略：先安装依赖，再从源码编译原生模块
 */
function installWithTwoSteps() {
  try {
    // 第一步：安装所有依赖，跳过 postinstall
    log.info('第一步: 安装 JS 依赖...')
    execCommand('pnpm install --ignore-scripts')
    log.success('JS 依赖安装完成')

    // 第二步：从源码编译原生模块
    log.info('第二步: 从源码编译原生模块...')
    log.info('这可能需要几分钟，请耐心等待...')

    const rebuildSuccess = rebuildNativeModules()

    // 第三步：重建 Electron（修复 electron-rebuild 后 Electron 路径问题）
    if (rebuildSuccess) {
      log.info('第三步: 重建 Electron...')
      try {
        execCommand('pnpm rebuild electron', { timeout: 120000 })
        log.success('Electron 重建完成')
      } catch (error) {
        log.warn('Electron 重建失败，可能需要手动运行: pnpm rebuild electron')
      }
    }

    // 第四步：配置 git hooks
    log.info('第四步: 配置 git hooks...')
    try {
      execCommand('npx simple-git-hooks', { ignoreError: true, silent: true })
    } catch {
      // 忽略 git hooks 错误
    }

    if (rebuildSuccess) {
      log.success('所有依赖安装完成')
      return true
    }

    showNativeModuleError()
    return false

  } catch (error) {
    log.error(`依赖安装失败: ${error.message}`)
    log.info('请手动执行: pnpm install')
    return false
  }
}

/**
 * 从源码重新编译原生模块
 */
function rebuildNativeModules() {
  // 获取 Electron 版本
  let electronVersion
  try {
    const pkgPath = join(__dirname, 'node_modules/electron/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    electronVersion = pkg.version
    log.info(`Electron 版本: ${electronVersion}`)
  } catch {
    log.error('无法获取 Electron 版本')
    return false
  }

  // 需要编译的原生模块列表
  const nativeModules = [
    'better-sqlite3-multiple-ciphers',
    '@homebridge/node-pty-prebuilt-multiarch'
  ]

  let allSuccess = true

  for (const moduleName of nativeModules) {
    log.info(`编译 ${moduleName}...`)
    try {
      // 使用 electron-rebuild 从源码编译，--force 强制重新编译
      execCommand(
        `npx electron-rebuild -f -w ${moduleName} -v ${electronVersion}`,
        { timeout: 600000 }
      )
      log.success(`${moduleName} 编译成功`)
    } catch (error) {
      log.warn(`${moduleName} 编译失败，尝试使用 electron-builder...`)

      // 回退到 electron-builder
      try {
        execCommand('npx electron-builder install-app-deps', { timeout: 600000 })
        log.success('原生模块编译成功 (使用 electron-builder)')
        return true
      } catch {
        log.error(`${moduleName} 编译失败`)
        allSuccess = false
      }
    }
  }

  return allSuccess
}

/**
 * 显示原生模块编译失败的帮助信息
 */
function showNativeModuleError() {
  console.log('')
  log.error('╔════════════════════════════════════════════════════════════╗')
  log.error('║  原生模块编译失败，应用无法正常启动                        ║')
  log.error('╚════════════════════════════════════════════════════════════╝')
  console.log('')
  log.info('请确保安装了以下工具:')
  console.log('')
  log.info('  1. Python 3.x (确保在 PATH 中)')
  log.info('     检查: python --version')
  console.log('')
  log.info('  2. Visual Studio 2022 (包含 C++ 桌面开发工作负载)')
  log.info('     或 Visual Studio Build Tools 2022')
  log.info('     下载: https://visualstudio.microsoft.com/visual-cpp-build-tools/')
  log.info('     安装时勾选 "使用 C++ 的桌面开发" 工作负载')
  console.log('')
  log.info('  3. 安装完成后，在 Windows PowerShell/CMD 中运行:')
  log.info('     node start.mjs --clean')
  console.log('')
  log.warn('注意: 必须在 Windows 原生环境中运行，不能在 WSL 中运行！')
  console.log('')
}

/**
 * 安装运行时依赖 (MCP 和 Python 执行环境)
 */
async function installRuntimeDependencies() {
  log.step('检查运行时依赖...')

  const runtimePath = join(__dirname, 'runtime')
  const uvPath = join(runtimePath, 'uv')
  const nodePath = join(runtimePath, 'node')

  // 检查是否已安装
  if (existsSync(uvPath) && existsSync(nodePath)) {
    log.success('运行时依赖已安装')
    return
  }

  log.info('正在安装运行时依赖 (uv + node)...')
  log.info(`使用 GitHub 代理: ${CHINA_MIRRORS.github_proxy}`)

  try {
    await installRuntimeWithProxy()
    log.success('运行时依赖安装完成')
  } catch (error) {
    log.warn('运行时依赖安装失败，但不影响基本开发')
    log.info('如需 MCP 功能，可手动下载:')
    log.info(`  uv: ${CHINA_MIRRORS.github_proxy}https://github.com/astral-sh/uv/releases`)
    log.info(`  将下载的文件解压到 runtime/uv 目录`)
  }
}

/**
 * 使用代理安装运行时
 */
async function installRuntimeWithProxy() {
  const runtimePath = join(__dirname, 'runtime')

  // 获取平台和架构信息
  const uvArch = ARCH === 'x64' ? 'x86_64' : ARCH === 'arm64' ? 'aarch64' : ARCH
  const nodeArch = ARCH

  // 构建下载 URL
  let uvPlatform, uvExt, nodePlatform, nodeExt

  if (IS_WINDOWS) {
    uvPlatform = 'pc-windows-msvc'
    uvExt = 'zip'
    nodePlatform = 'win'
    nodeExt = 'zip'
  } else if (IS_MAC) {
    uvPlatform = 'apple-darwin'
    uvExt = 'tar.gz'
    nodePlatform = 'darwin'
    nodeExt = 'tar.gz'
  } else {
    uvPlatform = 'unknown-linux-gnu'
    uvExt = 'tar.gz'
    nodePlatform = 'linux'
    nodeExt = 'tar.xz'
  }

  const uvVersion = '0.8.8'
  const nodeVersion = 'v22.19.0'

  // UV 下载 URL (通过 gh-proxy 代理)
  const uvFileName = `uv-${uvArch}-${uvPlatform}.${uvExt}`
  const uvUrl = `${CHINA_MIRRORS.github_proxy}https://github.com/astral-sh/uv/releases/download/${uvVersion}/${uvFileName}`

  // Node.js 从 npmmirror 下载
  const nodeFileName = `node-${nodeVersion}-${nodePlatform}-${nodeArch}.${nodeExt}`
  const nodeUrl = `${CHINA_MIRRORS.node_mirror}${nodeVersion}/${nodeFileName}`

  log.info(`下载 uv ${uvVersion}...`)
  log.info(`  URL: ${uvUrl}`)

  // 创建 runtime 目录
  if (!existsSync(runtimePath)) {
    execCommand(IS_WINDOWS ? `mkdir "${runtimePath}"` : `mkdir -p "${runtimePath}"`, { silent: true })
  }

  const uvDir = join(runtimePath, 'uv')
  const nodeDir = join(runtimePath, 'node')

  // 下载并解压 uv
  if (!existsSync(uvDir)) {
    execCommand(IS_WINDOWS ? `mkdir "${uvDir}"` : `mkdir -p "${uvDir}"`, { silent: true })

    const uvTempFile = join(runtimePath, uvFileName)

    if (IS_WINDOWS) {
      execCommand(`curl -L -o "${uvTempFile}" "${uvUrl}"`, { timeout: 300000 })
      execCommand(`tar -xf "${uvTempFile}" -C "${uvDir}"`, { silent: true })
    } else {
      execCommand(`curl -L "${uvUrl}" | tar -xz -C "${uvDir}"`, { timeout: 300000 })
    }

    // 清理临时文件
    if (existsSync(uvTempFile)) {
      execCommand(IS_WINDOWS ? `del "${uvTempFile}"` : `rm "${uvTempFile}"`, { silent: true, ignoreError: true })
    }

    log.success('uv 安装完成')
  }

  // 下载并解压 node
  log.info(`下载 Node.js ${nodeVersion}...`)
  log.info(`  URL: ${nodeUrl}`)

  if (!existsSync(nodeDir)) {
    execCommand(IS_WINDOWS ? `mkdir "${nodeDir}"` : `mkdir -p "${nodeDir}"`, { silent: true })

    const nodeTempFile = join(runtimePath, nodeFileName)

    if (IS_WINDOWS) {
      execCommand(`curl -L -o "${nodeTempFile}" "${nodeUrl}"`, { timeout: 300000 })
      execCommand(`tar -xf "${nodeTempFile}" -C "${nodeDir}" --strip-components=1`, { silent: true })
    } else if (nodeExt === 'tar.xz') {
      execCommand(`curl -L "${nodeUrl}" | tar -xJ -C "${nodeDir}" --strip-components=1`, { timeout: 300000 })
    } else {
      execCommand(`curl -L "${nodeUrl}" | tar -xz -C "${nodeDir}" --strip-components=1`, { timeout: 300000 })
    }

    // 清理临时文件
    if (existsSync(nodeTempFile)) {
      execCommand(IS_WINDOWS ? `del "${nodeTempFile}"` : `rm "${nodeTempFile}"`, { silent: true, ignoreError: true })
    }

    log.success('Node.js 安装完成')
  }
}

/**
 * 启动开发服务器
 */
function startDevServer(enableDevTools = false) {
  log.step('启动开发服务器...')
  log.info('按 Ctrl+C 停止服务器')
  console.log('')

  const command = IS_WINDOWS ? 'pnpm.cmd' : 'pnpm'

  // 通过 DEEPCHAT_DEVTOOLS 环境变量控制是否打开 DevTools
  const env = {
    ...process.env,
    DEEPCHAT_DEVTOOLS: enableDevTools ? '1' : '0'
  }

  if (!enableDevTools) {
    log.info('DevTools 已禁用 (可通过 F12 手动打开，或使用 --devtools 启动)')
  }

  const child = spawn(command, ['run', 'dev'], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: IS_WINDOWS,
    env
  })

  child.on('error', (error) => {
    log.error(`启动失败: ${error.message}`)
    process.exit(1)
  })

  child.on('close', (code) => {
    if (code !== 0) {
      log.error(`开发服务器异常退出，退出码: ${code}`)
      process.exit(code)
    }
  })
}

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
${colors.cyan}${colors.bright}DeepChat 开发环境启动脚本${colors.reset}

${colors.yellow}用法:${colors.reset}
  node start.mjs [选项]

${colors.yellow}选项:${colors.reset}
  --help, -h        显示帮助信息
  --install-only    仅安装依赖，不启动开发服务器
  --skip-runtime    跳过运行时依赖安装
  --skip-native     跳过原生模块编译 (仅用于调试)
  --no-mirror       不配置国内镜像
  --devtools        启动时自动打开 DevTools
  --clean           清理并重新安装所有依赖

${colors.yellow}示例:${colors.reset}
  node start.mjs              # 检查依赖并启动开发服务器
  node start.mjs --install-only  # 仅安装依赖
  node start.mjs --clean      # 清理并重新安装

${colors.yellow}环境要求:${colors.reset}
  Node.js >= 20.19.0
  pnpm >= 10.11.0
  Visual Studio 2022 (Windows, 包含 C++ 桌面开发)
  Python 3.x

${colors.yellow}注意:${colors.reset}
  Windows 用户必须在 PowerShell/CMD 中运行，不能在 WSL 中运行！
`)
}

/**
 * 清理依赖
 */
function cleanDependencies() {
  log.step('清理依赖...')

  const nodeModulesPath = join(__dirname, 'node_modules')

  try {
    if (existsSync(nodeModulesPath)) {
      log.info('删除 node_modules...')
      const rmCmd = IS_WINDOWS ? 'rmdir /s /q node_modules' : 'rm -rf node_modules'
      execCommand(rmCmd, { silent: true })
    }
    log.success('依赖清理完成')
  } catch (error) {
    log.warn('清理失败，请手动删除 node_modules 目录')
  }
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2)

  // 解析命令行参数
  const options = {
    help: args.includes('--help') || args.includes('-h'),
    installOnly: args.includes('--install-only'),
    skipRuntime: args.includes('--skip-runtime'),
    skipNative: args.includes('--skip-native'),
    noMirror: args.includes('--no-mirror'),
    devTools: args.includes('--devtools'),
    clean: args.includes('--clean')
  }

  if (options.help) {
    showHelp()
    return
  }

  console.log('')
  console.log(
    `${colors.cyan}${colors.bright}╔════════════════════════════════════════╗${colors.reset}`
  )
  console.log(
    `${colors.cyan}${colors.bright}║     DeepChat 开发环境启动脚本          ║${colors.reset}`
  )
  console.log(
    `${colors.cyan}${colors.bright}╚════════════════════════════════════════╝${colors.reset}`
  )
  console.log('')

  // 显示平台信息
  log.info(`平台: ${PLATFORM} (${ARCH})`)

  // 检测 WSL 环境
  if (IS_LINUX && existsSync('/proc/version')) {
    try {
      const procVersion = readFileSync('/proc/version', 'utf-8')
      if (procVersion.toLowerCase().includes('microsoft')) {
        log.warn('检测到 WSL 环境！')
        log.warn('Windows 原生模块需要在 Windows PowerShell/CMD 中编译')
        log.warn('请在 Windows 终端中运行此脚本')
        console.log('')
      }
    } catch {
      // 忽略
    }
  }

  // 1. 检查 Node.js 版本
  checkNodeVersion()

  // 2. 配置国内镜像
  if (!options.noMirror) {
    setupNpmrc()
    setupEnvironment()
  }

  // 3. 检查并安装 pnpm
  await ensurePnpm()

  // 4. 清理依赖（如果需要）
  if (options.clean) {
    cleanDependencies()
  }

  // 5. 安装项目依赖
  const installSuccess = installDependencies(options.skipNative)
  if (!installSuccess) {
    process.exit(1)
  }

  // 6. 安装运行时依赖
  if (!options.skipRuntime) {
    await installRuntimeDependencies()
  }

  // 7. 启动开发服务器
  if (!options.installOnly) {
    console.log('')
    log.success('环境准备完成!')
    console.log('')
    startDevServer(options.devTools)
  } else {
    console.log('')
    log.success('依赖安装完成!')
    log.info('运行 "pnpm run dev" 启动开发服务器')
  }
}

// 运行主函数
main().catch((error) => {
  log.error(`脚本执行失败: ${error.message}`)
  process.exit(1)
})
