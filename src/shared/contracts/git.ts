/** Git 工作区面板在 Host 与 Client 之间传输的稳定契约。 */

export interface GitRepoSnapshot {
  readonly workspaceId: string
  readonly repoRoot: string
  /** 当前工作区是否已经初始化为 Git 仓库；旧 Host 未提供时按 true 兼容。 */
  readonly enabled?: boolean
  readonly branch: string
  readonly ahead: number
  readonly behind: number
  readonly hasRemote: boolean
  readonly isDirty: boolean
  readonly lastFetchedAt: string | null
}

export interface GitChangeItem {
  readonly path: string
  readonly status: string
  readonly staged: boolean
  readonly oldPath: string | null
  readonly binary: boolean
  readonly stagedStatus: string | null
  readonly worktreeStatus: string | null
}

export interface GitStatus {
  readonly snapshot: GitRepoSnapshot
  readonly changes: readonly GitChangeItem[]
}

export interface GitDiff {
  readonly workspaceId: string
  readonly path: string
  readonly staged: boolean
  readonly binary: boolean
  readonly truncated: boolean
  readonly content: string
}

export interface GitHistoryItem {
  readonly commitHash: string
  readonly authorName: string
  readonly authoredAt: string
  readonly subject: string
  readonly body: string
  readonly refs: readonly GitHistoryRef[]
}

export interface GitHistoryRef {
  readonly name: string
  readonly kind: 'head' | 'local' | 'remote'
  readonly remoteName: string | null
}

export interface GitHistoryPage {
  readonly items: readonly GitHistoryItem[]
  readonly cursor: string | null
  readonly nextCursor: string | null
  readonly totalCount: number
}

export interface GitBranchItem {
  readonly name: string
  readonly current: boolean
  readonly upstream: string | null
  readonly remote: boolean
}

export interface GitBranchSnapshot {
  readonly currentBranch: string
  readonly local: readonly GitBranchItem[]
  readonly remote: readonly GitBranchItem[]
}

export interface GitCommitResult {
  readonly commitHash: string
  readonly summary: string
}
