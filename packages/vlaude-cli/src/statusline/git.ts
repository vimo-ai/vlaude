import { execSync } from 'child_process';

export interface GitChanges {
  insertions: number;
  deletions: number;
}

/**
 * 获取 Git 变更统计
 */
export function getGitChanges(): GitChanges | null {
  try {
    let totalInsertions = 0;
    let totalDeletions = 0;

    // 获取未暂存的变更
    const unstagedStat = execSync('git diff --shortstat', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    // 获取已暂存的变更
    const stagedStat = execSync('git diff --cached --shortstat', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    if (unstagedStat) {
      const insertMatch = /(\d+) insertion/.exec(unstagedStat);
      const deleteMatch = /(\d+) deletion/.exec(unstagedStat);
      totalInsertions += insertMatch?.[1] ? parseInt(insertMatch[1], 10) : 0;
      totalDeletions += deleteMatch?.[1] ? parseInt(deleteMatch[1], 10) : 0;
    }

    if (stagedStat) {
      const insertMatch = /(\d+) insertion/.exec(stagedStat);
      const deleteMatch = /(\d+) deletion/.exec(stagedStat);
      totalInsertions += insertMatch?.[1] ? parseInt(insertMatch[1], 10) : 0;
      totalDeletions += deleteMatch?.[1] ? parseInt(deleteMatch[1], 10) : 0;
    }

    // 如果没有任何变更，返回 null
    if (totalInsertions === 0 && totalDeletions === 0) {
      return null;
    }

    return { insertions: totalInsertions, deletions: totalDeletions };
  } catch {
    return null;
  }
}
