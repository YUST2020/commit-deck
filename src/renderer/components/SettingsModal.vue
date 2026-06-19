<script setup lang="ts">
/**
 * 应用设置弹窗（顶栏齿轮触发）。
 *
 * 分组：
 *   通用 —— 开机自启 / 开机静默启动（仅托盘）/ 关闭主窗口时（退出 or 最小化到托盘）/ 关闭时是否提醒
 *   快捷键 —— 全局唤出应用开关 + 快捷键录入（自定义组合键）
 *   AI 服务 —— 「API Key 配置」按钮，复用已有的 AiServiceConfigModal
 *             （不改动该弹窗本身，仅通过 ai.configModalOpen 触发）。
 *
 * 所有开关/选择即时保存（写盘 + useMessage 反馈），符合桌面端设置即时生效习惯。
 */
import { computed } from 'vue'
import {
  NModal,
  NForm,
  NFormItem,
  NSwitch,
  NRadioGroup,
  NRadioButton,
  NButton,
  NInput,
  NText,
  useMessage
} from 'naive-ui'
import { KeyRound, Keyboard, RotateCcw } from 'lucide-vue-next'
import type { CloseAction } from '@shared/index'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useAiStore } from '@/stores/useAiStore'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [v: boolean] }>()

const settings = useSettingsStore()
const ai = useAiStore()
const message = useMessage()

/** 默认快捷键（与 StoreService 的 DEFAULT_APP_SETTINGS.globalShortcut 保持一致） */
const DEFAULT_SHORTCUT = 'Alt+Shift+G'

const s = computed(() => settings.settings)

/* ---------- 即时保存 ---------- */
async function onLaunchChange(v: boolean): Promise<void> {
  await settings.setLaunchAtLogin(v)
  message.success(v ? '已开启开机自启' : '已关闭开机自启')
}

async function onSilentChange(v: boolean): Promise<void> {
  await settings.setLaunchSilent(v)
  message.success(v ? '已开启开机静默启动' : '已关闭开机静默启动')
}

async function onCloseActionChange(v: CloseAction): Promise<void> {
  await settings.setCloseAction(v)
  message.success('已更新关闭行为')
}

async function onRemindChange(v: boolean): Promise<void> {
  await settings.setRemindOnClose(v)
}

async function onShortcutEnabledChange(v: boolean): Promise<void> {
  await settings.setGlobalShortcutEnabled(v)
  message.success(v ? '已开启全局快捷键' : '已关闭全局快捷键')
}

/* ---------- 快捷键录入 ---------- */
/**
 * 录入框始终显示当前已保存的快捷键值。
 * 焦点在输入框时按下有效组合键 → 直接落盘并失焦；Esc → 仅失焦放弃。
 * 输入框 readonly，避免文本输入与录制冲突。
 */

/**
 * 把键盘事件转成 Electron accelerator 字符串。
 * 规则：修饰键（Ctrl/Alt/Shift/Super）+ 主键（字母/数字/F1-F24/方向键等）。
 * 仅纯修饰键按下时返回 null（等待主键）。
 */
function toAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  // 主键映射
  let key = ''
  const k = e.key
  if (/^[a-zA-Z]$/.test(k)) {
    key = k.toUpperCase()
  } else if (/^[0-9]$/.test(k)) {
    key = k
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) {
    key = k
  } else if (k === 'ArrowUp') key = 'Up'
  else if (k === 'ArrowDown') key = 'Down'
  else if (k === 'ArrowLeft') key = 'Left'
  else if (k === 'ArrowRight') key = 'Right'
  else if (k === 'Space') key = 'Space'
  else if (k === 'Enter') key = 'Return'
  else if (k === 'Backspace') key = 'Backspace'
  else if (k === 'Tab') key = 'Tab'
  else if (k === 'Home' || k === 'End' || k === 'Insert' || k === 'Delete') key = k
  else if (k.startsWith('Arrow')) return null // 其它方向键不处理

  // 单独修饰键、或只按了修饰键，不构成有效组合
  if (!key) return null
  // 至少需要一个修饰键，避免与普通输入冲突
  if (mods.length === 0) return null

  return [...mods, key].join('+')
}

/** 录入框按键处理：Esc 取消，有效组合则保存并失焦 */
async function onShortcutKeydown(e: KeyboardEvent): Promise<void> {
  // Esc：放弃录入，恢复显示已保存值（不写盘）
  if (e.key === 'Escape') {
    e.preventDefault()
    ;(e.target as HTMLInputElement).blur()
    return
  }
  const accel = toAccelerator(e)
  if (!accel) {
    // 仅修饰键或非法主键：阻止默认行为，等待完整组合
    e.preventDefault()
    return
  }
  e.preventDefault()
  await settings.setGlobalShortcut(accel)
  message.success(`快捷键已设为 ${accel}`)
  ;(e.target as HTMLInputElement).blur()
}

/** 重置为默认快捷键 */
async function onResetShortcut(): Promise<void> {
  await settings.setGlobalShortcut(DEFAULT_SHORTCUT)
  message.success(`已重置为 ${DEFAULT_SHORTCUT}`)
}

/* ---------- 打开 API Key 配置（复用已有弹窗） ---------- */
function openApiKeyConfig(): void {
  // 关闭设置弹窗，让 AI 服务配置弹窗叠在最上层；不改动 AiServiceConfigModal 的任何交互
  emit('update:show', false)
  ai.configModalOpen = true
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    title="设置"
    style="width: 440px; max-width: 92vw"
    :bordered="false"
    :body-style="{ padding: 0 }"
    @update:show="(v) => emit('update:show', v)"
  >
    <div class="set">
      <div class="set__body">
        <NForm label-placement="top" size="small" :show-feedback="false" class="set__form">
          <!-- 通用分组 -->
          <div class="set__group-title">通用</div>

          <!-- 开机自启 -->
          <NFormItem :show-label="false">
            <div class="set__row">
              <div class="set__row-main">
                <span class="set__label">开机自动启动</span>
                <NText depth="3" class="set__hint">登录系统时自动启动本应用</NText>
              </div>
              <NSwitch
                :value="s?.launchAtLogin ?? false"
                @update:value="(v) => onLaunchChange(v as boolean)"
              />
            </div>
          </NFormItem>

          <!-- 开机静默启动（仅托盘）：自启的附加项，未开启自启时禁用 -->
          <NFormItem :show-label="false">
            <div class="set__row">
              <div class="set__row-main">
                <span class="set__label">开机静默启动</span>
                <NText depth="3" class="set__hint">
                  自动启动时仅显示托盘图标，不弹出主窗口
                </NText>
              </div>
              <NSwitch
                :value="s?.launchSilent ?? false"
                :disabled="!s?.launchAtLogin"
                @update:value="(v) => onSilentChange(v as boolean)"
              />
            </div>
          </NFormItem>

          <!-- 关闭主窗口时 -->
          <NFormItem label="关闭主窗口时">
            <NRadioGroup
              :value="s?.closeAction ?? 'tray'"
              @update:value="(v) => onCloseActionChange(v as CloseAction)"
            >
              <NRadioButton value="tray">最小化到托盘</NRadioButton>
              <NRadioButton value="quit">退出应用</NRadioButton>
            </NRadioGroup>
          </NFormItem>

          <!-- 关闭时提醒 -->
          <NFormItem :show-label="false">
            <div class="set__row">
              <div class="set__row-main">
                <span class="set__label">关闭时提醒我</span>
                <NText depth="3" class="set__hint">关闭主窗口时弹出确认框选择操作</NText>
              </div>
              <NSwitch
                :value="s?.remindOnClose ?? true"
                @update:value="(v) => onRemindChange(v as boolean)"
              />
            </div>
          </NFormItem>

          <!-- 快捷键分组 -->
          <div class="set__group-title" style="margin-top: 12px;">快捷键</div>

          <!-- 全局快捷键开关 -->
          <NFormItem :show-label="false">
            <div class="set__row">
              <div class="set__row-main">
                <span class="set__label">唤出应用</span>
                <NText depth="3" class="set__hint">全局快捷键显示或隐藏主窗口</NText>
              </div>
              <NSwitch
                :value="s?.globalShortcutEnabled ?? true"
                @update:value="(v) => onShortcutEnabledChange(v as boolean)"
              />
            </div>
          </NFormItem>

          <!-- 快捷键录入：点击聚焦后按下组合键录制 -->
          <NFormItem :show-label="false">
            <div class="set__row set__row--key">
              <div class="set__row-main">
                <span class="set__label">快捷键</span>
                <NText depth="3" class="set__hint">点击输入框后按下组合键，Esc 取消</NText>
              </div>
              <div class="set__shortcut">
                <NInput
                  :value="s?.globalShortcut ?? ''"
                  :placeholder="s?.globalShortcutEnabled ? '按下组合键' : '已关闭'"
                  :readonly="true"
                  :disabled="!s?.globalShortcutEnabled"
                  size="small"
                  class="set__shortcut-input"
                  @keydown="onShortcutKeydown"
                >
                  <template #prefix>
                    <Keyboard :size="14" />
                  </template>
                </NInput>
                <NButton
                  size="small"
                  tertiary
                  :disabled="!s?.globalShortcutEnabled || s?.globalShortcut === DEFAULT_SHORTCUT"
                  @click="onResetShortcut"
                >
                  <template #icon><RotateCcw :size="14" /></template>
                </NButton>
              </div>
            </div>
          </NFormItem>

          <!-- AI 服务分组 -->
          <div class="set__group-title" style="margin-top: 12px;">AI 服务</div>

          <NFormItem :show-label="false">
            <div class="set__row set__row--key">
              <div class="set__row-main">
                <span class="set__label">API Key 配置</span>
                <NText depth="3" class="set__hint">配置服务商、模型与密钥</NText>
              </div>
              <NButton size="small" tertiary @click="openApiKeyConfig">
                <template #icon><KeyRound :size="14" /></template>
                配置
              </NButton>
            </div>
          </NFormItem>
        </NForm>
      </div>

      <div class="set__footer">
        <NButton size="small" @click="emit('update:show', false)">关闭</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.set {
  display: flex;
  flex-direction: column;
  max-height: min(70vh, 560px);
}
.set__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--sp-6) var(--sp-3);
}
.set__form :deep(.n-form-item) {
  margin-bottom: var(--sp-4);
}
.set__group-title {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: var(--sp-2);
  margin-top: var(--sp-2);
}
.set__group-title:first-child {
  margin-top: var(--sp-3);
}
.set__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
}
.set__row--key {
  align-items: flex-start;
}
.set__row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.set__label {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  font-weight: 500;
}
.set__hint {
  font-size: var(--fs-xs);
}
.set__hint--block {
  display: block;
  margin-top: var(--sp-1);
}
.set__shortcut {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.set__shortcut-input {
  width: 150px;
}
.set__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-6);
  flex-shrink: 0;
}
</style>
