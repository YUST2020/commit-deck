<script setup lang="ts">
/**
 * AI 服务配置弹窗（卡片内齿轮触发）。
 *
 * 三种模式：
 *   1. 预选服务商（glm / deepseek）：url 与协议由服务商固定（OpenAI 兼容），
 *      无需用户再选；只需选模型 + 填 API Key。
 *   2. 自定义：协议（OpenAI / Anthropic）+ URL 模式（自动补全 / 完整 URL）
 *      + 地址 + 模型 + Key。
 *
 * 另含「生成规则」编辑（多行）+ 恢复默认。
 * 弹窗内部 body 限制高度并滚动，避免内容溢出窗口。
 */
import { computed, ref, watch } from 'vue'
import {
  NModal,
  NForm,
  NFormItem,
  NRadioGroup,
  NRadioButton,
  NSelect,
  NSwitch,
  NInput,
  NButton,
  NSpace,
  NText,
  useMessage
} from 'naive-ui'
import { RotateCcw, ExternalLink } from 'lucide-vue-next'
import type { AiProviderId, AiServiceConfig, ThinkingEffort, UrlMode } from '@shared/index'
import { DEFAULT_RULES } from '@/ai/prompts'

const props = defineProps<{ show: boolean; config: AiServiceConfig; rules: string }>()
const emit = defineEmits<{
  'update:show': [v: boolean]
  save: [payload: { config: AiServiceConfig; rules: string }]
}>()

const message = useMessage()

/** 防御性默认配置：父级用 v-if 保证 config 已加载，此处仍兜底。 */
const FALLBACK_CONFIG: AiServiceConfig = {
  provider: 'glm',
  presetModel: 'glm-4.7-flash',
  presetCustomModel: false,
  protocol: 'openai',
  urlMode: 'auto',
  baseUrl: '',
  model: '',
  apiKey: '',
  thinking: false,
  thinkingEffort: 'high'
}

/** 本地可编辑副本（仅在 show 时从 props 同步） */
const draft = ref<AiServiceConfig>({ ...(props.config ?? FALLBACK_CONFIG) })
const draftRules = ref<string>(props.rules)
const presetCustomModel = ref<boolean>((props.config ?? FALLBACK_CONFIG).presetCustomModel)

watch(
  () => props.show,
  (open) => {
    if (open) {
      const cfg = props.config ?? FALLBACK_CONFIG
      draft.value = { ...cfg }
      draftRules.value = props.rules
      presetCustomModel.value = cfg.presetCustomModel
    }
  }
)

/** 预选服务商：各自支持的预设模型（自定义模型 ID 时这些不展示） */
const GLM_MODELS = [{ label: 'glm-4.7-flash（快速·免费）', value: 'glm-4.7-flash' }]

const DEEPSEEK_MODELS = [
  { label: 'deepseek-v4-flash（快速）', value: 'deepseek-v4-flash' },
  { label: 'deepseek-v4-pro（增强）', value: 'deepseek-v4-pro' }
]

/** 预选服务商每个 provider 的默认预设模型（切换时回填用） */
const PRESET_DEFAULT_MODEL: Record<'glm' | 'deepseek', string> = {
  glm: 'glm-4.7-flash',
  deepseek: 'deepseek-v4-flash'
}

/** 预设服务商下拉可选项（GLM / DeepSeek） */
const PRESET_PROVIDER_OPTIONS = [
  { label: '智谱GLM（BigModel）', value: 'glm' },
  { label: 'DeepSeek', value: 'deepseek' }
]

/**
 * 各服务商的「API Key 申请页」地址。
 * 用于 API Key 输入框右侧「获取 Key」按钮：点击用 window.open 打开，
 * 主进程 setWindowOpenHandler 会转 shell.openExternal 用系统浏览器打开。
 */
const API_KEY_CONSOLE_URL: Record<'glm' | 'deepseek', string> = {
  glm: 'https://open.bigmodel.cn/apikey/platform',
  deepseek: 'https://platform.deepseek.com/api_keys'
}

/** 当前预设服务商对应的 API Key 申请页地址（自定义模式无对应控制台，返回 null） */
const apiKeyConsoleUrl = computed<string | null>(() => {
  const p = draft.value.provider
  if (p === 'glm' || p === 'deepseek') return API_KEY_CONSOLE_URL[p]
  return null
})

/** 打开当前服务商的 API Key 申请页（系统浏览器） */
function openApiKeyConsole(): void {
  const url = apiKeyConsoleUrl.value
  if (url) window.open(url, '_blank', 'noopener')
}

/** 思考强度选项（DeepSeek：low/medium 会被映射为 high，故只暴露 high/max） */
const THINKING_EFFORTS: { label: string; value: ThinkingEffort }[] = [
  { label: 'high（推荐）', value: 'high' },
  { label: 'max（最强）', value: 'max' }
]

/** 地址输入框 placeholder（仅自定义模式） */
const urlPlaceholder = computed(() => {
  if (draft.value.urlMode === 'full') {
    return draft.value.protocol === 'openai'
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://api.anthropic.com/v1/messages'
  }
  return 'https://api.openai.com/v1'
})

/** 自动补全模式下的路径提示 */
const autoPathHint = computed(() => {
  if (draft.value.urlMode !== 'auto') return ''
  return draft.value.protocol === 'openai'
    ? '自动补全 /chat/completions'
    : '自动补全 /messages'
})

/** 当前预选服务商支持的预设模型列表 */
const presetModels = computed(() => {
  return draft.value.provider === 'glm' ? GLM_MODELS : DEEPSEEK_MODELS
})

/** 预选服务商当前会请求到的地址（只读展示，让用户放心） */
const presetPreview = computed(() => {
  if (draft.value.provider === 'glm') {
    return 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  }
  return 'https://api.deepseek.com/chat/completions'
})

/** 当前是否为「自定义」模式（反之即「预设模型」） */
const isCustomMode = computed(() => draft.value.provider === 'custom')

/** 「配置方式」radio 当前值：预设模型 / 自定义 */
const configMode = computed<'preset' | 'custom'>(() => (isCustomMode.value ? 'custom' : 'preset'))

/** 切换「配置方式」：预设模型 ↔ 自定义 */
function setConfigMode(mode: 'preset' | 'custom'): void {
  if (mode === 'custom') {
    // 进入自定义：保留协议/地址，切 provider
    draft.value.provider = 'custom'
  } else {
    // 进入预设模型：若当前 provider 不是预设服务商之一，则回退到 deepseek
    if (draft.value.provider !== 'glm' && draft.value.provider !== 'deepseek') {
      setProvider('deepseek')
    }
  }
}

function setProvider(p: AiProviderId): void {
  const prev = draft.value.provider
  draft.value.provider = p
  // 切换 glm ↔ deepseek：把 presetModel 重置为该服务商的默认值，
  // 避免选了 GLM 却仍挂着 deepseek-v4-flash 这种不匹配的值。
  if (p === 'glm' || p === 'deepseek') {
    if (p !== prev) draft.value.presetModel = PRESET_DEFAULT_MODEL[p]
  }
}

/** 预设模式下切换服务商（下拉驱动） */
function onPresetProviderChange(v: 'glm' | 'deepseek'): void {
  setProvider(v)
}

function setUrlMode(m: UrlMode): void {
  draft.value.urlMode = m
}

function onPresetCustomToggle(v: boolean): void {
  presetCustomModel.value = v
  draft.value.presetCustomModel = v
  if (!v) draft.value.model = ''
}

function resetRules(): void {
  draftRules.value = DEFAULT_RULES
  message.success('已恢复默认规则（需点击保存生效）')
}

function onCancel(): void {
  emit('update:show', false)
}

/**
 * 校验当前 draft 配置是否完整可用。返回首个错误文案或 null。
 * 保存与连通性测试共用，避免校验逻辑两处重复。
 */
function validateDraft(): string | null {
  if (!draft.value.apiKey.trim()) return '请填写 API Key'
  if (draft.value.provider === 'custom') {
    if (!draft.value.baseUrl.trim()) return '请填写请求地址'
    if (!draft.value.model.trim()) return '请填写模型 ID'
  } else if (presetCustomModel.value && !draft.value.model.trim()) {
    return '请填写自定义模型 ID'
  }
  return null
}

/** 连通性测试态（按钮 loading + 防重复点击） */
const testing = ref(false)

/**
 * 用当前 draft 配置发起连通性测试。填完即可测，无需先保存。
 * 跨 IPC 边界传参须转纯对象（去 Vue 响应式 Proxy），遵循 AGENTS.md 共性 bug 记录。
 */
async function onTest(): Promise<void> {
  const err = validateDraft()
  if (err) {
    message.error(err)
    return
  }
  testing.value = true
  try {
    const plainConfig = JSON.parse(JSON.stringify(draft.value)) as AiServiceConfig
    const res = await window.api.testAiConnection(plainConfig)
    if (res.ok) {
      message.success('连接成功')
    } else {
      message.error(res.error || '连接失败')
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : '连接测试失败')
  } finally {
    testing.value = false
  }
}

function onSave(): void {
  const err = validateDraft()
  if (err) {
    message.error(err)
    return
  }
  const finalConfig: AiServiceConfig = {
    ...draft.value,
    presetCustomModel: presetCustomModel.value
  }
  emit('save', { config: finalConfig, rules: draftRules.value })
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="AI 服务配置"
    style="width: 480px; max-width: 92vw"
    :bordered="false"
    :body-style="{ padding: 0 }"
    @update:show="(v) => emit('update:show', v)"
  >
    <div class="cfg">
      <!-- 可滚动主体 -->
      <div class="cfg__body">
        <NForm label-placement="top" size="small" :show-feedback="false" class="cfg__form">
          <!-- 模式切换：预设模型 / 自定义 -->
          <NFormItem label="配置方式">
            <NRadioGroup
              :value="configMode"
              @update:value="(v) => setConfigMode(v as 'preset' | 'custom')"
            >
              <NRadioButton value="preset">预设模型</NRadioButton>
              <NRadioButton value="custom">自定义</NRadioButton>
            </NRadioGroup>
          </NFormItem>

          <!-- 预设模型：在服务商处切换预设模型；url/协议已固定 -->
          <template v-if="!isCustomMode">
            <NFormItem label="服务商">
              <NSelect
                :value="draft.provider"
                :options="PRESET_PROVIDER_OPTIONS"
                @update:value="(v) => onPresetProviderChange(v as 'glm' | 'deepseek')"
              />
            </NFormItem>
            <NFormItem>
              <template #label>
                <div class="cfg__rules-label">
                  <span>模型</span>
                  <button
                    type="button"
                    class="cfg__inline" style="margin-left: var(--sp-4);"
                    @click="onPresetCustomToggle(!presetCustomModel)"
                  >
                    <NSwitch size="small" :value="presetCustomModel" />
                    <NText depth="3" class="cfg__inline-text">自定义模型 ID</NText>
                  </button>
                </div>
              </template>
              <NSelect
                v-if="!presetCustomModel"
                v-model:value="draft.presetModel"
                :options="presetModels"
              />
              <NInput
                v-else
                v-model:value="draft.model"
                placeholder="模型 ID"
              />
            </NFormItem>
            <NFormItem label="接口地址">
              <NText depth="3" class="cfg__mono">{{ presetPreview }}</NText>
            </NFormItem>
          </template>

          <!-- 自定义 -->
          <template v-else>
            <NFormItem label="协议格式">
              <NRadioGroup v-model:value="draft.protocol" name="protocol">
                <NRadioButton value="openai">OpenAI</NRadioButton>
                <NRadioButton value="anthropic">Anthropic</NRadioButton>
              </NRadioGroup>
            </NFormItem>

            <NFormItem label="地址模式">
              <button type="button" class="cfg__inline" @click="setUrlMode(draft.urlMode === 'auto' ? 'full' : 'auto')">
                <NSwitch size="small" :value="draft.urlMode === 'full'" />
                <NText depth="2" class="cfg__inline-text">
                  {{ draft.urlMode === 'auto' ? '自动补全路径' : '完整 URL' }}
                </NText>
              </button>
            </NFormItem>

            <NFormItem :label="draft.urlMode === 'auto' ? '基础地址' : '完整地址'">
              <NSpace vertical style="width: 100%" :size="2">
                <NInput v-model:value="draft.baseUrl" :placeholder="urlPlaceholder" />
                <NText v-if="autoPathHint" depth="3" class="cfg__hint">{{ autoPathHint }}</NText>
              </NSpace>
            </NFormItem>

            <NFormItem label="模型 ID">
              <NInput v-model:value="draft.model" placeholder="如 gpt-4o / claude-sonnet-4-5" />
            </NFormItem>
          </template>

          <!-- API Key（共用） -->
          <!-- API Key（共用）：预设服务商模式在标题行右侧带「获取 Key」入口 -->
          <NFormItem>
            <template #label>
              <div class="cfg__rules-label">
                <span>API Key</span>
                <button
                  v-if="apiKeyConsoleUrl"
                  type="button"
                  class="cfg__key-link" style="margin-left: var(--sp-4);"
                  title="前往控制台获取 API Key"
                  @click="openApiKeyConsole"
                >
                  <ExternalLink :size="12" />
                  <span>获取 Key</span>
                </button>
              </div>
            </template>
            <NInput
              v-model:value="draft.apiKey"
              type="password"
              show-password-on="click"
              placeholder="sk-..."
            />
          </NFormItem>

          <!-- 生成规则 -->
          <NFormItem>
            <template #label>
              <div class="cfg__rules-label">
                <span>生成规则</span>
                <button
                  type="button"
                  class="cfg__key-link" style="margin-left: var(--sp-4);"
                  @click="resetRules"
                >
                  <RotateCcw :size="12" />
                  <span>恢复默认</span>
                </button>
              </div>
            </template>
            <NInput
              v-model:value="draftRules"
              type="textarea"
              :autosize="{ minRows: 4, maxRows: 6 }"
              class="cfg__rules"
            />
          </NFormItem>
        </NForm>
      </div>

      <!-- 固定底部：左侧「测试连接」，右侧取消/保存 -->
      <div class="cfg__footer">
        <NButton
          size="small"
          :loading="testing"
          :disabled="testing"
          @click="onTest"
        >
          测试连接
        </NButton>
        <div class="cfg__footer-right">
          <NButton size="small" @click="onCancel">取消</NButton>
          <NButton size="small" type="primary" @click="onSave">保存</NButton>
        </div>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.cfg {
  display: flex;
  flex-direction: column;
  max-height: min(70vh, 560px);
}
.cfg__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--sp-6) var(--sp-3);
}
.cfg__form :deep(.n-form-item) {
  margin-bottom: var(--sp-4);
}
.cfg__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-6);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.cfg__footer-right {
  display: flex;
  gap: var(--sp-2);
}
.cfg__inline {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  background: none;
}
/* API Key 标题行右侧的「获取 Key」入口（与「恢复默认」同款 text 按钮） */
.cfg__key-link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--brand);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-standard);
}
.cfg__key-link:hover {
  color: var(--brand-hover);
}
.cfg__inline-text {
  font-size: var(--fs-sm);
}
.cfg__hint {
  font-size: var(--fs-xs);
}
.cfg__mono {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.cfg__rules :deep(textarea) {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: 1.6;
}
.cfg__rules-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
</style>
