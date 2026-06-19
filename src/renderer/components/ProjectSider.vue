<script setup lang="ts">
import { storeToRefs } from 'pinia'
import {
  NButton,
  NScrollbar,
  NTooltip,
  NSpin,
  useMessage,
  useDialog
} from 'naive-ui'
import { Plus, Trash2, FolderPlus, FolderOpen, GitCommitHorizontal } from 'lucide-vue-next'
import { computed } from 'vue'
import { useProjectStore } from '@/stores/useProjectStore'
import { useGitStore } from '@/stores/useGitStore'

defineProps<{ collapsed?: boolean }>()

const project = useProjectStore()
const git = useGitStore()
const { projects, activeId, loading } = storeToRefs(project)
const message = useMessage()
const dialog = useDialog()

async function onAdd() {
  const res = await project.addByDialog()
  if (res.ok) {
    message.success(`已添加 ${res.data?.name}`)
  } else if (res.message) {
    message.error(res.message)
  }
  // 用户取消（无 message）静默
}

function onSelect(id: string) {
  if (project.activeId === id) return
  project.select(id)
  // 切换项目：用 switchProject()（带淡入淡出过渡），不用 reset()+refreshAll()
  git.switchProject()
}

async function onRemove(id: string, name: string) {
  dialog.warning({
    title: '移除项目',
    content: `确定从列表移除「${name}」吗？（不会删除磁盘文件）`,
    positiveText: '移除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await project.remove(id)
      message.success('已移除')
      if (project.active) {
        git.switchProject()
      }
    }
  })
}

/** 路径缩短：过长则保留首段（盘符）+ ... + 末两级，避免侧栏溢出 */
function shortPath(p: string): string {
  const SEP = /[\\/]/
  const parts = p.split(SEP).filter(Boolean)
  if (parts.length <= 3) return p
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`
}

/**
 * 生成项目缩写（折叠态头像用）。
 * 规则：按驼峰 / 连字符 / 下划线 / 空格切分，取最多 2 段，每段首字母大写。
 *   AnTest  → AT ; an-test → AT ; anTest → AT ; admin → A
 */
function initials(name: string): string {
  // 先按非字母数字字符切，再按驼峰边界（小写→大写）二次切分
  const rough = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const words: string[] = []
  for (const seg of rough) {
    for (const m of seg.matchAll(/[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z]|$)/g)) {
      if (m[0]) words.push(m[0])
    }
  }
  const picked = words.slice(0, 2)
  return picked.map((w) => w[0]?.toUpperCase() ?? '').join('') || '?'
}

/**
 * 基于项目名生成稳定的品牌色系背景（让不同项目头像有色差）。
 * 颜色走 CSS 变量（--avatar-N-bg/fg，亮/暗各一套），不在 JS 里硬编码十六进制，
 * 从而在暗色模式下头像自动切换为"半透明深底 + 高饱和亮前景"，与深色面板协调。
 */
function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const idx = (h % 7) + 1
  return `background:var(--avatar-${idx}-bg);color:var(--avatar-${idx}-fg)`
}

const hasProjects = computed(() => projects.value.length > 0)
</script>

<template>
  <div class="sider" :class="{ 'sider--collapsed': collapsed }">
    <!-- 品牌：作为窗口顶部拖拽区（与右侧 header 等高），整行可拖拽移动窗口。
         logo/title/tooltip 自身用 app-region: no-drag 恢复交互。 -->
    <div class="sider__brand">
      <NTooltip v-if="collapsed" placement="right">
        <template #trigger>
          <div class="sider__logo"><GitCommitHorizontal :size="18" /></div>
        </template>
        Git Commit
      </NTooltip>
      <div v-else class="sider__logo"><GitCommitHorizontal :size="18" /></div>
      <span v-if="!collapsed" class="sider__title">Git Commit</span>
    </div>
    <!-- 有项目：列表 -->
    <template v-if="hasProjects">
      <div v-if="!collapsed" class="sider__section-label">
        项目 <span class="sider__count">{{ projects.length }}</span>
      </div>

      <div class="sider__list-wrap">
        <NSpin :show="loading" size="small" class="sider__spin">
          <NScrollbar class="sider__list" :class="{ 'sider__list--collapsed': collapsed }">
            <!-- 折叠态：驼峰首字母头像，tooltip 显示名称 -->
            <template v-if="collapsed">
              <NTooltip
                v-for="(p, i) in projects"
                :key="p.id"
                placement="right"
                :delay="200"
              >
                <template #trigger>
                  <div
                    class="project-avatar"
                    :class="{ 'project-avatar--active': p.id === activeId }"
                    :style="[avatarColor(p.name), { '--stagger': i }]"
                    @click="onSelect(p.id)"
                  >
                    {{ initials(p.name) }}
                  </div>
                </template>
                {{ p.name }}
              </NTooltip>
            </template>

            <!-- 展开态：完整卡片 -->
            <template v-else>
              <div
                v-for="(p, i) in projects"
                :key="p.id"
                class="project-item"
                :class="{ 'project-item--active': p.id === activeId }"
                :style="{ '--stagger': i + 'px' }"
                @click="onSelect(p.id)"
              >
                <span class="project-item__bar"></span>
                <FolderOpen :size="16" class="project-item__icon" />
                <div class="project-item__main">
                  <div class="project-item__name">{{ p.name }}</div>
                  <div class="project-item__path" :title="p.path">{{ shortPath(p.path) }}</div>
                </div>
                <NTooltip placement="right" :delay="300">
                  <template #trigger>
                    <button class="project-item__del" @click.stop="onRemove(p.id, p.name)">
                      <Trash2 :size="14" />
                    </button>
                  </template>
                  从列表移除
                </NTooltip>
              </div>
            </template>
          </NScrollbar>
        </NSpin>
      </div>
    </template>

    <!-- 空态：展开时居中引导卡片（含按钮）；折叠时空态留白，按钮由底部 footer 提供 -->
    <div v-else class="sider__empty-wrap">
      <div v-if="!loading && !collapsed" class="empty-guide">
        <div class="empty-guide__icon"><FolderPlus :size="26" /></div>
        <div class="empty-guide__title">还没有项目</div>
        <div class="empty-guide__desc">添加一个 Git 仓库文件夹，开始管理提交</div>
        <NButton type="primary" @click="onAdd">
          <template #icon><Plus :size="16" /></template>
          添加项目
        </NButton>
      </div>
    </div>

    <!-- 底部固定添加按钮：有项目、或折叠态空态时都显示 -->
    <div v-if="hasProjects || collapsed" class="sider__footer">
      <!-- 折叠态：添加按钮上方加分隔线，与项目头像区分开 -->
      <NTooltip v-if="collapsed" placement="right">
        <template #trigger>
          <NButton circle type="primary" @click="onAdd">
            <template #icon><Plus :size="18" /></template>
          </NButton>
        </template>
        添加项目
      </NTooltip>
      <NButton v-else block type="primary" @click="onAdd">
        <template #icon>
          <Plus :size="18" />
        </template>
        添加项目
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.sider {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  /* 顶部 padding 为 0：让 .sider__brand 紧贴窗口顶边，与右侧 header 顶部对齐，
     形成贯穿左右的可拖拽标题栏；左右下保留内边距给列表/底部按钮呼吸空间。 */
  padding: 0 var(--sp-3) var(--sp-3);
  overflow: hidden;
}

.sider--collapsed {
  align-items: center;
  /* 顶部 padding 为 0：折叠态品牌区同样紧贴窗口顶边对齐右侧 header；
     左右 padding 设为 0，为选中项阴影留出最大空间（54px 宽 - 34px 头像 = 10px 侧边距 > 7px 阴影）。 */
  padding: 0 0 var(--sp-3);
}

/* —— 品牌（顶部拖拽区）——
   高度对齐右侧 --header-height(48px)，让左右顶部连成一条可拖拽的标题栏。
   -webkit-app-region: drag 让整行可移动窗口；内部 logo/tooltip 自身 no-drag 恢复交互。
   注意：drag 区若完全无 padding/border，Electron 可能出现双击最大化异常，
   这里保留稳定的高度 + 居中布局。 */
.sider__brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  /* 顶部拖拽区：与右侧 header 等高，左右两侧顶部均可拖拽移动窗口 */
  height: var(--header-height);
  flex-shrink: 0;
  padding: 0 var(--sp-2);
  width: 100%;
  -webkit-app-region: drag;
  app-region: drag;
}

.sider--collapsed .sider__brand {
  justify-content: center;
  padding: 0;
}

/* 折叠态品牌/列表、列表/底部之间的分隔线，避免内容挤成一团；
   同时并入顶部拖拽区，保持拖拽连续性。 */
.sider__divider {
  width: 24px;
  height: 1px;
  background: var(--border);
  margin-bottom: var(--sp-3);
  flex-shrink: 0;
  -webkit-app-region: drag;
  app-region: drag;
}

.sider__logo {
  width: 28px;
  height: 28px;
  border-radius: var(--r-md);
  display: grid;
  place-items: center;
  color: var(--text-on-brand);
  background: var(--brand);
  flex-shrink: 0;
  /* logo 在拖拽行内：取消拖拽，恢复 hover 缩放等交互 */
  -webkit-app-region: no-drag;
  app-region: no-drag;
  transition: transform var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard);
}

.sider__logo:hover {
  transform: scale(1.06);
  box-shadow: var(--shadow-focus, 0 0 0 3px rgba(99, 102, 241, 0.22));
}

.sider__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  /* 标题文字保留在拖拽区：拖拽移动窗口，与 macOS 标题栏体验一致 */
  pointer-events: none;
}

.sider__section-label {
  padding: var(--sp-2) var(--sp-2) var(--sp-1);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.sider__count {
  color: var(--text-secondary);
  font-weight: 500;
}

/* —— 列表区 —— */
.sider__list-wrap {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.sider__spin {
  flex: 1;
  min-height: 0;
}

.sider__list {
  height: 100%;
  padding: 0 var(--sp-2);
}

.sider--collapsed .sider__list {
  padding: 0;
}

/* 折叠态：样式需作用到 n-scrollbar 的内容层（.n-scrollbar-content）。
   注意：不要在 n-scrollbar 根元素或 .n-scrollbar-container 上设置 padding，
   否则会被 Naive UI 的内部布局样式覆盖，或导致滚动条位置异常。 */
:deep(.sider__list--collapsed) .n-scrollbar-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 全方位留白：
     - 左右：降至 --sp-1 (2px)，确保头像在 54px 宽度下有充足空间展示选中阴影
     - 上下：给首尾头像留出呼吸空间 */
  padding: var(--sp-4) var(--sp-1);
  gap: var(--sp-1);
}

/* —— 展开态项目卡片 —— */
.project-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
  animation: item-in var(--dur-slow) var(--ease-standard) both;
  animation-delay: calc(var(--stagger, 0) * 12ms);
}

@keyframes item-in {
  from { opacity: 0; transform: translateX(-4px); }
  to { opacity: 1; transform: translateX(0); }
}

.project-item:hover {
  background: var(--bg-hover);
}

/* 左侧激活指示条 */
.project-item__bar {
  position: absolute;
  left: var(--sp-1);
  top: 50%;
  width: 3px;
  height: 0;
  border-radius: var(--r-full, 9999px);
  background: var(--brand);
  transform: translateY(-50%);
  transition: height var(--dur-base) var(--ease-standard);
}

.project-item--active {
  background: var(--bg-selected);
}

.project-item--active .project-item__bar {
  height: 18px;
}

.project-item--active .project-item__icon {
  color: var(--brand);
}

.project-item__icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
  transition: color var(--dur-base) var(--ease-standard);
}

.project-item__main {
  flex: 1;
  min-width: 0;
}

.project-item__name {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-item__path {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
  font-family: var(--font-mono);
}

.project-item__del {
  opacity: 0;
  color: var(--text-tertiary);
  padding: var(--sp-1);
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  transition: opacity var(--dur-fast), color var(--dur-fast), background var(--dur-fast);
  flex-shrink: 0;
}

.project-item:hover .project-item__del {
  opacity: 1;
}

.project-item__del:hover {
  color: var(--intent-error);
  background: var(--bg-app);
}

/* —— 折叠态头像项（驼峰首字母） —— */
.project-avatar {
  width: 34px;
  height: 34px;
  margin: 0 auto 4px auto;
  display: grid;
  place-items: center;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  font-weight: 700;
  letter-spacing: 0.5px;
  cursor: pointer;
  position: relative;
  transition: transform var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard),
    filter var(--dur-base) var(--ease-standard);
  animation: avatar-in var(--dur-slow) var(--ease-standard) both;
  animation-delay: calc(var(--stagger, 0) * 24ms);
}

@keyframes avatar-in {
  from { opacity: 0; transform: scale(0.6); }
  to { opacity: 1; transform: scale(1); }
}

.project-avatar:hover {
  transform: scale(1.08);
  filter: brightness(0.95);
}

/* 选中态：放弃硬边描边（内嵌或外扩都会和头像色板"打架"），改用柔和外发光。
   - 发光：半透明品牌色 + blur，头像像被"点亮"，颜色柔和不突兀，亮/暗都适配。
     外层近+远双层发光，过渡自然，无硬边。
   - 放大：scale(1.06) 浮起，与未选中项拉开层级；hover 时到 1.1。
   - 发光外延约 7px < 滚动容器 padding(var(--sp-3)=12px)，不会被裁剪。 */
.project-avatar--active {
  transform: scale(1.06);
  box-shadow: 0 0 6px 1px var(--brand-glow), 0 0 14px 3px var(--brand-glow);
  filter: saturate(1.08) brightness(1.03);
}

.project-avatar--active:hover {
  transform: scale(1.1);
}

/* —— 空态 —— */
.sider__empty-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4) var(--sp-3);
}

.empty-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--sp-2);
  animation: fade-in var(--dur-slow) var(--ease-standard) both;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.empty-guide__icon {
  width: 52px;
  height: 52px;
  border-radius: var(--r-xl);
  display: grid;
  place-items: center;
  color: var(--brand);
  background: var(--bg-selected);
  margin-bottom: var(--sp-1);
}

.empty-guide__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.empty-guide__desc {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  line-height: 1.6;
  max-width: 180px;
  margin-bottom: var(--sp-2);
}

/* —— 底部 —— */
.sider__footer {
  padding: var(--sp-3) var(--sp-1) var(--sp-1);
  width: 100%;
}

.sider--collapsed .sider__footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) 0 var(--sp-1);
}
</style>
