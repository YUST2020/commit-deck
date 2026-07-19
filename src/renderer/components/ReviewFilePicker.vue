<script setup lang="ts">
/**
 * 代码审查文件选择器
 * --------------------------------------------------
 * 由 AiCommitPanel 底部「代码审查」按钮触发（useCodeReviewStore.openPicker）。
 * 以树状结构展示当前改动文件（父子关系由文件夹层级决定），
 * 默认选中「未触发规则过滤的文件」（contentOmitted=false），
 * 二进制/产物/锁文件（contentOmitted=true）禁用勾选并标注原因。
 *
 * 确认后调用 startReview(paths)，仅对选中文件进行审查（后续交互与原 review 浮窗一致）。
 *
 * 实现：扁平 files → 按路径段构建 NTree 节点；NTree checkable + cascade 自动联动父子勾选。
 */
import { computed, h, ref, watch } from 'vue'
import { NModal, NTree, NTag, NSpin, NButton, NSpace, NScrollbar } from 'naive-ui'
import type { TreeOption } from 'naive-ui'
import {
  ScanEye,
  FilePlus,
  FileMinus,
  FileEdit,
  FileQuestion,
  FolderOpen,
  Ban
} from 'lucide-vue-next'
import type { VNode } from 'vue'
import type { ChangedFileInfo, FileStatus } from '@shared/index'
import { useCodeReviewStore } from '@/stores/useCodeReviewStore'

const review = useCodeReviewStore()

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [v: boolean] }>()

/** 受控勾选的文件路径集合（NTree 用 checkedKeys，这里仅保留叶子路径） */
const checkedKeys = ref<string[]>([])
/** 展开的文件夹 key */
const expandedKeys = ref<string[]>([])

/* ---------- 文件状态 → 标签/图标 ---------- */
function statusMeta(s: FileStatus): { label: string; type: 'default' | 'success' | 'warning' | 'error' | 'info' } {
  switch (s) {
    case 'added':
      return { label: '新增', type: 'success' }
    case 'modified':
      return { label: '修改', type: 'info' }
    case 'deleted':
      return { label: '删除', type: 'error' }
    case 'renamed':
      return { label: '重命名', type: 'warning' }
    case 'untracked':
      return { label: '未跟踪', type: 'default' }
    default:
      return { label: '改动', type: 'default' }
  }
}
function statusIcon(s: FileStatus): typeof FilePlus {
  switch (s) {
    case 'added':
      return FilePlus
    case 'deleted':
      return FileMinus
    case 'renamed':
      return FileQuestion
    case 'untracked':
      return FileQuestion
    default:
      return FileEdit
  }
}

function omitLabel(reason: 'binary' | 'generated' | undefined): string {
  if (reason === 'binary') return '二进制'
  if (reason === 'generated') return '产物/锁'
  return '已省略'
}

/* ---------- 自定义节点字段类型（_file 透传给 renderLabel） ---------- */
interface FileLeaf extends TreeOption {
  isLeaf: true
  _file?: ChangedFileInfo
}
/** 文件夹节点（有 children，非叶子） */
interface FolderNode extends TreeOption {
  isLeaf: false
  children: TreeOption[]
}

/* ---------- 构建树（单文件夹链压缩） ---------- */
/**
 * 把扁平文件列表按路径段（'/' 切分）组织成 NTree 节点。
 * contentOmitted 的叶子 disabled + 标注原因徽标。
 *
 * 单文件夹链压缩：当一个文件夹下只包含一个子文件夹（无兄弟文件/文件夹）时，
 * 把它和子文件夹合并显示为一个节点，label 为「a/b/c」（用 '/' 串联各段），
 * 避免深层嵌套（项目常有 src/renderer/components/... 五六层）。
 * 合并节点的 key 仍是最深一级的目录路径（用于 cascade/勾选展开）。
 */
function buildTree(files: ChangedFileInfo[]): { tree: TreeOption[]; allFolderKeys: string[] } {
  // 排序：先按目录再按文件名，阅读更连贯
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

  const rootChildren: TreeOption[] = []
  const allFolderKeys: string[] = []
  // 用 Map 按完整目录路径缓存文件夹节点（合并同名目录）
  const folderMap = new Map<string, FolderNode>()

  // 先创建所有需要的文件夹节点（含 label 暂为单段名）
  for (const f of sorted) {
    const segs = f.path.split('/')
    let acc = ''
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i]
      if (!folderMap.has(acc)) {
        const node: FolderNode = {
          key: acc,
          label: segs[i],
          children: [],
          isLeaf: false
        }
        folderMap.set(acc, node)
        allFolderKeys.push(acc)
      }
    }
  }

  // 连接父子：每个目录挂到其父的 children
  for (const [fullDir, node] of folderMap) {
    const parentDir = fullDir.includes('/') ? fullDir.slice(0, fullDir.lastIndexOf('/')) : ''
    if (parentDir === '' || !folderMap.has(parentDir)) {
      rootChildren.push(node)
    } else {
      folderMap.get(parentDir)!.children.push(node)
    }
  }

  // 挂叶子文件
  for (const f of sorted) {
    const segs = f.path.split('/')
    const parentDir = segs.length > 1 ? segs.slice(0, -1).join('/') : ''
    const parentArr =
      parentDir === '' || !folderMap.has(parentDir)
        ? rootChildren
        : folderMap.get(parentDir)!.children
    parentArr.push({
      key: f.path,
      label: segs[segs.length - 1],
      isLeaf: true,
      disabled: f.contentOmitted,
      _file: f
    } as TreeOption)
  }

  // 单文件夹链压缩：自顶向下递归，把「只含一个子文件夹」的节点与其子合并
  // 同时把合并后的 label 改为串联形式（a/b/c），key 保持最深目录路径
  compressChains(rootChildren)
  return { tree: rootChildren, allFolderKeys }
}

/**
 * 递归压缩单文件夹链：节点只有 1 个子项且该子项是文件夹 → 合并（label 串联，children 下移）。
 * 必须自顶向下处理（先处理当前层再进入子层），保证多层链被一路合并。
 */
function compressChains(nodes: TreeOption[]): void {
  for (const node of nodes) {
    // 当前节点是文件夹且只有一个子文件夹（无其它子项）→ 合并到自身（原地改 node 属性）
    while (
      !node.isLeaf &&
      node.children &&
      node.children.length === 1 &&
      !node.children[0].isLeaf
    ) {
      const onlyChild = node.children[0] as FolderNode
      node.label = `${String(node.label)}/${String(onlyChild.label)}`
      node.key = onlyChild.key
      node.children = onlyChild.children
    }
    // 进入合并后的子层继续压缩
    if (!node.isLeaf && node.children && node.children.length > 0) {
      compressChains(node.children)
    }
  }
}

/** 树数据 */
const treeData = computed(() => buildTree(review.changedFiles).tree)

/** 来源文案 */
const sourceLabel = computed(() => (review.pickerSource === 'all' ? '全量改动' : '暂存改动'))

/** 所有叶子文件路径集合（用于从 checkedKeys 中筛出真正的文件，排除文件夹 key） */
const filePathSet = computed(() => new Set(review.changedFiles.map((f) => f.path)))

/** 已选中的文件数（仅叶子文件；cascade 会让父文件夹 key 也进 checkedKeys，需排除） */
const selectedCount = computed(
  () => checkedKeys.value.filter((k) => filePathSet.value.has(k)).length
)

/** 可勾选文件数（用于禁用判断：全部被过滤时禁用开始按钮） */
const selectableCount = computed(() => review.changedFiles.filter((f) => !f.contentOmitted).length)

const canStart = computed(() => selectedCount.value > 0)

/* ---------- 初始化勾选/展开 ---------- */
/**
 * 当文件列表到位时初始化：
 *   - 默认勾选所有「未触发规则过滤」的文件（contentOmitted=false）——即本来就该审查的文件；
 *   - 默认展开全部文件夹。
 *
 * 监听 changedFiles 而非 props.show：openPicker 先把 pickerOpen 置 true 再异步取文件，
 * 仅监听 show 会在 changedFiles 还是空数组时触发，导致一个都没勾上。
 * changedFiles 一旦填充，这里就能拿到真实文件并勾选默认项。
 */
watch(
  () => review.changedFiles,
  (files) => {
    if (files.length === 0) {
      checkedKeys.value = []
      expandedKeys.value = []
      return
    }
    // 勾选未过滤文件（叶子路径）；NTree cascade 会自动勾上对应父文件夹
    checkedKeys.value = files.filter((f) => !f.contentOmitted).map((f) => f.path)
    const { allFolderKeys } = buildTree(files)
    expandedKeys.value = allFolderKeys
  },
  { immediate: true }
)

/* ---------- 操作 ---------- */
function onCancel(): void {
  review.closePicker()
  emit('update:show', false)
}

function onStart(): void {
  if (!canStart.value) return
  // 仅传叶子文件路径（cascade 会让文件夹 key 也进 checkedKeys，用文件集合筛除）
  const paths = checkedKeys.value.filter((k) => filePathSet.value.has(k))
  void review.startReview(paths)
  emit('update:show', false)
}

/**
 * 用 render-label（程序式）替代 #label 插槽：规避 vue-tsc 对 NTree label 插槽
 * 入参类型推断不精确（解构 { option } 拿不到 TreeOption）的问题。
 * 返回自定义节点内容（图标 + 名称 + 状态/过滤徽标）。
 *
 * 布局用内联 style：h() 渲染的节点不携带 scoped data-v-xxx 属性，
 * scoped CSS 不会作用到它们，故布局关键属性走 style 保证稳定生效；
 * 颜色/字号等用全局样式块（见 <style> 非 scoped 段）的 .rfp-* 类控制。
 */
function renderLabel({ option }: { option: TreeOption }): VNode {
  const file = (option as FileLeaf)._file
  const isOmitted = !!file?.contentOmitted
  const isFolder = !option.isLeaf
  const children: VNode[] = []

  // 图标
  const IconComp = file ? statusIcon(file.status) : FolderOpen
  children.push(h(IconComp as never, { size: 14, style: { flexShrink: '0', color: 'var(--text-tertiary)' } }))
  // 名称
  children.push(
    h('span', {
      class: 'rfp-node__label',
      title: String(option.label ?? ''),
      style: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    }, String(option.label ?? ''))
  )
  // 文件状态徽标（仅叶子文件）
  if (file) {
    const meta = statusMeta(file.status)
    children.push(
      h(NTag as never, {
        size: 'tiny',
        round: true,
        bordered: false,
        type: meta.type,
        style: { flexShrink: '0' }
      }, { default: () => meta.label })
    )
  }
  // 被过滤徽标 + 说明（二进制/产物/锁文件）
  if (isOmitted) {
    children.push(h(Ban as never, { size: 12, style: { flexShrink: '0', marginLeft: '4px', color: 'var(--text-tertiary)' } }))
    children.push(
      h('span', { style: { fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: '0' } },
        `${omitLabel(file?.omitReason)} · 内容已省略`)
    )
  }

  return h(
    'span',
    {
      class: ['rfp-node', isOmitted ? 'rfp-node--omitted' : null, isFolder ? 'rfp-node--folder' : null],
      style: { display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: '0', flex: '1' }
    },
    children
  )
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    :bordered="false"
    size="huge"
    :title="undefined"
    style="width: min(640px, 92vw); height: 70vh; display: flex; flex-direction: column"
    content-style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column"
    :mask-closable="true"
    @update:show="(v: boolean) => !v && onCancel()"
  >
    <!-- 头部 -->
    <template #header>
      <div class="rfp-head">
        <ScanEye :size="17" class="rfp-head__icon" />
        <span class="rfp-head__title">选择要审查的文件</span>
        <NTag
          v-if="review.pickerSource"
          size="tiny"
          round
          :bordered="false"
          class="rfp-head__tag"
        >
          {{ sourceLabel }}
        </NTag>
      </div>
    </template>

    <!-- 树区 -->
    <div class="rfp-body">
      <!-- loading -->
      <div v-if="review.pickerLoading" class="rfp-loading">
        <NSpin size="medium" />
        <div class="rfp-loading__text">正在读取改动文件…</div>
      </div>

      <!-- 无可审查文件（AGENTS.md：不用 n-empty，自定义占位） -->
      <div v-else-if="review.changedFiles.length === 0" class="rfp-empty">
        <FolderOpen :size="32" class="rfp-empty__icon" />
        <div class="rfp-empty__title">没有可审查的改动文件</div>
      </div>

      <!-- 树：用 render-label（程序式）渲染自定义节点，规避 NTree label 插槽类型推断问题。
           NScrollbar 包裹：NTree 非虚拟滚动时不带滚动容器，长列表需外层提供滚动；
           用 NScrollbar（AGENTS.md：长列表用 n-scrollbar）而非原生 overflow，样式与主题统一 -->
      <NScrollbar v-else class="rfp-tree-scroll">
        <NTree
          :data="treeData"
          :checked-keys="checkedKeys"
          :expanded-keys="expandedKeys"
          :render-label="renderLabel"
          checkable
          cascade
          block-line
          expand-on-click
          :selectable="false"
          :virtual-scroll="review.changedFiles.length > 200"
          @update:checked-keys="(keys: Array<string | number>) => (checkedKeys = keys as string[])"
          @update:expanded-keys="(keys: Array<string | number>) => (expandedKeys = keys as string[])"
        />
      </NScrollbar>
    </div>

    <!-- 底部操作 -->
    <template #footer>
      <div class="rfp-foot">
        <span class="rfp-foot__count">
          已选 <b>{{ selectedCount }}</b> / 可审查 {{ selectableCount }}
        </span>
        <NSpace :size="8">
          <NButton size="small" @click="onCancel">取消</NButton>
          <NButton
            size="small"
            type="primary"
            :disabled="!canStart"
            title="仅审查勾选的文件"
            @click="onStart"
          >
            <template #icon><ScanEye :size="14" /></template>
            开始审查
          </NButton>
        </NSpace>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.rfp-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
}
.rfp-head__icon {
  color: var(--brand);
  flex-shrink: 0;
}
.rfp-head__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}
.rfp-head__tag {
  flex-shrink: 0;
}

.rfp-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: var(--sp-1) 0;
}
/* 树滚动容器：必须显式 flex:1 + min-height:0 + height:0。
   - flex:1/min-height:0：在 .rfp-body（flex column）里拿到受限高度边界；
   - height:0：配合 flex:1 让 NScrollbar 的 .n-scrollbar{height:100%} 能解析到确定高度
     （仅 max-height 不建立确定高度上下文，height:100% 会塌缩到内容高度→不溢出→滚不动） */
.rfp-tree-scroll {
  flex: 1;
  min-height: 0;
  height: 0;
}

.rfp-loading,
.rfp-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  padding: var(--sp-8);
}
.rfp-loading__text {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.rfp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  width: 100%;
}
.rfp-foot__count {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
.rfp-foot__count b {
  color: var(--brand);
  font-weight: 600;
}
</style>

<!--
  全局（非 scoped）样式：renderLabel 用 h() 渲染的节点不携带 scoped data-v-xxx 属性，
  scoped CSS 无法作用到它们；故树节点的颜色/字号等装饰性样式放这里全局生效。
  布局相关属性已在 renderLabel 内联 style 中写死，这里只补颜色/字号。
-->
<style>
.rfp-node__label {
  color: var(--text-primary);
  font-size: var(--fs-sm);
}
/* 文件夹节点名称略加粗，区分于文件 */
.rfp-node--folder .rfp-node__label {
  font-weight: 500;
}
/* 被过滤节点整体弱化 */
.rfp-node--omitted {
  opacity: 0.55;
}
</style>
