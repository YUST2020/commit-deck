<script setup lang="ts">
/**
 * 自定义窗口 resize 热区（仅 Windows）。
 *
 * 背景：项目用 frame:false + transparent:true，Electron 在 Windows 上移除
 * WS_THICKFRAME，原生 resize 不可用。改用 8 方向热区 + 主进程 setBounds 轮询实现。
 * macOS / Linux 上 transparent 窗口原生 resize 可用，本组件不渲染（platform 守卫）。
 *
 * 热区放在 .app-root 外侧的 --win-gap（14px）透明边带里——这片空间原本只为
 * 容纳 box-shadow，现在兼任 resize 命中区，视觉零侵入。
 * - 整层 position:fixed 撑满 OS 窗口矩形，pointer-events:none 不挡内部内容；
 * - 8 个热区 div 各自 pointer-events:auto + app-region:no-drag 接管鼠标；
 * - mousedown 经 IPC 通知主进程开始 resize，主进程自己轮询 cursor 完成实际缩放
 *   （mouse 越界到桌面后渲染层会丢 mousemove，必须靠主进程系统级 cursor）；
 * - mouseup / blur / Escape 兜底结束，防止 resize 状态卡死。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ResizeDir } from '@shared/index'

/** 非 Windows 直接不渲染，节省 DOM 与事件绑定 */
const shouldRender = computed(() => window.api.platform === 'win32')

/** 8 方向热区配置：dir + 光标值（浏览器内置光标，无需走 token） */
interface HandleDef {
  dir: ResizeDir
  cursor: string
  /** 定位 class（见下方 CSS：n/s/e/w 四边 + 四角） */
  cls: string
}

const HANDLES: readonly HandleDef[] = [
  { dir: 'n', cursor: 'ns-resize', cls: 'rh--n' },
  { dir: 's', cursor: 'ns-resize', cls: 'rh--s' },
  { dir: 'e', cursor: 'ew-resize', cls: 'rh--e' },
  { dir: 'w', cursor: 'ew-resize', cls: 'rh--w' },
  { dir: 'ne', cursor: 'nesw-resize', cls: 'rh--ne' },
  { dir: 'nw', cursor: 'nwse-resize', cls: 'rh--nw' },
  { dir: 'se', cursor: 'nwse-resize', cls: 'rh--se' },
  { dir: 'sw', cursor: 'nesw-resize', cls: 'rh--sw' }
]

/** 当前是否处于 resize 中（用于阻止重复触发，并在期间禁用文本选择等） */
const resizing = ref(false)

async function onDown(dir: ResizeDir): Promise<void> {
  if (resizing.value) return
  resizing.value = true
  try {
    await window.api.windowResizeStart(dir)
  } catch (e) {
    console.error('[ResizeHandles] start resize failed:', e)
    resizing.value = false
  }
}

async function endResize(): Promise<void> {
  if (!resizing.value) return
  resizing.value = false
  try {
    await window.api.windowResizeEnd()
  } catch (e) {
    console.error('[ResizeHandles] end resize failed:', e)
  }
}

function onMouseUp(): void {
  void endResize()
}

function onBlur(): void {
  // 窗口失焦（alt+tab / 切到其他窗口）兜底结束
  void endResize()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && resizing.value) {
    void endResize()
  }
}

onMounted(() => {
  if (!shouldRender.value) return
  // mouseup 挂 window：鼠标拖到热区外释放也能收到
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('blur', onBlur)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  if (!shouldRender.value) return
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('blur', onBlur)
  window.removeEventListener('keydown', onKey)
  // 卸载时若仍在 resize，通知主进程清理
  if (resizing.value) void window.api.windowResizeEnd()
})
</script>

<template>
  <div v-if="shouldRender" class="resize-handles" aria-hidden="true">
    <div
      v-for="h in HANDLES"
      :key="h.dir"
      :class="['rh', h.cls]"
      :style="{ cursor: h.cursor }"
      @mousedown.left.prevent="onDown(h.dir)"
    ></div>
  </div>
</template>

<style scoped>
/* 整层撑满 OS 窗口矩形（注意不是 .app-root，而是完整 100vw/100vh）。
   pointer-events:none 保证只在 8 个热区本身接收事件，不挡内部内容。
   z-index 拉高到最顶，避免被其他浮层盖住导致热区失效。 */
.resize-handles {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
}

/* 单个热区基础：接管事件 + 取消 drag（否则会被当成窗口拖拽） */
.rh {
  position: absolute;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  background: transparent;
}

/* —— 4 个直边：贴 .app-root 外缘，宽度 = --win-gap（14px 透明带） —— */
/* 顶边：贴 OS 窗口最顶，横向铺满；左右两端各让出一个 corner 尺寸给角热区 */
.rh--n {
  top: 0;
  left: var(--corner);
  right: var(--corner);
  height: var(--win-gap);
}
.rh--s {
  bottom: 0;
  left: var(--corner);
  right: var(--corner);
  height: var(--win-gap);
}
.rh--e {
  top: var(--corner);
  bottom: var(--corner);
  right: 0;
  width: var(--win-gap);
}
.rh--w {
  top: var(--corner);
  bottom: var(--corner);
  left: 0;
  width: var(--win-gap);
}

/* —— 4 个角：corner 尺寸的方块，更好抓；覆盖对应边的交叉区 —— */
.rh--nw {
  top: 0;
  left: 0;
  width: var(--corner);
  height: var(--corner);
}
.rh--ne {
  top: 0;
  right: 0;
  width: var(--corner);
  height: var(--corner);
}
.rh--sw {
  bottom: 0;
  left: 0;
  width: var(--corner);
  height: var(--corner);
}
.rh--se {
  bottom: 0;
  right: 0;
  width: var(--corner);
  height: var(--corner);
}

/* 角热区尺寸：略大于边带，给角落更宽松的命中区（Windows 原生 corner 约 8~12px） */
.resize-handles {
  --corner: 14px;
}
</style>
