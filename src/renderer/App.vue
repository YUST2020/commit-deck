<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  NLayout,
  NLayoutSider,
  NLayoutHeader,
  NLayoutContent,
  NButton,
  NTooltip
} from 'naive-ui'
import { Moon, Sun, Settings } from 'lucide-vue-next'
import { useTheme } from '@/composables/useTheme'
import { useUiStore } from '@/stores/useUiStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useGitStore } from '@/stores/useGitStore'
import { useAiStore } from '@/stores/useAiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useCodeReviewStore } from '@/stores/useCodeReviewStore'
import ProjectSider from '@/components/ProjectSider.vue'
import AppHeader from '@/components/AppHeader.vue'
import WindowControls from '@/components/WindowControls.vue'
import SettingsModal from '@/components/SettingsModal.vue'
import CloseConfirmDialog from '@/components/CloseConfirmDialog.vue'
import ResizeHandles from '@/components/ResizeHandles.vue'
import WorkspaceView from '@/views/WorkspaceView.vue'

const { naiveTheme, themeOverrides, isDark, setMode } = useTheme()
const ui = useUiStore()
const project = useProjectStore()
const git = useGitStore()
const ai = useAiStore()
const settings = useSettingsStore()
const review = useCodeReviewStore()

function toggleTheme() {
  setMode(isDark.value ? 'light' : 'dark')
}

// 启动：加载项目列表 + AI 配置/偏好 + 侧栏折叠记忆 + 应用设置
onMounted(async () => {
  await Promise.all([project.load(), ui.initSiderCollapsed(), ai.init(), settings.init()])
  // 订阅主进程的关闭决策请求：自定义关闭按钮 / Alt+F4 触发
  // → 走 useSettingsStore.handleClose（已设置「不再提醒」则直接执行，否则弹确认框）
  unsubRequestClose = window.api.onRequestClose(() => {
    settings.handleClose()
  })
})

let unsubRequestClose: (() => void) | null = null

// 窗口聚焦 / 从后台切回时自动刷新（5s 节流，避免高频触发）
function onFocusRefresh(): void {
  if (project.active) git.refreshAllThrottled()
}
window.addEventListener('focus', onFocusRefresh)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onFocusRefresh()
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', onFocusRefresh)
  unsubRequestClose?.()
})

// 选中项目变化时加载对应 git 数据 + 切换 AI 卡片状态。
// - ai.switchProject(prevId, id)：按项目保存/恢复草稿与生成结果，
//   生成中切走会自动 abort 并丢弃部分结果。
// - git.switchProject()：刷新 git 状态，同时驱动 WorkspaceView 的
//   keyed <Transition> 做淡入淡出过渡，避免「卸载→转圈→重挂」的闪屏中间态。
// - review.switchProject()：中断在跑的代码审查 + 清空结果（按项目隔离）。
watch(
  () => project.activeId,
  (id, prevId) => {
    if (id && project.active) {
      void ai.switchProject(prevId, id)
      void review.switchProject()
      git.switchProject()
    }
  }
)
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <NNotificationProvider>
          <NLayout has-sider class="app-root">
            <!-- 左侧项目栏 -->
            <NLayoutSider
              :width="240"
              :collapsed-width="54"
              :collapsed="ui.siderCollapsed"
              collapse-mode="width"
              :show-trigger="true"
              :native-scrollbar="false"
              @update:collapsed="ui.siderCollapsed = $event"
            >
              <ProjectSider :collapsed="ui.siderCollapsed" />
            </NLayoutSider>

            <!-- 主区域 -->
            <NLayout>
              <NLayoutHeader class="app-header">
                <AppHeader />
                <div class="app-header__actions">
                  <NTooltip placement="bottom" :delay="300">
                    <template #trigger>
                      <NButton quaternary circle @click="ui.settingsOpen = true">
                        <template #icon>
                          <Settings :size="18" />
                        </template>
                      </NButton>
                    </template>
                    设置
                  </NTooltip>
                  <NButton quaternary circle @click="toggleTheme">
                    <template #icon>
                      <Moon v-if="!isDark" :size="18" />
                      <Sun v-else :size="18" />
                    </template>
                  </NButton>
                  <WindowControls />
                </div>
              </NLayoutHeader>

              <NLayoutContent class="app-content">
                <WorkspaceView />
              </NLayoutContent>
            </NLayout>
          </NLayout>

          <!-- 应用设置弹窗 -->
          <SettingsModal v-model:show="ui.settingsOpen" />
          <!-- 关闭主窗口确认弹窗（受 settings.confirmOpen 控制） -->
          <CloseConfirmDialog v-model:show="settings.confirmOpen" />
          <!-- 自定义窗口 resize 热区（仅 Windows，组件内部 platform 守卫）。
               position:fixed 撑满 OS 窗口矩形，与 .app-root 同级不互相影响。 -->
          <ResizeHandles />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
.app-root {
  /* 透明无边框窗口：四周留出 --win-gap 透明边带，让窗口描边与投影有地方渲染。
     高度随之收缩，避免 100vh 撑满窗口外缘把投影裁掉。 */
  height: calc(100vh - var(--win-gap) * 2);
  width: calc(100vw - var(--win-gap) * 2);
  margin: var(--win-gap);
  /* 窗口外圆角：透明窗口下，圆角以外区域露出桌面。
     overflow:hidden 裁剪内部背景到圆角范围内。 */
  border-radius: var(--r-xl);
  overflow: hidden;
  background: var(--bg-app);
  /* 窗口描边：明色下用 --border-strong 形成可见轮廓，暗色下用 --border 与深桌面区分。
     outline 跟随 border-radius 画出圆角描边，box-shadow 无法承担描边时由它补位。 */
  outline: var(--bw-thin) solid var(--border-strong);
  outline-offset: -1px;
  /* 窗口投影：主题感知（见 tokens.css 的 --shadow-window）。
     偏移全 0，向 4 周均匀扩散，跟随 border-radius 形成圆角辉光。
     --win-gap 需 ≥ shadow blur，否则会被窗口外缘的硬矩形裁切，
     让外部阴影看起来是直角。 */
  box-shadow: var(--shadow-window);
}

.app-header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-4);
  gap: var(--sp-2);
  /* 无边框设计：顶栏用 --bg-panel 浮起，与下方 --bg-app 内容区形成背景层差，
     替代此前的 bordered 底部分隔线。 */
  background: var(--bg-panel);
  /* 自定义标题栏：整个 header 可拖拽移动窗口；
     header 内的按钮/控件自身用 app-region: no-drag 取消拖拽，恢复点击。 */
  -webkit-app-region: drag;
  app-region: drag;
}

.app-header__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
  /* 操作区按钮可点击：取消拖拽 */
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.app-content {
  /* 显式高度撑满主区域（主 NLayout 非 flex 容器，不能靠 flex:1）。
     app-root 已收缩 2×--win-gap，这里同步减去以保持高度链一致，
     否则 content 会高出 app-root 触发超长滚动。 */
  height: calc(100vh - var(--header-height) - var(--win-gap) * 2);
  background: var(--bg-app);
}
</style>
