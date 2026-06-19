/**
 * 渲染进程侧的前缀 id 生成器。
 * 与主进程 StoreService.genPrefixId 保持相同格式（p-<time>-<rand>），
 * 但渲染进程无 Node crypto，用 Date + Math.random 即可（前缀 id 无安全要求）。
 */
export function genPrefixIdLocal(): string {
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}
