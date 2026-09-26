import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, relative, resolve } from 'node:path'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type {
  GitBranchItem,
  GitBranchSnapshot,
  GitChangeItem,
  GitCommitResult,
  GitDiff,
  GitHistoryItem,
  GitHistoryPage,
  GitHistoryRef,
  GitStatus,
} from '../../shared/contracts/git.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'

const execFile = promisify(execFileCallback)
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_DIFF_BYTES = 60_000

/** Host 侧 Git 工作区服务；所有路径都由 resolveWorkspaceRoot 权威解析。 */
export function createGitManagementFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'gitManagement',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      context.resources.add(context.services.rpc.register('git', async (action, payload) => {
        const input = record(payload)
        const workspaceId = requiredString(input.workspaceId, 'workspaceId')
        const root = context.services.resolveWorkspaceRoot?.(workspaceId)
        if (root === null || root === undefined) throw new CodingNsRpcError('GIT_WORKSPACE_UNAVAILABLE', '当前 Workspace 没有可用的本地目录')
        switch (action) {
          case 'status': return readStatus(workspaceId, root)
          case 'init': return runGit(root, ['init']).then(() => readStatus(workspaceId, root))
          case 'diff': return readDiff(workspaceId, root, requiredString(input.path, 'path'), input.staged === true)
          case 'stage': return mutateTargets(workspaceId, root, input.targets, 'add')
          case 'unstage': return mutateTargets(workspaceId, root, input.targets, 'reset')
          case 'discard': return discardTargets(workspaceId, root, input.targets)
          case 'commit': return commit(workspaceId, root, requiredString(input.subject, 'subject'))
          case 'history': return readHistory(workspaceId, root, input.limit)
          case 'branches': return readBranches(root)
          case 'switch': return switchBranch(root, requiredString(input.branchName, 'branchName'), input.create === true)
          default: throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 Git RPC: git/${action}`)
        }
      }))
    },
  }
}

async function readStatus(workspaceId: string, root: string): Promise<GitStatus> {
  let result: { stdout: string; stderr: string }
  try {
    result = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch'])
  } catch (error) {
    if (!isNotGitRepositoryError(error)) throw error
    return {
      snapshot: { workspaceId, repoRoot: root, enabled: false, branch: 'HEAD', ahead: 0, behind: 0, hasRemote: false, isDirty: false, lastFetchedAt: null },
      changes: [],
    }
  }
  const tokens = result.stdout.split('\0')
  const changes: GitChangeItem[] = []
  let branch = 'HEAD'
  let ahead = 0
  let behind = 0
  let hasRemote = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (token.startsWith('## ')) {
      const tracking = parseBranchLine(token.slice(3))
      branch = tracking.branch
      ahead = tracking.ahead
      behind = tracking.behind
      hasRemote = tracking.hasRemote
      continue
    }
    if (token.length < 3) continue
    const stagedStatus = token[0] === ' ' || token[0] === '?' || token[0] === '!' ? null : token[0] ?? null
    const worktreeStatus = token[1] === ' ' || token[1] === '?' || token[1] === '!' ? null : token[1] ?? null
    const status = `${token[0] ?? ' '}${token[1] ?? ' '}`.trim() || '?'
    const path = normalizeGitPath(token.slice(3))
    let oldPath: string | null = null
    if ((token[0] === 'R' || token[0] === 'C' || token[1] === 'R' || token[1] === 'C') && tokens[index + 1]) {
      oldPath = normalizeGitPath(tokens[index + 1] ?? '')
      index += 1
    }
    changes.push({ path, status, staged: stagedStatus !== null, oldPath, binary: false, stagedStatus, worktreeStatus })
  }
  return {
    snapshot: { workspaceId, repoRoot: root, enabled: true, branch, ahead, behind, hasRemote, isDirty: changes.length > 0, lastFetchedAt: null },
    changes,
  }
}

function parseBranchLine(value: string): { branch: string; ahead: number; behind: number; hasRemote: boolean } {
  const [rawBranch, rawTracking] = value.split('...')
  const branch = (rawBranch ?? 'HEAD').replace(/^No commits yet on /u, '').trim() || 'HEAD'
  const tracking = rawTracking ?? ''
  const ahead = Number(/\[ahead (\d+)/u.exec(tracking)?.[1] ?? 0)
  const behind = Number(/\[behind (\d+)/u.exec(tracking)?.[1] ?? 0)
  return { branch, ahead, behind, hasRemote: rawTracking !== undefined }
}

async function readDiff(workspaceId: string, root: string, target: string, staged: boolean): Promise<GitDiff> {
  const path = safeTarget(root, target)
  try {
    const result = await runGit(root, [...(staged ? ['diff', '--cached'] : ['diff']), '--binary', '--', path])
    const content = result.stdout.slice(0, MAX_DIFF_BYTES)
    return { workspaceId, path: normalizeGitPath(target), staged, binary: /Binary files /u.test(result.stdout), truncated: result.stdout.length > content.length, content }
  } catch (error) {
    if (error instanceof GitCommandError && error.stderr.includes('unknown revision')) throw error
    return { workspaceId, path: normalizeGitPath(target), staged, binary: false, truncated: false, content: '' }
  }
}

async function mutateTargets(workspaceId: string, root: string, rawTargets: unknown, action: 'add' | 'reset'): Promise<GitStatus> {
  const targets = safeTargets(root, rawTargets)
  if (targets.length > 0) await runGit(root, action === 'add' ? ['add', '--', ...targets] : ['reset', '--', ...targets])
  return readStatus(workspaceId, root)
}

async function discardTargets(workspaceId: string, root: string, rawTargets: unknown): Promise<GitStatus> {
  const targets = safeTargets(root, rawTargets)
  if (targets.length > 0) {
    await runGit(root, ['restore', '--worktree', '--staged', '--', ...targets]).catch(() => undefined)
    await runGit(root, ['clean', '-f', '--', ...targets]).catch(() => undefined)
  }
  return readStatus(workspaceId, root)
}

async function commit(workspaceId: string, root: string, subject: string): Promise<GitCommitResult & { readonly status: GitStatus }> {
  if (subject.length > 200) throw new TypeError('subject 不能超过 200 个字符')
  const result = await runGit(root, ['commit', '-m', subject])
  const hash = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim()
  return { commitHash: hash, summary: result.stdout.trim() || `已提交 ${hash.slice(0, 8)}`, status: await readStatus(workspaceId, root) }
}

async function readHistory(_workspaceId: string, root: string, rawLimit: unknown): Promise<GitHistoryPage> {
  const limit = Math.max(1, Math.min(100, Number.isSafeInteger(rawLimit) ? Number(rawLimit) : 20))
  let result: { stdout: string; stderr: string }
  try {
    result = await runGit(root, ['log', `--max-count=${String(limit)}`, '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e'])
  } catch (error) {
    if (isEmptyRepositoryError(error)) return { items: [], cursor: null, nextCursor: null, totalCount: 0 }
    throw error
  }
  const items: GitHistoryItem[] = []
  for (const record of result.stdout.split('\x1e')) {
    const fields = record.trim().split('\x1f')
    if (fields.length < 5 || !fields[0]) continue
    items.push({ commitHash: fields[0]!, authorName: fields[1] ?? '', authoredAt: fields[2] ?? '', subject: fields[3] ?? '', body: fields[4] ?? '', refs: [] })
  }
  let total = 0
  try {
    total = Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim() || 0)
  } catch (error) {
    if (!isEmptyRepositoryError(error)) throw error
  }
  return { items, cursor: null, nextCursor: items.length < total ? items.at(-1)?.commitHash ?? null : null, totalCount: total }
}

async function readBranches(root: string): Promise<GitBranchSnapshot> {
  const currentBranch = (await runGit(root, ['branch', '--show-current'])).stdout.trim() || 'HEAD'
  const result = await runGit(root, ['for-each-ref', '--format=%(refname:short)%x1f%(HEAD)%x1f%(upstream:short)', 'refs/heads', 'refs/remotes'])
  const local: GitBranchItem[] = []
  const remote: GitBranchItem[] = []
  for (const line of result.stdout.split('\n')) {
    const [name, head, upstream] = line.trim().split('\x1f')
    if (!name) continue
    const item = { name, current: head === '*', upstream: upstream || null, remote: name.startsWith('origin/') || name.includes('/') && name.includes('->') }
    ;(item.remote ? remote : local).push(item)
  }
  return { currentBranch, local, remote }
}

async function switchBranch(root: string, branchName: string, create: boolean): Promise<GitBranchSnapshot> {
  if (!/^[A-Za-z0-9._/-]+$/u.test(branchName) || branchName.startsWith('-')) throw new TypeError('branchName 无效')
  await runGit(root, create ? ['switch', '-c', branchName] : ['switch', branchName])
  return readBranches(root)
}

async function runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', [...args], { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: 30_000 }) as { stdout: string; stderr: string }
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; code?: string | number }
    throw new GitCommandError(`git ${args.join(' ')} 执行失败`, detail.stderr ?? detail.stdout ?? String(error), detail.code)
  }
}

class GitCommandError extends Error {
  constructor(message: string, readonly stderr: string, readonly commandCode?: string | number) { super(message) }
}

function safeTargets(root: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError('targets 必须是字符串数组')
  return value.map((item) => safeTarget(root, item)).filter((item, index, list) => list.indexOf(item) === index)
}

function safeTarget(root: string, value: string): string {
  const target = normalizeGitPath(value)
  if (!target || target.includes('\0') || isAbsolute(target) || target === '.' || target.split('/').includes('..')) throw new TypeError('Git 路径无效')
  const absolute = resolve(root, target)
  const escaped = relative(root, absolute)
  if (escaped.startsWith('..') || isAbsolute(escaped)) throw new TypeError('Git 路径超出 Workspace')
  return target
}

function normalizeGitPath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\//u, '').trim() }

function isNotGitRepositoryError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false
  return error.commandCode === 128 && /not a git repository|not a git repository/u.test(error.stderr)
}

function isEmptyRepositoryError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false
  return error.commandCode === 128 && /does not have any commits yet|your current branch/u.test(error.stderr)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Git RPC 参数必须是对象')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 必须是非空字符串`)
  return value.trim()
}
