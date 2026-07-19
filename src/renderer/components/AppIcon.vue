<script setup lang="ts">
/**
 * 应用品牌图标：内联自 build/icon.svg（Git 图谱 + AI 闪电渐变）。
 * 内联渲染以便随尺寸缩放并保留渐变定义，无需经 Vite 静态资源处理。
 */
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="23 8 74 93"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    class="app-icon"
  >
    <!-- Git 图谱 -->
    <path
      d="M38 28 L38 52 C38 62 44 68 54 72 L82 86"
      stroke="#38BDF8"
      stroke-width="6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M38 28 C32 34 32 42 38 48"
      stroke="#38BDF8"
      stroke-width="6"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.65"
    />
    <!-- 节点 -->
    <circle cx="38" cy="28" r="7" fill="white" stroke="#2563EB" stroke-width="4" />
    <circle cx="54" cy="72" r="7" fill="white" stroke="#22C55E" stroke-width="4" />
    <circle cx="82" cy="86" r="7" fill="white" stroke="#0EA5E9" stroke-width="4" />
    <!-- 闪电（AI 核心） -->
    <path d="M66 14L50 46H64L56 88L84 42H70L78 14Z" fill="url(#boltGrad)" />
    <!-- 能量线 -->
    <path d="M56 54L70 54" stroke="#A855F7" stroke-width="4" stroke-linecap="round" opacity="0.6" />
    <rect x="62" y="40" width="14" height="6" rx="3" fill="#A855F7" opacity="0.55" />
    <rect x="66" y="58" width="16" height="6" rx="3" fill="#7C3AED" opacity="0.35" />
    <defs>
      <linearGradient id="boltGrad" x1="50" y1="14" x2="84" y2="88" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#A855F7" />
        <stop offset="45%" stop-color="#7C3AED" />
        <stop offset="100%" stop-color="#6366F1" />
      </linearGradient>
    </defs>
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex-shrink: 0;
}
</style>
